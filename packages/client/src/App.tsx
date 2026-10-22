import { useEffect, useState } from 'react';
import type {
  ErrorPayload,
  GameResultPayload,
  GameStartPayload,
  GameStateFullPayload,
  OtherSeatSnapshot,
  RoomState,
  WelcomePayload,
} from '@bearbricks/shared';
import { GameView } from './components/GameView';
import { GameViewMP } from './components/GameViewMP';
import { Lobby } from './components/Lobby';
import { RoomView } from './components/RoomView';
import { net, type NetStatus } from './net/netClient';
import { useRoomStore } from './store/room';
import type { LocalMode } from './game/engineRunner';

type Screen =
  | { name: 'lobby' }
  | { name: 'room' }
  | { name: 'game-sp'; mode: LocalMode; runId: number }
  | { name: 'game-mp' };

function Toast() {
  const toast = useRoomStore((s) => s.toast);
  const setToast = useRoomStore((s) => s.setToast);
  if (!toast) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm text-slate-100 shadow-lg">
      <span>{toast}</span>
      <button onClick={() => setToast(null)} className="text-slate-400 hover:text-slate-200">
        ×
      </button>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'lobby' });
  const [netStatus, setNetStatus] = useState<NetStatus>(net.status);

  const leaveRoom = (): void => {
    net.send('room.leave', {});
    useRoomStore.getState().setRoom(null);
    useRoomStore.getState().resetMp();
    setScreen({ name: 'lobby' });
  };

  useEffect(() => {
    net.connect();
    const offs = [
      net.on('room.state', (d) => {
        const p = d as { room?: RoomState; selfSeatId?: number };
        const store = useRoomStore.getState();
        store.setRoom(p.room ?? null, p.selfSeatId ?? null);
        // 创建/加入房间：从大厅进入房间屏（对局屏不受影响，避免 PLAYING 中被拽回）
        if (p.room) setScreen((s) => (s.name === 'lobby' ? { name: 'room' } : s));
        // 再来一局：FINISHED → WAITING 时从对战屏回到房间
        if (p.room?.phase === 'WAITING' && store.mpStart) {
          store.resetMp();
          setScreen((s) => (s.name === 'game-mp' ? { name: 'room' } : s));
        }
      }),
      net.on('welcome', (d) => {
        // 断线重连：welcome 携带身份与（resume 时的）房间态
        const p = d as WelcomePayload;
        const store = useRoomStore.getState();
        if (p.session.selfSeatId != null) store.setSelfSeatId(p.session.selfSeatId);
        if (p.room) {
          store.setRoom(p.room, p.session.selfSeatId ?? null);
          if (p.room.phase !== 'PLAYING') {
            // PLAYING 时等待紧随其后的 game.state.full 再重建对局
            setScreen((s) => (s.name === 'lobby' ? { name: 'room' } : s));
          }
        } else if (store.room) {
          // resume 失败/服务器重启（房间全丢）：按新会话处理，回大厅，避免卡死在对局画面
          store.setRoom(null);
          store.resetMp();
          setScreen({ name: 'lobby' });
        }
      }),
      net.on('game.state.full', (d) => {
        // 断线重连恢复：用全量态重建对局（seed + 权威快照 + seq 基线）
        const p = d as GameStateFullPayload;
        const store = useRoomStore.getState();
        store.setRoom(p.room, p.seatId);
        store.setResult(null);
        store.setCountdown(null);
        store.setMpStart({
          seed: p.seed,
          mode: p.room.settings.mode,
          targetLines: p.self.modeState.sprint?.target ?? 0,
          startTs: null,
          initial: p.self,
          initialSeq: p.seq,
        });
        setScreen({ name: 'game-mp' });
      }),
      // 对手快照（10Hz，变化才发）：驱动对手小板/分数/淘汰状态/待收垃圾预警（FR-11.2）
      net.on('game.snapshot.others', (d) => {
        const p = d as { seats?: OtherSeatSnapshot[] };
        if (Array.isArray(p.seats)) useRoomStore.getState().applyOthers(p.seats);
      }),
      net.on('room.countdown', (d) => {
        useRoomStore.getState().setCountdown((d as { seconds: number }).seconds);
      }),
      net.on('game.start', (d) => {
        const p = d as GameStartPayload;
        const self = useRoomStore.getState().selfSeatId;
        const seed = (self != null && p.seeds[String(self)]) || '';
        const store = useRoomStore.getState();
        store.setMpStart({ seed, mode: p.mode, targetLines: p.targetLines, startTs: p.startTs });
        store.setCountdown(null);
        store.setResult(null);
        setScreen({ name: 'game-mp' });
      }),
      net.on('game.result', (d) => {
        useRoomStore.getState().setResult(d as GameResultPayload);
      }),
      net.on('error', (d) => {
        const e = d as ErrorPayload;
        if (e.code === 'E4030' && e.reason === 'kicked') {
          useRoomStore.getState().setRoom(null);
          useRoomStore.getState().resetMp();
          useRoomStore.getState().setToast('你已被房主移出房间');
          setScreen({ name: 'lobby' });
          return;
        }
        if (e.code === 'E4010') {
          useRoomStore.getState().setRoom(null);
          useRoomStore.getState().resetMp();
          useRoomStore.getState().setToast('该身份已在其他窗口登录，本页已断开');
          setScreen({ name: 'lobby' });
          return;
        }
        if (e.code === 'E4040' || e.code === 'E4090') {
          useRoomStore.getState().setRoom(null);
          useRoomStore.getState().resetMp();
          setScreen({ name: 'lobby' });
        }
        if (e.code !== 'E4001') useRoomStore.getState().setToast(e.message || e.code);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => net.onStatus(setNetStatus), []);

  const netBanner =
    netStatus === 'reconnecting' ? (
      <div className="fixed inset-x-0 top-0 z-50 bg-amber-600/90 py-1 text-center text-sm font-semibold text-white">
        连接中断，正在重连…
      </div>
    ) : null;

  if (screen.name === 'lobby') {
    return (
      <>
        <Toast />
        {netBanner}
        <Lobby onSingle={(mode) => setScreen({ name: 'game-sp', mode, runId: 1 })} />
      </>
    );
  }

  if (screen.name === 'room') {
    return (
      <>
        <Toast />
        {netBanner}
        <RoomView onExit={leaveRoom} />
      </>
    );
  }

  if (screen.name === 'game-sp') {
    return (
      <GameView
        key={screen.runId}
        mode={screen.mode}
        onExit={() => setScreen({ name: 'lobby' })}
        onRestart={() =>
          setScreen((s) => (s.name === 'game-sp' ? { ...s, runId: s.runId + 1 } : s))
        }
      />
    );
  }

  return (
    <>
      <Toast />
      {netBanner}
      <GameViewMP onExit={leaveRoom} />
    </>
  );
}
