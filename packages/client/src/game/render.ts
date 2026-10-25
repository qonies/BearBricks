// Canvas 2D 渲染：棋盘（含 Ghost）与 Hold/Next 小窗 + 对手小板（技术设计 §5.1）

import {
  BOARD_WIDTH,
  HIDDEN_ROWS,
  TOTAL_HEIGHT,
  PIECE_CELLS,
  boardFromString,
  dropDistance,
  pieceCells,
  type ActivePieceData,
  type Board,
  type PieceType,
  type TetrisGame,
} from '@bearbricks/shared';
import { CELL_COLORS } from '../theme';

/** 消行三闪覆盖层（与 clearFx.ts 的 ClearFxFrame 结构兼容）：有值时绘制动画帧而非实时棋盘 */
export interface ClearFlashOverlay {
  /** 消行前的棋盘（含待消失行，clearFx.ts 提供） */
  board: Board;
  /** 待闪烁行号（消行前坐标） */
  rows: number[];
  /** true = 亮（白色覆盖）；false = 暗（压暗） */
  flashOn: boolean;
}

/** 底层绘制：棋盘数组 + 当前块（单人/多人共用）；overlay 存在时绘制消行动画帧（不画新块/Ghost） */
export function drawBoardState(
  ctx: CanvasRenderingContext2D,
  board: Board,
  active: ActivePieceData | null,
  cell: number,
  showGhost: boolean,
  overlay?: ClearFlashOverlay,
): void {
  const w = BOARD_WIDTH * cell;
  const h = (TOTAL_HEIGHT - HIDDEN_ROWS) * cell;
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(148,163,184,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c <= BOARD_WIDTH; c++) {
    ctx.moveTo(c * cell + 0.5, 0);
    ctx.lineTo(c * cell + 0.5, h);
  }
  for (let r = 0; r <= TOTAL_HEIGHT - HIDDEN_ROWS; r++) {
    ctx.moveTo(0, r * cell + 0.5);
    ctx.lineTo(w, r * cell + 0.5);
  }
  ctx.stroke();

  const drawCell = (row: number, col: number, color: string, alpha = 1): void => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(col * cell + 1, (row - HIDDEN_ROWS) * cell + 1, cell - 2, cell - 2);
    ctx.globalAlpha = 1;
  };

  // 消行三闪动画期间绘制"消行前"的棋盘快照（行尚未塌下）
  const src = overlay ? overlay.board : board;
  for (let r = HIDDEN_ROWS; r < TOTAL_HEIGHT; r++) {
    for (let c = 0; c < BOARD_WIDTH; c++) {
      const v = src[r * BOARD_WIDTH + c];
      if (v) drawCell(r, c, CELL_COLORS[v] ?? '#94a3b8');
    }
  }

  if (overlay) {
    // 待消失行明暗交替：亮相位白色覆盖、暗相位压暗；动画期间不绘制新块/Ghost（街机惯例）
    for (const r of overlay.rows) {
      if (r < HIDDEN_ROWS) continue;
      for (let c = 0; c < BOARD_WIDTH; c++) {
        if (!overlay.board[r * BOARD_WIDTH + c]) continue;
        drawCell(
          r,
          c,
          overlay.flashOn ? '#f8fafc' : '#0f172a',
          overlay.flashOn ? 0.95 : 0.6,
        );
      }
    }
    return;
  }

  if (active) {
    const cells = pieceCells(active.type, active.rot);
    if (showGhost) {
      const d = dropDistance(board, cells, active.x, active.y);
      for (const [cx, cy] of cells) {
        const gy = active.y + cy + d;
        if (gy >= HIDDEN_ROWS) drawCell(gy, active.x + cx, CELL_COLORS[active.type], 0.25);
      }
    }
    for (const [cx, cy] of cells) {
      const py = active.y + cy;
      if (py >= HIDDEN_ROWS) drawCell(py, active.x + cx, CELL_COLORS[active.type]);
    }
  }
}

export function drawBoard(
  ctx: CanvasRenderingContext2D,
  game: TetrisGame,
  cell: number,
  showGhost: boolean,
  overlay?: ClearFlashOverlay,
): void {
  drawBoardState(ctx, game.board, game.active, cell, showGhost, overlay);
}

/** 对手小板：由协议快照（220 字符 + active）绘制，无 Ghost */
export function drawOpponentBoard(
  ctx: CanvasRenderingContext2D,
  boardStr: string,
  active: ActivePieceData | null,
  cell: number,
): void {
  try {
    drawBoardState(ctx, boardFromString(boardStr), active, cell, false);
  } catch {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
}

/** Hold / Next 横向小窗：水平排布（竖屏/分屏下的紧凑栏，与 drawMini 共用绘制规则） */
export function drawMiniRow(
  ctx: CanvasRenderingContext2D,
  types: readonly (PieceType | null)[],
  cell: number,
  w: number = ctx.canvas.width,
  h: number = ctx.canvas.height,
): void {
  const slotW = w / Math.max(1, types.length);
  ctx.clearRect(0, 0, w, h);
  types.forEach((t, i) => {
    if (!t) return;
    const cells = PIECE_CELLS[t][0];
    const xs = cells.map((c) => c[0]);
    const ys = cells.map((c) => c[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const pw = (maxX - minX + 1) * cell;
    const ph = (maxY - minY + 1) * cell;
    const ox = i * slotW + (slotW - pw) / 2;
    const oy = (h - ph) / 2;
    ctx.fillStyle = CELL_COLORS[t];
    for (const [cx, cy] of cells) {
      ctx.fillRect(ox + (cx - minX) * cell + 1, oy + (cy - minY) * cell + 1, cell - 2, cell - 2);
    }
  });
}

/** HiDPI 画布：按 devicePixelRatio 设置 backing store 并应用变换，返回逻辑坐标的 2D 上下文 */
export function hiDpiCanvas(
  c: HTMLCanvasElement | null,
  w: number,
  h: number,
): CanvasRenderingContext2D | null {
  if (!c) return null;
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (c.width !== bw || c.height !== bh) {
    c.width = bw;
    c.height = bh;
  }
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Hold / Next 小窗：每个元素占据一槽，居中绘制 spawn 形态（w/h 为逻辑尺寸，缺省取画布属性） */
export function drawMini(
  ctx: CanvasRenderingContext2D,
  types: readonly (PieceType | null)[],
  cell: number,
  w: number = ctx.canvas.width,
  h: number = ctx.canvas.height,
): void {
  const slotH = h / Math.max(1, types.length);
  ctx.clearRect(0, 0, w, h);
  types.forEach((t, i) => {
    if (!t) return;
    const cells = PIECE_CELLS[t][0];
    const xs = cells.map((c) => c[0]);
    const ys = cells.map((c) => c[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const pw = (maxX - minX + 1) * cell;
    const ph = (maxY - minY + 1) * cell;
    const ox = (w - pw) / 2;
    const oy = i * slotH + (slotH - ph) / 2;
    ctx.fillStyle = CELL_COLORS[t];
    for (const [cx, cy] of cells) {
      ctx.fillRect(ox + (cx - minX) * cell + 1, oy + (cy - minY) * cell + 1, cell - 2, cell - 2);
    }
  });
}
