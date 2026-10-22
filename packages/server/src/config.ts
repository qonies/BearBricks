// 服务器配置（NFR-7：全部配置走环境变量）

export const config = {
  port: Number(process.env.PORT ?? 3000),
  origin: process.env.ORIGIN ?? null,
  isProd: process.env.NODE_ENV === 'production',
  /** 部署在可信反代（Caddy/Nginx）后设为 1：限流按 x-forwarded-for 取真实 IP */
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',

  /** 建房限流（次/10min/IP）；getter 读取以便测试/部署按环境覆盖（NFR-7） */
  get roomCreateLimit(): number {
    return Number(process.env.ROOM_CREATE_LIMIT ?? 3);
  },

  /** Origin 校验（protocol §9 / TC-SEC-005）：生产仅允许配置域名；开发放行 localhost 与私有网段（局域网联机主场景） */
  allowOrigin(origin: string | undefined): boolean {
    if (!origin) return !this.isProd;
    if (this.origin) return origin === this.origin;
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
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    return false;
  },
};
