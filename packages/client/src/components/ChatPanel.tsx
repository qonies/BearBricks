// 聊天侧栏（FR-9 / FR-11.2）：用户消息 + 系统消息（i18n key 渲染）+ 发送输入框
// 安全：React 文本节点渲染（天然防 XSS），禁止 dangerouslySetInnerHTML；Enter 发送 / Esc 退出输入框
// iPad（技术设计 §5.6）：尺寸由父容器决定（侧栏 / 抽屉 / 房间内），输入框字号 ≥16px 防 iOS 聚焦缩放

import { useEffect, useRef, useState } from 'react';
import { net } from '../net/netClient';
import { useRoomStore } from '../store/room';

const MAX_TEXT = 200;

export function ChatPanel({
  selfSeatId,
  defaultOpen = true,
}: {
  selfSeatId: number | null;
  defaultOpen?: boolean;
}) {
  const chatLog = useRoomStore((s) => s.chatLog);
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chatLog, open]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-lg bg-slate-700 px-3 py-2 text-sm hover:bg-slate-600"
      >
        打开聊天
      </button>
    );
  }

  const send = (): void => {
    const trimmed = text.trim().slice(0, MAX_TEXT);
    if (!trimmed) return;
    net.send('chat.send', { text: trimmed });
    setText('');
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col rounded-lg border border-slate-700 bg-slate-800/60">
      <div className="flex items-center justify-between border-b border-slate-700 px-3 py-2">
        <span className="text-xs font-semibold text-slate-300">聊天</span>
        <button
          onClick={() => setOpen(false)}
          className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-700 hover:text-slate-200"
        >
          收起
        </button>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 text-sm">
        {chatLog.map((m, i) => (
          <div key={i} className={m.kind === 'system' ? 'text-xs text-amber-400/90' : ''}>
            {m.kind === 'system' ? (
              <span>[{m.text}]</span>
            ) : (
              <span>
                <span className={m.seatId === selfSeatId ? 'text-emerald-400' : 'text-sky-400'}>
                  {m.nickname ?? `座位${m.seatId}`}
                </span>
                <span className="text-slate-500">：</span>
                <span className="break-all text-slate-200">{m.text}</span>
              </span>
            )}
          </div>
        ))}
        {chatLog.length === 0 && (
          <div className="text-xs text-slate-500">和房间里的玩家打个招呼吧…</div>
        )}
      </div>
      <div className="border-t border-slate-700 p-2">
        <input
          value={text}
          maxLength={MAX_TEXT}
          placeholder="发送消息（Enter）"
          enterKeyHint="send"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 中文/日文 IME 选词回车不应发送消息（composition 结束前 keydown 仍是 Enter）
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            } else if (e.key === 'Escape') {
              (e.target as HTMLInputElement).blur(); // FR-9.4：Esc 退出输入框，交还游戏键
            }
          }}
          className="w-full rounded bg-slate-700 px-2 py-1.5 text-base"
        />
      </div>
    </div>
  );
}

