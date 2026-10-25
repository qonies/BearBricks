// 键位映射（FR-5.2 改键 / 技术设计 §5.6）：归一化、查表、冲突改绑、展示名

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYMAP,
  assignKey,
  buildKeyIndex,
  cloneKeymap,
  findKeyOwner,
  keyLabel,
  keymapLabel,
  normalizeKey,
} from '../src/input/keymap';

describe('keymap', () => {
  it('默认键位索引：方向 / 硬降 / 旋转 / 暂停', () => {
    const index = buildKeyIndex(DEFAULT_KEYMAP);
    expect(index.get('ArrowLeft')).toBe('moveL');
    expect(index.get('ArrowRight')).toBe('moveR');
    expect(index.get(' ')).toBe('hard');
    expect(index.get('x')).toBe('rotCW');
    expect(index.get('Control')).toBe('rotCCW');
    expect(index.get('Escape')).toBe('pause');
  });

  it('单字符键名大小写归一，修饰键/方向键原样保留', () => {
    expect(normalizeKey('X')).toBe('x');
    expect(normalizeKey('C')).toBe('c');
    expect(normalizeKey(' ')).toBe(' ');
    expect(normalizeKey('ArrowUp')).toBe('ArrowUp');
    expect(normalizeKey('Control')).toBe('Control');
  });

  it('大写输入同样命中默认键位（KeyboardEvent.key 可能是 X）', () => {
    const index = buildKeyIndex(DEFAULT_KEYMAP);
    expect(index.get(normalizeKey('X'))).toBe('rotCW');
  });

  it('assignKey 从其它动作移除同键并写入目标动作', () => {
    const next = assignKey(DEFAULT_KEYMAP, 'hold', 'x');
    expect(next.hold).toContain('x');
    expect(next.rotCW).not.toContain('x');
    expect(next.rotCW).toContain('ArrowUp'); // 其它键保留
    expect(DEFAULT_KEYMAP.rotCW).toContain('x'); // 原对象不被修改
  });

  it('findKeyOwner 返回占用动作，未占用返回 null', () => {
    expect(findKeyOwner(DEFAULT_KEYMAP, 'c')).toBe('hold');
    expect(findKeyOwner(DEFAULT_KEYMAP, 'X')).toBe('rotCW');
    expect(findKeyOwner(DEFAULT_KEYMAP, 'q')).toBeNull();
  });

  it('keyLabel / keymapLabel 生成可读标签', () => {
    expect(keyLabel(' ')).toBe('Space');
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('Escape')).toBe('Esc');
    expect(keymapLabel(DEFAULT_KEYMAP, 'hold')).toBe('Shift / C');
  });

  it('cloneKeymap 深拷贝数组，修改副本不影响默认值', () => {
    const copy = cloneKeymap();
    copy.hold.push('q');
    expect(DEFAULT_KEYMAP.hold).not.toContain('q');
  });
});
