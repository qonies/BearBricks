# 技术上下文（Tech Context）

## 当前环境（2026-10-22 全量代码审查后实测）
- OS: Windows 11（win32），Shell: **PowerShell 5.1**（注意 UTF-8 编码与 PS 语法差异，避免 bash 语法）
- Node: **v24.13.0**，npm: **11.12.1**（此前记录的 Node 22/npm 12 已过期）；git 2.34.1（cygwin git 的 HOME 环境变量不可用 → **勿用 `--global` 配置/`gh auth setup-git`**，一律 `--local`）；仓库 **github.com/qonies/BearBricks**（**Public**，MIT 协议，main 分支，remote = 规范大小写 URL）；项目名/仓库名统一 **BearBricks**（gh rename 后旧 URL 自动重定向）
- 工作目录：BearBricks 仓库根目录（路径含个人用户名，故不记录；以仓库根为基准执行全部命令）

## 规划技术栈（详见 docs/technical-design.md 与 ADR-0001）
| 层 | 选型 |
|---|---|
| 语言 | TypeScript 5.x（strict）全部包 |
| 构建 | Vite 6（client）、esbuild/tsx（server）、npm workspaces（shared 以源码形式被引用/打包） |
| 前端 UI | React 19 + Zustand + Tailwind CSS v4 |
| 渲染 | Canvas 2D（棋盘），DOM（HUD/大厅/聊天） |
| 服务端 | Node 22 + Fastify（静态资源/健康检查）+ `ws`（WebSocket） |
| 校验 | Zod（协议消息、房间设置） |
| 测试 | Vitest（单元+集成）、Playwright（E2E 多 context）、自研 ws 压测脚本 |
| 质量 | ESLint（flat config）+ Prettier + GitHub Actions CI |
| 部署 | Docker（node:22-alpine）单镜像，Caddy/Nginx 反代 TLS/WSS |

## 目录结构（M6 审计修复后实际状态，2026-10-25）
```
packages/
  shared/    纯 TS 引擎 + 规则 + 协议 + AI（engine/*、rules/*、ai/bot.ts、modes/{strategy,sprint,survival,timed}.ts、protocol/{messages,snapshot}.ts）+ tests/（Vitest 98 用例）+ scripts/bot-tune.ts（AI 调参）
  client/    React19+Vite6+Tailwind4+Zustand（net/{netClient,identity}、input/{commands,router,gestures,keymap,useGameInput,touchLayout}、game/{engineRunner,netGame,autoshift,render,clearFx,fitCell,viewport}、components/{Lobby,RoomView,GameView,GameViewMP,ChatPanel,SettingsPanel,TouchControls}、public/{manifest.webmanifest,icon-192.png,icon-512.png,apple-touch-icon.png}、i18n.ts）+ tests/（57 用例）
  server/    Fastify+ws+@fastify/compress（net/{wsHub,session}、room/{roomManager,room}、app/index/config/log）+ tests/（单元 16 + 真实 ws 集成 13 = 29 用例，vitest fileParallelism=false）
docs/        需求(v1.1)/技术(v1.2)/协议(v1.7)/测试(v1.2)/ADR
memory-bank/ 本记忆库
```

## 命令（实际可用）
- `npm test` —— shared(98) + client(57) + server(29) 全部 Vitest（server 集成较慢 ~45s，可按文件单独跑；`npx vitest run tests/xxx.test.ts`）
- `npm run test:coverage` —— shared 覆盖率（V8，阈值 90/80/85/90 见 `packages/shared/vitest.config.ts`）
- `npm run build` —— client（tsc+vite）+ server（esbuild → `dist/index.mjs`，shared 打进 bundle；fastify/ws/zod/@fastify/compress 为 external）
- `npm start` —— 运行 server 构建产物（静态托管 client dist + ws；`CLIENT_DIST` 可覆盖目录）
- `npm run dev` / `npm run dev:server` —— vite(5173，/ws 代理 :3000) / tsx watch server
- `npm run typecheck` / `npm run lint` / `npm run format` —— 三包 tsc（含各包 tests）/ ESLint flat / Prettier
- Docker：仓库根 `Dockerfile`（`docker build -t bearbricks .` && `docker run -p 3000:3000`，**未实测**；运行阶段 `USER node` + `HEALTHCHECK /healthz`）

## 环境注意事项
- **端口纪律**：每次测试完成后必须退出后台 node/preview 进程，不占用端口（项目规则 test-rule）
- PowerShell 5.1 下写文件注意 UTF-8（无 BOM）；长命令避免 bash 风格 `&&` 以外的语法陷阱（PS7 才支持 `&&`，5.1 用 `;`）
- 无 Docker 运行时要求（本机开发直接 node）；部署阶段才需要
- **服务端全部限额/节奏走环境变量**（getter 每次读取 `process.env`，非法值回退默认）：`MAX_CONN_PER_IP`(20)、`MAX_CONNECTIONS`(512)、`ROOM_CREATE_LIMIT`(5)、`ROOM_CREATE_WINDOW_MS`(600000)、`JOIN_FAIL_LIMIT`(10)、`ROOM_TTL_MS`(600000)、`GRACE_MS`(30000)、`HEARTBEAT_MS`(15000)、`MAX_MSG_PER_SEC`(120)、`INPUT_RATE_LIMIT`(60)、`CHAT_MSG_PER_10S`(10)、`MAX_SOCKET_BUFFER_BYTES`(1048576)、`MAX_ERRORS_PER_SEC`(30)；集中在 `packages/server/src/config.ts`

## 约束
- 纯内存状态，无数据库、无 Redis（ADR-0001/需求 §7）
- 浏览器目标：Chrome/Edge/Firefox/Safari 最近 2 大版本；**iPadOS Safari（横竖屏 + Split View / Stage Manager 任意尺寸）**——触屏用屏上按键/手势，键盘为可选输入
- 局域网 http 属非安全上下文：无 `navigator.clipboard`（房间码回退手动抄写）、无 SW/离线/`wakeLock`；iPadOS 无全屏 API → 「添加到主屏幕」standalone（manifest，不注册 SW）
- iPhone 的 Home Indicator / 刘海安全区通过 `env(safe-area-inset-*)` 处理；Safari 工具栏伸缩用 `100dvh`
- 无登录 → 身份仅 localStorage，可被用户清除（接受）
