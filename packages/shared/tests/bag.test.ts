// TC-ENG-003：7-bag 分布、可复现性、同袋不重复

import { describe, expect, it } from 'vitest';
import { Rng } from '../src/engine/rng';
import { SevenBag } from '../src/engine/bag';
import { PIECE_TYPES } from '../src/engine/srs';

describe('7-bag', () => {
  it('连续 70 块每种方块恰 10 次', () => {
    const bag = new SevenBag(new Rng('bag-seed'));
    const seq: string[] = [];
    for (let i = 0; i < 70; i++) seq.push(bag.next());
    for (const t of PIECE_TYPES) {
      expect(seq.filter((s) => s === t)).toHaveLength(10);
    }
  });

  it('同一 seed 序列完全可复现', () => {
    const draw = (): string[] => {
      const bag = new SevenBag(new Rng('deterministic'));
      const out: string[] = [];
      for (let i = 0; i < 140; i++) out.push(bag.next());
      return out;
    };
    expect(draw()).toEqual(draw());
  });

  it('每 7 块恰好为 7 种各一次', () => {
    const bag = new SevenBag(new Rng('per-bag'));
    for (let b = 0; b < 10; b++) {
      const set = new Set<string>();
      for (let i = 0; i < 7; i++) set.add(bag.next());
      expect(set.size).toBe(7);
    }
  });
});
