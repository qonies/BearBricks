// 访客身份（FR-1.1）：playerId + 昵称，持久化 localStorage

import { sanitizeNickname } from '@bearbricks/shared';

export interface Identity {
  playerId: string;
  nickname: string;
}

const PLAYER_ID_KEY = 'bearbricks.playerId';
const NICKNAME_KEY = 'bearbricks.nickname';

function randomNickname(): string {
  return `玩家_${Math.random().toString(36).slice(2, 6)}`;
}

/** crypto.randomUUID 仅在安全上下文（HTTPS/localhost）可用；局域网 HTTP 部署需兜底 */
function newUUID(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/** localStorage 可能不可用（隐私模式/禁用存储）→ 读写一律兜底，身份退化为"本次会话内有效" */
function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function loadIdentity(): Identity {
  let playerId = storageGet(PLAYER_ID_KEY);
  if (!playerId) {
    playerId = newUUID();
    storageSet(PLAYER_ID_KEY, playerId);
  }
  let nickname = storageGet(NICKNAME_KEY);
  if (!nickname) {
    nickname = randomNickname();
    storageSet(NICKNAME_KEY, nickname);
  } else {
    nickname = sanitizeNickname(nickname) || randomNickname();
  }
  return { playerId, nickname };
}

export function saveNickname(nickname: string): void {
  const trimmed = sanitizeNickname(nickname);
  if (trimmed) storageSet(NICKNAME_KEY, trimmed);
}
