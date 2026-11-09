import type { WorldState } from "./types.ts";

/**
 * 64-bit state hash (two independent FNV-1a 32-bit lanes) over the exact
 * IEEE-754 bit patterns of every simulated quantity. Any difference in any
 * bit of state changes the hash. Returned as 16 lowercase hex chars.
 */
export function hashState(s: WorldState): string {
  const buf = new DataView(new ArrayBuffer(8));
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  const byte = (b: number) => {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ b, 0x5bd1e995) >>> 0; // odd multiplier: keeps all bits live
  };
  const num = (v: number) => {
    buf.setFloat64(0, v);
    for (let i = 0; i < 8; i++) byte(buf.getUint8(i));
  };
  const str = (v: string) => {
    for (let i = 0; i < v.length; i++) byte(v.charCodeAt(i) & 0xff);
  };

  num(s.seed);
  num(s.tick);
  for (const r of s.rng) num(r);
  for (const p of s.players) {
    str(p.id);
    num(p.x);
    num(p.y);
    num(p.vx);
    num(p.vy);
    num(p.heading);
    num(p.stamina);
    num(p.intent.targetX ?? Number.NaN);
    num(p.intent.targetY ?? Number.NaN);
    byte(p.intent.sprint ? 1 : 0);
    byte(p.intent.dribble ? 1 : 0);
    num(p.touchCooldown);
    num(p.tackleCooldown);
    num(p.catchCooldown);
    num(p.stunned);
  }
  num(s.ball.x);
  num(s.ball.y);
  num(s.ball.vx);
  num(s.ball.vy);
  str(s.ball.heldBy ?? "-");
  num(s.ball.holdTicks);
  str(s.ball.lastTouch ?? "-");
  str(s.ball.inGoal ?? "-");
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
