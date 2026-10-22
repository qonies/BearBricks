// i18n 骨架（requirements §2.2：UI 默认简体中文，预留多语言结构）
// 系统消息按 code 渲染（protocol §6 chat.system），后续新增语言 = 在 DICTS 增加键表

export type Locale = 'zh-CN';

export type SystemCode =
  | 'JOIN'
  | 'LEAVE'
  | 'KICKED'
  | 'TOP_OUT'
  | 'RESPAWN'
  | 'VICTORY'
  | 'START';

const DICTS: Record<Locale, Record<SystemCode, string>> = {
  'zh-CN': {
    JOIN: '{nickname} 加入了房间',
    LEAVE: '{nickname} 离开了房间',
    KICKED: '{nickname} 被房主移出房间',
    TOP_OUT: '{nickname} 被淘汰，转入观战',
    RESPAWN: '{nickname} 复活',
    VICTORY: '{nickname} 获得胜利！',
    START: '对局开始，祝你好运！',
  },
};

/** 系统消息模板渲染；{key} 占位符由 params 替换，未知 code 回退为 code 本身 */
export function formatSystemMessage(
  code: SystemCode,
  params?: Record<string, string | number>,
  locale: Locale = 'zh-CN',
): string {
  const tpl = DICTS[locale][code];
  if (!tpl) return code;
  return tpl.replace(/\{(\w+)\}/g, (_, key: string) => String(params?.[key] ?? ''));
}
