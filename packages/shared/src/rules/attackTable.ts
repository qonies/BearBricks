// 攻击表（requirements.md §4.3，ADR-0004）：survival / timed 使用，sprint 返回 0

import type { TSpinKind } from '../engine/score';

export interface AttackInput {
  lines: number;
  tspin: TSpinKind;
  /** 连续消行第 n 连 */
  combo: number;
  b2b: boolean;
  perfectClear: boolean;
}

export function calcAttack(inp: AttackInput): number {
  let base: number;
  if (inp.tspin === 'normal') {
    base = [0, 2, 4, 6][inp.lines] ?? 0;
  } else if (inp.tspin === 'mini') {
    base = inp.lines >= 1 ? 1 : 0;
  } else {
    base = [0, 0, 1, 2, 4][inp.lines] ?? 0;
  }
  if (base > 0 && inp.b2b) base = Math.ceil(base * 1.5);
  // Combo：第 2 连起每连 +1，上限 +5
  const comboBonus = inp.combo >= 2 ? Math.min(5, inp.combo - 1) : 0;
  let attack = base + comboBonus;
  if (inp.perfectClear) attack += 10;
  return attack;
}
