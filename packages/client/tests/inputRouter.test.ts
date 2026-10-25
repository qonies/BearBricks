// InputRouter：键盘 / 触屏 / 手势 三源合并（技术设计 §5.6）
// 重点回归：多来源按住同一方向时互不取消、方向切换、软降「或」合成、全释放。

import { describe, expect, it } from 'vitest';
import type { GameAction } from '@bearbricks/shared';
import { InputRouter } from '../src/input/router';
import type { Dir } from '../src/input/commands';

class FakeCommands {
  readonly log: string[] = [];
  apply(action: GameAction): boolean {
    this.log.push(`apply:${action}`);
    return true;
  }
  pressDirection(dir: Dir): void {
    this.log.push(`press:${dir}`);
  }
  releaseDirection(dir: Dir): void {
    this.log.push(`release:${dir}`);
  }
  setSoft(on: boolean): void {
    this.log.push(`soft:${on}`);
  }
}

function setup(): { cmds: FakeCommands; router: InputRouter } {
  const cmds = new FakeCommands();
  return { cmds, router: new InputRouter(() => cmds) };
}

describe('InputRouter', () => {
  it('触屏按住后键盘再按同向：释放键盘不取消触屏的按住态', () => {
    const { cmds, router } = setup();
    router.pressDirection('L', 'touch');
    router.pressDirection('L', 'keyboard');
    expect(cmds.log).toEqual(['press:L']); // 同向重复按下不重复触发（不重置 DAS）
    router.releaseDirection('L', 'keyboard');
    expect(router.heldDirection).toBe('L');
    expect(cmds.log).toEqual(['press:L']);
    router.releaseDirection('L', 'touch');
    expect(router.heldDirection).toBeNull();
    expect(cmds.log).toEqual(['press:L', 'release:L', 'release:R']);
  });

  it('方向切换：最近按下者生效，释放后回退到仍按住的来源', () => {
    const { cmds, router } = setup();
    router.pressDirection('L', 'touch');
    router.pressDirection('R', 'keyboard');
    expect(router.heldDirection).toBe('R');
    router.releaseDirection('R', 'keyboard');
    expect(router.heldDirection).toBe('L');
    expect(cmds.log).toEqual(['press:L', 'press:R', 'press:L']);
  });

  it('软降多来源按「或」合成：最后一个来源释放才关闭', () => {
    const { cmds, router } = setup();
    router.setSoft(true, 'keyboard');
    router.setSoft(true, 'touch');
    router.setSoft(false, 'keyboard');
    expect(cmds.log).toEqual(['soft:true']);
    router.setSoft(false, 'touch');
    expect(cmds.log).toEqual(['soft:true', 'soft:false']);
  });

  it('releaseSource 只释放指定来源（pointercancel / blur 场景）', () => {
    const { cmds, router } = setup();
    router.pressDirection('R', 'touch');
    router.pressDirection('L', 'keyboard');
    router.setSoft(true, 'touch');
    router.releaseSource('touch');
    expect(router.heldDirection).toBe('L');
    expect(cmds.log).toEqual(['press:R', 'press:L', 'soft:true', 'soft:false']);
    router.releaseAll();
    expect(cmds.log).toContain('release:L');
    expect(cmds.log).toContain('release:R');
  });

  it('releaseAll 释放方向与软降，且清空按住态', () => {
    const { cmds, router } = setup();
    router.pressDirection('L', 'touch');
    router.setSoft(true, 'touch');
    router.releaseAll();
    expect(router.heldDirection).toBeNull();
    expect(cmds.log).toEqual(['press:L', 'soft:true', 'release:L', 'release:R', 'soft:false']);
  });

  it('执行器未就绪时静默丢弃（effect 重建窗口）', () => {
    const router = new InputRouter(() => null);
    expect(() => router.pressDirection('L', 'keyboard')).not.toThrow();
    expect(router.apply('hard')).toBe(false);
    expect(() => router.releaseAll()).not.toThrow();
  });
});
