// 访客身份（FR-1.1）：playerId + 昵称，持久化 localStorage

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

export function loadIdentity(): Identity {
  let playerId = localStorage.getItem(PLAYER_ID_KEY);
  if (!playerId) {
    playerId = newUUID();
    localStorage.setItem(PLAYER_ID_KEY, playerId);
  }
  let nickname = localStorage.getItem(NICKNAME_KEY);
  if (!nickname) {
    nickname = randomNickname();
    localStorage.setItem(NICKNAME_KEY, nickname);
  }
  return { playerId, nickname };
}

export function saveNickname(nickname: string): void {
  const trimmed = nickname.trim().slice(0, 12);
  if (trimmed) localStorage.setItem(NICKNAME_KEY, trimmed);
}
