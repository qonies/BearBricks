// 多人对战屏（FR-11.2，M3）：己方板（乐观渲染+校正）+ 对手小板 + HUD + 攻击预警 + 聊天侧栏 + 结算
import { useEffect, useRef, useState } from 'react';
import {
  BOARD_WIDTH,
  HIDDEN_ROWS,
  TOTAL_HEIGHT,
  type ActivePieceData,
  type ChatMessagePayload,
  type GameAttackPayload,
  type SelfSnapshot,
} from '@bearbricks/shared';
import { net } from '../net/netClient';
import { NetGameRunner } from '../game/netGame';
import { drawBoard, drawMini, drawOpponentBoard } from '../game/render';
import { formatSystemMessage, type SystemCode } from '../i18n';
import { ChatPanel } from './ChatPanel';
import { useRoomStore } from '../store/room';
import { useSettings } from '../store/settings';

const CELL = 26;
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const holdRef = useRef<HTMLCanvasElement | null>(null);
  const nextRef = useRef<HTMLCanvasElement | null>(null);
  const [hud, setHud] = useState({
    lines: 0,
    level: 1,
    score: 0,
    elapsedMs: 0,
    selfAlive: true,
    timeLeftMs: 0,
    respawnLeftMs: 0,
    immuneLeftMs: 0,
  });
  const [survival, setSurvival] = useState({ aliveCount: 0, pending: 0 });
  const timedRef = useRef<TimedHudState | null>(null);
  const [attackFlash, setAttackFlash] = useState<{ from: string; lines: number } | null>(null);

  // 收到指向自己的攻击 → 短暂闪烁提示（game.attack，protocol §4）
  useEffect(() => {
    if (!attackFlash) return;
    const t = window.setTimeout(() => setAttackFlash(null), 2500);
    return () => window.clearTimeout(t);
  }, [attackFlash]);

  useEffect(() => {
    if (!mpStart) return;
    const settings = useSettings.getState();
    const runner = new NetGameRunner(mpStart.seed, mpStart.mode, mpStart.targetLines, {
      das: settings.das,
      arr: settings.arr,
      initialSeq: mpStart.initialSeq,
    });
    // 断线重连恢复：挂载前先应用 game.state.full 的权威快照（棋盘/elapsed/seq 基线）
    if (mpStart.initial) runner.resync(mpStart.initial);
    runner.onInput = (seq, action) => net.input(seq, action);
    runner.onSoftChange = (on) => net.soft(on);
    const unsubSettings = useSettings.subscribe((s) => runner.setTiming(s.das, s.arr));

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = BOARD_WIDTH * CELL * dpr;
    canvas.height = (TOTAL_HEIGHT - HIDDEN_ROWS) * CELL * dpr;
    ctx.scale(dpr, dpr);

    const offSelf = net.on('game.snapshot.self', (d) => {
      const snap = d as SelfSnapshot;
      runner.resync(snap);
      if (snap.modeState.survival) {
        setSurvival({
          aliveCount: snap.modeState.survival.aliveCount,
          pending: snap.modeState.survival.pendingGarbage,
        });
      }
      // timed（M4）：modeState.timed 驱动 HUD（剩余时间/复活倒计时/免伤）与本地复活同步
      if (snap.modeState.timed) {
        timedRef.current = snap.modeState.timed;
        runner.syncTimed(snap.modeState.timed);
      }
    });

    // 聊天（FR-9）：用户消息 + 系统消息（i18n key 渲染）
    const offChatMsg = net.on('chat.message', (d) => {
      const p = d as ChatMessagePayload;
      useRoomStore.getState().appendChat({
        kind: 'user',
        seatId: p.seatId,
        nickname: p.nickname,
        text: p.text,
        ts: p.ts,
      });
    });
    const offChatSys = net.on('chat.system', (d) => {
      const p = d as { code: SystemCode; params?: Record<string, string | number> };
      useRoomStore.getState().appendChat({
        kind: 'system',
        text: formatSystemMessage(p.code, p.params),
        ts: Date.now(),
      });
    });
    // 攻击指示：指向自己的攻击闪烁提示
    const offAttack = net.on('game.attack', (d) => {
      const p = d as GameAttackPayload;
      const st = useRoomStore.getState();
      if (st.selfSeatId == null || !p.targets.includes(st.selfSeatId)) return;
      const from = st.room?.seats.find((s) => s.seatId === p.fromSeat)?.nickname;
      setAttackFlash({ from: from ?? `座位${p.fromSeat}`, lines: p.lines });
    });

    let lastSig = '';
    let lastHudPush = 0;
    const onFrame = (): void => {
      const g = runner.game;
      drawBoard(ctx, g, CELL, useSettings.getState().ghost);
      const holdCtx = holdRef.current?.getContext('2d');
      if (holdCtx) drawMini(holdCtx, [g.hold], 18);
      const nextCtx = nextRef.current?.getContext('2d');
      if (nextCtx) drawMini(nextCtx, g.queue.slice(0, 5), 18);
      const sig = `${g.lines}|${g.level}|${g.score}|${g.status}`;
      const now = performance.now();
      if (sig !== lastSig || now - lastHudPush > 100) {
        lastSig = sig;
        lastHudPush = now;
        const t = timedRef.current;
        setHud({
          lines: g.lines,
          level: g.level,
          score: g.score,
          elapsedMs: g.elapsedMs,
          selfAlive: g.status === 'running',
          timeLeftMs: t ? Math.max(0, t.endsAt - Date.now()) : 0,
          respawnLeftMs: t?.respawnAt != null ? Math.max(0, t.respawnAt - Date.now()) : 0,
          immuneLeftMs: t?.immuneUntil != null ? Math.max(0, t.immuneUntil - Date.now()) : 0,
        });
      }
    };
    runner.start(
      onFrame,
      mpStart.startTs != null
        ? { elapsedOffsetMs: Math.max(0, Date.now() - mpStart.startTs) }
        : undefined,
    );

    const releaseInputs = (): void => {
      runner.releaseAll();
      runner.setSoft(false);
    };
    const down = (e: KeyboardEvent): void => {
      // 聊天输入框聚焦时不拦截游戏键（FR-9.4，避免 Enter/空格等误触对局操作）
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      const k = e.key;
      if (
        ![
          'ArrowLeft',
          'ArrowRight',
          'ArrowDown',
          'ArrowUp',
          ' ',
          'x',
          'X',
          'z',
          'Z',
          'Control',
          'Shift',
          'c',
          'C',
        ].includes(k)
      )
        return;
      if (useRoomStore.getState().result) return; // 结算遮罩期间不再产生输入
      e.preventDefault();
      if (e.repeat) return;
      if (k === 'ArrowLeft') runner.pressDirection('L');
      else if (k === 'ArrowRight') runner.pressDirection('R');
      else if (k === 'ArrowDown') runner.setSoft(true);
      else if (k === 'ArrowUp' || k === 'x' || k === 'X') runner.apply('rotCW');
      else if (k === 'z' || k === 'Z' || k === 'Control') runner.apply('rotCCW');
      else if (k === ' ') runner.apply('hard');
      else runner.apply('hold'); // Shift / c / C
    };
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') runner.releaseDirection('L');
      else if (e.key === 'ArrowRight') runner.releaseDirection('R');
      else if (e.key === 'ArrowDown') runner.setSoft(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', releaseInputs);
    const onVisibility = (): void => {
      if (document.hidden) releaseInputs(); // 后台节流时释放按住的键（与单人版一致）
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      runner.stop();
      offSelf();
      offChatMsg();
      offChatSys();
      offAttack();
      unsubSettings();
      releaseInputs();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseInputs);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mpStart]);
  if (!mpStart) return null;
  const isHost = room != null && selfSeatId != null && room.hostSeat === selfSeatId;
  const isSurvival = mpStart.mode === 'survival';
  const isTimed = mpStart.mode === 'timed';
  const pendingRows = Math.min(survival.pending, 20);
  const selfEliminated = isSurvival && !hud.selfAlive;

  return (
    <div className="flex min-h-screen items-center justify-center gap-6 bg-slate-900 p-6 text-slate-100">
      <div className="flex flex-col items-center gap-3">
        <div className="flex w-[312px] items-baseline justify-between">
          <span className="text-lg font-bold">
            {isSurvival
              ? `生存淘汰 · 存活 ${survival.aliveCount}`
              : isTimed
                ? '限时赛'
                : `Sprint ${mpStart.targetLines}`}
          </span>
          <span className={`font-mono text-xl ${isTimed && hud.timeLeftMs <= 10_000 ? 'text-rose-400' : ''}`}>
            {isTimed ? formatClock(hud.timeLeftMs) : formatTime(hud.elapsedMs)}
          </span>
        </div>
        <div className="flex items-stretch gap-2">
          <canvas
            ref={canvasRef}
            style={{ width: BOARD_WIDTH * CELL, height: (TOTAL_HEIGHT - HIDDEN_ROWS) * CELL }}
            className="rounded-lg border border-slate-700"
          />
          {isSurvival && (
            <div
              className="flex w-4 flex-col-reverse items-stretch justify-start gap-px rounded border border-slate-700 bg-slate-950/60"
              title={`待接收垃圾行：${survival.pending}`}
            >
              {Array.from({ length: pendingRows }, (_, i) => (
                <div key={i} className="h-[12px] w-full flex-1 bg-rose-600" />
              ))}
            </div>
          )}
        </div>
        {selfEliminated && (
          <div className="rounded-lg bg-rose-900/60 px-4 py-1 text-sm font-semibold text-rose-300">
            你已被淘汰（观战中）
          </div>
        )}
        {isTimed && hud.respawnLeftMs > 0 && (
          <div className="rounded-lg bg-amber-700/80 px-4 py-1 text-sm font-semibold text-amber-100">
            复活倒计时 {(hud.respawnLeftMs / 1000).toFixed(1)}s
          </div>
        )}
        {isTimed && hud.respawnLeftMs <= 0 && hud.immuneLeftMs > 0 && (
          <div className="rounded-lg bg-sky-800/80 px-4 py-1 text-sm font-semibold text-sky-100">
            🛡 免伤中（{(hud.immuneLeftMs / 1000).toFixed(1)}s）
          </div>
        )}
        {attackFlash && (
          <div className="rounded-lg bg-rose-800/80 px-4 py-1 text-sm font-semibold text-rose-100">
            ⚔ {attackFlash.from} 向你发来 +{attackFlash.lines} 行垃圾！
          </div>
        )}
        <div className="text-xs text-slate-500">
          ←→ 移动 · ↑/X 顺旋 · Z/Ctrl 逆旋 · ↓ 软降 · Space 硬降 · Shift/C Hold
        </div>
      </div>

      <div className="flex w-44 flex-col gap-4">
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <div className="mb-1 text-xs text-slate-400">HOLD</div>
          <canvas ref={holdRef} width={96} height={48} />
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <div className="mb-1 text-xs text-slate-400">NEXT</div>
          <canvas ref={nextRef} width={96} height={210} />
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm">
          {isSurvival ? (
            <>
              <div className="flex justify-between">
                <span className="text-slate-400">存活</span>
                <span className="font-mono">{survival.aliveCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">消行</span>
                <span className="font-mono">{hud.lines}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">待收垃圾</span>
                <span className={`font-mono ${survival.pending > 0 ? 'text-rose-400' : ''}`}>
                  {survival.pending}
                </span>
              </div>
            </>
          ) : isTimed ? (
            <>
              <div className="flex justify-between">
                <span className="text-slate-400">剩余时间</span>
                <span className={`font-mono ${hud.timeLeftMs <= 10_000 ? 'text-rose-400' : ''}`}>
                  {formatClock(hud.timeLeftMs)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">得分</span>
                <span className="font-mono">{hud.score}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">消行</span>
                <span className="font-mono">{hud.lines}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">等级</span>
                <span className="font-mono">{hud.level}</span>
              </div>
            </>
          ) : (
            <>
              <div className="flex justify-between">
                <span className="text-slate-400">行数</span>
                <span className="font-mono">
                  {hud.lines}/{mpStart.targetLines}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">等级</span>
                <span className="font-mono">{hud.level}</span>
              </div>
            </>
          )}
        </div>
        <button
          onClick={onExit}
          className="rounded-lg bg-slate-700 px-3 py-2 text-sm hover:bg-slate-600"
        >
          离开对局
        </button>
      </div>

      <Opponents selfSeatId={selfSeatId} />
      <ChatPanel selfSeatId={selfSeatId} />
      {result && <ResultOverlay isHost={isHost} onExit={onExit} />}
    </div>
  );
}

function Opponents({ selfSeatId }: { selfSeatId: number | null }) {
  const opponents = useRoomStore((s) => s.opponents);
  const room = useRoomStore((s) => s.room);
  const list = Object.values(opponents).filter((o) => o.seatId !== selfSeatId);
  if (list.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {list.map((o) => {
        const seat = room?.seats.find((s) => s.seatId === o.seatId);
        return (
          <div key={o.seatId} className="rounded-lg border border-slate-700 bg-slate-800/60 p-2">
            <div className="mb-1 flex justify-between text-xs">
              <span className="font-semibold">{seat?.nickname ?? `座位${o.seatId}`}</span>
              <span className="font-mono text-slate-400">
                {o.lines}
                {o.status === 'finished' && ' ✓'}
                {o.status === 'eliminated' && <span className="text-rose-400"> 淘汰</span>}
                {o.status === 'abandoned' && ' ✗'}
              </span>
            </div>
            {(o.pendingGarbage ?? 0) > 0 && (
              <div className="mb-1 text-right text-xs font-semibold text-rose-400">
                ⚠ 即将+{o.pendingGarbage} 行
              </div>
            )}
            <OpponentCanvas view={o} />
          </div>
        );
      })}
    </div>
  );
}

function OpponentCanvas(props: { view: { board: string; active: ActivePieceData | null } }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const { view } = props;
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (ctx) drawOpponentBoard(ctx, view.board, view.active, MINI_CELL);
  }, [view]);
  return <canvas ref={ref} width={80} height={160} />;
}

function ResultOverlay(props: { isHost: boolean; onExit: () => void }) {
  const { isHost, onExit } = props;
  const result = useRoomStore((s) => s.result);
  const room = useRoomStore((s) => s.room);
  const selfSeatId = useRoomStore((s) => s.selfSeatId);
  if (!result) return null;
  const nameOf = (seatId: number): string =>
    room?.seats.find((s) => s.seatId === seatId)?.nickname ?? `座位${seatId}`;
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/70">
      <div className="w-[420px] rounded-xl bg-slate-800 p-8 text-center">
        <div className="text-2xl font-bold">
          {result.reason === 'timeout' ? '时间到！' : '完赛！'}
        </div>
        <div className="mt-4 text-left text-sm">
          {[...result.ranking]
            .sort((a, b) => a.rank - b.rank)
            .map((r) => (
              <div
                key={r.seatId}
                className={`flex justify-between rounded px-2 py-1 ${r.seatId === selfSeatId ? 'bg-emerald-900/40 text-emerald-300' : ''}`}
              >
                <span>
                  第{r.rank}名 · {nameOf(r.seatId)}
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
