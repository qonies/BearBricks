// 游戏引擎核心：确定性 TetrisGame（同一 seed + 同一输入序列 = 同一结果，ADR-0002）
// 双端复用：客户端单人模式本地权威（技术设计 §5.5）、服务端权威模拟与 AI（M2+）

import {
  HIDDEN_ROWS,
  LINES_PER_LEVEL,
  LOCK_DELAY_MS,
  MAX_LOCK_RESETS,
  SOFT_DROP_FACTOR,
  SPRINT_TIMEOUT_MS,
  gravitySecondsPerLine,
} from '../rules/constants';
import { Rng } from './rng';
import { SevenBag } from './bag';
import { SPAWN_X, SPAWN_Y, kicksFor, pieceCells, type PieceType, type Rotation } from './srs';
import {
  boardToString,
  clearLines,
  collides,
  createBoard,
  dropDistance,
  findFullRows,
  insertGarbage,
  isBoardEmpty,
  mergePiece,
  type Board,
} from './board';
import { detectTSpin, scoreClear, type TSpinKind } from './score';

export type GameAction = 'moveL' | 'moveR' | 'rotCW' | 'rotCCW' | 'soft' | 'hard' | 'hold';
export type GameMode = 'marathon' | 'sprint';
export type GameStatus = 'running' | 'finished';

export interface GameConfig {
  mode: GameMode;
  /** sprint 目标行数（20/40，默认 40） */
  targetLines?: number;
  seed?: string | number;
}

export interface ActivePiece {
  type: PieceType;
  x: number;
  y: number;
  rot: Rotation;
}

export interface LastClear {
  lines: number;
  tspin: TSpinKind;
  points: number;
  b2b: boolean;
  combo: number;
  perfectClear: boolean;
}

/**
 * 消行视觉数据（客户端"闪烁三次后消失"动画的数据源）：纯视觉，不进 stateHash、
 * 不进协议快照，也不参与攻击/垃圾行判定——服务端权威时序不受影响。
 */
export interface ClearVisual {
  /** 单调递增的事件 id（客户端据此识别"新的一次消行"） */
  id: number;
  /** 被消除的行号（消行前坐标，升序） */
  rows: number[];
  /** 消行前的棋盘快照（含待闪烁行），动画期间直接绘制 */
  board: Board;
}

export interface GameState {
  board: Board;
  active: ActivePiece | null;
  queue: PieceType[];
  hold: PieceType | null;
  canHold: boolean;
  score: number;
  lines: number;
  /** 从队列取块的累计次数（快照/重连时用于对齐 7-bag 游标） */
  spawnCount: number;
  level: number;
  combo: number;
  b2bActive: boolean;
  status: GameStatus;
  elapsedMs: number;
  finishTimeMs: number | null;
  topOut: boolean;
  lastClear: LastClear | null;
}

