// 多人模式乐观渲染执行器（技术设计 §5.3 / ADR-0002）：
// 本地 TetrisGame（服务器 seed）即时应用输入零延迟渲染，输入带 seq 上行；
// 收到权威快照比较 stateHash，不一致 → applySnapshotState 重建 + 重放未确认输入。

import {
  ARR_MS,
  DAS_MS,
  TetrisGame,
  boardFromString,
  type GameAction,
  type GameModeName,
  type SelfSnapshot,
} from '@bearbricks/shared';
import { AutoShiftScheduler, type Dir } from './autoshift';

const STEP_MS = 1000 / 60;

export class NetGameRunner {
  readonly game: TetrisGame;
  paused = false;
  onInput?: (seq: number, action: GameAction) => void;
  onSoftChange?: (on: boolean) => void;

  private seqCounter = 0;
  private inputLog = new Map<number, GameAction>();
  private softOn = false;
  private scheduler: AutoShiftScheduler;
  private acc = 0;
  private lastTs = 0;
  private rafId = 0;
  private running = false;

  constructor(
    seed: string,
    mode: GameModeName,
    targetLines: number,
    opts?: { das?: number; arr?: number; initialSeq?: number },
  ) {
    // sprint：引擎内 300s 超时 + 顶出清盘；survival/timed：marathon 语义（顶出即终局，处置由服务器）
    this.game = new TetrisGame({
      mode: mode === 'sprint' ? 'sprint' : 'marathon',
      targetLines,
      seed,
    });
    // 协议 §4：seq 重连后不重置——从 game.state.full 的基线继续
    this.seqCounter = opts?.initialSeq ?? 0;
    this.scheduler = new AutoShiftScheduler(
      (dir) => this.dispatch(dir === 'L' ? 'moveL' : 'moveR'),
      opts?.das ?? DAS_MS,
      opts?.arr ?? ARR_MS,
    );
  }

  setTiming(das: number, arr: number): void {
    this.scheduler.setTiming(das, arr);
  }

  start(onFrame: () => void, opts?: { elapsedOffsetMs?: number }): void {
    if (this.running) return;
    this.running = true;
    // 用服务器 game.start 的 startTs 补偿 RTT，HUD 计时与权威计时对齐
    if (opts?.elapsedOffsetMs && opts.elapsedOffsetMs > 0) {
      this.game.elapsedMs += Math.min(opts.elapsedOffsetMs, 300_000);
    }
    this.lastTs = performance.now();
    const loop = (ts: number): void => {
      const dt = Math.max(0, Math.min(ts - this.lastTs, 250));
      this.lastTs = ts;
      if (!this.paused) {
        this.scheduler.update(dt);
        this.acc += dt;
        while (this.acc >= STEP_MS) {
          this.game.update(STEP_MS);
          this.acc -= STEP_MS;
        }
      }
      onFrame();
      // 本地 status finished 不停帧：终局以服务器 game.result 为准（重连/校正可能复活预测态）
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.running = false;
  }

  /** 本地应用 + 记录 seq + 上行回调；终局/暂停后不再产生输入（防 E4031 轰炸） */
  private dispatch(action: GameAction): boolean {
    if (this.paused || this.game.status !== 'running') return false;
    const seq = ++this.seqCounter;
    const ok = this.game.applyInput(action);
    this.inputLog.set(seq, action);
    this.onInput?.(seq, action);
    return ok;
  }

  apply(action: GameAction): boolean {
    return this.dispatch(action);
  }

  pressDirection(dir: Dir): void {
    this.scheduler.press(dir);
  }

  releaseDirection(dir: Dir): void {
    this.scheduler.release(dir);
  }

  releaseAll(): void {
    this.scheduler.releaseAll();
  }

  setSoft(on: boolean): void {
    if (this.softOn === on) return;
    this.softOn = on;
    this.game.setSoftDrop(on);
    this.onSoftChange?.(on);
  }

  /** 权威快照校正：一致 → 仅确认 seq 并对齐计时；不一致 → 重建 + 重放未确认输入 */
  resync(snap: SelfSnapshot): boolean {
    if (this.game.stateHash() === snap.h) {
      this.game.elapsedMs = snap.elapsedMs; // 权威计时对齐（stateHash 不含 elapsedMs）
      this.seqCounter = Math.max(this.seqCounter, snap.seq); // seq 单调不减（重连基线）
      this.trimLog(snap.seq);
      return false;
    }
    this.game.applySnapshotState({
      board: boardFromString(snap.board),
      active: snap.active,
      queue: [...snap.queue],
      hold: snap.hold,
      canHold: snap.canHold,
      score: snap.score,
      lines: snap.lines,
      level: snap.level,
      combo: snap.combo,
      b2bActive: snap.b2b,
      elapsedMs: snap.elapsedMs,
      softDrop: this.softOn,
    });
    this.seqCounter = Math.max(this.seqCounter, snap.seq);
    const unconfirmed = [...this.inputLog.entries()]
      .filter(([s]) => s > snap.seq)
      .sort((a, b) => a[0] - b[0]);
    for (const [, action] of unconfirmed) this.game.applyInput(action);
    this.trimLog(snap.seq);
    return true;
  }

  private trimLog(ackedSeq: number): void {
    for (const s of this.inputLog.keys()) {
      if (s <= ackedSeq) this.inputLog.delete(s);
    }
  }
}
