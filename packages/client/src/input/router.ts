// 输入路由（纯逻辑，技术设计 §5.6）：把 keyboard / touch / gesture 三个来源
// 合并成单一执行器状态，解决两类真实问题：
//   1. 触屏按住"←"时用妙控键盘按"→"，任一来源松手不能把另一来源的按住态取消；
//   2. 软降是持续态（game.soft），多来源按「或」合成，最后一个来源释放才关闭。

import type { GameAction } from '@bearbricks/shared';
import type { Dir, GameCommands } from './commands';

export type InputSource = 'keyboard' | 'touch' | 'gesture';

interface HeldDir {
  source: InputSource;
  dir: Dir;
}

export class InputRouter {
  /** 按按下顺序记录（末尾 = 最近按下，决定生效方向） */
  private held: HeldDir[] = [];
  private effective: Dir | null = null;
  private soft = new Set<InputSource>();
  private softApplied = false;

  constructor(private readonly target: () => GameCommands | null) {}

  get heldDirection(): Dir | null {
    return this.effective;
  }

  /** 执行器可能尚未就绪（effect 重建期）：未就绪时静默丢弃 */
  apply(action: GameAction): boolean {
    const t = this.target();
    if (!t) return false;
    t.apply(action);
    return true;
  }

  pressDirection(dir: Dir, source: InputSource): void {
    if (this.held.some((h) => h.source === source && h.dir === dir)) return;
    this.held.push({ source, dir });
    this.syncDirection();
  }

  releaseDirection(dir: Dir, source: InputSource): void {
    const i = this.held.findIndex((h) => h.source === source && h.dir === dir);
    if (i < 0) return;
    this.held.splice(i, 1);
    this.syncDirection();
  }

  setSoft(on: boolean, source: InputSource): void {
    if (on) this.soft.add(source);
    else this.soft.delete(source);
    this.syncSoft();
  }

  /** 释放某个来源的全部按住态（pointercancel / blur / 触控簇卸载） */
  releaseSource(source: InputSource): void {
    this.held = this.held.filter((h) => h.source !== source);
    this.soft.delete(source);
    this.syncDirection();
    this.syncSoft();
  }

  /**
   * 全释放（窗口失焦、页面切后台、设置面板打开、终局）：
   * 方向与软降都归零，避免"按键状态卡在按下"导致回前台后棋子自己下滑。
   */
  releaseAll(): void {
    this.held = [];
    this.soft.clear();
    const t = this.target();
    this.effective = null;
    if (t) {
      t.releaseDirection('L');
      t.releaseDirection('R');
    }
    this.syncSoft();
  }

  private syncDirection(): void {
    const next = this.held.length > 0 ? this.held[this.held.length - 1].dir : null;
    if (next === this.effective) return;
    this.effective = next;
    const t = this.target();
    if (!t) return;
    if (next) t.pressDirection(next);
    else {
      t.releaseDirection('L');
      t.releaseDirection('R');
    }
  }

  private syncSoft(): void {
    const want = this.soft.size > 0;
    if (want === this.softApplied) return;
    this.softApplied = want;
    this.target()?.setSoft(want);
  }
}
