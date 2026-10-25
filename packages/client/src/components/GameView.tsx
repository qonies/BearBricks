// 游戏屏（FR-3 / FR-11.2 / FR-12.2）：己方大板 + Hold/Next + HUD + 暂停/结算覆盖层
// 单人本地权威（技术设计 §5.5）：rAF 固定 60Hz 驱动 shared/engine，Esc 或按钮暂停冻结重力与锁定延迟。
// iPad（技术设计 §5.6）：格子按视口自适应、屏上触控键 + 手势、设置面板（改键 / 触控 / 音量）。

import { useEffect, useMemo, useRef, useState } from 'react';
import { BOARD_WIDTH, HIDDEN_ROWS, NEXT_PREVIEW_COUNT, TOTAL_HEIGHT } from '@bearbricks/shared';
import { EngineRunner, type LocalMode } from '../game/engineRunner';
import { ClearFxTracker } from '../game/clearFx';
import { drawBoard, drawMini, drawMiniRow, hiDpiCanvas } from '../game/render';
import { useFitCell, useMediaQuery, useShowTouchControls } from '../game/viewport';
import { useSettings } from '../store/settings';
import { InputRouter } from '../input/router';
import { useGameInput } from '../input/useGameInput';
import { TouchControls } from './TouchControls';
import { SettingsOverlay } from './SettingsPanel';

const VISIBLE_ROWS = TOTAL_HEIGHT - HIDDEN_ROWS;

interface HudData {
  score: number;
  lines: number;
  level: number;
  combo: number;
  b2b: boolean;
  elapsedMs: number;
  status: 'running' | 'finished';
  finishTimeMs: number | null;
  topOut: boolean;
}

function bestKey(mode: LocalMode): string {
  return mode === 'sprint' ? 'bearbricks.best.sprint40' : 'bearbricks.best.marathon';
}

