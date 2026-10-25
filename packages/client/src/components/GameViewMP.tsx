// 多人对战屏（FR-11.2 / FR-12.2）：己方板（乐观渲染 + 校核）+ 对手小板 + HUD + 攻击预警 + 聊天 + 结算
// iPad（技术设计 §5.6）：≥1024 三栏 / 较窄两栏 + 聊天抽屉 / 分屏紧凑单栏
// Esc / 齿轮按钮打开设置面板（联机不暂停，服务端权威照常跑）

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BOARD_WIDTH,
  HIDDEN_ROWS,
  NEXT_PREVIEW_COUNT,
  TOTAL_HEIGHT,
  type ActivePieceData,
  type GameAttackPayload,
  type GameTopOutPayload,
  type SelfSnapshot,
  type SeatPlayStatus,
} from '@bearbricks/shared';
import { net } from '../net/netClient';
import { NetGameRunner } from '../game/netGame';
import { ClearFxTracker } from '../game/clearFx';
import { drawBoard, drawMini, drawMiniRow, drawOpponentBoard, hiDpiCanvas } from '../game/render';
import { useFitCell, useMediaQuery, useShowTouchControls } from '../game/viewport';
import { InputRouter } from '../input/router';
import { useGameInput } from '../input/useGameInput';
import { ChatPanel } from './ChatPanel';
import { TouchControls } from './TouchControls';
import { SettingsOverlay } from './SettingsPanel';
import { useRoomStore } from '../store/room';
import { useSettings } from '../store/settings';

const VISIBLE_ROWS = TOTAL_HEIGHT - HIDDEN_ROWS;
const MINI_CELL = 8;

function formatTime(ms: number): string {
  const total = Math.floor(ms / 10);
  return `${String(Math.floor(total / 6000)).padStart(2, '0')}:${String(Math.floor(total / 100) % 60).padStart(2, '0')}.${String(total % 100).padStart(2, '0')}`;
}

/** 倒计时用 mm:ss（向上取整，0 显示 00:00） */
function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

interface TimedHudState {
  endsAt: number;
  respawnAt?: number;
  immuneUntil?: number;
}

