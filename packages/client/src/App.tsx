import { useEffect, useState } from 'react';
import type {
  ChatMessagePayload,
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
import { SettingsView } from './components/SettingsPanel';
import { net, type NetStatus } from './net/netClient';
import { useRoomStore } from './store/room';
import { formatSystemMessage, type SystemCode } from './i18n';
import type { LocalMode } from './game/engineRunner';

type Screen =
  | { name: 'lobby' }
  | { name: 'room' }
  | { name: 'settings' }
  | { name: 'game-sp'; mode: LocalMode; runId: number }
  | { name: 'game-mp' };

function DisplacedOverlay() {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-sm rounded-xl bg-slate-800 p-6 text-center text-slate-100">
        <div className="text-xl font-bold">连接已断开</div>
        <div className="mt-2 text-sm text-slate-400">
          该身份已在其他窗口登录，或本页连接已被接管。为避免多标签互相顶号，本页不再自动重连。
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500"
        >
          刷新页面
        </button>
      </div>
    </div>
  );
}

function Toast() {
  const toast = useRoomStore((s) => s.toast);
  const setToast = useRoomStore((s) => s.setToast);
  if (!toast) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm text-slate-100 shadow-lg"
    >
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
  /** 连续建连失败次数：≥3 时给出"连不上"的可操作提示（P2-5，Origin/网络配置） */
  const [netFailures, setNetFailures] = useState(net.connectFailures);
  /** E4010 顶号/身份失效：进入终态，提示刷新（NetClient 不再自动重连） */
  const [displaced, setDisplaced] = useState(false);

  const leaveRoom = (): void => {
    net.send('room.leave', {});
    // 清除 resumeToken：断线重连时不得被 resume 拉回已退出的对局（P2-7）
    net.clearResumeToken();
    useRoomStore.getState().setRoom(null);
    useRoomStore.getState().resetMp();
    setScreen({ name: 'lobby' });
  };

  useEffect(() => {
    net.connect();
    /**
     * 房间态迁移统一入口：room.state 广播与 welcome 重连共用（H-3）。
     * 掉线期间房主 rematch/开新局时，welcome 可能带回 WAITING/COUNTDOWN；
     * 必须清掉旧 mpStart/result 并回房间，否则会卡在旧对局屏。
     */
    const applyRoom = (room: RoomState, selfSeatId: number | null): void => {
      const store = useRoomStore.getState();
      store.setRoom(room, selfSeatId);
      if (room.phase !== 'COUNTDOWN') store.setCountdown(null);
      if (store.mpStart && (room.phase === 'WAITING' || room.phase === 'COUNTDOWN')) {
        store.resetMp();
        setScreen((s) => (s.name === 'room' ? s : { name: 'room' }));
        return;
      }
      if (room.phase !== 'PLAYING') {
        // 创建/加入房间：从大厅进入房间屏；PLAYING 时等待 game.state.full 再重建对局
        setScreen((s) => (s.name === 'lobby' ? { name: 'room' } : s));
      }
    };
    const offs = [
      net.on('room.state', (d) => {
        const p = d as { room?: RoomState; selfSeatId?: number };
        if (p.room) applyRoom(p.room, p.selfSeatId ?? null);
        else useRoomStore.getState().setRoom(null, null);
      }),
      net.on('welcome', (d) => {
        // 断线重连：welcome 携带身份与（resume 时的）房间态；与 room.state 走同一迁移逻辑
        const p = d as WelcomePayload;
        const store = useRoomStore.getState();
        if (p.session.selfSeatId != null) store.setSelfSeatId(p.session.selfSeatId);
        if (p.room) applyRoom(p.room, p.session.selfSeatId ?? null);
        else if (store.room) {
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
          targetLines: p.self.modeState.sprint?.target ?? p.room.settings.targetLines ?? 0,
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
      // 聊天（FR-9）：App 级注册——等待房间/倒计时阶段的消息不因对局屏未挂载而丢失（P2-2）
      net.on('chat.message', (d) => {
        const m = d as ChatMessagePayload;
        useRoomStore.getState().appendChat({
          kind: 'user',
          seatId: m.seatId,
          nickname: m.nickname,
          text: m.text,
          ts: m.ts,
        });
      }),
      net.on('chat.system', (d) => {
        const m = d as { code: SystemCode; params?: Record<string, string | number> };
        useRoomStore.getState().appendChat({
          kind: 'system',
          text: formatSystemMessage(m.code, m.params),
          ts: Date.now(),
        });
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
          setDisplaced(true);
          return;
        }
        if (e.code === 'E4040' || e.code === 'E4090') {
          useRoomStore.getState().setRoom(null);
          useRoomStore.getState().resetMp();
          setScreen({ name: 'lobby' });
        }
        if (e.code !== 'E4001') useRoomStore.getState().setToast(e.message || e.code);
        else console.warn('[BearBricks] 协议消息被拒绝：', e.code, e.message);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(
    () =>
      net.onStatus((s, failures) => {
        setNetStatus(s);
        setNetFailures(failures);
      }),
    [],
  );

  // iPad/Safari：后台会节流定时器甚至挂起页面，退避重连可能停滞 → 回前台/恢复网络立即补一次
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') net.reconnectNow();
    };
    const onPageShow = (e: PageTransitionEvent): void => {
      if (e.persisted) net.reconnectNow(); // bfcache 恢复：页面状态陈旧，走 resume 拿全量态
    };
    const onOnline = (): void => net.reconnectNow();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  const netBanner =
    netStatus === 'reconnecting' ? (
      <div className="fixed inset-x-0 top-0 z-50 bg-amber-600/90 py-1 text-center text-sm font-semibold text-white">
        {netFailures >= 3
          ? '无法连接服务器：请检查网络；若是局域网/域名部署，需在服务器设置 ORIGIN（见 README 环境变量）。正在重试…'
          : '连接中断，正在重连…'}
      </div>
    ) : null;

  if (screen.name === 'lobby') {
    return (
      <>
        <Toast />
        {netBanner}
        {displaced && <DisplacedOverlay />}
        <Lobby
          onSingle={(mode) => setScreen({ name: 'game-sp', mode, runId: 1 })}
          onSettings={() => setScreen({ name: 'settings' })}
        />
      </>
    );
  }

  if (screen.name === 'room') {
    return (
      <>
        <Toast />
        {netBanner}
        {displaced && <DisplacedOverlay />}
        <RoomView onExit={leaveRoom} />
      </>
    );
  }

  if (screen.name === 'settings') {
    return (
      <>
        <Toast />
        {netBanner}
        {displaced && <DisplacedOverlay />}
        <SettingsView onBack={() => setScreen({ name: 'lobby' })} />
      </>
    );
  }

  if (screen.name === 'game-sp') {
    return (
      <>
        {displaced && <DisplacedOverlay />}
        <GameView
          key={screen.runId}
          mode={screen.mode}
          onExit={() => setScreen({ name: 'lobby' })}
          onRestart={() =>
            setScreen((s) => (s.name === 'game-sp' ? { ...s, runId: s.runId + 1 } : s))
          }
        />
      </>
    );
  }

  return (
    <>
      <Toast />
      {netBanner}
        {displaced && <DisplacedOverlay />}
      <GameViewMP onExit={leaveRoom} />
    </>
  );
}
