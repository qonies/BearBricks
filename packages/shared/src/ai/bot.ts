// M5 BotController（技术设计 §6，requirements FR-4.1/4.2）：服务端 AI 落点评估
// 纯 TS、确定性（误操作 RNG 由座位 seed 派生）；AI 不直接改棋盘，
// 每 tick 经 decide() 产出 ≤1 个 GameAction，由 Room 走与真人相同的 game.applyInput 通道执行。

import { BOARD_WIDTH, TOTAL_HEIGHT } from '../rules/constants';
import type { Difficulty } from '../protocol/messages';
import {
  clearLines,
  collides,
  dropDistance,
  mergePiece,
  type Board,
} from '../engine/board';
import { pieceCells, SPAWN_Y, type PieceType, type Rotation } from '../engine/srs';
import { TetrisGame, type ActivePiece, type GameAction } from '../engine/game';
import { Rng } from '../engine/rng';

/** Bot 每 tick 被调用一次（60Hz 权威步长） */
const BOT_STEP_MS = 1000 / 60;
/** Hold 换块收益阈值：Hold 块最优代价需优于当前块最优该值以上才值得换 */
const HOLD_MARGIN = 0.3;
/** 计划推进卡住（踢墙失败/目标被垃圾行堵死）多少 tick 后放弃计划兜底硬降 */
const STUCK_TICKS_LIMIT = 3;

export interface BotDifficultyParams {
  /** 新块出现后的思考延迟（ms），期间不产生输入 */
  thinkDelayMs: number;
  /** 误操作率：以该概率放弃最优解（EASY 全候选随机 / NORMAL 取次优） */
  mistakeRate: number;
}

/** 难度参数（技术设计 §6） */
export const BOT_DIFFICULTY_PARAMS: Record<Difficulty, BotDifficultyParams> = {
  EASY: { thinkDelayMs: 300, mistakeRate: 0.15 },
  NORMAL: { thinkDelayMs: 150, mistakeRate: 0.05 },
  HARD: { thinkDelayMs: 60, mistakeRate: 0 },
};

/** 启发式权重（经典调优组合，TC-BOT-001 批量对局回归验证） */
export const BOT_WEIGHTS = {
  aggregateHeight: 0.510066,
  holes: 0.35663,
  bumpiness: 0.184483,
  wells: 0.1,
  linesCleared: 0.760666,
  /** 攻击模式（survival/timed）下 4 消（Tetris）额外奖励：HARD 保留 Tetris 压制（技术设计 §6） */
  tetrisBonus: 0.8,
} as const;

export interface BoardFeatures {
  aggregateHeight: number;
  holes: number;
  bumpiness: number;
  wells: number;
}

/** 棋盘启发式特征（对模拟硬降后的副本棋盘计算） */
export function evaluateBoard(board: Board): BoardFeatures {
  const heights = new Array<number>(BOARD_WIDTH).fill(0);
  for (let c = 0; c < BOARD_WIDTH; c++) {
    for (let r = 0; r < TOTAL_HEIGHT; r++) {
      if (board[r * BOARD_WIDTH + c] !== null) {
        heights[c] = TOTAL_HEIGHT - r;
        break;
      }
    }
  }
  let aggregateHeight = 0;
  let bumpiness = 0;
  for (let c = 0; c < BOARD_WIDTH; c++) {
    aggregateHeight += heights[c];
    if (c > 0) bumpiness += Math.abs(heights[c] - heights[c - 1]);
  }
  // 空洞：同列上方存在方块的空格
  let holes = 0;
  for (let c = 0; c < BOARD_WIDTH; c++) {
    let covered = false;
    for (let r = 0; r < TOTAL_HEIGHT; r++) {
      if (board[r * BOARD_WIDTH + c] !== null) covered = true;
      else if (covered) holes++;
    }
  }
  // 累计井深：两侧均为墙/方块的连续空列，深度 1+2+...+n 计（井越深补齐代价越大）
  let wells = 0;
  for (let c = 0; c < BOARD_WIDTH; c++) {
    let depth = 0;
    for (let r = 0; r < TOTAL_HEIGHT; r++) {
      const idx = r * BOARD_WIDTH + c;
      const leftBlocked = c === 0 || board[idx - 1] !== null;
      const rightBlocked = c === BOARD_WIDTH - 1 || board[idx + 1] !== null;
      if (board[idx] === null && leftBlocked && rightBlocked) depth++;
      else depth = 0;
      wells += depth;
    }
  }
  return { aggregateHeight, holes, bumpiness, wells };
}