export function GameViewMP({ onExit }: { onExit: () => void }) {
  const mpStart = useRoomStore((s) => s.mpStart);
  const room = useRoomStore((s) => s.room);
  const selfSeatId = useRoomStore((s) => s.selfSeatId);
  const result = useRoomStore((s) => s.result);
  const opponents = useRoomStore((s) => s.opponents);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const holdRef = useRef<HTMLCanvasElement | null>(null);
  const nextRef = useRef<HTMLCanvasElement | null>(null);
  const boardWrapRef = useRef<HTMLDivElement | null>(null);
  const runnerRef = useRef<NetGameRunner | null>(null);
  const [hud, setHud] = useState({
    lines: 0,
    level: 1,
    score: 0,
    elapsedMs: 0,
    timeLeftMs: 0,
    respawnLeftMs: 0,
    immuneLeftMs: 0,
  });
  const [survival, setSurvival] = useState({ aliveCount: 0, pending: 0 });
  const [selfStatus, setSelfStatus] = useState<SeatPlayStatus>('playing');
  const timedRef = useRef<TimedHudState | null>(null);
  const [attackFlash, setAttackFlash] = useState<{ from: string; lines: number } | null>(null);
  const [netDown, setNetDown] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const resultPausedRef = useRef(false);
  const netDownRef = useRef(false);
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;

  const wide = useMediaQuery('(min-width: 1024px)');
  const showTouch = useShowTouchControls();
  const cell = useFitCell(boardWrapRef, { cols: BOARD_WIDTH, rows: VISIBLE_ROWS, min: 10, max: 30 });
  const cellRef = useRef(cell);
  cellRef.current = cell;
  const wideRef = useRef(wide);
  wideRef.current = wide;

  const router = useMemo(() => new InputRouter(() => runnerRef.current), []);

  const syncPause = (): void => {
    if (runnerRef.current) runnerRef.current.paused = resultPausedRef.current || netDownRef.current;
  };

  // 收到指向自己的攻击 → 短暂闪烁提示（game.attack，protocol §4）
  useEffect(() => {
    if (!attackFlash) return;
    const t = window.setTimeout(() => setAttackFlash(null), 2500);
    return () => window.clearTimeout(t);
  }, [attackFlash]);

  useEffect(
    () =>
      net.onStatus((s) => {
        const down = s === 'connecting' || s === 'reconnecting';
        netDownRef.current = down;
        syncPause();
        setNetDown(down);
      }),
    [],
  );

  useEffect(() => {
    if (settingsOpen) router.releaseAll();
  }, [settingsOpen, router]);

  // 连接中断时释放按住态：否则重连恢复后棋子会继续朝原方向移动
  useEffect(() => {
    if (netDown) router.releaseAll();
  }, [netDown, router]);

  useEffect(() => {
    if (!mpStart) return;
    const settings = useSettings.getState();
    const runner = new NetGameRunner(mpStart.seed, mpStart.mode, mpStart.targetLines, {
      das: settings.das,
      arr: settings.arr,
      initialSeq: mpStart.initialSeq,
    });
    runnerRef.current = runner;
    const clearFx = new ClearFxTracker(runner.game);
    resultPausedRef.current = false;
    netDownRef.current = net.status === 'connecting' || net.status === 'reconnecting';
    syncPause();
    // 断线重连恢复：先同步 timed 复活状态，再应用 game.state.full 的权威快照
    // （顺序必须 syncTimed → resync：权威快照可能已包含复活后的新棋盘/新方块，P1-2）
    if (mpStart.initial) {
      const init = mpStart.initial;
      runner.syncTimed(init.modeState.timed ?? null);
      runner.resync(init);
      // 用初始快照预热 HUD（否则被淘汰/复活中重连会短暂显示"playing / 存活 0"）
      setSelfStatus(init.status ?? 'playing');
      if (init.modeState.survival) {
        setSurvival({
          aliveCount: init.modeState.survival.aliveCount,
          pending: init.modeState.survival.pendingGarbage,
        });
      }
      if (init.modeState.timed) {
        timedRef.current = init.modeState.timed;
        setSurvival((s) => ({ ...s, pending: init.modeState.timed?.pendingGarbage ?? 0 }));
      }
    }
    runner.onInput = (seq, action) => net.input(seq, action);
    runner.onSoftChange = (on) => net.soft(on);
    const unsubSettings = useSettings.subscribe((s) => runner.setTiming(s.das, s.arr));

    const offSelf = net.on('game.snapshot.self', (d) => {
      const snap = d as SelfSnapshot;
      // 先同步 timed 复活（可能触发本地 respawn），再应用权威快照覆盖——最终状态 = 服务器（P1-2）
      runner.syncTimed(snap.modeState.timed ?? null);
      runner.resync(snap);
      // v1.5：座位状态以服务端权威口径为准（观战/终局显示 + 本地预测卡死校正）
      setSelfStatus(snap.status ?? 'playing');
      if (snap.modeState.survival) {
        setSurvival({
          aliveCount: snap.modeState.survival.aliveCount,
          pending: snap.modeState.survival.pendingGarbage,
        });
      }
      if (snap.modeState.timed) {
        timedRef.current = snap.modeState.timed;
        // v1.5：timed 与 survival 同口径的攻击预警；归零时服务端省略字段，必须显式清零（P2-3）
        setSurvival((s) => ({ ...s, pending: snap.modeState.timed?.pendingGarbage ?? 0 }));
      }
    });
    // 顶出处置事件：立即反映自身淘汰/复活（不等下一帧快照）；对手状态由 others 快照驱动
    const offTopOut = net.on('game.topOut', (d) => {
      const p = d as GameTopOutPayload;
      const st = useRoomStore.getState();
      if (st.selfSeatId != null && p.seatId === st.selfSeatId) {
        setSelfStatus(p.action === 'ELIMINATE' ? 'eliminated' : 'playing');
      }
    });
    // 结算：停本地引擎与输入（服务端已不再接受输入，避免 E4031 轰炸）
    const offResult = net.on('game.result', () => {
      resultPausedRef.current = true;
      syncPause();
      router.releaseAll();
    });
    // 攻击指示：指向自己的攻击闪烁提示（聊天 handler 已上移到 App 级，P2-2）
    const offAttack = net.on('game.attack', (d) => {
      const p = d as GameAttackPayload;
      const st = useRoomStore.getState();
      if (st.selfSeatId == null || !p.targets.includes(st.selfSeatId)) return;
      const from = st.room?.seats.find((s) => s.seatId === p.fromSeat)?.nickname;
      setAttackFlash({ from: from ?? `座位${p.fromSeat}`, lines: p.lines });
    });

    let lastSig = '';
    let lastHudPush = 0;
    const serverNow = (): number => net.serverNow();
    const onFrame = (): void => {
      const g = runner.game;
      const now = performance.now();
      clearFx.update(g, now);
      const c = cellRef.current;
      const ctx = hiDpiCanvas(canvasRef.current, BOARD_WIDTH * c, VISIBLE_ROWS * c);
      if (ctx) drawBoard(ctx, g, c, useSettings.getState().ghost, clearFx.frame(now) ?? undefined);
      if (wideRef.current) {
        const holdCtx = hiDpiCanvas(holdRef.current, 96, 48);
        if (holdCtx) drawMini(holdCtx, [g.hold], 18, 96, 48);
        const nextCtx = hiDpiCanvas(nextRef.current, 96, 210);
        if (nextCtx) drawMini(nextCtx, g.queue.slice(0, NEXT_PREVIEW_COUNT), 18, 96, 210);
      } else {
        const holdCtx = hiDpiCanvas(holdRef.current, 64, 34);
        if (holdCtx) drawMini(holdCtx, [g.hold], 13, 64, 34);
        const nextCtx = hiDpiCanvas(nextRef.current, 117, 34);
        if (nextCtx) drawMiniRow(nextCtx, g.queue.slice(0, 3), 13, 117, 34);
      }
      const sig = `${g.lines}|${g.level}|${g.score}|${g.status}`;
      if (sig !== lastSig || now - lastHudPush > 100) {
        lastSig = sig;
        lastHudPush = now;
        const t = timedRef.current;
        setHud({
          lines: g.lines,
          level: g.level,
          score: g.score,
          elapsedMs: g.elapsedMs,
          timeLeftMs: t ? Math.max(0, t.endsAt - serverNow()) : 0,
          respawnLeftMs: t?.respawnAt != null ? Math.max(0, t.respawnAt - serverNow()) : 0,
          immuneLeftMs: t?.immuneUntil != null ? Math.max(0, t.immuneUntil - serverNow()) : 0,
        });
      }
    };
    runner.now = serverNow; // 冻结窗口同样使用服务器校正时钟
    // 计时补偿必须用服务器校正时钟（P2-1）：startTs 是服务器 epoch，
    // 用本地 Date.now() 相减会把客户端时钟偏差整段灌进 elapsedMs（HUD/结算时间全部偏移）
    const startTs = mpStart.startTs;
    runner.start(onFrame, startTs != null ? { elapsedOffsetMs: Math.max(0, serverNow() - startTs) } : undefined);

    return () => {
      runner.stop();
      runnerRef.current = null;
      offSelf();
      offAttack();
      offTopOut();
      offResult();
      unsubSettings();
      router.releaseAll();
    };
  }, [mpStart, router]);

  useGameInput({
    router,
    canInput: () => {
      const r = runnerRef.current;
      if (!r || r.paused || settingsOpenRef.current) return false;
      if (useRoomStore.getState().result) return false;
      return r.game.status === 'running';
    },
    getCellPx: () => cellRef.current,
    onEscape: () => setSettingsOpen((v) => !v),
    surfaceRef: boardWrapRef,
  });

  if (!mpStart) return null;
  const isHost = room != null && selfSeatId != null && room.hostSeat === selfSeatId;
  const isSurvival = mpStart.mode === 'survival';
  const isTimed = mpStart.mode === 'timed';
  const isSprint = mpStart.mode === 'sprint';
  const pendingRows = Math.min(survival.pending, 20);
  const selfEliminated = isSurvival && (selfStatus === 'eliminated' || selfStatus === 'abandoned');
  // timed 实时排名（§4.4）：按总分即时比较（对手分来自 others 快照）
  const timedRank =
    1 + Object.values(opponents).filter((o) => o.score > hud.score && o.status !== 'abandoned').length;
  const interactive = !result && !netDown && !settingsOpen && selfStatus === 'playing';
  const modeTitle = isSurvival
    ? `生存淘汰 · 存活 ${survival.aliveCount}`
    : isTimed
      ? '限时赛'
      : `Sprint ${mpStart.targetLines}`;
  const clockText = isTimed ? formatClock(hud.timeLeftMs) : formatTime(hud.elapsedMs);
  const lowTime = isTimed && hud.timeLeftMs <= 10_000;

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-slate-900 text-slate-100">
      <header
        className="flex items-center justify-between gap-2 px-3 pb-1"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
      >
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-base font-bold sm:text-lg">{modeTitle}</span>
          <span className={`font-mono text-sm sm:text-xl ${lowTime ? 'text-rose-400' : ''}`}>{clockText}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs sm:text-sm">
          <button
            type="button"
            onClick={() => setChatOpen((v) => !v)}
            className="rounded-lg bg-slate-700 px-2.5 py-2 hover:bg-slate-600 lg:hidden"
          >
            聊天
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg bg-slate-700 px-2.5 py-2 hover:bg-slate-600"
          >
            设置
          </button>
          <button
            type="button"
            onClick={onExit}
            className="rounded-lg bg-slate-700 px-2.5 py-2 hover:bg-slate-600"
          >
            离开
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-2 px-2">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
          {!wide && (
            <div className="flex items-center gap-1.5">
              <div className="rounded border border-slate-700 bg-slate-800/60 p-1">
                <canvas ref={holdRef} style={{ width: 64, height: 34 }} />
              </div>
              <div className="rounded border border-slate-700 bg-slate-800/60 p-1">
                <canvas ref={nextRef} style={{ width: 117, height: 34 }} />
              </div>
              <div className="ml-auto flex gap-2 text-right text-xs">
                <Stat label="分" value={hud.score} />
                <Stat label="行" value={hud.lines} />
                <Stat label="级" value={hud.level} />
              </div>
            </div>
          )}
          {!wide && <OpponentsStrip selfSeatId={selfSeatId} />}
          <div className="flex min-h-0 flex-1 items-stretch justify-center gap-1">
            <div ref={boardWrapRef} className="game-surface flex min-h-0 min-w-0 flex-1 items-center justify-center">
              <canvas
                ref={canvasRef}
                style={{ width: BOARD_WIDTH * cell, height: VISIBLE_ROWS * cell }}
                className="rounded-lg border border-slate-700"
              />
            </div>
            {(isSurvival || isTimed) && (
              <div
                className="flex w-3 shrink-0 flex-col-reverse gap-px self-stretch rounded border border-slate-700 bg-slate-950/60"
                title={`待接收垃圾行：${survival.pending}`}
              >
                {Array.from({ length: pendingRows }, (_, i) => (
                  <div key={i} className="w-full flex-1 bg-rose-600" />
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {selfEliminated && <Badge tone="rose">你已被淘汰（观战中）</Badge>}
            {isSprint && selfStatus === 'finished' && (
              <Badge tone="sky">你已完成，等待其他玩家…</Badge>
            )}
            {isTimed && hud.respawnLeftMs > 0 && (
              <Badge tone="amber">复活倒计时 {(hud.respawnLeftMs / 1000).toFixed(1)}s</Badge>
            )}
            {isTimed && hud.respawnLeftMs <= 0 && hud.immuneLeftMs > 0 && (
              <Badge tone="sky">🛡 免伤中（{(hud.immuneLeftMs / 1000).toFixed(1)}s）</Badge>
            )}
            {attackFlash && (
              <Badge tone="rose">
                ⚔ {attackFlash.from} 向你发来 +{attackFlash.lines} 行垃圾！
              </Badge>
            )}
          </div>
        </div>

        {wide && (
          <aside className="flex w-40 shrink-0 flex-col gap-2 py-1">
            <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-2">
              <div className="mb-1 text-xs text-slate-400">HOLD</div>
              <canvas ref={holdRef} style={{ width: 96, height: 48 }} />
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-2">
              <div className="mb-1 text-xs text-slate-400">NEXT</div>
              <canvas ref={nextRef} style={{ width: 96, height: 210 }} />
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-2 text-sm">
              {isTimed && (
                <>
                  <div className="flex justify-between">
                    <span className="text-slate-400">剩余</span>
                    <span className={`font-mono ${lowTime ? 'text-rose-400' : ''}`}>
                      {formatClock(hud.timeLeftMs)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">排名</span>
                    <span className="font-mono">#{timedRank}</span>
                  </div>
                </>
              )}
              {isSurvival && (
                <>
                  <div className="flex justify-between">
                    <span className="text-slate-400">存活</span>
                    <span className="font-mono">{survival.aliveCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">待接垃圾</span>
                    <span className="font-mono">{survival.pending}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between">
                <span className="text-slate-400">得分</span>
                <span className="font-mono">{hud.score}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">消行</span>
                <span className="font-mono">
                  {isSprint ? `${hud.lines}/${mpStart.targetLines}` : hud.lines}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">等级</span>
                <span className="font-mono">{hud.level}</span>
              </div>
            </div>
          </aside>
        )}

        {wide && (
          <aside className="flex w-24 shrink-0 flex-col py-1">
            <Opponents selfSeatId={selfSeatId} />
          </aside>
        )}
        {wide && (
          <div className="flex min-h-0 w-64 shrink-0 py-1">
            <ChatPanel selfSeatId={selfSeatId} />
          </div>
        )}
      </div>

      {showTouch && (
        <div className="shrink-0 pt-1">
          <TouchControls router={router} disabled={!interactive} />
        </div>
      )}

      {chatOpen && !wide && (
        <div className="fixed inset-0 z-40 flex flex-col bg-black/60" onClick={() => setChatOpen(false)}>
          <div
            className="mt-auto h-[55dvh] w-full rounded-t-xl bg-slate-900 p-2"
            onClick={(e) => e.stopPropagation()}
          >
            <ChatPanel selfSeatId={selfSeatId} />
          </div>
        </div>
      )}

      {settingsOpen && <SettingsOverlay onClose={() => setSettingsOpen(false)} />}

      {netDown && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
          <div className="rounded-xl bg-slate-800 px-6 py-5 text-center">
            <div className="text-xl font-bold">连接中断</div>
            <div className="mt-2 text-sm text-slate-400">
              正在重连服务器，棋局已暂停（服务端宽限 30s 内可恢复）
            </div>
          </div>
        </div>
      )}
      {result && <ResultOverlay isHost={isHost} onExit={onExit} />}
    </div>
  );
}

function OpponentCanvas({
  view,
  cell,
}: {
  view: { board: string; active: ActivePieceData | null };
  cell: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const w = BOARD_WIDTH * cell;
  const h = VISIBLE_ROWS * cell;
  useEffect(() => {
    // HiDPI（P2-7）：对手小板与主棋盘同样按 devicePixelRatio 放大 backing store，
    // 否则高分屏下小格被拉成模糊色块（看不清对手堆叠）
    const ctx = hiDpiCanvas(ref.current, w, h);
    if (ctx) drawOpponentBoard(ctx, view.board, view.active, cell);
  }, [view, cell, w, h]);
  // CSS 尺寸固定为逻辑尺寸，backing store 由 hiDpiCanvas 按 DPR 设置
  return <canvas ref={ref} width={w} height={h} style={{ width: w, height: h }} />;
}

/** 宽屏对手列（≤3 个小板 + 行数/状态/攻击预警） */
function Opponents({ selfSeatId }: { selfSeatId: number | null }) {
  const opponents = useRoomStore((s) => s.opponents);
  const room = useRoomStore((s) => s.room);
  const list = Object.values(opponents).filter((o) => o.seatId !== selfSeatId);
  if (list.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {list.map((o) => {
        const seat = room?.seats.find((s) => s.seatId === o.seatId);
        return (
          <div key={o.seatId} className="rounded-lg border border-slate-700 bg-slate-800/60 p-1">
            <div className="mb-1 flex items-center justify-between gap-1 text-[11px]">
              <span className="truncate font-semibold">{seat?.nickname ?? `座位${o.seatId}`}</span>
              <span className="shrink-0 font-mono text-slate-400">
                {o.lines}
                {o.status === 'finished' && ' ✓'}
                {o.status === 'eliminated' && <span className="text-rose-400"> 淘汰</span>}
                {o.status === 'abandoned' && ' ✗'}
              </span>
            </div>
            {(o.pendingGarbage ?? 0) > 0 && (
              <div className="mb-1 text-right text-[11px] font-semibold text-rose-400">
                ⚠ +{o.pendingGarbage}
              </div>
            )}
            <OpponentCanvas view={o} cell={MINI_CELL} />
          </div>
        );
      })}
    </div>
  );
}

/** 窄屏对手条（横排缩略板，可横向滚动；分屏/竖屏用） */
function OpponentsStrip({ selfSeatId }: { selfSeatId: number | null }) {
  const opponents = useRoomStore((s) => s.opponents);
  const room = useRoomStore((s) => s.room);
  const list = Object.values(opponents).filter((o) => o.seatId !== selfSeatId);
  if (list.length === 0) return null;
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-0.5">
      {list.map((o) => {
        const seat = room?.seats.find((s) => s.seatId === o.seatId);
        return (
          <div key={o.seatId} className="shrink-0 rounded border border-slate-700 bg-slate-800/60 p-1">
            <div className="mb-0.5 flex items-center gap-1 text-[10px] leading-none">
              <span className="max-w-[46px] truncate font-semibold">{seat?.nickname ?? `座位${o.seatId}`}</span>
              <span className="font-mono text-slate-400">{o.lines}</span>
              {o.status === 'eliminated' && <span className="text-rose-400">淘汰</span>}
              {o.status === 'abandoned' && <span>✗</span>}
              {(o.pendingGarbage ?? 0) > 0 && <span className="text-rose-400">⚠{o.pendingGarbage}</span>}
            </div>
            <OpponentCanvas view={o} cell={5} />
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="leading-tight">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className="font-mono">{value}</div>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'rose' | 'amber' | 'sky'; children: React.ReactNode }) {
  const cls =
    tone === 'rose'
      ? 'bg-rose-900/70 text-rose-200'
      : tone === 'amber'
        ? 'bg-amber-700/80 text-amber-100'
        : 'bg-sky-800/80 text-sky-100';
  return <div className={`rounded-lg px-3 py-1 text-xs font-semibold ${cls}`}>{children}</div>;
}

function ResultOverlay({ isHost, onExit }: { isHost: boolean; onExit: () => void }) {
  const result = useRoomStore((s) => s.result);
  const room = useRoomStore((s) => s.room);
  const selfSeatId = useRoomStore((s) => s.selfSeatId);
  if (!result) return null;
  const nameOf = (entry: (typeof result.ranking)[number]): string =>
    entry.nickname ??
    room?.seats.find((s) => s.seatId === entry.seatId)?.nickname ??
    `座位${entry.seatId}`;
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[90dvh] w-full max-w-[420px] overflow-y-auto rounded-xl bg-slate-800 p-6 text-center">
        <div className="text-2xl font-bold">{result.reason === 'timeout' ? '时间到！' : '完赛！'}</div>
        <div className="mt-4 text-left text-sm">
          {[...result.ranking]
            .sort((a, b) => a.rank - b.rank)
            .map((r) => (
              <div
                key={r.seatId}
                className={`flex justify-between rounded px-2 py-1 ${r.seatId === selfSeatId ? 'bg-emerald-900/40 text-emerald-300' : ''}`}
              >
                <span>
                  第{r.rank}名 · {nameOf(r)}
                  {r.seatId === selfSeatId ? '（我）' : ''}
                </span>
                <span className="font-mono">
                  {result.mode === 'survival'
                    ? r.status === 'abandoned'
                      ? '放弃'
                      : r.timeMs != null
                        ? `${formatTime(r.timeMs)} 淘汰`
                        : '存活'
                    : result.mode === 'timed'
                      ? r.status === 'abandoned'
                        ? '放弃'
                        : `${(r.score ?? 0).toLocaleString()} 分 · ${r.lines} 行`
                      : r.timeMs != null
                        ? formatTime(r.timeMs)
                        : `${r.lines} 行`}
                </span>
              </div>
            ))}
        </div>
        <div className="mt-6 flex justify-center gap-3">
          {isHost ? (
            <button
              onClick={() => net.send('room.rematch', {})}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500"
            >
              再来一局
            </button>
          ) : (
            <span className="self-center text-sm text-slate-400">等待房主开始下一局…</span>
          )}
          <button
            onClick={onExit}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600"
          >
            返回大厅
          </button>
        </div>
      </div>
    </div>
  );
}
