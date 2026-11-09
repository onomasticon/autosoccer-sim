#!/usr/bin/env bun
/**
 * Headless throughput benchmark. Prints a table and writes docs/performance.md
 * (with --write) including the reference machine.
 *   bun run bench [--matches 3] [--write]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { buildObservation, serializeObservation } from "@autosoccer/controller-sdk";
import { CommandRunner, createSafeController, createSandboxedController, createPlaygroundScript } from "@autosoccer/controller-runtime";
import { makeConfig, Simulation, step } from "@autosoccer/sim-core";
import { ReplayPlayer, runtimeId } from "@autosoccer/telemetry";
import { runControllerMatch } from "./controllers.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const N = Number(arg("matches") ?? 3);
const cfg = makeConfig();
const matchSec = cfg.halfDurationSec * cfg.halves;
const src = (f: string) => readFileSync(new URL(`../../../examples/controllers/${f}`, import.meta.url), "utf8");

type Row = { name: string; msPerMatch: number; realtime: number; ticksPerSec: number; note: string };
const rows: Row[] = [];
const add = (name: string, ms: number, ticks: number, note: string) => rows.push({ name, msPerMatch: ms, realtime: matchSec / (ms / 1000), ticksPerSec: ticks / (ms / 1000), note });

function timeRuns(make: (seed: number) => { sim: Simulation; tick: () => void }): { ms: number; ticks: number } {
  let ms = 0;
  let ticks = 0;
  for (let i = 0; i < N; i++) {
    const { sim, tick } = make(100 + i);
    const t0 = performance.now();
    while (!sim.clock.finished) tick();
    ms += performance.now() - t0;
    ticks += sim.state.tick;
  }
  return { ms: ms / N, ticks: ticks / N };
}

// 1. Engine only.
{
  const r = timeRuns((seed) => { const sim = new Simulation(seed, cfg); return { sim, tick: () => sim.tick() }; });
  add("engine only (no commands)", r.ms, r.ticks, "physics + match rules, restarts via fallback");
}
// 2. Built-in controllers (no sandbox).
{
  const r = timeRuns((seed) => { const sim = new Simulation(seed, cfg); const run = new CommandRunner(sim, [createSafeController("blue"), createSafeController("red")]); return { sim, tick: () => run.tick() }; });
  add("safe vs safe (in-process)", r.ms, r.ticks, "built-in baseline controllers");
}
{
  const r = timeRuns((seed) => { const sim = new Simulation(seed, cfg); const run = new CommandRunner(sim, [createPlaygroundScript(seed)]); return { sim, tick: () => run.tick() }; });
  add("playground script (in-process)", r.ms, r.ticks, "debug script driving both teams");
}
// 3. Sandboxed featured controllers.
let replayJson = "";
{
  let ms = 0, ticks = 0;
  for (let i = 0; i < N; i++) {
    const m = await runControllerMatch({ seed: 100 + i, blue: { source: src("blue-possession.js") }, red: { source: src("red-counter.js") }, record: i === 0 });
    ms += m.wallMs;
    ticks += m.state.tick;
    if (m.replay) replayJson = JSON.stringify(m.replay);
  }
  add("blue-possession vs red-counter (sandboxed)", ms / N, ticks / N, "2 QuickJS sandboxes, 10 Hz decisions each");
}
{
  let ms = 0, ticks = 0;
  for (let i = 0; i < N; i++) {
    const m = await runControllerMatch({ seed: 100 + i, blue: { source: src("dumb.js") }, red: { source: src("dumb.js") } });
    ms += m.wallMs;
    ticks += m.state.tick;
  }
  add("dumb vs dumb (sandboxed)", ms / N, ticks / N, "sandbox overhead with trivial logic");
}
// 4. Replay verification (no controllers).
{
  const p = new ReplayPlayer(JSON.parse(replayJson));
  const t0 = performance.now();
  const v = p.verify();
  const ms = performance.now() - t0;
  add("replay verify (re-simulate + hashes)", ms, p.replay.finalTick, v.ok ? "all hashes matched" : "MISMATCH");
}

// Per-decision breakdown (sandboxed).
const sim = new Simulation(42, cfg);
const blue = await createSandboxedController({ team: "blue", source: src("blue-possession.js"), seed: 42 });
const red = await createSandboxedController({ team: "red", source: src("red-counter.js"), seed: 42 });
const dumb = await createSandboxedController({ team: "blue", source: "defineController({ update() { return []; } })", seed: 1 });
new CommandRunner(sim, [blue, red]).run(3000);
const per = (f: () => void, n = 300) => { for (let i = 0; i < 20; i++) f(); const t = performance.now(); for (let i = 0; i < n; i++) f(); return ((performance.now() - t) / n) * 1000; };
const breakdown = {
  engineStepUs: per(() => step(sim.state, [], cfg), 3000),
  observationHostUs: per(() => serializeObservation(buildObservation(sim.state, "blue")), 3000),
  sandboxEmptyDecideUs: per(() => dumb.decide({ tick: sim.state.tick, state: sim.state, events: [], rejected: [] })),
  blueDecideUs: per(() => blue.decide({ tick: sim.state.tick, state: sim.state, events: [], rejected: [] })),
  redDecideUs: per(() => red.decide({ tick: sim.state.tick, state: sim.state, events: [], rejected: [] })),
};

const machine = { cpu: cpus()[0]?.model ?? "?", cores: cpus().length, memGB: +(totalmem() / 2 ** 30).toFixed(1), freeGB: +(freemem() / 2 ** 30).toFixed(1), os: `${platform()} ${release()}`, runtime: runtimeId() };
console.log(`machine     ${machine.cpu} · ${machine.cores} cores · ${machine.memGB} GB · ${machine.os} · ${machine.runtime}`);
console.log(`${"scenario".padEnd(44)} ${"ms/match".padStart(9)} ${"× real-time".padStart(12)} ${"ticks/s".padStart(10)}`);
for (const r of rows) console.log(`${r.name.padEnd(44)} ${r.msPerMatch.toFixed(0).padStart(9)} ${r.realtime.toFixed(0).padStart(11)}× ${Math.round(r.ticksPerSec).toString().padStart(10)}`);
console.log(`per decision (µs): engine step ${breakdown.engineStepUs.toFixed(1)} · observation ${breakdown.observationHostUs.toFixed(1)} · sandbox empty ${breakdown.sandboxEmptyDecideUs.toFixed(0)} · blue ${breakdown.blueDecideUs.toFixed(0)} · red ${breakdown.redDecideUs.toFixed(0)}`);
const target = rows.every((r) => r.realtime >= 10);
console.log(`target ≥10× real-time: ${target ? "MET for every scenario" : "MISSED"}`);

if (process.argv.includes("--write")) {
  const md = [
    "# Performance",
    "",
    `Measured with \`bun run bench --matches ${N} --write\`. Full 2 × ${cfg.halfDurationSec} s matches, mean of ${N} seeds.`,
    "",
    "## Reference machine",
    "",
    `- CPU: ${machine.cpu} (${machine.cores} cores)`,
    `- Memory: ${machine.memGB} GB`,
    `- OS: ${machine.os}`,
    `- Runtime: ${machine.runtime}, single thread per match`,
    "",
    "## Throughput (target: at least 10× real time)",
    "",
    "| Scenario | ms per match | × real time | ticks/s | Notes |",
    "| --- | ---: | ---: | ---: | --- |",
    ...rows.map((r) => `| ${r.name} | ${r.msPerMatch.toFixed(0)} | **${r.realtime.toFixed(0)}×** | ${Math.round(r.ticksPerSec).toLocaleString("en-US")} | ${r.note} |`),
    "",
    `Target ≥10× real time: **${target ? "met in every scenario" : "missed — see table"}**.`,
    "",
    "## Where the time goes (sandboxed match)",
    "",
    "| Cost | µs |",
    "| --- | ---: |",
    `| engine \`step\` (one 60 Hz tick) | ${breakdown.engineStepUs.toFixed(1)} |`,
    `| build + serialise one observation (host) | ${breakdown.observationHostUs.toFixed(1)} |`,
    `| sandbox round trip with an empty controller (parse obs, freeze, call, stringify) | ${breakdown.sandboxEmptyDecideUs.toFixed(0)} |`,
    `| blue-possession decision | ${breakdown.blueDecideUs.toFixed(0)} |`,
    `| red-counter decision | ${breakdown.redDecideUs.toFixed(0)} |`,
    "",
    "A full match has 14,640 ticks and 2,400 decisions per team. The engine costs about 50 ms per match; almost all of the rest is controller decisions inside QuickJS.",
    "",
    "**Bottlenecks and what was done (M7):**",
    "",
    "1. **Parsing the observation in QuickJS.** `JSON.parse` is slow for long decimal numbers. SDK 1.2 rounds observation numbers to 4 decimals (0.1 mm), which roughly halves parse time.",
    "2. **An extra sandbox call per update to drain logs.** The host now reads a pending-log counter first and only drains when something was logged.",
    "3. **Controller helpers.** `Soccer.interceptPoint` now computes the ball-path constants once per call instead of once per step, and rejects unreachable points early.",
    "4. **Batches scale across cores.** `bun run tournament` runs matches in parallel worker processes, and each match is independent and deterministic.",
    "",
    "**Remaining headroom:** a binary or structured-clone transfer instead of JSON, skipping the deep-freeze of observations, and caching repeated helper results inside controllers.",
    "",
  ];
  writeFileSync(new URL("../../../docs/performance.md", import.meta.url), md.join("\n"));
  console.log("wrote docs/performance.md");
}
if (!target) process.exit(1);
