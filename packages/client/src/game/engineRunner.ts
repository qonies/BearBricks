// 单人模式本地权威执行器（技术设计 §5.5）：rAF 固定 60Hz 步长 + DAS/ARR 调度

import { DAS_MS, ARR_MS, TetrisGame, type ActivePiece, type GameAction } from '@bearbricks/shared';
import { AutoShiftScheduler, type Dir } from './autoshift';

const STEP_MS = 1000 / 60;

export type LocalMode = 'marathon' | 'sprint';

export class EngineRunner {
  readonly game: TetrisGame;
  paused = false;
  private scheduler: AutoShiftScheduler;
  onFinish?: () => void;

  private acc = 0;
  private lastTs = 0;
  private lastActiveForLatch: ActivePiece | null = null;
  private rafId = 0;
  private running = false;

  constructor(mode: LocalMode, opts?: { das?: number; arr?: number }) {
    this.game = new TetrisGame({
      mode,
      targetLines: mode === 'sprint' ? 40 : undefined,
      seed: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    });
    this.scheduler = new AutoShiftScheduler(
      (dir) => this.apply(dir === 'L' ? 'moveL' : 'moveR'),
      opts?.das ?? DAS_MS,
      opts?.arr ?? ARR_MS,
    );
  }

  setTiming(das: number, arr: number): void {
    this.scheduler.setTiming(das, arr);
  }

  start(onFrame: () => void): void {
    if (this.running) return;
    this.running = true;
    this.lastTs = performance.now();
    const loop = (ts: number): void => {
      const dt = Math.max(0, Math.min(ts - this.lastTs, 250));
      this.lastTs = ts;
      if (this.game.active !== this.lastActiveForLatch) {
        this.lastActiveForLatch = this.game.active;
        this.scheduler.resetWallLatch();
      }
      if (!this.paused) {
        this.scheduler.update(dt);
        this.acc += dt;
        while (this.acc >= STEP_MS) {
          this.game.update(STEP_MS);
          this.acc -= STEP_MS;
        }
      }
      onFrame();
      if (this.game.status === 'finished') {
        this.running = false;
        this.onFinish?.();
        return;
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.running = false;
  }

  apply(action: GameAction): boolean {
    return this.game.applyInput(action);
  }

  pressDirection(dir: Dir): void {
    this.scheduler.press(dir);
  }

  releaseDirection(dir: Dir): void {
    this.scheduler.release(dir);
  }

  setSoftDrop(on: boolean): void {
    this.game.setSoftDrop(on);
  }

  /** GameCommands 接口别名（键盘/触控/手势统一走 setSoft） */
  setSoft(on: boolean): void {
    this.setSoftDrop(on);
  }

  /** 释放所有按住态（失焦/切后台/关闭设置面板） */
  releaseAll(): void {
    this.scheduler.releaseAll();
  }
}
