// 游戏屏（FR-3 / FR-11.2 / FR-12.2）：己方大板 + Hold/Next + HUD + 暂停/结算覆盖层
// 单人本地权威（技术设计 §5.5）；Esc 暂停冻结重力与锁定延迟

import { useEffect, useRef, useState } from 'react';
import { BOARD_WIDTH, HIDDEN_ROWS, TOTAL_HEIGHT } from '@bearbricks/shared';
import { EngineRunner, type LocalMode } from '../game/engineRunner';
import { drawBoard, drawMini, hiDpiCanvas } from '../game/render';
import { useSettings } from '../store/settings';

const CELL = 30;

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
  const raw = localStorage.getItem(bestKey(mode));
  return raw == null ? null : Number(raw);
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
  const [hud, setHud] = useState<HudData>(INITIAL_HUD);
  const [paused, setPaused] = useState(false);
  const [best, setBest] = useState<number | null>(() => readBest(mode));

  useEffect(() => {
    const runner = new EngineRunner(mode, {
      das: useSettings.getState().das,
      arr: useSettings.getState().arr,
    });
    const unsubSettings = useSettings.subscribe((s) => {
      runner.setTiming(s.das, s.arr);
    });

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = BOARD_WIDTH * CELL * dpr;
    canvas.height = (TOTAL_HEIGHT - HIDDEN_ROWS) * CELL * dpr;
    ctx.scale(dpr, dpr);

    let finishHandled = false;
    runner.onFinish = () => {
      if (finishHandled) return;
      finishHandled = true;
      const g = runner.game;
      if (mode === 'sprint' && g.finishTimeMs != null) {
        const prev = readBest('sprint');
        if (prev == null || g.finishTimeMs < prev) {
          localStorage.setItem(bestKey('sprint'), String(g.finishTimeMs));
          setBest(g.finishTimeMs);
        }
      } else if (mode === 'marathon') {
        const prev = readBest('marathon');
        if (prev == null || g.score > prev) {
          localStorage.setItem(bestKey('marathon'), String(g.score));
          setBest(g.score);
        }
      }
    };

    let lastSig = '';
    let lastHudPush = 0;
    const onFrame = (): void => {
      const g = runner.game;
      drawBoard(ctx, g, CELL, useSettings.getState().ghost);
      const holdCtx = hiDpiCanvas(holdRef.current, 96, 52);
      if (holdCtx) drawMini(holdCtx, [g.hold], 20, 96, 52);
      const nextCtx = hiDpiCanvas(nextRef.current, 96, 230);
      if (nextCtx) drawMini(nextCtx, g.queue.slice(0, 5), 20, 96, 230);
      // HUD 节流：数值变化立即更新，计时器最多 10Hz（TC-PERF-004，避免 60 次/秒重渲染）
      const sig = `${g.score}|${g.lines}|${g.level}|${g.combo}|${g.b2bActive}|${g.status}|${g.finishTimeMs}|${g.topOut}`;
      const now = performance.now();
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

    const gameKeys = new Set([
      'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' ',
      'x', 'X', 'z', 'Z', 'Control', 'Shift', 'c', 'C', 'Escape',
    ]);
    const releaseInputs = (): void => {
      runner.releaseDirection('L');
      runner.releaseDirection('R');
      runner.setSoftDrop(false);
    };
    const down = (e: KeyboardEvent): void => {
      if (!gameKeys.has(e.key)) return;
      e.preventDefault();
      if (e.repeat) return; // 长按（含 Esc）不重复触发
      if (e.key === 'Escape') {
        setPaused((p) => {
          const next = !p && runner.game.status !== 'finished';
          runner.paused = next;
          return next;
        });
        return;
      }
      if (runner.paused || runner.game.status === 'finished') return;
      switch (e.key) {
        case 'ArrowLeft':
          runner.pressDirection('L');
          break;
        case 'ArrowRight':
          runner.pressDirection('R');
          break;
        case 'ArrowDown':
          runner.setSoftDrop(true);
          break;
        case 'ArrowUp':
        case 'x':
        case 'X':
          runner.apply('rotCW');
          break;
        case 'z':
        case 'Z':
        case 'Control':
          runner.apply('rotCCW');
          break;
        case ' ':
          runner.apply('hard');
          break;
        case 'Shift':
        case 'c':
        case 'C':
          runner.apply('hold');
          break;
      }
    };
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') runner.releaseDirection('L');
      else if (e.key === 'ArrowRight') runner.releaseDirection('R');
      else if (e.key === 'ArrowDown') runner.setSoftDrop(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', releaseInputs);
    const onVisibility = (): void => {
      if (document.hidden) releaseInputs();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      runner.stop();
      unsubSettings();
      releaseInputs();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseInputs);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mode]);

  const isSprint = mode === 'sprint';

  return (
    <div className="flex min-h-screen items-center justify-center gap-6 bg-slate-900 p-6 text-slate-100">
      <div className="flex flex-col items-center gap-3">
        <div className="flex w-[300px] items-baseline justify-between">
          <span className="text-lg font-bold">{isSprint ? 'Sprint 40' : 'Marathon'}</span>
          <span className="font-mono text-xl">
            {formatTime(isSprint ? (hud.finishTimeMs ?? hud.elapsedMs) : hud.elapsedMs)}
          </span>
        </div>
        <canvas
          ref={canvasRef}
          style={{ width: BOARD_WIDTH * CELL, height: (TOTAL_HEIGHT - HIDDEN_ROWS) * CELL }}
          className="rounded-lg border border-slate-700"
        />
        <div className="text-xs text-slate-500">
          ←→ 移动 · ↑/X 顺旋 · Z/Ctrl 逆旋 · ↓ 软降 · Space 硬降 · Shift/C Hold · Esc 暂停
        </div>
      </div>

      <div className="flex w-44 flex-col gap-4">
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <div className="mb-1 text-xs text-slate-400">HOLD</div>
          <canvas ref={holdRef} style={{ width: 96, height: 52 }} />
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <div className="mb-1 text-xs text-slate-400">NEXT</div>
          <canvas ref={nextRef} style={{ width: 96, height: 230 }} />
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm">
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
        </div>
        <button
          onClick={onExit}
          className="rounded-lg bg-slate-700 px-3 py-2 text-sm hover:bg-slate-600"
        >
          返回大厅
        </button>
      </div>

      {paused && hud.status === 'running' && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/60">
          <div className="rounded-xl bg-slate-800 p-8 text-center">
            <div className="text-2xl font-bold">已暂停</div>
            <div className="mt-2 text-sm text-slate-400">重力与锁定延迟已冻结 · 按 Esc 继续</div>
            <button
              onClick={onExit}
              className="mt-4 rounded-lg bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600"
            >
              返回大厅
            </button>
          </div>
        </div>
      )}

      {hud.status === 'finished' && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70">
          <div className="w-80 rounded-xl bg-slate-800 p-8 text-center">
            <div className="text-2xl font-bold">{hud.topOut ? '游戏结束' : '完赛！'}</div>
            {isSprint ? (
              <div className="mt-3">
                <div className="text-sm text-slate-400">成绩</div>
                <div className="font-mono text-3xl">
                  {hud.finishTimeMs != null ? formatTime(hud.finishTimeMs) : '超时'}
                </div>
                <div className="mt-1 text-sm text-slate-400">
                  最佳 {best != null ? formatTime(best) : '--'}
                  {best != null && hud.finishTimeMs != null && hud.finishTimeMs <= best ? ' 🏆 新纪录' : ''}
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
                  {best != null && hud.score >= best ? ' 🏆 新纪录' : ''}
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
