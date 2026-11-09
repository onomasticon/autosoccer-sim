/**
 * One match of a seeded series, with all the checks a release batch needs:
 * completion, controller failures, per-tick invariants, optional determinism
 * re-run (same seed ⇒ same final hash) and optional replay recording +
 * verification. Pure function of (seed, spec) — safe to run in parallel workers.
 */
import { CommandRunner, createSandboxedController } from "@autosoccer/controller-runtime";
import type { ConfigOverrides } from "@autosoccer/sim-core";
import { checkInvariants, makeConfig, Simulation } from "@autosoccer/sim-core";
import { ReplayPlayer, ReplayRecorder, type ReplayFile } from "@autosoccer/telemetry";
import { buildReplay } from "./record.ts";
import { analyzeMatch, sampleState, type Sample, type TeamStats } from "./stats.ts";

export interface SeriesSpec {
  blue: { label: string; source: string };
  red: { label: string; source: string };
  config?: ConfigOverrides;
  /** Re-run this match and compare final hashes when seed % determinismEvery === 0 (0 = never). */
  determinismEvery?: number;
  /** Record + verify a replay when seed % replayEvery === 0, or always on failure (0 = only failures). */
  replayEvery?: number;
  checkInvariants?: boolean;
  maxTicks?: number;
}

export interface MatchSummary {
  seed: number;
  finished: boolean;
  ticks: number;
  score: { blue: number; red: number };
  wallMs: number;
  realtime: number;
  hash: string;
  rerunHash: string | null;
  deterministic: boolean | null;
  replayVerified: boolean | null;
  failures: string[];
  invariantViolations: string[];
  profile: Record<"blue" | "red", TeamStats>;
}

async function playOnce(seed: number, spec: SeriesSpec, record: boolean) {
  const config = makeConfig(spec.config);
  const blue = await createSandboxedController({ team: "blue", source: spec.blue.source, label: spec.blue.label, config, seed });
  const red = await createSandboxedController({ team: "red", source: spec.red.source, label: spec.red.label, config, seed });
  const sim = new Simulation(seed, config);
  const runner = new CommandRunner(sim, [blue, red]);
  const recorder = record ? new ReplayRecorder() : null;
  recorder?.observe(sim.state);
  const samples: Sample[] = [];
  const violations: string[] = [];
  const max = spec.maxTicks ?? 40_000;
  const t0 = performance.now();
  while (!sim.clock.finished && sim.state.tick < max) {
    const s = runner.tick();
    recorder?.observe(s);
    if (spec.checkInvariants !== false && violations.length < 5) for (const v of checkInvariants(s, config)) violations.push(`t=${s.tick} ${v}`);
    if (s.tick % 60 === 0 && (s.match.period === "firstHalf" || s.match.period === "secondHalf")) samples.push(sampleState(s, config));
  }
  const wallMs = performance.now() - t0;
  const replay: ReplayFile | null = recorder ? buildReplay(sim, recorder, { blue, red }) : null;
  const failures = [...blue.diagnostics, ...red.diagnostics]
    .filter((d) => ["error", "timeout", "out-of-memory", "invalid-output", "disabled"].includes(d.kind))
    .map((d) => `${d.team} ${d.kind}: ${d.message}`);
  failures.push(...runner.diagnostics.filter((d) => d.kind === "error").map((d) => `runner: ${d.message}`));
  runner.dispose();
  return { sim, wallMs, samples, violations, failures, replay, config };
}

