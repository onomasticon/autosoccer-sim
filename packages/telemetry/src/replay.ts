/**
 * Replay files (format v1) — everything needed to reproduce and inspect a
 * match without running any controller:
 *   versions + seed + full config, controller identities, the validated
 *   command stream, every event, engine rejections, controller decision
 *   records (issued actions, validation rejections, modes/notes), periodic
 *   full-state snapshots for seeking, and periodic state hashes for
 *   verification.
 *
 * ReplayPlayer rebuilds any tick by loading the nearest snapshot and stepping
 * the engine forward with the recorded commands. The same renderer and
 * inspector are used for live and replay viewing.
 */
import type { CommandLogEntry, EngineCommand, LoggedEvent, SimConfig, TeamId, WorldState } from "@autosoccer/sim-core";
import { createWorld, ENGINE_VERSION, hashState, step } from "@autosoccer/sim-core";

export const REPLAY_FORMAT = "autosoccer-replay";
export const REPLAY_FORMAT_VERSION = 1;

export interface ControllerIdentity {
  team: TeamId;
  name: string;
  version: string | null;
  label: string;
  /** FNV-1a hash of the script source (identifies the exact code). */
  sourceHash: string | null;
  disabled?: boolean;
}

/** One controller decision as recorded (no pitch-drawing lines). */
export interface RecordedDecision {
  tick: number;
  team: TeamId;
  status: "ok" | "failed" | "fallback";
  /** Raw actions the script returned (issued). */
  actions: unknown[] | null;
  /** SDK-validation rejections for this decision. */
  rejected: Array<{ action: unknown; reason: string }>;
  mode?: string | null;
  notes?: string[];
  /** Decision lines (rounded to cm) so replays render exactly like live play. */
  lines?: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; kind?: string }>;
}

export interface RecordedDiagnostic {
  tick: number;
  team: TeamId;
  kind: string;
  message: string;
}

export interface ReplayFile {
  format: typeof REPLAY_FORMAT;
  formatVersion: number;
  engineVersion: string;
  sdkVersion: string | null;
  runtime: string;
  seed: number;
  config: SimConfig;
  controllers: Partial<Record<TeamId, ControllerIdentity>>;
  initialHash: string;
  finalTick: number;
  finalHash: string;
  result: { period: string; score: { blue: number; red: number } };
  /** Validated command stream (what the engine accepted, by decision tick). */
  commands: CommandLogEntry[];
  /** Engine rejections of submitted commands (issued but not executed). */
  engineRejections: Array<{ tick: number; command: unknown; reason: string }>;
  events: LoggedEvent[];
  decisions: RecordedDecision[];
  diagnostics: RecordedDiagnostic[];
  snapshotEvery: number;
  snapshots: Array<{ tick: number; state: WorldState }>;
  hashEvery: number;
  hashes: Array<{ tick: number; hash: string }>;
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/**
 * Collects snapshots and hashes while a match runs. Call `observe(state)`
 * with every new state (including the initial one), then `finish(...)`.
 */
export class ReplayRecorder {
  readonly snapshots: Array<{ tick: number; state: WorldState }> = [];
  readonly hashes: Array<{ tick: number; hash: string }> = [];
  constructor(
    readonly snapshotEvery = 600,
    readonly hashEvery = 60,
  ) {}

  observe(state: WorldState): void {
    if (state.tick % this.hashEvery === 0) this.hashes.push({ tick: state.tick, hash: hashState(state) });
    if (state.tick % this.snapshotEvery === 0) this.snapshots.push({ tick: state.tick, state: JSON.parse(JSON.stringify(state)) as WorldState });
  }

  finish(args: {
    seed: number;
    config: SimConfig;
    state: WorldState;
    commands: readonly CommandLogEntry[];
    engineRejections: ReadonlyArray<{ tick: number; command: unknown; reason: string }>;
    events: readonly LoggedEvent[];
    decisions?: readonly RecordedDecision[];
    diagnostics?: readonly RecordedDiagnostic[];
    controllers?: Partial<Record<TeamId, ControllerIdentity>>;
    sdkVersion?: string | null;
    runtime?: string;
  }): ReplayFile {
    const { state } = args;
    if (this.hashes[this.hashes.length - 1]?.tick !== state.tick) this.hashes.push({ tick: state.tick, hash: hashState(state) });
    return {
      format: REPLAY_FORMAT,
      formatVersion: REPLAY_FORMAT_VERSION,
      engineVersion: ENGINE_VERSION,
      sdkVersion: args.sdkVersion ?? null,
      runtime: args.runtime ?? "unknown",
      seed: args.seed,
      config: args.config,
      controllers: args.controllers ?? {},
      initialHash: hashState(createWorld(args.seed, args.config)),
      finalTick: state.tick,
      finalHash: hashState(state),
      result: { period: state.match.period, score: { ...state.match.score } },
      commands: args.commands.map((e) => ({ tick: e.tick, commands: [...e.commands] })),
      engineRejections: args.engineRejections.map((r) => ({ tick: r.tick, command: r.command, reason: r.reason })),
      events: [...args.events],
      decisions: [...(args.decisions ?? [])],
      diagnostics: [...(args.diagnostics ?? [])],
      snapshotEvery: this.snapshotEvery,
      snapshots: this.snapshots,
      hashEvery: this.hashEvery,
      hashes: this.hashes,
    };
  }
}

export function parseReplay(text: string): ReplayFile {
  const r = JSON.parse(text) as ReplayFile;
  if (r.format !== REPLAY_FORMAT) throw new Error("not an autosoccer replay file");
  if (r.formatVersion !== REPLAY_FORMAT_VERSION) throw new Error(`unsupported replay format version ${r.formatVersion}`);
  if (r.engineVersion !== ENGINE_VERSION) throw new Error(`replay recorded with engine ${r.engineVersion}; this build is ${ENGINE_VERSION}`);
  return r;
}

export interface VerifyReport {
  checked: number;
  mismatches: Array<{ tick: number; expected: string; actual: string }>;
  initialOk: boolean;
  finalOk: boolean;
  ok: boolean;
}

/**
 * Plays a replay without controllers. `seek(tick)` reuses the current state
 * when moving forward a little, otherwise restarts from the nearest snapshot.
 */
export class ReplayPlayer {
  state: WorldState;
  private readonly byTick = new Map<number, readonly EngineCommand[]>();
  /** Decisions sorted by tick, per team. */
  private readonly decisionsByTeam: Record<TeamId, RecordedDecision[]> = { blue: [], red: [] };

