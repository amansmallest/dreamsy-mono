/** Seeded PRNG (sfc32). Deterministic across platforms. */
export class Random {
  private a: number; private b: number; private c: number; private d: number;
  constructor(seed: number) {
    this.a = 0x9e3779b9; this.b = 0x243f6a88; this.c = 0xb7e15162; this.d = seed >>> 0;
    for (let i = 0; i < 15; i++) this.next();
  }
  /** [0, 1) */
  next(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
}
