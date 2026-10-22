# BearBricks 🐻🧱

浏览器端多人俄罗斯方块对战平台：单人可玩、联机 sprint 竞速赛与 survival 生存淘汰（M3）、房间内文字聊天。零门槛（无需登录）。timed 限时赛与真实 AI 计划于 M4/M5 交付。

## 快速开始

```powershell
npm install          # npm workspaces（Node >= 22）
npm run dev:server   # 终端 1：服务器（Fastify + ws，默认 :3000）
npm run dev          # 终端 2：client（Vite :5173，/ws 已代理到 :3000）
```

打开 http://localhost:5173 → 大厅 → 单人（Marathon / Sprint 40）或 创建房间/房间码加入/快速匹配。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm test` | shared + client + server 全部 Vitest |
| `npm run test:coverage` | shared 覆盖率（V8） |
| `npm run typecheck` | 三包严格类型检查 |
| `npm run build` | client（tsc + vite）+ server（esbuild → `dist/index.mjs`） |
| `npm start` | 运行 server 构建产物（静态托管 client dist + ws） |
| `npm run lint` / `npm run format` | ESLint flat config / Prettier |

## 结构

- `packages/shared` — 纯 TS 游戏核心（SRS / 7-bag / 计分 / 顶出 / 垃圾行）+ 协议（Zod）+ 模式策略与排名（sprint / survival，timed 为 M4）
- `packages/server` — Node 22 + Fastify + ws：房间状态机、60Hz 权威 GameLoop、快照节流（己方 20Hz / 对手 10Hz）、断线宽限 30s、心跳 / 限流 / Origin 校验
- `packages/client` — React 19 + Vite + Zustand：单人本地权威 + 联机乐观渲染（快照校正 + 未确认输入重放）+ 聊天侧栏（i18n 骨架 `src/i18n.ts`）
- `docs/` — 需求 / 技术设计 / 协议（v1.3）/ 测试计划 / ADR
- `memory-bank/` — 项目记忆库

## 环境

- `PORT`（默认 3000）、`ORIGIN`（生产域名；开发自动放行 localhost 与私有网段 10/192.168/172.16-31）、`NODE_ENV`
- `TRUST_PROXY=1`：部署在可信反代后开启，限流按 `x-forwarded-for` 取真实 IP
- `ROOM_CREATE_LIMIT`（默认 3 次/10min/IP）、`CLIENT_DIST`（自定义静态目录，Docker 用）、`LOG_LEVEL`
- 健康检查：`GET /healthz`；优雅停机：SIGTERM → 广播 E4999 → 5s 内关闭（异常退出以非零码退出）
- **局域网部署注意**：每 IP 限流（并发连接 ≤5、建房 3/10min）在 NAT 后为全体玩家共享；办公室场景建议在反代上启用真实 IP 透传并设 `TRUST_PROXY=1`
- Docker：仓库根目录 `Dockerfile`（多阶段构建，client dist 静态托管由 server 提供）

## 测试纪律

每轮测试/调试后必须退出后台 node/vite 进程、不占用端口（`afterAll` 强制关闭 + `Get-NetTCPConnection` 抽查）。

详细规则见 `docs/`，里程碑进度见 `memory-bank/progress.md`。