export interface Placement {
  rot: Rotation;
  x: number;
  /** 评估代价（越小越优） */
  cost: number;
  /** 该落点硬降锁定后的消行数 */
  lines: number;
}

/**
 * 枚举某方块在棋盘上的全部合法硬降落点（旋转 × 列），模拟硬降 + 消行后按启发式评分，
 * 返回按代价升序排列的候选列表。无任何合法落点（堆到顶）时返回空数组。
 */
export function enumeratePlacements(
  board: Board,
  type: PieceType,
  attackMode: boolean,
): Placement[] {
  const out: Placement[] = [];
  const seen = new Set<string>();
  for (let rot = 0 as Rotation; rot < 4; rot = (rot + 1) as Rotation) {
    const cells = pieceCells(type, rot);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let shape = '';
    for (const [cx, cy] of cells) {
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      shape += `${cx},${cy};`;
    }
    for (let x = -minX; x + maxX < BOARD_WIDTH; x++) {
      // 同一形态同一列只评估一次（O 块四旋转同形 / I 块 0、2 同形）
      const key = `${shape}|${x}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (collides(board, cells, x, SPAWN_Y)) continue; // 出生位即碰撞：该列不可用
      const d = dropDistance(board, cells, x, SPAWN_Y);
      const sim = board.slice();
      mergePiece(sim, type, cells, x, SPAWN_Y + d);
      const lines = clearLines(sim);
      const f = evaluateBoard(sim);
      let cost =
        BOT_WEIGHTS.aggregateHeight * f.aggregateHeight +
        BOT_WEIGHTS.holes * f.holes +
        BOT_WEIGHTS.bumpiness * f.bumpiness +
        BOT_WEIGHTS.wells * f.wells -
        BOT_WEIGHTS.linesCleared * lines;
      if (attackMode && lines >= 4) cost -= BOT_WEIGHTS.tetrisBonus;
      out.push({ rot, x, cost, lines });
    }
  }
  out.sort((a, b) => a.cost - b.cost);
  return out;
}

type Plan = { kind: 'hold' } | { kind: 'place'; rot: Rotation; x: number };

export interface BotOptions {
  /** 误操作决策 RNG（服务端按 `${seed}:bot` 派生，同 seed 同输入序列可复现） */
  rng?: Rng;
  /** 攻击模式（survival/timed）：评估时对 4 消追加奖励 */
  attackMode?: boolean;
}

/**
 * 单座位 Bot 控制器。生命周期 = 一局（beginGame 创建，rematch/开局重置）。
 * decide() 按权威 tick（60Hz）调用一次：新块先进入思考延迟，随后产出
 * 旋转/平移/硬降/Hold 动作（每 tick 一个，与真人输入节奏一致）。
 */
export class BotController {
  readonly difficulty: Difficulty;
  private readonly params: BotDifficultyParams;
  private readonly rng: Rng | null;
  private readonly attackMode: boolean;
  /** 当前计划；null = 待规划 */
  private plan: Plan | null = null;
  /** 规划对应的 active 对象身份（引擎每块新建对象，身份变化即新块） */
  private plannedPiece: ActivePiece | null = null;
  private thinkTicks = 0;
  private lastX: number | null = null;
  private lastRot: Rotation | null = null;
  private stuckTicks = 0;

  constructor(difficulty: Difficulty, opts: BotOptions = {}) {
    this.difficulty = difficulty;
    this.params = BOT_DIFFICULTY_PARAMS[difficulty];
    this.rng = opts.rng ?? null;
    this.attackMode = opts.attackMode ?? false;
  }

  /** 权威 tick 驱动：返回本 tick 应执行的动作（Room 层负责 game.applyInput），null = 思考/等待 */
  decide(game: TetrisGame): GameAction | null {
    if (game.status !== 'running' || !game.active) return null;
    const active = game.active;
    if (active !== this.plannedPiece) {
      // 新块（出生 / Hold 换块 / sprint 顶出清盘 / timed 复活）：重置思考与计划
      this.plannedPiece = active;
      this.plan = null;
      this.thinkTicks = Math.round(this.params.thinkDelayMs / BOT_STEP_MS);
      this.lastX = null;
      this.lastRot = null;
      this.stuckTicks = 0;
      return null;
    }
    if (this.thinkTicks > 0) {
      this.thinkTicks--;
      return null;
    }
    if (this.plan === null) {
      this.plan = this.choosePlan(game);
      if (this.plan === null) return 'hard'; // 无合法落点：兜底硬降，由引擎判定顶出
    }
    if (this.plan.kind === 'hold') {
      this.plan = null; // 换块后 active 身份变化，下一 tick 自动重新规划
      return 'hold';
    }
    if (active.rot !== this.plan.rot) return this.guardStuck(active, 'rotCW');
    if (active.x !== this.plan.x)
      return this.guardStuck(active, active.x < this.plan.x ? 'moveR' : 'moveL');
    this.plan = null; // 已就位：硬降锁定
    return 'hard';
  }

  /** 生成计划：当前块候选 + Hold 权衡 + 误操作率扰动 */
  private choosePlan(game: TetrisGame): Plan | null {
    const active = game.active as ActivePiece;
    const candidates = enumeratePlacements(game.board, active.type, this.attackMode);
    if (candidates.length === 0) return null;
    // Hold 权衡（技术设计 §6）：Hold/队列首块的最优解显著更优时先换块
    if (game.canHold) {
      const swapType: PieceType | undefined = game.hold ?? game.queue[0];
      if (swapType && swapType !== active.type) {
        const swapCandidates = enumeratePlacements(game.board, swapType, this.attackMode);
        if (swapCandidates.length > 0 && candidates[0].cost - swapCandidates[0].cost > HOLD_MARGIN)
          return { kind: 'hold' };
      }
    }
    const chosen = this.applyMistake(candidates);
    return { kind: 'place', rot: chosen.rot, x: chosen.x };
  }

  /** 误操作（技术设计 §6 难度参数）：EASY 全候选随机，NORMAL 取次优 */
  private applyMistake(candidates: Placement[]): Placement {
    const rate = this.params.mistakeRate;
    if (this.rng !== null && rate > 0 && this.rng.next() < rate) {
      if (this.difficulty === 'EASY')
        return candidates[Math.floor(this.rng.next() * candidates.length)];
      return candidates[Math.min(1, candidates.length - 1)];
    }
    return candidates[0];
  }

  /**
   * 推进卡住保护：踢墙旋转失败 / 垃圾行插入后目标不可达时，x 与 rot 连续多 tick 不变
   * → 放弃当前计划，兜底硬降（下一块重新规划），保证 bot 永不挂死。
   */
  private guardStuck(active: ActivePiece, action: GameAction): GameAction {
    if (active.x === this.lastX && active.rot === this.lastRot) {
      this.stuckTicks++;
      if (this.stuckTicks >= STUCK_TICKS_LIMIT) {
        this.plan = null;
        this.stuckTicks = 0;
        return 'hard';
      }
    } else {
      this.stuckTicks = 0;
    }
    this.lastX = active.x;
    this.lastRot = active.rot;
    return action;
  }
}

export interface BotGameStats {
  lines: number;
  score: number;
  pieces: number;
  ticks: number;
  topOut: boolean;
}

/**
 * 无头对局模拟（TC-BOT-001 批量回归 / 权重调参用）：
 * 用 BotController 驱动一局 marathon 至顶出终局或步数上限，返回战绩。
 * 与服务端同构：每 tick 先 decide → applyInput，无动作时推进引擎重力。
 */
export function simulateBotGame(config: {
  seed: string;
  difficulty: Difficulty;
  attackMode?: boolean;
  maxTicks?: number;
}): BotGameStats {
  const game = new TetrisGame({ mode: 'marathon', seed: config.seed });
  const bot = new BotController(config.difficulty, {
    rng: new Rng(`${config.seed}:bot`),
    attackMode: config.attackMode ?? false,
  });
  const maxTicks = config.maxTicks ?? 60_000;
  let pieces = 0;
  let ticks = 0;
  let lastPiece: ActivePiece | null = null;
  while (game.status === 'running' && ticks < maxTicks) {
    if (game.active !== lastPiece) {
      lastPiece = game.active;
      pieces++;
    }
    const action = bot.decide(game);
    if (action) game.applyInput(action);
    else game.update(BOT_STEP_MS);
    ticks++;
  }
  return {
    lines: game.lines,
    score: game.score,
    pieces,
    ticks,
    topOut: game.topOut,
  };
}

