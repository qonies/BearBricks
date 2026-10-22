// 房间屏（FR-2）：座位 / 准备 / 房主控制 / 倒计时
import { useEffect, useState } from 'react';
import type { Difficulty } from '@bearbricks/shared';
import { net } from '../net/netClient';
import { useRoomStore } from '../store/room';

export function RoomView({ onExit }: { onExit: () => void }) {
  const room = useRoomStore((s) => s.room);
  const selfSeatId = useRoomStore((s) => s.selfSeatId);
  const countdown = useRoomStore((s) => s.countdown);
  const [botDifficulty, setBotDifficulty] = useState<Difficulty>('EASY');
  // 开局倒计时本地递减（服务端只发一次 seconds，客户端按秒倒数到 0）
  const [countdownLeft, setCountdownLeft] = useState<number | null>(null);
  useEffect(() => {
    if (countdown == null) {
      setCountdownLeft(null);
      return;
    }
    setCountdownLeft(countdown);
    const iv = setInterval(() => {
      setCountdownLeft((t) => (t != null && t > 0 ? t - 1 : 0));
    }, 1000);
    return () => clearInterval(iv);
  }, [countdown]);

  if (!room || selfSeatId == null) return null;

  const isHost = room.hostSeat === selfSeatId;
  const occupied = room.seats.filter((s) => s.kind !== 'empty');
  const humans = room.seats.filter((s) => s.kind === 'human');
  const allHumansReady = humans.every((s) => s.ready);
  const firstEmpty = room.seats.find((s) => s.kind === 'empty');
  const mySeat = room.seats.find((s) => s.seatId === selfSeatId);
  const canStart = room.phase === 'WAITING' && occupied.length >= 2 && allHumansReady;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-900 text-slate-100">
      <div className="text-center">
        <div className="text-sm text-slate-400">房间码（点击复制）</div>
        <button
          onClick={() => navigator.clipboard?.writeText(room.roomCode)}
          className="font-mono text-4xl font-black tracking-[0.3em] text-emerald-400 hover:text-emerald-300"
        >
          {room.roomCode}
        </button>
        <div className="mt-1 text-xs text-slate-500">
          {room.visibility === 'public' ? '公开房间' : '私密房间'} · 模式：
          {room.settings.mode === 'sprint'
            ? `竞速赛 ${room.settings.targetLines ?? 40} 行`
            : room.settings.mode === 'survival'
              ? '生存淘汰'
              : room.settings.mode === 'timed'
                ? `限时赛 ${room.settings.timeLimit ?? 180} 秒`
                : room.settings.mode}
        </div>
      </div>

      <div className="grid w-[640px] grid-cols-2 gap-3">
        {room.seats.map((seat) => (
          <SeatCard key={seat.seatId} seat={seat} selfSeatId={selfSeatId} hostSeat={room.hostSeat} canKick={isHost && room.phase === 'WAITING' && seat.kind !== 'empty' && seat.seatId !== room.hostSeat} />
        ))}
      </div>
      {room.phase === 'WAITING' && (
        <div className="flex w-[640px] flex-col gap-3">
          {isHost && (
            <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-sm">
              <span className="text-slate-300">对局设置</span>
              <div className="flex items-center gap-2">
                <select
                  value={room.settings.mode}
                  onChange={(e) =>
                    net.send('room.updateSettings', { mode: e.target.value, targetLines: room.settings.targetLines })
                  }
                  className="rounded bg-slate-700 px-2 py-1"
                >
                  <option value="sprint">竞速赛 sprint</option>
                  <option value="survival">生存淘汰 survival</option>
                  <option value="timed">限时赛 timed</option>
                </select>
                {room.settings.mode === 'sprint' && (
                  <select
                    value={room.settings.targetLines ?? 40}
                    onChange={(e) =>
                      net.send('room.updateSettings', { mode: 'sprint', targetLines: Number(e.target.value) })
                    }
                    className="rounded bg-slate-700 px-2 py-1"
                  >
                    <option value={20}>20 行</option>
                    <option value={40}>40 行</option>
                  </select>
                )}
                {room.settings.mode === 'timed' && (
                  <select
                    value={room.settings.timeLimit ?? 180}
                    onChange={(e) =>
                      net.send('room.updateSettings', { mode: 'timed', timeLimit: Number(e.target.value) })
                    }
                    className="rounded bg-slate-700 px-2 py-1"
                  >
                    <option value={120}>120 秒</option>
                    <option value={180}>180 秒</option>
                    <option value={300}>300 秒</option>
                  </select>
                )}
              </div>
            </div>
          )}

          {isHost && firstEmpty && (
            <div className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-sm">
              <span className="text-slate-300">AI 补位</span>
              <div className="flex items-center gap-2">
                <select
                  value={botDifficulty}
                  onChange={(e) => setBotDifficulty(e.target.value as Difficulty)}
                  className="rounded bg-slate-700 px-2 py-1"
                >
                  <option value="EASY">EASY</option>
                  <option value="NORMAL">NORMAL</option>
                  <option value="HARD">HARD</option>
                </select>
                <button
                  onClick={() => net.send('room.addBot', { seatId: firstEmpty.seatId, difficulty: botDifficulty })}
                  className="rounded-lg bg-slate-700 px-4 py-1.5 font-semibold hover:bg-slate-600"
                >
                  添加 AI
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-center gap-3">
            {mySeat?.kind === 'human' && selfSeatId !== room.hostSeat && (
              <button
                onClick={() => net.send('game.ready', { ready: !mySeat.ready })}
                className={`rounded-lg px-6 py-2 font-semibold ${
                  mySeat.ready ? 'bg-slate-700 hover:bg-slate-600' : 'bg-emerald-600 hover:bg-emerald-500'
                }`}
              >
                {mySeat.ready ? '取消准备' : '准备'}
              </button>
            )}
            {isHost && (
              <button
                onClick={() => net.send('game.start', {})}
                disabled={!canStart}
                title={
                  canStart
                    ? '开始游戏'
                    : `需要 ≥2 个座位且所有真人已准备（当前 ${occupied.length} 人）`
                }
                className="rounded-lg bg-emerald-600 px-6 py-2 font-semibold hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
              >
                开始游戏
              </button>
            )}
            <button onClick={onExit} className="rounded-lg bg-slate-700 px-6 py-2 font-semibold hover:bg-slate-600">
              离开房间
            </button>
          </div>
        </div>
      )}

      {room.phase === 'FINISHED' && <div className="text-sm text-slate-400">对局已结束，等待房主「再来一局」…</div>}

      {countdownLeft != null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70">
          <div className="text-8xl font-black text-emerald-400">{countdownLeft}</div>
        </div>
      )}
    </div>
  );
}

