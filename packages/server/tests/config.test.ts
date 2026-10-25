// config.allowOrigin 回归（P1-4）：生产环境 LAN 访问必须显式配置 ORIGIN；
// 开发放行 localhost / 私有网段；localhost 在任何环境都放行（本机 Docker 烟测）。

import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';

const origNodeEnv = process.env.NODE_ENV;
const origOriginEnv = process.env.ORIGIN;

function setProd(prod: boolean): void {
  if (prod) process.env.NODE_ENV = 'production';
  else delete process.env.NODE_ENV;
}

function setOrigin(origin: string | null): void {
  if (origin == null) delete process.env.ORIGIN;
  else process.env.ORIGIN = origin;
}

afterEach(() => {
  if (origNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = origNodeEnv;
  if (origOriginEnv === undefined) delete process.env.ORIGIN;
  else process.env.ORIGIN = origOriginEnv;
});

describe('config.allowOrigin（P1-4）', () => {
  it('开发环境：放行 localhost / 私有网段 / 无 Origin；拒绝公网', () => {
    setProd(false);
    setOrigin(null);
    expect(config.allowOrigin(undefined)).toBe(true);
    expect(config.allowOrigin('http://localhost:5173')).toBe(true);
    expect(config.allowOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(config.allowOrigin('http://192.168.1.5:5173')).toBe(true);
    expect(config.allowOrigin('http://10.0.0.3:5173')).toBe(true);
    expect(config.allowOrigin('http://172.16.3.9')).toBe(true);
    expect(config.allowOrigin('http://8.8.8.8')).toBe(false);
  });

  it('生产环境：未配置 ORIGIN 时仅 localhost 放行，LAN 被拒（Docker 默认行为）', () => {
    setProd(true);
    setOrigin(null);
    expect(config.allowOrigin('http://localhost:3000')).toBe(true);
    expect(config.allowOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(config.allowOrigin('http://192.168.1.10:3000')).toBe(false);
  });

  it('生产环境：配置 ORIGIN 后归一化匹配（容忍结尾 / 与路径），拒绝无 Origin 客户端', () => {
    setProd(true);
    setOrigin('http://192.168.1.10:3000/');
    expect(config.allowOrigin('http://192.168.1.10:3000')).toBe(true);
    expect(config.allowOrigin('http://192.168.1.11:3000')).toBe(false);
    expect(config.allowOrigin(undefined)).toBe(false);
  });
});

describe('config 限额/端口环境变量（NFR-7）', () => {
  const keys = ['MAX_CONN_PER_IP', 'ROOM_CREATE_LIMIT', 'ROOM_TTL_MS', 'GRACE_MS', 'HEARTBEAT_MS'];
  const origPort = process.env.PORT;
  afterEach(() => {
    for (const k of keys) delete process.env[k];
    if (origPort === undefined) delete process.env.PORT;
    else process.env.PORT = origPort;
  });

  it('环境变量覆盖默认值；非法/缺省回退默认（不会把限流关掉或锁死服务）', () => {
    const defaults = {
      maxIpConnections: config.maxIpConnections,
      roomCreateLimit: config.roomCreateLimit,
      roomTtlMs: config.roomTtlMs,
      graceMs: config.graceMs,
      heartbeatMs: config.heartbeatMs,
    };
    expect(defaults.maxIpConnections).toBeGreaterThan(0); // 默认放行同 NAT 多人开黑

    process.env.MAX_CONN_PER_IP = '64';
    process.env.ROOM_CREATE_LIMIT = '8';
    process.env.ROOM_TTL_MS = '60000';
    process.env.GRACE_MS = '5000';
    process.env.HEARTBEAT_MS = '2000';
    expect(config.maxIpConnections).toBe(64);
    expect(config.roomCreateLimit).toBe(8);
    expect(config.roomTtlMs).toBe(60_000);
    expect(config.graceMs).toBe(5000);
    expect(config.heartbeatMs).toBe(2000);

    process.env.MAX_CONN_PER_IP = 'abc';
    process.env.GRACE_MS = '-1';
    process.env.HEARTBEAT_MS = '0'; // 心跳间隔有下限，避免 0 变成忙等
    expect(config.maxIpConnections).toBe(defaults.maxIpConnections);
    expect(config.graceMs).toBe(defaults.graceMs);
    expect(config.heartbeatMs).toBe(1000);

    process.env.PORT = 'abc';
    expect(config.port).toBe(3000);
    process.env.PORT = '4321';
    expect(config.port).toBe(4321);
  });
});
