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

export interface GameState {
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

  private readonly bag: SevenBag;
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
    this.bag = new SevenBag(new Rng(config.seed ?? defaultSeed()));
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

  /** 取出并清空 lastClear（Room 层每次锁定只结算一次攻击，防止重复计攻） */
  takeLastClear(): LastClear | null {
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
    insertGarbage(this.board, rows, holeCol);
    if (this.active) this.active = { ...this.active, y: this.active.y - rows };
    this.validateActiveAfterBoardChange();
  }

  // ===== 内部机制 =====

  private fillQueue(): void {
    while (this.queue.length < 8) this.queue.push(this.bag.next());
  }

  /** 生成下一块；出生位被占 → Block Out（marathon 结束 / sprint 清盘重来） */
  spawnActive(): void {
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
    } else {
      this.spawnActive();
    }
    this.postSpawnDrop();
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
    softDrop?: boolean;
  }): void {
    this.board = [...s.board];
    this.active = s.active ? { ...s.active } : null;
    this.queue = [...s.queue];
    this.hold = s.hold;
    this.canHold = s.canHold;
    this.score = s.score;
    this.lines = s.lines;
    this.level = s.level;
    this.combo = s.combo;
    this.b2bActive = s.b2bActive;
    this.elapsedMs = s.elapsedMs;
    if (s.status) this.status = s.status;
    if (s.softDrop !== undefined) this.softDrop = s.softDrop;
    this.gravityAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.lowestY = this.active ? this.active.y : SPAWN_Y;
    this.lastActionRotation = false;
    this.lastClear = null;
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
      lastClear: this.lastClear ? { ...this.lastClear } : null,
    };
  }
}
