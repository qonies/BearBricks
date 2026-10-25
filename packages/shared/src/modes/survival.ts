// survival 生存淘汰排名（ADR-0004 / requirements §4.4）
// 存活者并列第 1；淘汰者按淘汰时刻降序（越晚淘汰名次越高），同刻并列；
// abandoned（主动离开/宽限超时判淘汰；服务端 `rankBottom` 映射到本字段）视为最晚淘汰，垫底并列

export interface SurvivalRankEntry {
  seatId: number;
  /** 淘汰时刻（对局开始起 ms）；null = 游戏结束时仍存活 */
  eliminatedAtMs: number | null;
  /** 主动离开/宽限超时判淘汰：垫底并列（不阻止迟到 resume 观战） */
  abandoned: boolean;
}

/** 返回 seatId → rank（1 起；存活者并列第 1，淘汰者按淘汰顺序倒序） */
export function computeSurvivalRanking(entries: SurvivalRankEntry[]): Map<number, number> {
  const alive = entries.filter((e) => !e.abandoned && e.eliminatedAtMs == null);
  const ranks = new Map<number, number>();
  alive.forEach((e) => ranks.set(e.seatId, 1));
  const eliminated = entries
    .filter((e) => e.abandoned || e.eliminatedAtMs != null)
    .sort((a, b) => {
      // 淘汰时刻降序（越晚名次越高）；abandoned 判淘汰垫底（FR-10.3）
      const at = a.abandoned ? -1 : (a.eliminatedAtMs as number);
      const bt = b.abandoned ? -1 : (b.eliminatedAtMs as number);
      return bt - at;
    });
  let lastKey: string | null = null;
  let lastRank = 0;
  eliminated.forEach((e, i) => {
    const key = e.abandoned ? 'abandoned' : `t${e.eliminatedAtMs}`;
    const rank = key === lastKey ? lastRank : alive.length + i + 1;
    ranks.set(e.seatId, rank);
    lastKey = key;
    lastRank = rank;
  });
  return ranks;
}