  constructor(readonly replay: ReplayFile) {
    for (const e of replay.commands) this.byTick.set(e.tick, e.commands);
    for (const d of replay.decisions) this.decisionsByTeam[d.team].push(d);
    this.state = this.snapshotAtOrBefore(0);
  }

  get tick(): number {
    return this.state.tick;
  }

  private snapshotAtOrBefore(tick: number): WorldState {
    let best: WorldState | null = null;
    for (const s of this.replay.snapshots) if (s.tick <= tick && (!best || s.tick > best.tick)) best = s.state;
    return best ? (JSON.parse(JSON.stringify(best)) as WorldState) : createWorld(this.replay.seed, this.replay.config);
  }

  /** Advance one tick using only the recorded commands. */
  stepOnce(): WorldState {
    if (this.state.tick >= this.replay.finalTick) return this.state;
    this.state = step(this.state, this.byTick.get(this.state.tick) ?? [], this.replay.config).state;
    return this.state;
  }

  seek(tick: number): WorldState {
    const target = Math.max(0, Math.min(tick, this.replay.finalTick));
    if (target < this.state.tick || target - this.state.tick > this.replay.snapshotEvery) this.state = this.snapshotAtOrBefore(target);
    while (this.state.tick < target) this.stepOnce();
    return this.state;
  }

  /** Events up to and including the current tick. */
  eventsUpTo(tick = this.state.tick): LoggedEvent[] {
    return this.replay.events.filter((e) => e.tick < tick);
  }

  /** Most recent decision of a team at or before a tick. */
  decisionAt(team: TeamId, tick = this.state.tick): RecordedDecision | null {
    const a = this.decisionsByTeam[team];
    let lo = 0;
    let hi = a.length - 1;
    let ans: RecordedDecision | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid]!.tick <= tick) {
        ans = a[mid]!;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Re-simulate the whole match from the seed and compare every recorded hash. */
  verify(onProgress?: (tick: number) => void): VerifyReport {
    let s = createWorld(this.replay.seed, this.replay.config);
    const initialOk = hashState(s) === this.replay.initialHash;
    const expected = new Map(this.replay.hashes.map((h) => [h.tick, h.hash]));
    const mismatches: VerifyReport["mismatches"] = [];
    let checked = 0;
    const check = () => {
      const e = expected.get(s.tick);
      if (e === undefined) return;
      checked++;
      const a = hashState(s);
      if (a !== e) mismatches.push({ tick: s.tick, expected: e, actual: a });
    };
    check();
    while (s.tick < this.replay.finalTick) {
      s = step(s, this.byTick.get(s.tick) ?? [], this.replay.config).state;
      check();
      if (onProgress && s.tick % 1200 === 0) onProgress(s.tick);
    }
    const finalOk = hashState(s) === this.replay.finalHash;
    return { checked, mismatches, initialOk, finalOk, ok: initialOk && finalOk && mismatches.length === 0 };
  }
}

/** Timeline markers for the viewer / CLI. */
export interface TimelineMarker {
  tick: number;
  kind: "goal" | "foul" | "restart" | "period" | "shot" | "catch" | "tackle";
  label: string;
  team?: TeamId;
}

export function timelineMarkers(events: readonly LoggedEvent[]): TimelineMarker[] {
  const out: TimelineMarker[] = [];
  for (const le of events) {
    const e = le.event;
    if (e.type === "goalScored") out.push({ tick: le.tick, kind: "goal", team: e.team, label: `GOAL ${e.team}${e.scorer ? ` (${e.scorer})` : ""} ${e.score.blue}–${e.score.red}` });
    else if (e.type === "foul") out.push({ tick: le.tick, kind: "foul", team: e.by.startsWith("blue") ? "blue" : "red", label: `foul by ${e.by}` });
    else if (e.type === "restartAwarded" && e.restart !== "kickoff") out.push({ tick: le.tick, kind: "restart", team: e.team, label: `${e.restart} → ${e.team}` });
    else if (e.type === "periodStart" && e.period !== "firstHalf") out.push({ tick: le.tick, kind: "period", label: e.period });
    else if (e.type === "catch" && e.success) out.push({ tick: le.tick, kind: "catch", team: e.playerId.startsWith("blue") ? "blue" : "red", label: `${e.playerId} catch` });
    else if (e.type === "tackle" && e.success) out.push({ tick: le.tick, kind: "tackle", team: e.playerId.startsWith("blue") ? "blue" : "red", label: `${e.playerId} tackle won` });
  }
  return out;
}