function readBest(mode: LocalMode): number | null {
  // localStorage 在隐私模式/被禁用/配额异常时会抛异常（P2-6）：最佳成绩读不到不该炸掉整个对局屏
  try {
    const raw = localStorage.getItem(bestKey(mode));
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** 写入最佳成绩：失败（隐私模式/配额）只影响"下次还显示旧纪录"，不能中断对局结束流程 */
function writeBest(mode: LocalMode, value: number): void {
  try {
    localStorage.setItem(bestKey(mode), String(value));
  } catch {
    // ignore
  }
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 10);
  const cs = total % 100;
  const s = Math.floor(total / 100) % 60;
  const m = Math.floor(total / 6000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

const INITIAL_HUD: HudData = {
  score: 0,
  lines: 0,
  level: 1,
  combo: 0,
  b2b: false,
  elapsedMs: 0,
  status: 'running',
  finishTimeMs: null,
  topOut: false,
};

export function GameView({
  mode,
  onExit,
  onRestart,
}: {
  mode: LocalMode;
  onExit: () => void;
  onRestart: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const holdRef = useRef<HTMLCanvasElement | null>(null);
  const nextRef = useRef<HTMLCanvasElement | null>(null);
  const boardWrapRef = useRef<HTMLDivElement | null>(null);
  const runnerRef = useRef<EngineRunner | null>(null);
  const [hud, setHud] = useState<HudData>(INITIAL_HUD);
  const [paused, setPaused] = useState(false);
  const [best, setBest] = useState<number | null>(() => readBest(mode));
  const [newRecord, setNewRecord] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const wide = useMediaQuery('(min-width: 640px)');
  const showTouch = useShowTouchControls();
  // 格子尺寸由可用容器反推：旋转/分屏只改变量，**不进下面的 effect 依赖**（否则重建 runner 丢棋局）
  const cell = useFitCell(boardWrapRef, { cols: BOARD_WIDTH, rows: VISIBLE_ROWS, min: 12, max: 34 });
  const cellRef = useRef(cell);
  cellRef.current = cell;
  const wideRef = useRef(wide);
  wideRef.current = wide;
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;

  const router = useMemo(() => new InputRouter(() => runnerRef.current), []);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const runner = new EngineRunner(mode, {
      das: useSettings.getState().das,
      arr: useSettings.getState().arr,
    });
    runnerRef.current = runner;
    // 消行三闪动画（纯视觉层）
    const clearFx = new ClearFxTracker(runner.game);
    const unsubSettings = useSettings.subscribe((s) => {
      runner.setTiming(s.das, s.arr);
    });

    let finishHandled = false;
    runner.onFinish = () => {
      if (finishHandled) return;
      finishHandled = true;
      const g = runner.game;
      if (mode === 'sprint' && g.finishTimeMs != null) {
        const prev = readBest('sprint');
        if (prev == null || g.finishTimeMs < prev) {
          writeBest('sprint', g.finishTimeMs);
          setBest(g.finishTimeMs);
          setNewRecord(true);
        }
      } else if (mode === 'marathon') {
        const prev = readBest('marathon');
        if (prev == null || g.score > prev) {
          writeBest('marathon', g.score);
          setBest(g.score);
          setNewRecord(true);
        }
      }
    };

    let lastSig = '';
    let lastHudPush = 0;
    const onFrame = (): void => {
      const g = runner.game;
      const now = performance.now();
      clearFx.update(g, now);
      const c = cellRef.current;
      const ctx = hiDpiCanvas(canvasRef.current, BOARD_WIDTH * c, VISIBLE_ROWS * c);
      if (ctx) drawBoard(ctx, g, c, useSettings.getState().ghost, clearFx.frame(now) ?? undefined);
      if (wideRef.current) {
        const holdCtx = hiDpiCanvas(holdRef.current, 96, 52);
        if (holdCtx) drawMini(holdCtx, [g.hold], 20, 96, 52);
        const nextCtx = hiDpiCanvas(nextRef.current, 96, 230);
        if (nextCtx) drawMini(nextCtx, g.queue.slice(0, NEXT_PREVIEW_COUNT), 20, 96, 230);
      } else {
        const holdCtx = hiDpiCanvas(holdRef.current, 64, 36);
        if (holdCtx) drawMini(holdCtx, [g.hold], 14, 64, 36);
        const nextCtx = hiDpiCanvas(nextRef.current, 126, 36);
        if (nextCtx) drawMiniRow(nextCtx, g.queue.slice(0, 3), 14, 126, 36);
      }
      // HUD 节流：数值变化立即更新，计时器最多 10Hz（TC-PERF-004，避免 60 次/秒重渲染）
      const sig = `${g.score}|${g.lines}|${g.level}|${g.combo}|${g.b2bActive}|${g.status}|${g.finishTimeMs}|${g.topOut}`;
      if (sig !== lastSig || now - lastHudPush > 100) {
        lastSig = sig;
        lastHudPush = now;
        setHud({
          score: g.score,
          lines: g.lines,
          level: g.level,
          combo: g.combo,
          b2b: g.b2bActive,
          elapsedMs: g.elapsedMs,
          status: g.status,
          finishTimeMs: g.finishTimeMs,
          topOut: g.topOut,
        });
      }
    };
    runner.start(onFrame);

    return () => {
      runner.stop();
      unsubSettings();
      runnerRef.current = null;
    };
  }, [mode]);

  /** 设置弹层自动暂停标记：关闭时只恢复由设置触发的暂停 */
  const settingsAutoPausedRef = useRef(false);

  const applyPaused = (next: boolean): void => {
    const runner = runnerRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (runner) runner.paused = next;
    if (next) router.releaseAll();
  };

  const togglePause = (): void => {
    const runner = runnerRef.current;
    const next = !pausedRef.current && runner?.game.status !== 'finished';
    applyPaused(next);
  };

  // 单人设置弹层：自动暂停（关闭时只恢复由设置触发的暂停），避免调 DAS/键位时棋子继续下落
  useEffect(() => {
    if (settingsOpen) {
      if (!pausedRef.current && runnerRef.current?.game.status === 'running') {
        settingsAutoPausedRef.current = true;
        applyPaused(true);
      } else {
        settingsAutoPausedRef.current = false;
      }
      router.releaseAll();
    } else if (settingsAutoPausedRef.current) {
      settingsAutoPausedRef.current = false;
      applyPaused(false);
    }
  }, [settingsOpen, router]);

  useGameInput({
    router,
    canInput: () => {
      const r = runnerRef.current;
      return !!r && !r.paused && r.game.status === 'running' && !settingsOpenRef.current;
    },
    getCellPx: () => cellRef.current,
    onPause: () => {
      if (settingsOpenRef.current) setSettingsOpen(false);
      else togglePause();
    },
    surfaceRef: boardWrapRef,
  });

  const isSprint = mode === 'sprint';
  const timeText = formatTime(isSprint ? (hud.finishTimeMs ?? hud.elapsedMs) : hud.elapsedMs);
  const interactive = !settingsOpen && hud.status === 'running';

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-slate-900 text-slate-100">
      <header
        className="flex items-center justify-between gap-2 px-3 pb-1"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
      >
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-base font-bold sm:text-lg">
            {isSprint ? 'Sprint 40' : 'Marathon'}
          </span>
          <span className="font-mono text-sm sm:text-xl">{timeText}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs sm:text-sm">
          <button
            type="button"
            onClick={togglePause}
            className="rounded-lg bg-slate-700 px-2.5 py-2 hover:bg-slate-600"
          >
            {paused ? '继续' : '暂停'}
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
            退出
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-2 px-2">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
          {!wide && (
            <div className="flex items-center gap-1.5">
              <div className="rounded border border-slate-700 bg-slate-800/60 p-1">
                <canvas ref={holdRef} style={{ width: 64, height: 36 }} />
              </div>
              <div className="rounded border border-slate-700 bg-slate-800/60 p-1">
                <canvas ref={nextRef} style={{ width: 126, height: 36 }} />
              </div>
              <div className="ml-auto flex gap-2 text-right text-xs">
                <Stat label={isSprint ? '行' : '分'} value={isSprint ? `${hud.lines}/40` : hud.score} />
                <Stat label="级" value={hud.level} />
                <Stat label="最佳" value={best ?? '--'} />
              </div>
            </div>
          )}
          <div ref={boardWrapRef} className="game-surface flex min-h-0 flex-1 items-center justify-center">
            <canvas
              ref={canvasRef}
              style={{ width: BOARD_WIDTH * cell, height: VISIBLE_ROWS * cell }}
              className="rounded-lg border border-slate-700"
            />
          </div>
          {wide && (
            <div className="text-center text-xs text-slate-500">键位可在「设置」中修改</div>
          )}
        </div>

        {wide && (
          <aside className="flex w-40 shrink-0 flex-col gap-2 py-1">
            <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-2">
              <div className="mb-1 text-xs text-slate-400">HOLD</div>
              <canvas ref={holdRef} style={{ width: 96, height: 52 }} />
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-2">
              <div className="mb-1 text-xs text-slate-400">NEXT</div>
              <canvas ref={nextRef} style={{ width: 96, height: 230 }} />
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-2 text-sm">
              <StatsBlock hud={hud} best={best} isSprint={isSprint} />
            </div>
          </aside>
        )}
      </div>

      {showTouch && (
        <div className="shrink-0 pt-1">
          <TouchControls router={router} disabled={!interactive} />
        </div>
      )}

      {settingsOpen && <SettingsOverlay onClose={() => setSettingsOpen(false)} />}

      {paused && hud.status === 'running' && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl bg-slate-800 p-6 text-center">
            <div className="text-2xl font-bold">已暂停</div>
            <div className="mt-2 text-sm text-slate-400">重力与锁定延迟已冻结</div>
            <div className="mt-4 flex justify-center gap-3">
              <button
                onClick={togglePause}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500"
              >
                继续
              </button>
              <button
                onClick={onExit}
                className="rounded-lg bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600"
              >
                返回大厅
              </button>
            </div>
          </div>
        </div>
      )}

      {hud.status === 'finished' && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-xl bg-slate-800 p-6 text-center">
            <div className="text-2xl font-bold">{hud.topOut ? '游戏结束' : isSprint && hud.finishTimeMs == null ? '时间到' : '完赛！'}</div>
            {isSprint ? (
              <div className="mt-3">
                <div className="text-sm text-slate-400">成绩</div>
                <div className="font-mono text-3xl">
                  {hud.finishTimeMs != null ? formatTime(hud.finishTimeMs) : '超时'}
                </div>
                <div className="mt-1 text-sm text-slate-400">
                  最佳 {best != null ? formatTime(best) : '--'}
                  {newRecord ? ' 🏆 新纪录' : ''}
                </div>
              </div>
            ) : (
              <div className="mt-3">
                <div className="font-mono text-3xl">{hud.score}</div>
                <div className="text-sm text-slate-400">
                  行数 {hud.lines} · 等级 {hud.level}
                </div>
                <div className="mt-1 text-sm text-slate-400">
                  最佳 {best ?? '--'}
                  {newRecord ? ' 🏆 新纪录' : ''}
                </div>
              </div>
            )}
            <div className="mt-6 flex justify-center gap-3">
              <button
                onClick={onRestart}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500"
              >
                再来一局
              </button>
              <button
                onClick={onExit}
                className="rounded-lg bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600"
              >
                返回大厅
              </button>
            </div>
          </div>
        </div>
      )}
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

function StatsBlock({
  hud,
  best,
  isSprint,
}: {
  hud: HudData;
  best: number | null;
  isSprint: boolean;
}) {
  return (
    <>
      {isSprint ? (
        <>
          <div className="flex justify-between">
            <span className="text-slate-400">行数</span>
            <span className="font-mono">{hud.lines}/40</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">最佳</span>
            <span className="font-mono">{best != null ? formatTime(best) : '--'}</span>
          </div>
        </>
      ) : (
        <>
          <div className="flex justify-between">
            <span className="text-slate-400">分数</span>
            <span className="font-mono">{hud.score}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">行数</span>
            <span className="font-mono">{hud.lines}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">等级</span>
            <span className="font-mono">{hud.level}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">最佳</span>
            <span className="font-mono">{best ?? '--'}</span>
          </div>
        </>
      )}
      {hud.combo >= 2 && <div className="mt-1 text-amber-400">Combo ×{hud.combo}</div>}
      {hud.b2b && <div className="text-amber-400">B2B</div>}
    </>
  );
}
