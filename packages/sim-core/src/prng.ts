/**
 * Seeded, serialisable PRNG (sfc32 seeded via splitmix32). Its whole state is
 * four uint32s, so it can live inside the immutable world state and be hashed.
 * All randomness in the engine must flow through this.
 */
export type RngState = readonly [number, number, number, number];

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export function seedRng(seed: number): RngState {
  if (!Number.isFinite(seed)) throw new Error("seed must be a finite number");
  const sm = splitmix32(Math.trunc(seed));
  const st: [number, number, number, number] = [sm(), sm(), sm(), sm()];
  // Warm up so nearby seeds diverge immediately.
  let r: RngState = st;
  for (let i = 0; i < 12; i++) r = nextUint32(r)[1];
  return r;
}

/** Returns [uint32, nextState]. Pure. */
export function nextUint32(s: RngState): [number, RngState] {
  let [a, b, c, d] = s;
  const t = (((a + b) >>> 0) + d) >>> 0;
  d = (d + 1) >>> 0;
  a = (b ^ (b >>> 9)) >>> 0;
  b = (c + (c << 3)) >>> 0;
  c = ((c << 21) | (c >>> 11)) >>> 0;
  c = (c + t) >>> 0;
  return [t, [a, b, c, d]];
}

/** Returns [float in [0,1), nextState]. */
export function nextFloat(s: RngState): [number, RngState] {
  const [u, n] = nextUint32(s);
  return [u / 4294967296, n];
}

/**
 * Mutable convenience wrapper for code that draws many numbers in sequence
 * (e.g. world creation, debug scripts). Call `.state` to get it back out.
 */
export class Rng {
  state: RngState;
  constructor(seedOrState: number | RngState) {
    this.state = typeof seedOrState === "number" ? seedRng(seedOrState) : seedOrState;
  }
  float(): number {
    const [v, n] = nextFloat(this.state);
    this.state = n;
    return v;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }
  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.float() * (maxExclusive - minInclusive));
  }
  bool(p = 0.5): boolean {
    return this.float() < p;
  }
}
