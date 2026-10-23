// 临时调参脚本（M5）：观察三难度在不同 tick 预算下的批量对局数据
import { simulateBotGame } from '../src/ai/bot';

const seeds = Array.from({ length: 12 }, (_, i) => `tc-bot-001-${i}`);
for (const mt of [4000, 6000, 10000, 20000]) {
  for (const d of ['EASY', 'NORMAL', 'HARD'] as const) {
    const rs = seeds.map((s) => simulateBotGame({ seed: s, difficulty: d, maxTicks: mt }));
    const avgL = rs.reduce((a, r) => a + r.lines, 0) / rs.length;
    const avgP = rs.reduce((a, r) => a + r.pieces, 0) / rs.length;
    const to = rs.filter((r) => r.topOut).length;
    console.log(d.padEnd(7), 'maxTicks', mt, 'avgLines', avgL.toFixed(1), 'avgPieces', avgP.toFixed(1), 'topOuts', to);
  }
}
