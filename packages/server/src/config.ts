// 服务器配置（NFR-7：全部配置走环境变量）
// 限额类配置一律走 getter：测试/部署可在运行时覆盖 process.env（getter 每次读取），
// 非法值（NaN/负数）回退默认，避免部署时一个笔误把限流关掉或把服务锁死。

/** 读取非负整数环境变量；缺省/非法 → fallback */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const config = {
  /** 监听端口（非法值回退 3000） */
  get port(): number {
    const n = Number(process.env.PORT ?? 3000);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.floor(n) : 3000;
  },
  /** 生产部署域名（用于 Origin 校验） */
  get origin(): string | null {
    return process.env.ORIGIN ?? null;
  },
  get isProd(): boolean {
    return process.env.NODE_ENV === 'production';
  },
  /** 部署在可信反代（Caddy/Nginx）后设为 1：限流按 x-forwarded-for 取真实 IP */
  get trustProxy(): boolean {
    return process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
  },

  /** 建房限流（次/ROOM_CREATE_WINDOW_MS/IP）；默认 5 次/10min（办公室/宿舍同出口 NAT 场景放宽） */
  get roomCreateLimit(): number {
    return envInt('ROOM_CREATE_LIMIT', 5);
  },
  /** 建房/进房失败限流的统计窗口 */
  get roomCreateWindowMs(): number {
    return Math.max(1000, envInt('ROOM_CREATE_WINDOW_MS', 10 * 60_000));
  },
  /** 房间码爆破防护：窗口内进房失败上限（TC-SEC-004） */
  get joinFailLimit(): number {
    return Math.max(1, envInt('JOIN_FAIL_LIMIT', 10));
  },
  /** WAITING 空房 / FINISHED 房的回收 TTL（protocol §9） */
  get roomTtlMs(): number {
    return Math.max(1000, envInt('ROOM_TTL_MS', 10 * 60_000));
  },
  /** 断线宽限（FR-10.2），超时按模式处置 */
  get graceMs(): number {
    return envInt('GRACE_MS', 30_000);
  },
  /** 心跳间隔（连续 2 个 ping 无 pong ≈ 2×该值判定断线） */
  get heartbeatMs(): number {
    return Math.max(1000, envInt('HEARTBEAT_MS', 15_000));
  },
  /** 每 IP 并发 WS 连接上限（0 = 不限制）；同 NAT 多人开黑的场景可调高 */
  get maxIpConnections(): number {
    return envInt('MAX_CONN_PER_IP', 20);
  },
  /** 全服并发 WS 连接上限（0 = 不限制）：单 IP 配额之外的最后一道内存保护 */
  get maxConnections(): number {
    return envInt('MAX_CONNECTIONS', 512);
  },
  /** 每连接入站消息速率上限（条/s），超限直接断开 */
  get maxMsgPerSec(): number {
    return Math.max(1, envInt('MAX_MSG_PER_SEC', 120));
  },
  /** 对局输入速率上限（action/s），超限丢弃并告警 */
  get inputRateLimit(): number {
    return Math.max(1, envInt('INPUT_RATE_LIMIT', 60));
  },
  /** 聊天限流：10s 窗口内条数上限（另有 1 条/s 的硬间隔） */
  get chatPer10s(): number {
    return Math.max(1, envInt('CHAT_MSG_PER_10S', 10));
  },
  /** 单连接下行缓冲上限（字节）：超过视为慢客户端，主动断开（重连后走全量态恢复） */
  get maxSocketBufferBytes(): number {
    return envInt('MAX_SOCKET_BUFFER_BYTES', 1_048_576);
  },
  /** 单连接错误回包速率上限（条/s）：防止非法请求 → 错误回包的放大（P2-8） */
  get maxErrorsPerSec(): number {
    return Math.max(1, envInt('MAX_ERRORS_PER_SEC', 30));
  },

  /** Origin 校验（protocol §9 / TC-SEC-005）：生产仅允许配置域名；开发放行 localhost 与私有网段（局域网联机主场景） */
  allowOrigin(origin: string | undefined): boolean {
    if (!origin) return !this.isProd;
    if (this.origin) {
      // 归一化比较：容忍配置里多写结尾 / 或带路径（浏览器 Origin 永远无路径）
      try {
        return new URL(origin).origin === new URL(this.origin).origin;
      } catch {
        return false;
      }
    }
    try {
      const u = new URL(origin);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
      // 开发环境放行私有网段（办公室/家庭局域网直接以 IP 访问 dev server 的场景）
      if (!this.isProd && this.isPrivateHostname(u.hostname)) return true;
      return false;
    } catch {
      return false;
    }
  },

  /** IPv4 私有网段 + .local mDNS 主机名 */
  isPrivateHostname(hostname: string): boolean {
    if (hostname.endsWith('.local')) return true;
    if (hostname === '::1' || hostname === '[::1]') return true; // IPv6 loopback
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    return false;
  },
};
