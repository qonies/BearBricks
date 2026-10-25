// 设置内容（FR-11.1 / FR-12.1 / FR-12.2，技术设计 §5.6）
// 同一份内容有两种外壳：SettingsView（大厅进入的独立屏）与 SettingsOverlay（对局内模态）。
// 对局内打开设置不暂停联机对局（服务端权威照常跑），单人仍由 Esc 控制暂停。

import { useEffect, useState } from 'react';
import {
  ACTION_LABELS,
  INPUT_ACTIONS,
  assignKey,
  findKeyOwner,
  keyLabel,
  keymapLabel,
  type InputAction,
} from '../input/keymap';
import { useSettings } from '../store/settings';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
      <h2 className="mb-2 text-sm font-semibold text-emerald-400">{title}</h2>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <div className="min-w-0">
        <div className="text-slate-200">{label}</div>
        {hint && <div className="text-xs text-slate-500">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

const selectClass = 'rounded bg-slate-700 px-2 py-1 text-slate-100';

export function SettingsPanel() {
  const settings = useSettings();
  const { update, reset } = settings;
  const [capturing, setCapturing] = useState<InputAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 改键捕获：capture 阶段拦截并 stopPropagation，避免同时触发对局输入
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Dead') return;
      const owner = findKeyOwner(settings.keymap, e.key);
      update({ keymap: assignKey(settings.keymap, capturing, e.key) });
      setNotice(
        owner && owner !== capturing
          ? `${keyLabel(e.key)} 原属「${ACTION_LABELS[owner]}」，已改绑到「${ACTION_LABELS[capturing]}」`
          : null,
      );
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, settings.keymap, update]);

  return (
    <div className="flex flex-col gap-3">
      <Section title="操作（键盘 · 点击「改键」后按下新键）">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {INPUT_ACTIONS.map((action) => (
            <div key={action} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-slate-300">{ACTION_LABELS[action]}</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-slate-400">{keymapLabel(settings.keymap, action)}</span>
                <button
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    setCapturing(action);
                  }}
                  className={`rounded px-2 py-1 text-xs ${
                    capturing === action ? 'bg-amber-600 text-white' : 'bg-slate-700 hover:bg-slate-600'
                  }`}
                >
                  {capturing === action ? '按键…' : '改键'}
                </button>
              </div>
            </div>
          ))}
        </div>
        {notice && <div className="text-xs text-amber-400">{notice}</div>}
        <div className="text-xs text-slate-500">
          提示：Esc 同时是「暂停 / 设置」键；单人对局中 Esc 暂停，联机对局中 Esc 打开设置面板。
        </div>
      </Section>

      <Section title="触控（iPad / 平板）">
        <Row label="输入形态" hint="自动 = 检测到触屏才显示虚拟按键">
          <select
            value={settings.inputMode}
            onChange={(e) => update({ inputMode: e.target.value as typeof settings.inputMode })}
            className={selectClass}
          >
            <option value="auto">自动</option>
            <option value="touch">始终显示触控键</option>
            <option value="keyboard">仅键盘</option>
          </select>
        </Row>
        <Row label="按键布局" hint="移动键簇的位置（左右手）">
          <select
            value={settings.touchLayout}
            onChange={(e) => update({ touchLayout: e.target.value as typeof settings.touchLayout })}
            className={selectClass}
          >
            <option value="left">移动键在左</option>
            <option value="right">移动键在右</option>
          </select>
        </Row>
        <Row label="按键尺寸">
          <select
            value={String(settings.touchScale)}
            onChange={(e) => update({ touchScale: Number(e.target.value) })}
            className={selectClass}
          >
            <option value="0.9">小</option>
            <option value="1">中</option>
            <option value="1.15">大</option>
          </select>
        </Row>
        <Row label="按键不透明度">
          <input
            type="range"
            min={0.4}
            max={1}
            step={0.05}
            value={settings.touchOpacity}
            onChange={(e) => update({ touchOpacity: Number(e.target.value) })}
            className="w-32"
          />
          <span className="w-10 text-right font-mono text-xs text-slate-400">
            {Math.round(settings.touchOpacity * 100)}%
          </span>
        </Row>
        <Row label="棋盘手势" hint="轻点旋转 / 横滑移动 / 下滑落子 / 上滑 Hold">
          <input
            type="checkbox"
            checked={settings.gestures}
            onChange={(e) => update({ gestures: e.target.checked })}
          />
        </Row>
        <Row label="轻点动作">
          <select
            value={settings.gestureTap}
            onChange={(e) => update({ gestureTap: e.target.value as typeof settings.gestureTap })}
            className={selectClass}
          >
            <option value="rotCW">顺时针旋转</option>
            <option value="rotCCW">逆时针旋转</option>
          </select>
        </Row>
        <Row label="下滑动作">
          <select
            value={settings.gestureDown}
            onChange={(e) => update({ gestureDown: e.target.value as typeof settings.gestureDown })}
            className={selectClass}
          >
            <option value="hard">硬降</option>
            <option value="soft">软降（逐格）</option>
          </select>
        </Row>
      </Section>

      <Section title="手感">
        <Row label="DAS（ms）" hint="按住后开始自动重复的延迟">
          <input
            type="number"
            inputMode="numeric"
            min={50}
            max={400}
            value={settings.das}
            onChange={(e) => update({ das: Math.min(400, Math.max(50, Number(e.target.value) || 133)) })}
            className="w-20 rounded bg-slate-700 px-2 py-1 text-right font-mono"
          />
        </Row>
        <Row label="ARR（ms，0 = 瞬间）" hint="自动重复间隔">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={200}
            value={settings.arr}
            onChange={(e) => update({ arr: Math.min(200, Math.max(0, Number(e.target.value) || 0)) })}
            className="w-20 rounded bg-slate-700 px-2 py-1 text-right font-mono"
          />
        </Row>
        <Row label="显示 Ghost">
          <input
            type="checkbox"
            checked={settings.ghost}
            onChange={(e) => update({ ghost: e.target.checked })}
          />
        </Row>
      </Section>

      <Section title="音效（音量已持久化，音效本体随 M6 上线）">
        <Row label="音效音量">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.soundVolume}
            onChange={(e) => update({ soundVolume: Number(e.target.value) })}
            className="w-32"
          />
          <span className="w-10 text-right font-mono text-xs text-slate-400">
            {Math.round(settings.soundVolume * 100)}%
          </span>
        </Row>
        <Row label="音乐音量">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.musicVolume}
            onChange={(e) => update({ musicVolume: Number(e.target.value) })}
            className="w-32"
          />
          <span className="w-10 text-right font-mono text-xs text-slate-400">
            {Math.round(settings.musicVolume * 100)}%
          </span>
        </Row>
      </Section>

      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">设置保存在本机浏览器（localStorage）</span>
        <button
          type="button"
          onClick={() => {
            reset();
            setNotice('已恢复默认设置');
          }}
          className="rounded bg-slate-700 px-3 py-1.5 text-sm hover:bg-slate-600"
        >
          恢复默认
        </button>
      </div>
    </div>
  );
}

export function SettingsView({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-slate-900 text-slate-100">
      <header
        className="flex items-center justify-between px-4 py-3"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <h1 className="text-xl font-bold">设置</h1>
        <button onClick={onBack} className="rounded-lg bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600">
          返回
        </button>
      </header>
      <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-4 pb-10">
        <SettingsPanel />
      </div>
    </div>
  );
}

/** 对局内设置模态（FR-12.2：联机不暂停；打开时调用方负责释放按住输入） */
export function SettingsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-3">
      <div className="mx-auto my-4 w-full max-w-xl rounded-xl border border-slate-700 bg-slate-800 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-lg font-bold">设置</div>
          <button onClick={onClose} className="rounded bg-slate-700 px-3 py-1.5 text-sm hover:bg-slate-600">
            关闭
          </button>
        </div>
        <SettingsPanel />
      </div>
    </div>
  );
}
