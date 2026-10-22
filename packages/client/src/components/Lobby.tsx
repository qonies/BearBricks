// 大厅（FR-1.3）：单人模式 / 创建房间 / 房间码加入 / 快速匹配 / 设置
import { useState } from 'react';
import { ROOM_CODE_SCHEMA } from '@bearbricks/shared';
import { net } from '../net/netClient';
import { loadIdentity, saveNickname } from '../net/identity';
import { useRoomStore } from '../store/room';
import { useSettings } from '../store/settings';
import type { LocalMode } from '../game/engineRunner';

export function Lobby({ onSingle }: { onSingle: (mode: LocalMode) => void }) {
  const [nickname, setNickname] = useState(loadIdentity().nickname);
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [code, setCode] = useState('');
  const { das, arr, ghost, update } = useSettings();

  /** 昵称落库；若发生变化则重建握手，让服务端以新昵称重新 hello（大厅场景不在房间内） */
  const commitNickname = (): void => {
    const prev = loadIdentity().nickname;
    saveNickname(nickname);
    const next = nickname.trim().slice(0, 12);
    if (next && next !== prev) net.rehandshake();
  };

  const join = (): void => {
    const normalized = code.trim().toUpperCase();
    if (!ROOM_CODE_SCHEMA.safeParse(normalized).success) {
      useRoomStore.getState().setToast('房间码为 6 位大写字母/数字（不含 0/O/1/I）');
      return;
    }
    net.send('room.join', { roomCode: normalized });
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-slate-900 text-slate-100">
      <div>
        <h1 className="text-5xl font-black tracking-widest text-emerald-400">BEARBRICKS</h1>
        <p className="mt-2 text-center text-sm text-slate-400">浏览器多人俄罗斯方块对战</p>
      </div>

      <div className="flex gap-6">
        <button
          onClick={() => onSingle('marathon')}
          className="w-56 rounded-2xl border border-slate-700 bg-slate-800 p-6 text-left transition hover:border-emerald-500 hover:bg-slate-700"
        >
          <div className="text-xl font-bold">马拉松 Marathon</div>
          <div className="mt-1 text-sm text-slate-400">单人 · 无限模式 · 顶出结束</div>
        </button>
        <button
          onClick={() => onSingle('sprint')}
          className="w-56 rounded-2xl border border-slate-700 bg-slate-800 p-6 text-left transition hover:border-emerald-500 hover:bg-slate-700"
        >
          <div className="text-xl font-bold">竞速 Sprint 40</div>
          <div className="mt-1 text-sm text-slate-400">单人 · 最先清除 40 行 · 计时挑战</div>
        </button>
      </div>

      <div className="w-[560px] rounded-2xl border border-slate-700 bg-slate-800/60 p-5">
        <div className="mb-3 text-lg font-bold text-emerald-400">多人对战</div>

        <label className="mb-3 flex items-center justify-between text-sm">
          <span className="text-slate-300">昵称（≤12 字符）</span>
          <input
            value={nickname}
            maxLength={12}
            onChange={(e) => setNickname(e.target.value)}
            onBlur={commitNickname}
            className="w-40 rounded bg-slate-700 px-2 py-1 text-right"
          />
        </label>

        <div className="mb-3 flex items-center justify-between text-sm">
          <span className="text-slate-300">创建房间</span>
          <div className="flex items-center gap-2">
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as 'public' | 'private')}
              className="rounded bg-slate-700 px-2 py-1"
            >
              <option value="public">公开（可快速匹配）</option>
              <option value="private">私密（仅房间码）</option>
            </select>
            <button
              onClick={() => net.send('room.create', { visibility })}
              className="rounded-lg bg-emerald-600 px-4 py-1.5 font-semibold hover:bg-emerald-500"
            >
              创建
            </button>
          </div>
        </div>
        <div className="mb-3 flex items-center justify-between text-sm">
          <span className="text-slate-300">房间码加入</span>
          <div className="flex items-center gap-2">
            <input
              value={code}
              maxLength={6}
              placeholder="ABC234"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && join()}
              className="w-28 rounded bg-slate-700 px-2 py-1 text-center font-mono tracking-widest"
            />
            <button
              onClick={join}
              className="rounded-lg bg-slate-700 px-4 py-1.5 font-semibold hover:bg-slate-600"
            >
              加入
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-300">快速匹配</span>
          <button
            onClick={() => net.send('room.quickMatch', {})}
            className="rounded-lg bg-slate-700 px-4 py-1.5 font-semibold hover:bg-slate-600"
          >
            匹配
          </button>
        </div>
      </div>

      <SettingsBlock das={das} arr={arr} ghost={ghost} update={update} />
    </div>
  );
}

function SettingsBlock(props: {
  das: number;
  arr: number;
  ghost: boolean;
  update: (patch: { das?: number; arr?: number; ghost?: boolean }) => void;
}) {
  const { das, arr, ghost, update } = props;
  return (
    <div className="w-[560px] rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-sm">
      <div className="mb-2 font-semibold text-slate-300">设置（localStorage 持久化）</div>
      <div className="flex gap-8">
        <label className="flex flex-1 items-center justify-between py-1">
          <span>DAS (ms)</span>
          <input
            type="number"
            min={50}
            max={400}
            value={das}
            onChange={(e) => update({ das: Math.min(400, Math.max(50, Number(e.target.value) || 133)) })}
            className="w-20 rounded bg-slate-700 px-2 py-1 text-right font-mono"
          />
        </label>
        <label className="flex flex-1 items-center justify-between py-1">
          <span>ARR (ms, 0=瞬间)</span>
          <input
            type="number"
            min={0}
            max={200}
            value={arr}
            onChange={(e) => update({ arr: Math.min(200, Math.max(0, Number(e.target.value) || 0)) })}
            className="w-20 rounded bg-slate-700 px-2 py-1 text-right font-mono"
          />
        </label>
        <label className="flex flex-1 items-center justify-between py-1">
          <span>显示 Ghost</span>
          <input type="checkbox" checked={ghost} onChange={(e) => update({ ghost: e.target.checked })} />
        </label>
      </div>
    </div>
  );
}
