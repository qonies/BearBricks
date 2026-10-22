// timed 限时赛排名（ADR-0004 / requirements §4.4）
// 排名依据：总分 → 消行数 → 顶出次数（越少越靠前）；同分同消行同顶出 → 并列；
// abandoned（FR-10.3 宽限超时/主动放弃）移出排名（与 sprint 口径一致，protocol §3）

export interface TimedRankEntry {
  seatId: number;
  score: number;
  lines: number;
  topOuts: number;
  abandoned?: boolean;
}

/** 返回 seatId → rank（1 起；abandoned 不在结果中；完全同分同消行同顶出并列） */
export function computeTimedRanking(entries: TimedRankEntry[]): Map<number, number> {
  const ranked = entries.filter((e) => !e.abandoned);
  const sorted = [...ranked].sort(
    (a, b) =>
      b.score - a.score ||
      b.lines - a.lines ||
      a.topOuts - b.topOuts ||
      a.seatId - b.seatId,
  );
  const ranks = new Map<number, number>();
  let lastKey: string | null = null;
  let lastRank = 0;
  sorted.forEach((e, i) => {
    const key = `${e.score}|${e.lines}|${e.topOuts}`;
    const rank = key === lastKey ? lastRank : i + 1;
    ranks.set(e.seatId, rank);
    lastKey = key;
    lastRank = rank;
  });
  return ranks;
}