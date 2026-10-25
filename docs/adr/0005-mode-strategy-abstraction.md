# ADR-0005：模式策略抽象（GameModeStrategy）

- 状态：已接受（2026-10-22）
- 关联：ADR-0004、technical-design.md §2.3

## 决策
三个模式各自实现统一接口，`Room` 持有一个策略实例，不写模式分支散落逻辑。
**M3 落地后的实际接口（修订）**：

```ts
interface GameModeStrategy {
  readonly id: 'sprint' | 'survival' | 'timed';
  onLinesCleared(clear: AttackInput): AttackPlan | null; // 攻击计划，sprint 返回 null
  onTopOut(): TopOutAction; // ELIMINATE | RESPAWN | RESET_BOARD
  engineMode(): GameMode;   // sprint 引擎自带超时/清盘；其余用 marathon 语义（顶出即终局）
}
```

- 与下述初稿的差异（2026-10-22，M3 落地时简化并记入 technical-design §2.3）：
  - `createInitialState/onTick/isFinished/computeRanking/hudDescriptor` 不进入接口：排名由各模式模块的
    `computeSprintRanking` / `computeSurvivalRanking` 提供，ModeState 由 Room 层组装，HUD 按模式切换；
  - `AttackPlan = { lines }`，offset 与目标转发在 Room 层完成；
  - M4 timed 复用本接口，复活经 `onTopOut → RESPAWN` 扩展。
- `TopOutAction` 直接映射三模式差异：`ELIMINATE`（survival）、`RESPAWN`（timed）、`RESET_BOARD`（sprint，引擎内部清盘处置）
- `AttackPlan` 由 `rules/attackTable.ts` 计算，sprint 策略返回 `null`（攻击关闭）
- 新增模式 = 新增一个策略文件 + 注册，引擎与网络层零改动

## 理由
- 三模式的差异集中在「消行后做什么 / 顶出后做什么 / 何时结束 / 怎么排名」四个问题，正好是策略接口的钩子
- 客户端 HUD 由 `mode` 分支渲染（`hudDescriptor()` 未进入最终接口；后续若模式继续增加可再抽象）

## 备选
- 在 Room 内 if-else：三处 × 每处 3 分支，随模式增加失控
- 三个 Room 子类：继承层次深，公共生命周期逻辑重复

## 后果
- `shared/modes/` 每模式一个文件，各自可独立单测
- ModeState 需可序列化进快照/重连恢复包（协议已预留 `modeState` 字段）
