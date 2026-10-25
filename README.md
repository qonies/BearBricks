# BearBricks 🐻🧱

[![CI](https://github.com/qonies/BearBricks/actions/workflows/ci.yml/badge.svg)](https://github.com/qonies/BearBricks/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

**BearBricks** 是一个零门槛（无需登录）的浏览器端多人俄罗斯方块对战平台：打开网页、输入昵称即可开局——支持单人练习、最多 4 人同房联机对战（真人 + AI 补位）与房间内文字聊天。服务端权威架构 + 客户端乐观渲染，办公室/局域网内即可低延迟开黑。

## ✨ 特性

- 🎮 **标准手感**：Tetris Guideline 级复刻 —— SRS 踢墙、7-bag、锁定延迟（500ms / 最多 15 次重置）、Hold、Ghost、DAS/ARR 可调、软降/硬降计分
- 🏁 **对战模式**：sprint 竞速赛（20/40 行）、survival 生存淘汰（攻击 / 垃圾行 / 淘汰观战）、timed 限时赛（120/180/300 秒，顶出 3s 复活 + 免伤）；三档 AI
- ⚔️ **公平竞技**：服务端 60Hz 权威模拟，客户端只上报输入（防作弊）；带 seed 的确定性引擎双端复用，乐观渲染 + 快照校正收敛，断线 30s 内重连恢复棋局
- 💬 **房间社交**：公开房/私密房、房间码加入、快速匹配、准备与房主控制、系统消息 + 纯文本聊天（限流 + 控制字符清洗，React 文本渲染防 XSS）
- 📱 **iPad / 平板**：屏上虚拟按键（尺寸/透明度/左右手布局可调、按宽度自适应，320px Split View 不重叠）+ 棋盘手势 + 改键；横竖屏、Split View、Stage Manager 自适应；添加到主屏幕图标（manifest + apple-touch-icon）；回前台立即重连恢复棋局
- 🔒 **安全基线**：Zod 全量校验、4KB 帧上限、每连接/每 IP 多层限流、Origin 校验（归一化）、resumeToken 一次性轮换，playerId 不下发；生产响应补 CSP/安全头与 gzip
- 🚀 **零门槛部署**：无账号体系、纯内存房间状态、单 Docker 镜像（`node:22-alpine`，非 root + HEALTHCHECK）

## 🎮 游戏模式

| 模式 | 状态 | 规则 |
|---|---|---|
| 单人 Marathon / Sprint 40 | ✅ 已上线 | 本地权威运行，最佳成绩持久化 localStorage |
| sprint 竞速赛（联机） | ✅ 已上线 | 各自独立棋盘，最先清满 N 行者胜，无攻击 |
| survival 生存淘汰（联机） | ✅ 已上线 | 消行产生攻击/垃圾行（B2B/Combo/PC 加成），被顶出者淘汰转观战仍可聊天，最后存活者胜 |
| timed 限时赛（联机） | ✅ 已上线 | 固定时长（120/180/300s）比总分，消行产生攻击/垃圾行；顶出 3s 复活（棋盘清空、分数保留）+ 复活后 3s 免伤 |
| AI 机器人 EASY/NORMAL/HARD | ✅ 已上线 | 服务端 BotController 落点评估（聚合高度/空洞/凹凸度/井深/消行 + Hold 权衡 + 误操作率），每 tick 经与真人相同的 `game.applyInput` 通道执行；误操作 RNG 从对局 seed 派生，可复现。M6 下调难度（450/300/180ms，30%/18%/6%），且每个方块必须逐格软降至少一半高度（10 行）后才允许硬降 |

> **键位**：←/→ 移动 · ↑/X 顺旋 · Z/Ctrl 逆旋 · ↓ 软降 · Space 硬降 · Shift/C Hold · Esc 暂停（单人）/ 打开设置面板（联机）；键位可在「设置」中改绑并持久化。iPad 等触屏设备自动显示虚拟按键（← → ▼ / ⟲ ⟳ HOLD ⤓）。

## 快速开始

```powershell
npm install          # npm workspaces（Node >= 22）
npm run dev:server   # 终端 1：服务器（Fastify + ws，默认 :3000）
npm run dev          # 终端 2：client（Vite :5173，/ws 已代理到 :3000）
```

打开 http://localhost:5173 → 大厅 → 单人（Marathon / Sprint 40）或 创建房间/房间码加入/快速匹配。

开发服务器监听 `0.0.0.0`（`vite.config.ts` host），局域网内其他设备可直接访问 `http://<开发机IP>:5173` 联机。

## 📱 iPad / 平板

- 大厅 →「设置」：改键（捕获式绑定 / 冲突提示 / 恢复默认）、触控按键尺寸与不透明度、左右手布局、棋盘手势开关与映射、DAS/ARR/Ghost
- 游戏屏：单人右上角「暂停 / 设置」；联机按 Esc 或「设置」打开面板且 **不暂停对局**（服务端权威照常跑）
- 横屏、竖屏、Split View / Stage Manager 均自适应：棋盘格子按可用空间缩放，**旋转屏幕不会中断棋局**
- 建议横屏游玩；Safari「分享 → 添加到主屏幕」后以独立窗口启动（manifest + apple-touch-icon 已提供；iPadOS 无全屏 API，这是最接近全屏的方式）
- Split View 1/3（约 320px）下触控按键按容器宽度自动收缩（约 51px），不再重叠
- **局域网 http（非安全上下文）的能力限制**：不能自动复制房间码（改为提示手动抄写）、无 Service Worker / 离线缓存 / 屏幕常亮；需要这些能力请改用 HTTPS（Caddy/Nginx + 可信证书）
- iPad 切后台较常见：建议部署时设 `GRACE_MS=45000`~`60000`，避免短暂切走就被判离线；回前台会立即重连并通过 `game.state.full` 恢复棋局

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm test` | shared 98 + client 57 + server 29 全部 Vitest |
| `npm run test:coverage` | shared 覆盖率（V8） |
| `npm run typecheck` | 三包严格类型检查 |
| `npm run build` | client（tsc + vite）+ server（esbuild → `dist/index.mjs`） |
| `npm start` | 运行 server 构建产物（静态托管 client dist + ws） |
| `npm run lint` / `npm run format` | ESLint flat config / Prettier |

## 结构

- `packages/shared` — 纯 TS 游戏核心（SRS / 7-bag / 计分 / 顶出 / 垃圾行）+ 协议（Zod）+ 模式策略与排名（sprint / survival / timed）+ AI（BotController）
- `packages/server` — Node 22 + Fastify + ws：房间状态机、60Hz 权威 GameLoop、快照节流（己方 20Hz / 对手 10Hz）、断线宽限 30s、心跳 / 限流 / Origin 校验
- `packages/client` — React 19 + Vite + Zustand：单人本地权威 + 联机乐观渲染（快照校正 + 未确认输入重放）+ 聊天侧栏（i18n 骨架 `src/i18n.ts`）+ 三源输入（键盘/触屏/手势，`src/input/`）与设置屏（改键/触控/音量）
- `docs/` — 需求 / 技术设计 / 协议（v1.7）/ 测试计划 / ADR
- `memory-bank/` — 项目记忆库

## 环境

- `PORT`（默认 3000）、`ORIGIN`（生产域名；开发自动放行 localhost 与私有网段 10/192.168/172.16-31；比较前归一化，结尾 `/` 不影响）、`NODE_ENV`。**注意：`NODE_ENV=production`（含 Docker 镜像）且未设置 `ORIGIN` 时，仅 localhost 来源可建立 WebSocket——局域网/域名部署必须设置 `ORIGIN`（如 `http://<host>:3000`），否则 `/ws` 会被 Origin 校验拒绝**
- `TRUST_PROXY=1`：部署在可信反代后开启，限流按 `x-forwarded-for` 取真实 IP
- 限流/节奏（全部可用环境变量覆盖，非法值回退默认；`0` 对连接上限表示"不限制"）：
  | 变量 | 默认 | 含义 |
  |---|---|---|
  | `MAX_CONN_PER_IP` | 20 | 每 IP 并发 WS 连接（同 NAT 开黑按人数上调） |
  | `MAX_CONNECTIONS` | 512 | 全服并发 WS 连接（0 = 不限制） |
  | `ROOM_CREATE_LIMIT` / `ROOM_CREATE_WINDOW_MS` | 5 / 600000 | 建房限流与统计窗口 |
  | `JOIN_FAIL_LIMIT` | 10 | 窗口内进房失败上限（房间码爆破防护） |
  | `ROOM_TTL_MS` | 600000 | WAITING 空房 / FINISHED 房回收 TTL |
  | `GRACE_MS` | 30000 | 断线宽限（超时按模式处置；iPad 场景建议 45000~60000） |
  | `HEARTBEAT_MS` | 15000 | 心跳间隔（连续 2 次无 pong ≈ 2× 该值判断线） |
  | `MAX_MSG_PER_SEC` | 120 | 每连接入站消息上限（超限断开） |
  | `INPUT_RATE_LIMIT` | 60 | 对局输入上限（action/s，超限丢弃） |
  | `CHAT_MSG_PER_10S` | 10 | 聊天窗口上限 |
  | `MAX_SOCKET_BUFFER_BYTES` | 1048576 | 下行积压上限（慢客户端断开） |
  | `MAX_ERRORS_PER_SEC` | 30 | 单连接错误回包上限（超限断开） |
- `CLIENT_DIST`（自定义静态目录，Docker 用）、`LOG_LEVEL`
- 健康检查：`GET /healthz`；优雅停机：SIGTERM → 广播 E4999 → 5s 内关闭（异常退出以非零码退出）
- **局域网部署注意**：每 IP 限流（默认并发连接 ≤20、建房 5/10min）在 NAT 后为全体玩家共享；办公室场景建议在反代上启用真实 IP 透传并设 `TRUST_PROXY=1`，或直接上调 `MAX_CONN_PER_IP` / `ROOM_CREATE_LIMIT`
- Docker：仓库根目录 `Dockerfile`（多阶段构建、`USER node`、`HEALTHCHECK /healthz`；client dist 静态托管由 server 提供；`@fastify/compress` 为生产依赖）

## 测试纪律

每轮测试/调试后必须退出后台 node/vite 进程、不占用端口（`afterAll` 强制关闭 + `Get-NetTCPConnection` 抽查）。

详细规则见 `docs/`，里程碑进度见 `memory-bank/progress.md`。

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源。

> 「Tetris / 俄罗斯方块」名称及相关商标归其权利人所有；本项目为原创代码实现（游戏规则本身不受著作权保护），仅供学习与交流使用。
