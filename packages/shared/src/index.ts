// @bearbricks/shared —— 纯 TS 游戏核心 + 规则 + 协议（引擎零 DOM/Node 依赖；protocol 依赖 zod）

export * from './rules/constants';
export * from './rules/attackTable';
export * from './engine/rng';
export * from './engine/bag';
export * from './engine/srs';
export * from './engine/board';
export * from './engine/garbage';
export * from './engine/score';
export * from './engine/game';
export * from './modes/sprint';
export * from './modes/survival';
export * from './modes/timed';
export * from './modes/strategy';
export * from './protocol/messages';
export * from './protocol/snapshot';
