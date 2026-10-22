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
  type GameStatus,
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
  /** 时钟源（可注入服务器校正时钟）：timed 冻结窗口以服务器 epoch 为基准 */
  now: () => number = () => Date.now();
  /** timed：复活倒计时冻结截止（epoch ms）；期间不推进引擎、不上行输入 */
  private freezeUntilMs: number | null = null;
  /** timed：当前生效的复活事件（respawnAt），用于识别新一次顶出复活 */
  private activeRespawnAt: number | null = null;

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

  /** timed 复活同步（M4）：快照 modeState.timed 驱动 —— respawnAt 出现 = 新一次顶出复活
   *  （本地引擎同步 respawn 并冻结输入至 respawnAt）；respawnAt 消失 = 倒计时结束恢复对局 */
  syncTimed(t: { respawnAt?: number } | null): void {
    const respawnAt = t?.respawnAt ?? null;
    if (respawnAt != null) {
      if (this.activeRespawnAt == null) {
        // 复活等待期服务端静默丢弃输入：清空未确认日志，避免重放陈旧输入污染新棋盘；
        // 服务端同时清了 softDrop（顶出处置），本地保持一致（松键后重新生效）
        this.inputLog.clear();
        this.game.respawn();
        this.setSoft(false);
      }
      this.activeRespawnAt = respawnAt;
      this.freezeUntilMs = respawnAt;
    } else if (this.activeRespawnAt != null) {
      this.activeRespawnAt = null;
      this.freezeUntilMs = null;
    }
  }

  /** timed 冻结判定：倒计时截止前不推进引擎（与服务器冻结窗口对齐） */
  private frozen(): boolean {
    if (this.freezeUntilMs == null) return false;
    if (this.now() >= this.freezeUntilMs) {
      this.freezeUntilMs = null;
      return false;
    }
    return true;
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
      if (!this.paused && !this.frozen()) {
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

  /** 本地应用 + 记录 seq + 上行回调；终局/暂停/复活冻结期间不再产生输入（防 E4031 轰炸） */
  private dispatch(action: GameAction): boolean {
    if (this.paused || this.frozen() || this.game.status !== 'running') return false;
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
      this.applyServerStatus(snap);
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
      status: this.serverStatusToEngine(snap),
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

  /**
   * 服务端座位状态 → 引擎 status：权威说"仍在进行"而本地已预测顶出 → 必须恢复 running
   * （快照不含足以重建顶出的信息，乐观渲染校正无法自行解除 finished，否则客户端永久卡死）；
   * 淘汰/放弃/完赛 → finished（本地停引擎、停输入，进入观战/终局显示）。
   */
  private serverStatusToEngine(snap: SelfSnapshot): GameStatus | undefined {
    if (snap.status == null) return undefined;
    return snap.status === 'playing' ? 'running' : 'finished';
  }

  /** hash 一致时也同步座位状态（本地预测顶出但权威仍在打的场景不改变 hash） */
  private applyServerStatus(snap: SelfSnapshot): void {
    const status = this.serverStatusToEngine(snap);
    if (status != null && this.game.status !== status) {
      this.game.applySnapshotState({
        board: this.game.board,
        active: this.game.active,
        queue: this.game.queue,
        hold: this.game.hold,
        canHold: this.game.canHold,
        score: this.game.score,
        lines: this.game.lines,
        level: this.game.level,
        combo: this.game.combo,
        b2bActive: this.game.b2bActive,
        elapsedMs: this.game.elapsedMs,
        status,
        softDrop: this.softOn,
      });
    }
  }

  private trimLog(ackedSeq: number): void {
    for (const s of this.inputLog.keys()) {
      if (s <= ackedSeq) this.inputLog.delete(s);
    }
  }
}
