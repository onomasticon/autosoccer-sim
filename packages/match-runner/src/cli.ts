#!/usr/bin/env bun
/**
 * Headless runner CLI.
 *
 *   bun run headless --seed 42 --seconds 30 [--out out/run.jsonl] [--verify]
 *
 * --verify re-runs the recorded command stream without the script and checks
 * the final state hash matches.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashState, Simulation } from "@autosoccer/sim-core";
import { runtimeId } from "@autosoccer/telemetry";
import { runHeadless } from "./index.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const seed = Number(arg("seed") ?? 42);
const seconds = arg("seconds") !== undefined ? Number(arg("seconds")) : undefined;
const out = arg("out");

const r = runHeadless({ seed, seconds });
console.log(`runtime      ${runtimeId()}`);
console.log(`seed         ${r.seed}`);
console.log(`ticks        ${r.ticks} (${(r.ticks / r.config.tickRate).toFixed(1)} s simulated @ ${r.config.tickRate} Hz)`);
console.log(`commands     ${r.log.reduce((n, e) => n + e.commands.length, 0)} accepted across ${r.log.length} decision ticks`);
for (const c of r.checkpoints.filter((_, i) => i % 10 === 0)) console.log(`  t=${String(c.tick).padStart(6)}  ${c.hash}`);
console.log(`final hash   ${r.finalHash}`);
console.log(`wall time    ${r.wallMs.toFixed(1)} ms  (${r.realtimeFactor.toFixed(0)}x real-time)`);

if (process.argv.includes("--verify")) {
  const replayed = Simulation.replay(seed, r.log, r.ticks, r.config);
  const h = hashState(replayed);
  const ok = h === r.finalHash;
  console.log(`replay hash  ${h}  ${ok ? "MATCH" : "MISMATCH"}`);
  if (!ok) process.exit(1);
}

if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, r.telemetry.toJSONL());
  console.log(`telemetry    ${out}`);
}