function defaultSeed(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class TetrisGame {
  readonly mode: GameMode;
  readonly targetLines: number;
  board: Board;
  active: ActivePiece | null = null;
  queue: PieceType[] = [];
  hold: PieceType | null = null;
  canHold = true;
  score = 0;
  lines = 0;
  level = 1;
  combo = 0;
  b2bActive = false;
  status: GameStatus = 'running';
  elapsedMs = 0;
  finishTimeMs: number | null = null;
  topOut = false;
  lastClear: LastClear | null = null;
  /** 从队列取块的累计次数（v1.7：7-bag 对齐；lock/新块/Hold 取新块时 +1） */
  spawnCount = 0;
  /** 消行视觉数据（客户端动画用；服务端只是顺带持有，不参与任何判定） */
  clearVisual: ClearVisual | null = null;

  private bag: SevenBag;
  /** 原始 seed（applySnapshotState 重对齐 7-bag 用） */
  private readonly seed: string;
  /** 待结算消行队列：同一 tick 内多次锁定按顺序逐个结算，避免攻击被后一次锁定覆盖 */
  private clears: LastClear[] = [];
  /** clearVisual.id 计数器（单调递增，重开/复活/快照校正都不回退） */
  private clearSeq = 0;
  private gravityAcc = 0;
  private lockTimer = 0;
  private lockResets = 0;
  private lowestY = SPAWN_Y;
  private softDrop = false;
  private lastActionRotation = false;

  constructor(config: GameConfig) {
    this.mode = config.mode;
    this.targetLines = config.mode === 'sprint' ? (config.targetLines ?? 40) : 0;
    this.board = createBoard();
    this.seed = String(config.seed ?? defaultSeed());
    this.bag = new SevenBag(new Rng(this.seed));
    this.fillQueue();
    this.spawnActive();
  }

  /** 固定步长驱动（客户端 60Hz / 服务端权威 tick），dt 单位 ms */
  update(dt: number): void {
    if (this.status !== 'running') return;
    this.elapsedMs += dt;
    if (this.mode === 'sprint' && this.elapsedMs >= SPRINT_TIMEOUT_MS) {
      this.status = 'finished';
      return;
    }
    const a = this.active;
    if (!a) return;
    const interval =
      (gravitySecondsPerLine(this.level) * 1000) / (this.softDrop ? SOFT_DROP_FACTOR : 1);
    this.gravityAcc += dt;
    while (this.gravityAcc >= interval) {
      this.gravityAcc -= interval;
      if (!this.tryShift(0, 1)) break;
      if (this.softDrop) this.score += 1;
    }
    if (!this.active) return;
    const cur = this.active;
    if (collides(this.board, pieceCells(cur.type, cur.rot), cur.x, cur.y + 1)) {
      this.lockTimer += dt;
      if (this.lockTimer >= LOCK_DELAY_MS) this.lock();
    } else {
      this.lockTimer = 0;
    }
  }

  /** 输入动作（与协议 §4 game.input 同名）；soft 为持续态，通常走 setSoftDrop */
  applyInput(action: GameAction): boolean {
    if (this.status !== 'running' || !this.active) return false;
    switch (action) {
      case 'moveL':
        return this.tryHorizontal(-1);
      case 'moveR':
        return this.tryHorizontal(1);
      case 'rotCW':
        return this.tryRotate(1);
      case 'rotCCW':
        return this.tryRotate(-1);
      case 'hard':
        return this.hardDrop();
      case 'hold':
        return this.holdSwap();
      case 'soft': {
        // 与 update() 的持续软降同分：每成功下移一格 +1（requirements §4.2）
        const moved = this.tryShift(0, 1);
        if (moved) this.score += 1;
        return moved;
      }
    }
  }

  setSoftDrop(on: boolean): void {
    this.softDrop = on;
  }

  /**
   * 取出并清空待结算的消行（Room 层每次锁定只结算一次攻击，防止重复计攻）。
   * 队列优先：同一 tick 内多次锁定（输入积压 / game.inputBatch / 补帧）的消行按发生顺序
   * 逐个返回，不会因为后一次"无消行锁定"把前一次的攻击冲掉；队列为空时回退到外部
   * 手工赋值的 lastClear（测试/工具用途）。
   */
  takeLastClear(): LastClear | null {
    const queued = this.clears.shift();
    if (queued) {
      this.lastClear = this.clears.length > 0 ? (this.clears[this.clears.length - 1] as LastClear) : null;
      return queued;
    }
    const lc = this.lastClear;
    this.lastClear = null;
    return lc;
  }

  /** 外部修改棋盘（Room 层插入垃圾行）后调用：active 与棋盘冲突则按模式顶出处置 */
  validateActiveAfterBoardChange(): void {
    if (this.status !== 'running') return;
    const a = this.active;
    if (!a) return;
    if (collides(this.board, pieceCells(a.type, a.rot), a.x, a.y)) this.handleTopOut();
  }

  /**
   * survival：接收垃圾行（Room 层到期批量插入）。
   * 棋盘整体上移 rows 行，当前方块随之一起上移（Guideline：垃圾行推着 active 上升），
   * 上移后立即校验 active——与棋盘冲突（被挤压）→ 按模式顶出处置。
   */
  receiveGarbage(rows: number, holeCol: number): void {
    if (this.status !== 'running' || rows <= 0) return;
    // 顶部方块被挤出棋盘 = 溢出（Guideline：堆叠被垃圾推出场地上界）→ 按模式顶出处置，
    // 不能静默丢弃方块（否则垃圾可以"吃掉"对手顶部堆叠而不判负）
    const overflow = insertGarbage(this.board, rows, holeCol);
    if (overflow) {
      this.handleTopOut();
      return;
    }
    if (this.active) this.active = { ...this.active, y: this.active.y - rows };
    this.validateActiveAfterBoardChange();
  }

  // ===== 内部机制 =====

  private fillQueue(): void {
    while (this.queue.length < 8) this.queue.push(this.bag.next());
  }

  /** 生成下一块；出生位被占 → Block Out（marathon 结束 / sprint 清盘重来） */
  spawnActive(): void {
    this.spawnCount += 1;
    const type = this.queue.shift() as PieceType;
    this.fillQueue();
    const piece: ActivePiece = { type, x: SPAWN_X[type], y: SPAWN_Y, rot: 0 };
    if (collides(this.board, pieceCells(type, 0), piece.x, piece.y)) {
      if (this.mode === 'sprint') {
        this.board = createBoard();
        this.combo = 0;
        this.b2bActive = false;
      } else {
        this.active = null;
        this.topOut = true;
        this.status = 'finished';
        this.finishTimeMs ??= this.elapsedMs;
        return;
      }
    }
    this.active = piece;
    this.postSpawnDrop();
    this.lowestY = this.active ? this.active.y : SPAWN_Y;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.gravityAcc = 0;
    this.lastActionRotation = false;
  }

  /** Guideline：出生后若可下移则立即下移一格（保证至少一行进入可见区） */
  private postSpawnDrop(): void {
    const a = this.active;
    if (!a) return;
    if (!collides(this.board, pieceCells(a.type, a.rot), a.x, a.y + 1)) a.y += 1;
  }

  private tryShift(dx: number, dy: number): boolean {
    const a = this.active;
    if (!a) return false;
    if (collides(this.board, pieceCells(a.type, a.rot), a.x + dx, a.y + dy)) return false;
    a.x += dx;
    a.y += dy;
    if (a.y > this.lowestY) {
      this.lowestY = a.y; // 到达新低点 → 重置锁定重置计数（Guideline lowest-row 规则）
      this.lockResets = 0;
    }
    return true;
  }

  private tryHorizontal(dx: -1 | 1): boolean {
    const a = this.active;
    if (!a || !this.tryShift(dx, 0)) return false;
    this.lastActionRotation = false;
    // 移出平台（离地）→ 清锁定计时，避免继承旧计时提前锁定
    if (!collides(this.board, pieceCells(a.type, a.rot), a.x, a.y + 1)) this.lockTimer = 0;
    this.touchReset();
    return true;
  }

  private tryRotate(dir: 1 | -1): boolean {
    const a = this.active;
    if (!a) return false;
    if (a.type === 'O') return true;
    const to = ((((a.rot + dir) % 4) + 4) % 4) as Rotation;
    const cells = pieceCells(a.type, to);
    const kicks = kicksFor(a.type, a.rot, to);
    for (const [kx, kyUp] of kicks) {
      const nx = a.x + kx;
      const ny = a.y - kyUp; // 踢墙表 y 上为正 → 棋盘 y 取反
      if (!collides(this.board, cells, nx, ny)) {
        a.rot = to;
        a.x = nx;
        a.y = ny;
        this.lastActionRotation = true;
        if (a.y > this.lowestY) {
          this.lowestY = a.y;
          this.lockResets = 0;
        }
        if (!collides(this.board, cells, a.x, a.y + 1)) this.lockTimer = 0;
        this.touchReset();
        return true;
      }
    }
    return false;
  }

  /** 触地时的移动/旋转重置（最多 MAX_LOCK_RESETS 次） */
  private touchReset(): void {
    const a = this.active;
    if (!a) return;
    if (collides(this.board, pieceCells(a.type, a.rot), a.x, a.y + 1)) {
      if (this.lockResets < MAX_LOCK_RESETS) {
        this.lockTimer = 0;
        this.lockResets++;
      }
    }
  }

  private hardDrop(): boolean {
    const a = this.active;
    if (!a) return false;
    const d = dropDistance(this.board, pieceCells(a.type, a.rot), a.x, a.y);
    a.y += d;
    this.score += d * 2;
    if (d > 0) this.lastActionRotation = false; // 硬降位移后不再是旋转入位
    this.lock();
    return true;
  }

  private holdSwap(): boolean {
    if (!this.canHold || !this.active) return false;
    const cur = this.active.type;
    const swap = this.hold;
    this.hold = cur;
    this.canHold = false;
    this.lastActionRotation = false;
    if (swap) {
      this.active = { type: swap, x: SPAWN_X[swap], y: SPAWN_Y, rot: 0 };
      if (collides(this.board, pieceCells(swap, 0), this.active.x, this.active.y)) {
        this.handleSpawnCollision();
        if (this.status !== 'running') return true; // marathon：顶出结束
        // sprint：清盘重来后继续当前块（与 spawnActive 一致地复位下落/锁定状态）
        this.postSpawnDrop();
        this.lowestY = this.active ? this.active.y : SPAWN_Y;
        this.lockTimer = 0;
        this.lockResets = 0;
        this.gravityAcc = 0;
        return true;
      }
      // 换回 Hold 的块：走与 spawnActive 相同的"出生下移一格"，只做一次
      this.postSpawnDrop();
    } else {
      // Hold 为空：从队列取新块，spawnActive 内部已含出生下移，不再重复
      this.spawnActive();
    }
    this.lowestY = this.active ? this.active.y : SPAWN_Y;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.gravityAcc = 0;
    return true;
  }

  private handleSpawnCollision(): void {
    if (this.mode === 'sprint') {
      this.board = createBoard();
      this.combo = 0;
      this.b2bActive = false;
      this.canHold = true; // 清盘重来 → Hold 机会随新棋盘恢复
    } else {
      this.active = null;
      this.topOut = true;
      this.status = 'finished';
      this.finishTimeMs ??= this.elapsedMs;
    }
  }

  private lock(): void {
    const a = this.active;
    if (!a) return;
    const cells = pieceCells(a.type, a.rot);
    const tspin =
      a.type === 'T'
        ? detectTSpin(this.board, a.x, a.y, a.rot, this.lastActionRotation)
        : ('none' as TSpinKind);
    const allHidden = cells.every(([, cy]) => a.y + cy < HIDDEN_ROWS); // Lock Out：完全锁在隐藏缓冲区
    mergePiece(this.board, a.type, cells, a.x, a.y);
    this.active = null;

    // 消行视觉数据先留存（消行前棋盘 + 待消失行号），供客户端三闪动画绘制；
    // 纯视觉，不进 stateHash / 快照，也不影响攻击与垃圾行时序
    const fullRows = findFullRows(this.board);
    if (fullRows.length > 0) {
      this.clearVisual = { id: ++this.clearSeq, rows: fullRows, board: [...this.board] };
    }

    const cleared = clearLines(this.board);
    if (cleared > 0) this.combo += 1;
    else this.combo = 0;
    const perfectClear = cleared > 0 && isBoardEmpty(this.board);
    const res = scoreClear({
      lines: cleared,
      tspin,
      perfectClear,
      b2bEligible: this.b2bActive,
      combo: this.combo,
      level: this.level,
    });
    this.score += res.points;
    if (cleared > 0) this.b2bActive = res.difficult;
    this.lines += cleared;
    this.level = Math.floor(this.lines / LINES_PER_LEVEL) + 1;
    this.lastClear =
      cleared > 0 || tspin !== 'none'
        ? {
            lines: cleared,
            tspin,
            points: res.points,
            b2b: res.b2bUsed,
            combo: this.combo,
            perfectClear,
          }
        : null;
    // 消行入队：同一 tick 内可能发生多次锁定，Room 层用循环 takeLastClear 逐个结算攻击
    if (this.lastClear) this.clears.push(this.lastClear);

    // sprint 完赛
    if (this.mode === 'sprint' && this.lines >= this.targetLines) {
      this.status = 'finished';
      this.finishTimeMs = this.elapsedMs;
      return;
    }
    // Lock Out → 顶出处置（sprint 清盘重来 / marathon 结束）
    if (allHidden) {
      this.handleTopOut();
      return;
    }
    this.canHold = true;
    this.lockResets = 0;
    this.lockTimer = 0;
    this.gravityAcc = 0;
    this.lastActionRotation = false;
    this.spawnActive();
  }

  private handleTopOut(): void {
    if (this.mode === 'sprint') {
      // 棋盘清空重来，消行计数保留（防负反馈死局，requirements §4.5）
      this.board = createBoard();
      this.combo = 0;
      this.b2bActive = false;
      this.canHold = true;
      this.lockResets = 0;
      this.lockTimer = 0;
      this.gravityAcc = 0;
      this.lastActionRotation = false;
      this.spawnActive();
    } else {
      this.topOut = true;
      this.status = 'finished';
      this.finishTimeMs = this.elapsedMs;
    }
  }

  /**
   * timed 限时赛复活（M4，requirements §4.4/§4.5）：棋盘清空、分数/消行/等级保留、
   * Hold 保留、Combo/B2B 清零；方块序列（bag/queue）延续 —— 双端（服务端权威 + 客户端预测）
   * 在同一事件各自调用本方法即可保持一致；调用后 status 恢复 running。
   */
  respawn(): void {
    this.board = createBoard();
    this.combo = 0;
    this.b2bActive = false;
    this.canHold = true;
    this.topOut = false;
    this.status = 'running';
    this.finishTimeMs = null;
    this.lastClear = null;
    this.clearVisual = null;
    this.clears = [];
    this.active = null;
    this.spawnActive();
  }

  /** 服务端权威快照 → 本地状态重建（M2 乐观渲染校正用，技术设计 §5.3） */
  applySnapshotState(s: {
    board: Board;
    active: ActivePiece | null;
    queue: PieceType[];
    hold: PieceType | null;
    canHold: boolean;
    score: number;
    lines: number;
    level: number;
    combo: number;
    b2bActive: boolean;
    elapsedMs: number;
    status?: GameStatus;
    /** v1.7：快照携带的已取块数（缺省 = 不重对齐，兼容旧客户端/测试） */
    spawnCount?: number;
    softDrop?: boolean;
  }): void {
    this.board = [...s.board];
    this.active = s.active ? { ...s.active } : null;
    this.queue = [...s.queue];
    // v1.7：恢复 7-bag 游标（spawnCount + 当前 queue 长度 = 已从 bag 取出的块数）。
    // 否则重连/校正后客户端从 bag 起点重新取块，Next 预览与实际出块会逐渐偏离服务器。
    if (s.spawnCount !== undefined) {
      this.spawnCount = s.spawnCount;
      this.alignBag();
    }
    this.hold = s.hold;
    this.canHold = s.canHold;
    this.score = s.score;
    this.lines = s.lines;
    this.level = s.level;
    this.combo = s.combo;
    this.b2bActive = s.b2bActive;
    this.elapsedMs = s.elapsedMs;
    if (s.status) {
      this.status = s.status;
      // 权威快照说仍在进行 → 清除本地预测残留的顶出终局（乐观渲染校正无法自行恢复）
      if (s.status === 'running') {
        this.topOut = false;
        this.finishTimeMs = null;
      }
    }
    if (s.softDrop !== undefined) this.softDrop = s.softDrop;
    this.gravityAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.lowestY = this.active ? this.active.y : SPAWN_Y;
    this.lastActionRotation = false;
    this.lastClear = null;
    // 快照校正后不再回放旧的消行动画/未结算消行（防止重连、复活后补播或重复计攻）
    this.clearVisual = null;
    this.clears = [];
  }

  /** 以 seed + 已取块数重建 bag 游标（queue 已由服务器给出，bag 对齐到 queue 之后） */
  private alignBag(): void {
    this.bag = new SevenBag(new Rng(this.seed));
    const draws = this.spawnCount + this.queue.length;
    for (let i = 0; i < draws; i++) this.bag.next();
  }

  /** 状态指纹（快照变化检测 / 客户端一致性比较），不含 lastClear/finishTime 等派生信息 */
  stateHash(): string {
    const a = this.active;
    return [
      boardToString(this.board),
      a ? `${a.type},${a.x},${a.y},${a.rot}` : '-',
      this.score,
      this.lines,
      this.level,
      this.combo,
      this.b2bActive ? 1 : 0,
      this.hold ?? '-',
      this.canHold ? 1 : 0,
      this.spawnCount,
    ].join('|');
  }

  getSnapshot(): GameState {
    return {
      board: [...this.board],
      active: this.active ? { ...this.active } : null,
      queue: this.queue.slice(0, 8),
      hold: this.hold,
      canHold: this.canHold,
      score: this.score,
      lines: this.lines,
      level: this.level,
      combo: this.combo,
      b2bActive: this.b2bActive,
      status: this.status,
      elapsedMs: this.elapsedMs,
      finishTimeMs: this.finishTimeMs,
      topOut: this.topOut,
      spawnCount: this.spawnCount,
      lastClear: this.lastClear ? { ...this.lastClear } : null,
    };
  }
}
