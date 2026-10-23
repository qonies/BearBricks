# BearBricks 🐻🧱

[![CI](https://github.com/qonies/BearBricks/actions/workflows/ci.yml/badge.svg)](https://github.com/qonies/BearBricks/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

**BearBricks** 是一个零门槛（无需登录）的浏览器端多人俄罗斯方块对战平台：打开网页、输入昵称即可开局——支持单人练习、最多 4 人同房联机对战（真人 + AI 补位）与房间内文字聊天。服务端权威架构 + 客户端乐观渲染，办公室/局域网内即可低延迟开黑。

## ✨ 特性

- 🎮 **标准手感**：Tetris Guideline 级复刻 —— SRS 踢墙、7-bag、锁定延迟（500ms / 最多 15 次重置）、Hold、Ghost、DAS/ARR 可调、软降/硬降计分
- 🏁 **对战模式**：sprint 竞速赛（20/40 行）、survival 生存淘汰（攻击 / 垃圾行 / 淘汰观战）、timed 限时赛（120/180/300 秒，顶出 3s 复活 + 免伤）；三档 AI 规划于 M5
- ⚔️ **公平竞技**：服务端 60Hz 权威模拟，客户端只上报输入（防作弊）；带 seed 的确定性引擎双端复用，乐观渲染 + 快照校正收敛，断线 30s 内重连恢复棋局
- 💬 **房间社交**：公开房/私密房、房间码加入、快速匹配、准备与房主控制、系统消息 + 纯文本聊天（限流 + 控制字符清洗，React 文本渲染防 XSS）
- 🔒 **安全基线**：Zod 全量校验、4KB 帧上限、每连接/每 IP 多层限流、Origin 校验、resumeToken 一次性轮换，playerId 不下发
- 🚀 **零门槛部署**：无账号体系、纯内存房间状态、单 Docker 镜像（`node:22-alpine`）

## 🎮 游戏模式

| 模式 | 状态 | 规则 |
|---|---|---|
| 单人 Marathon / Sprint 40 | ✅ 已上线 | 本地权威运行，最佳成绩持久化 localStorage |
| sprint 竞速赛（联机） | ✅ 已上线 | 各自独立棋盘，最先清满 N 行者胜，无攻击 |
| survival 生存淘汰（联机） | ✅ 已上线 | 消行产生攻击/垃圾行（B2B/Combo/PC 加成），被顶出者淘汰转观战仍可聊天，最后存活者胜 |
| timed 限时赛（联机） | ✅ 已上线 | 固定时长（120/180/300s）比总分，消行产生攻击/垃圾行；顶出 3s 复活（棋盘清空、分数保留）+ 复活后 3s 免伤 |
| AI 机器人 EASY/NORMAL/HARD | ✅ 已上线 | 服务端 BotController 落点评估（聚合高度/空洞/凹凸度/井深/消行 + Hold 权衡 + 误操作率），每 tick 经与真人相同的 `game.applyInput` 通道执行；误操作 RNG 从对局 seed 派生，可复现 |

> **键位**：←/→ 移动 · ↑/X 顺旋 · Z/Ctrl 逆旋 · ↓ 软降 · Space 硬降 · Shift/C Hold · Esc 暂停（仅单人）

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

- `packages/shared` — 纯 TS 游戏核心（SRS / 7-bag / 计分 / 顶出 / 垃圾行）+ 协议（Zod）+ 模式策略与排名（sprint / survival / timed）
- `packages/server` — Node 22 + Fastify + ws：房间状态机、60Hz 权威 GameLoop、快照节流（己方 20Hz / 对手 10Hz）、断线宽限 30s、心跳 / 限流 / Origin 校验
- `packages/client` — React 19 + Vite + Zustand：单人本地权威 + 联机乐观渲染（快照校正 + 未确认输入重放）+ 聊天侧栏（i18n 骨架 `src/i18n.ts`）
- `docs/` — 需求 / 技术设计 / 协议（v1.5）/ 测试计划 / ADR
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

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源。

> 「Tetris / 俄罗斯方块」名称及相关商标归其权利人所有；本项目为原创代码实现（游戏规则本身不受著作权保护），仅供学习与交流使用。
