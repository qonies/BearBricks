// sprint 竞速赛排名（ADR-0004 / requirements §4.4）
// 完赛（finishTimeMs != null）按时间升序；未完赛按已清行数降序；放弃者移出排名；
// 平局并列名次（同一时间/同一行数 → 同 rank）

export interface SprintRankEntry {
  seatId: number;
  finishTimeMs: number | null;
  lines: number;
  abandoned: boolean;
}

/** 返回 seatId → rank（1 起；abandoned 不在结果中） */
export function computeSprintRanking(entries: SprintRankEntry[]): Map<number, number> {
  const ranked = entries.filter((e) => !e.abandoned);
  const sorted = [...ranked].sort((a, b) => {
    const aFinished = a.finishTimeMs != null;
    const bFinished = b.finishTimeMs != null;
    if (aFinished !== bFinished) return aFinished ? -1 : 1;
    if (aFinished && bFinished) return (a.finishTimeMs as number) - (b.finishTimeMs as number);
    return b.lines - a.lines;
  });
  const ranks = new Map<number, number>();
  let lastKey: string | null = null;
  let lastRank = 0;
  sorted.forEach((e, i) => {
    const key = e.finishTimeMs != null ? `t${e.finishTimeMs}` : `l${e.lines}`;
    const rank = key === lastKey ? lastRank : i + 1;
    ranks.set(e.seatId, rank);
    lastKey = key;
    lastRank = rank;
  });
  return ranks;
}