// 确定性 RNG：xmur3 字符串散列派生 xorshift128 四字状态（协议/技术设计选定）

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export class Rng {
  private x: number;
  private y: number;
  private z: number;
  private w: number;

  constructor(seed: string | number) {
    const h = xmur3(String(seed));
    this.x = h();
    this.y = h();
    this.z = h();
    this.w = h();
    if ((this.x | this.y | this.z | this.w) === 0) this.x = 0x9e3779b9;
  }

  /** 返回 32 位无符号整数 */
  nextUint32(): number {
    let t = this.x ^ (this.x << 11);
    t >>>= 0;
    const w = this.w;
    this.x = this.y;
    this.y = this.z;
    this.z = w;
    this.w = (w ^ (w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return this.w;
  }

  /** 返回 [0, 1) */
  next(): number {
    return this.nextUint32() / 4294967296;
  }
}
