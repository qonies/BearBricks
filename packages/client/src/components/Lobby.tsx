// 大厅（FR-1.3）：单人模式 / 创建房间 / 房间码加入 / 快速匹配 / 设置
import { useState } from 'react';
import { ROOM_CODE_SCHEMA } from '@bearbricks/shared';
import { net } from '../net/netClient';
import { loadIdentity, saveNickname } from '../net/identity';
import { useRoomStore } from '../store/room';
import { useSettings } from '../store/settings';
import type { LocalMode } from '../game/engineRunner';

export function Lobby({
  onSingle,
  onSettings,
}: {
  onSingle: (mode: LocalMode) => void;
  onSettings: () => void;
}) {
  const [nickname, setNickname] = useState(loadIdentity().nickname);
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [code, setCode] = useState('');
  const settings = useSettings();

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
    <div className="flex min-h-[100dvh] w-full flex-col items-center gap-5 overflow-y-auto bg-slate-900 px-4 py-6 text-slate-100" style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top))' }}>
      <div>
        <h1 className="text-4xl font-black tracking-widest text-emerald-400 sm:text-5xl">BEARBRICKS</h1>
        <p className="mt-2 text-center text-sm text-slate-400">浏览器多人俄罗斯方块对战</p>
      </div>

      <div className="flex w-full max-w-[560px] flex-col gap-3 sm:flex-row">
        <button
          onClick={() => onSingle('marathon')}
          className="w-full rounded-2xl border border-slate-700 bg-slate-800 p-5 text-left transition hover:border-emerald-500 hover:bg-slate-700 sm:w-1/2"
        >
          <div className="text-xl font-bold">马拉松 Marathon</div>
          <div className="mt-1 text-sm text-slate-400">单人 · 无限模式 · 顶出结束</div>
        </button>
        <button
          onClick={() => onSingle('sprint')}
          className="w-full rounded-2xl border border-slate-700 bg-slate-800 p-5 text-left transition hover:border-emerald-500 hover:bg-slate-700 sm:w-1/2"
        >
          <div className="text-xl font-bold">竞速 Sprint 40</div>
          <div className="mt-1 text-sm text-slate-400">单人 · 最先清除 40 行 · 计时挑战</div>
        </button>
      </div>

      <div className="w-full max-w-[560px] rounded-2xl border border-slate-700 bg-slate-800/60 p-5">
        <div className="mb-3 text-lg font-bold text-emerald-400">多人对战</div>

        <label className="mb-3 flex items-center justify-between text-sm">
          <span className="text-slate-300">昵称（≤12 字符）</span>
          <input
            value={nickname}
            maxLength={12}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
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
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
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

      <div className="flex w-full max-w-[560px] items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-sm">
        <div className="min-w-0">
          <div className="font-semibold text-slate-300">设置</div>
          <div className="truncate text-xs text-slate-500">
            键位 · 触控 · 手感 · 音效（DAS {settings.das}ms / ARR {settings.arr}ms / Ghost{' '}
            {settings.ghost ? '开' : '关'}）
          </div>
        </div>
        <button
          onClick={onSettings}
          className="shrink-0 rounded-lg bg-slate-700 px-4 py-2 font-semibold hover:bg-slate-600"
        >
          打开设置
        </button>
      </div>
    </div>
  );
}
