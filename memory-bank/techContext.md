# 技术上下文（Tech Context）

## 当前环境（2026-10-22 全量代码审查后实测）
- OS: Windows 11（win32），Shell: **PowerShell 5.1**（注意 UTF-8 编码与 PS 语法差异，避免 bash 语法）
- Node: **v24.13.0**，npm: **11.12.1**（此前记录的 Node 22/npm 12 已过期）；git 2.34.1（cygwin git，HOME=/home/tony 不存在 → **勿用 `--global` 配置/`gh auth setup-git`**，一律 `--local`）；仓库 **github.com/qonies/BearBricks**（**Public**，MIT 协议，main 分支，remote = 规范大小写 URL）；项目名/仓库名统一 **BearBricks**（gh rename 后旧 URL 自动重定向）
- 工作目录：BearBricks 仓库根目录（路径含个人用户名，故不记录；以仓库根为基准执行全部命令）

## 规划技术栈（详见 docs/technical-design.md 与 ADR-0001）
| 层 | 选型 |
|---|---|
| 语言 | TypeScript 5.x（strict）全部包 |
| 构建 | Vite 6（client）、tsup/ts-node（server、shared）、npm workspaces |
| 前端 UI | React 19 + Zustand + Tailwind CSS v4 |
| 渲染 | Canvas 2D（棋盘），DOM（HUD/大厅/聊天） |
| 服务端 | Node 22 + Fastify（静态资源/健康检查）+ `ws`（WebSocket） |
| 校验 | Zod（协议消息、房间设置） |
| 测试 | Vitest（单元+集成）、Playwright（E2E 多 context）、自研 ws 压测脚本 |
| 质量 | ESLint（flat config）+ Prettier + GitHub Actions CI |
| 部署 | Docker（node:22-alpine）单镜像，Caddy/Nginx 反代 TLS/WSS |

## 目录结构（M3 + 全量审查修复后实际状态，2026-10-22）
```
packages/
  shared/    纯 TS 引擎 + 规则 + 协议（engine/*、rules/*、modes/{strategy,sprint,survival}.ts、protocol/{messages,snapshot}.ts）+ tests/（Vitest 68 用例）
  client/    React19+Vite6+Tailwind4+Zustand（net/{netClient,identity}、game/*、components/{Lobby,RoomView,GameView,GameViewMP,ChatPanel}、i18n.ts）+ tests/（13 用例）
  server/    Fastify+ws（net/{wsHub,session}、room/{roomManager,room}、app/index/config）+ tests/（真实 ws 集成 8 用例）
docs/        需求/技术/协议(v1.3)/测试/ADR
memory-bank/ 本记忆库
```

## 命令（实际可用）
- `npm test` —— shared(68) + client(13) + server(8) 全部 Vitest
- `npm run test:coverage` —— shared 覆盖率（V8，阈值 90/80/85/90 见 `packages/shared/vitest.config.ts`）
- `npm run build` —— client（tsc+vite）+ server（esbuild → `dist/index.mjs`，shared 打进 bundle）
- `npm start` —— 运行 server 构建产物（静态托管 client dist + ws；`CLIENT_DIST` 可覆盖目录）
- `npm run dev` / `npm run dev:server` —— vite(5173，/ws 代理 :3000) / tsx watch server
- `npm run typecheck` / `npm run lint` / `npm run format` —— 三包 tsc（含各包 tests）/ ESLint flat / Prettier
- Docker：仓库根 `Dockerfile`（`docker build -t bearbricks .` && `docker run -p 3000:3000`，未实测）

## 环境注意事项
- **端口纪律**：每次测试完成后必须退出后台 node/preview 进程，不占用端口（项目规则 test-rule）
- PowerShell 5.1 下写文件注意 UTF-8（无 BOM）；长命令避免 bash 风格 `&&` 以外的语法陷阱（PS7 才支持 `&&`，5.1 用 `;`）
- 无 Docker 运行时要求（本机开发直接 node）；部署阶段才需要

## 约束
- 纯内存状态，无数据库、无 Redis（ADR-0001/需求 §7）
- 浏览器目标：Chrome/Edge/Firefox/Safari 最近 2 大版本
- 无登录 → 身份仅 localStorage，可被用户清除（接受）