export async function runSeriesMatch(seed: number, spec: SeriesSpec): Promise<{ summary: MatchSummary; replay: ReplayFile | null }> {
  const wantReplay = !!spec.replayEvery && seed % spec.replayEvery === 0;
  let a = await playOnce(seed, spec, wantReplay);
  const finished = a.sim.state.match.period === "fullTime";
  // Failures always get a replay for offline inspection.
  if (!wantReplay && (!finished || a.failures.length || a.violations.length)) a = { ...a, replay: (await playOnce(seed, spec, true)).replay };
  let rerunHash: string | null = null;
  if (spec.determinismEvery && seed % spec.determinismEvery === 0) rerunHash = (await playOnce(seed, spec, false)).sim.hash();
  const replayVerified = a.replay ? new ReplayPlayer(JSON.parse(JSON.stringify(a.replay))).verify().ok : null;
  const s = a.sim.state;
  return {
    summary: {
      seed,
      finished,
      ticks: s.tick,
      score: { ...s.match.score },
      wallMs: a.wallMs,
      realtime: s.tick / a.config.tickRate / (a.wallMs / 1000),
      hash: a.sim.hash(),
      rerunHash,
      deterministic: rerunHash === null ? null : rerunHash === a.sim.hash(),
      replayVerified,
      failures: a.failures,
      invariantViolations: a.violations,
      profile: analyzeMatch(a.sim.events, a.samples, a.config),
    },
    replay: a.replay,
  };
}

export interface SeriesReport {
  blue: string;
  red: string;
  matches: number;
  completed: number;
  hangs: number[];
  failures: Array<{ seed: number; failures: string[] }>;
  invariantViolations: Array<{ seed: number; violations: string[] }>;
  determinismChecked: number;
  determinismDiverged: number[];
  replaysVerified: number;
  replaysFailed: number[];
  results: { blueWins: number; draws: number; redWins: number; goals: { blue: number; red: number }; scorelines: Record<string, number> };
  meanPerMatch: Record<"blue" | "red", Record<string, number>>;
  runtime: { totalWallMs: number; meanMatchMs: number; minRealtime: number; meanRealtime: number };
}

export function summarize(blue: string, red: string, list: MatchSummary[], totalWallMs: number): SeriesReport {
  const n = list.length || 1;
  const totals: Record<"blue" | "red", Record<string, number>> = { blue: {}, red: {} };
  const scorelines: Record<string, number> = {};
  let bw = 0, rw = 0, dr = 0, gb = 0, gr = 0;
  for (const m of list) {
    for (const t of ["blue", "red"] as const) for (const [k, v] of Object.entries(m.profile[t])) totals[t][k] = (totals[t][k] ?? 0) + (v as number);
    const key = `${m.score.blue}-${m.score.red}`;
    scorelines[key] = (scorelines[key] ?? 0) + 1;
    gb += m.score.blue;
    gr += m.score.red;
    if (m.score.blue > m.score.red) bw++;
    else if (m.score.red > m.score.blue) rw++;
    else dr++;
  }
  const mean = (t: "blue" | "red") => Object.fromEntries(Object.entries(totals[t]).map(([k, v]) => [k, +(v / n).toFixed(3)]));
  return {
    blue,
    red,
    matches: list.length,
    completed: list.filter((m) => m.finished).length,
    hangs: list.filter((m) => !m.finished).map((m) => m.seed),
    failures: list.filter((m) => m.failures.length).map((m) => ({ seed: m.seed, failures: m.failures })),
    invariantViolations: list.filter((m) => m.invariantViolations.length).map((m) => ({ seed: m.seed, violations: m.invariantViolations })),
    determinismChecked: list.filter((m) => m.deterministic !== null).length,
    determinismDiverged: list.filter((m) => m.deterministic === false).map((m) => m.seed),
    replaysVerified: list.filter((m) => m.replayVerified === true).length,
    replaysFailed: list.filter((m) => m.replayVerified === false).map((m) => m.seed),
    results: { blueWins: bw, draws: dr, redWins: rw, goals: { blue: gb, red: gr }, scorelines },
    meanPerMatch: { blue: mean("blue"), red: mean("red") },
    runtime: {
      totalWallMs,
      meanMatchMs: list.reduce((s, m) => s + m.wallMs, 0) / n,
      minRealtime: Math.min(...list.map((m) => m.realtime)),
      meanRealtime: list.reduce((s, m) => s + m.realtime, 0) / n,
    },
  };
}
