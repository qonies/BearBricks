// 7-bag：每袋 7 种方块洗牌后依次取出（Fisher-Yates，由确定性 Rng 驱动）

import { PIECE_TYPES, type PieceType } from './srs';
import type { Rng } from './rng';

export class SevenBag {
  private pending: PieceType[] = [];

  constructor(private readonly rng: Rng) {}

  private refill(): void {
    const bag: PieceType[] = [...PIECE_TYPES];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng.next() * (i + 1));
      const tmp = bag[i];
      bag[i] = bag[j];
      bag[j] = tmp;
    }
    this.pending.push(...bag);
  }

  next(): PieceType {
    if (this.pending.length === 0) this.refill();
    return this.pending.shift() as PieceType;
  }

  peek(n: number): PieceType[] {
    while (this.pending.length < n) this.refill();
    return this.pending.slice(0, n);
  }
}
