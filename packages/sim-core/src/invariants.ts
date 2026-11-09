/**
 * Simulation invariants that must hold after every tick, whatever commands
 * arrive. Used by regression tests, soak runs and tournaments (`--check`).
 * Returns a list of violations (empty when healthy).
 */
import type { SimConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { dhypot } from "./dmath.ts";
import { isRestartPhase } from "./match.ts";
import type { WorldState } from "./types.ts";

export function checkInvariants(s: WorldState, cfg: SimConfig = DEFAULT_CONFIG): string[] {
  const out: string[] = [];
  const halfL = cfg.pitch.length / 2;
  const halfW = cfg.pitch.width / 2;
  const run = cfg.pitch.runOff;
  const finite = (v: number) => Number.isFinite(v);

  if (s.players.length !== 10) out.push(`expected 10 players, got ${s.players.length}`);
  for (const p of s.players) {
    for (const [k, v] of Object.entries({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, heading: p.heading, stamina: p.stamina })) if (!finite(v)) out.push(`${p.id}.${k} not finite`);
    if (Math.abs(p.x) > halfL + run + 1e-6 || Math.abs(p.y) > halfW + run + 1e-6) out.push(`${p.id} outside the world (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
    if (dhypot(p.vx, p.vy) > cfg.player.sprintSpeed + 3) out.push(`${p.id} too fast (${dhypot(p.vx, p.vy).toFixed(2)} m/s)`);
    if (p.stamina < 0 || p.stamina > 1) out.push(`${p.id} stamina ${p.stamina}`);
    if (p.touchCooldown < 0 || p.tackleCooldown < 0 || p.catchCooldown < 0 || p.stunned < 0) out.push(`${p.id} negative cooldown`);
  }
  // Player overlap: separation is iterative, so allow a small tolerance.
  for (let i = 0; i < s.players.length; i++)
    for (let j = i + 1; j < s.players.length; j++) {
      const a = s.players[i]!, b = s.players[j]!;
      const d = dhypot(a.x - b.x, a.y - b.y);
      if (d < cfg.player.radius * 2 * 0.5) out.push(`${a.id} and ${b.id} overlap (${d.toFixed(3)} m)`);
    }
  const b = s.ball;
  for (const [k, v] of Object.entries({ x: b.x, y: b.y, vx: b.vx, vy: b.vy })) if (!finite(v)) out.push(`ball.${k} not finite`);
  if (Math.abs(b.x) > halfL + run + 1e-6 || Math.abs(b.y) > halfW + run + 1e-6) out.push(`ball outside the world (${b.x.toFixed(2)}, ${b.y.toFixed(2)})`);
  if (dhypot(b.vx, b.vy) > cfg.action.maxKickSpeed + cfg.player.sprintSpeed + 1) out.push(`ball too fast (${dhypot(b.vx, b.vy).toFixed(1)} m/s)`);
  if (b.heldBy) {
    const k = s.players.find((p) => p.id === b.heldBy);
    if (!k || k.role !== "GK") out.push(`ball held by non-keeper ${b.heldBy}`);
  }
  const m = s.match;
  if (m.score.blue < 0 || m.score.red < 0) out.push("negative score");
  if (m.halfTicks > cfg.halfDurationSec * cfg.tickRate) out.push(`half clock overran (${m.halfTicks})`);
  if (isRestartPhase(m.phase)) {
    if (!m.restart) out.push(`phase ${m.phase} without a restart`);
    else {
      const t = s.players.find((p) => p.id === m.restart!.taker);
      if (!t || t.team !== m.restart.team) out.push(`restart taker ${m.restart.taker} not on ${m.restart.team}`);
      if (m.restart.deadlineTick < m.restart.readyTick) out.push("restart deadline before ready tick");
      if (s.tick > m.restart.deadlineTick + 1) out.push(`restart overdue at tick ${s.tick} (deadline ${m.restart.deadlineTick})`);
    }
  } else if (m.restart && m.phase !== "kickoff") out.push(`restart present in phase ${m.phase}`);
  if ((m.period === "preMatch" || m.period === "halftime" || m.period === "fullTime") && m.phase !== "stopped") out.push(`period ${m.period} with phase ${m.phase}`);
  return out;
}