function SeatCard(props: {
  seat: { seatId: number; kind: 'human' | 'bot' | 'empty'; nickname?: string; difficulty?: 'EASY' | 'NORMAL' | 'HARD'; ready?: boolean; online?: boolean };
  selfSeatId: number;
  hostSeat: number;
  canKick: boolean;
}) {
  const { seat, selfSeatId, hostSeat, canKick } = props;
  return (
    <div
      className={`flex items-center justify-between rounded-xl border p-4 ${
        seat.kind === 'empty' ? 'border-dashed border-slate-700 text-slate-500' : 'border-slate-600 bg-slate-800'
      }`}
    >
      <div>
        <div className="font-bold">
          {seat.seatId === hostSeat && <span className="mr-1 text-amber-400">👑</span>}
          {seat.kind === 'empty'
            ? '空位'
            : seat.kind === 'bot'
              ? `AI · ${seat.difficulty}`
              : `${seat.nickname ?? '???'}${seat.seatId === selfSeatId ? '（我）' : ''}`}
          {seat.kind === 'human' && seat.online === false && <span className="ml-2 text-xs text-rose-400">离线</span>}
        </div>
        <div className="text-xs text-slate-500">
          {seat.kind === 'empty' ? '等待加入' : seat.kind === 'bot' ? '机器人（M5 完整 AI）' : '真人玩家'}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {seat.kind === 'human' && seat.ready && <span className="text-sm text-emerald-400">已准备</span>}
        {canKick && (
          <button
            onClick={() => net.send('room.removeSeat', { seatId: seat.seatId })}
            className="rounded bg-rose-900/60 px-2 py-1 text-xs text-rose-300 hover:bg-rose-800"
          >
            移除
          </button>
        )}
      </div>
    </div>
  );
}
