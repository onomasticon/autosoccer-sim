import type { CommandSource } from "@autosoccer/controller-sdk";
import {
  CommandRunner,
  createPlaygroundScript,
  createScenarioSource,
  getScenario,
  keyboardCommands,
  loadSandbox,
  SandboxedController,
  type KeyActions,
  type KeyState,
  type ScenarioSource,
} from "@autosoccer/controller-runtime";
import { buildReplay } from "@autosoccer/match-runner";
import type { LoggedEvent, PlayerId, TeamId } from "@autosoccer/sim-core";
import { parseReplay, ReplayPlayer, ReplayRecorder, type RecordedDecision, type ReplayFile, type VerifyReport } from "@autosoccer/telemetry";
import { DEFAULT_CONFIG, hashState, isDecisionTick, Simulation } from "@autosoccer/sim-core";

export type InputMode = "script" | "manual" | "scenario" | "controllers" | "replay";

/** What the inspector shows for a team's decision (live or replayed). */
export interface DecisionView {
  tick: number;
  status: string;
  actions: unknown[] | null;
  rejected: Array<{ action: unknown; reason: string }>;
  mode: string | null;
  notes: string[];
  lines: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; kind?: string }>;
}

export interface ScriptSlot {
  source: string;
  label: string;
}

export interface VerifyResult {
  tick: number;
  live: string;
  replayed: string;
  match: boolean;
}

/**
 * Viewer-side driver. Owns a sim-core Simulation (the same class the headless
 * runner uses), advances it on a fixed 60 Hz accumulator and notifies React.
 * Rendering never writes to the simulation state.
 */
export class ViewerEngine {
  sim: Simulation;
  private runner!: CommandRunner;
  playing = false;
  speed = 1;
  mode: InputMode = "script";
  scenario: ScenarioSource | null = null;
  selected: PlayerId | null = null;
  overlays = true;
  keys: KeyState = { up: false, down: false, left: false, right: false, sprint: false, dribble: false };
  /** One-shot action keys, latched until the next decision tick. */
  pending: KeyActions = { kick: false, tackle: false, hands: false };
  lastVerify: VerifyResult | null = null;
  /** Controller scripts per team (used in "controllers" mode). */
  scripts: { blue: ScriptSlot; red: ScriptSlot } = { blue: { source: "", label: "" }, red: { source: "", label: "" } };
  controllers: { blue: SandboxedController | null; red: SandboxedController | null } = { blue: null, red: null };
  private qjs: Awaited<ReturnType<typeof loadSandbox>> | null = null;
  /** Records every live run so it can be saved as a replay. */
  recorder = new ReplayRecorder();
  /** Set in replay mode. */
  player: ReplayPlayer | null = null;
  lastReplayVerify: VerifyReport | null = null;
  /** Fit the pitch to the window width instead of 1:1 pixels. */
  fit = false;
  private listeners = new Set<() => void>();
  private raf = 0;
  private lastTime = 0;
  private acc = 0;

  constructor(seed: number) {
    this.sim = new Simulation(seed, DEFAULT_CONFIG);
    this.buildRunner();
    this.recorder.observe(this.sim.state);
  }

  /** Load the QuickJS sandbox (async, once). */
  async init(): Promise<void> {
    this.qjs = await loadSandbox();
  }

  setScript(team: "blue" | "red", slot: ScriptSlot, restart = true): void {
    this.scripts[team] = slot;
    if (restart && this.mode === "controllers") this.reset();
  }

  private disposeControllers(): void {
    this.controllers.blue?.dispose();
    this.controllers.red?.dispose();
    this.controllers = { blue: null, red: null };
  }

  private buildRunner(): void {
    this.disposeControllers();
    if (this.mode === "replay") {
      this.runner = new CommandRunner(this.sim, []);
      return;
    }
    if (this.mode === "controllers" && this.qjs) {
      for (const team of ["blue", "red"] as const) {
        const c = new SandboxedController(this.qjs, { team, source: this.scripts[team].source, label: this.scripts[team].label, config: this.sim.config });
        c.seedRandom(this.sim.seed);
        this.controllers[team] = c;
      }
      this.runner = new CommandRunner(this.sim, [this.controllers.blue!, this.controllers.red!]);
      return;
    }
    if (this.mode === "scenario" && this.scenario) {
      this.runner = new CommandRunner(this.sim, [this.scenario]);
      return;
    }
    const script = createPlaygroundScript(this.sim.seed, this.sim.config);
    // In manual mode the selected player is driven by the keyboard instead.
    const filtered: CommandSource = {
      name: script.name,
      team: script.team,
      decide: (ctx) => {
        const cmds = script.decide(ctx);
        return this.mode === "manual" && this.selected ? cmds.filter((c) => !("playerId" in c) || c.playerId !== this.selected) : cmds;
      },
    };
    this.runner = new CommandRunner(this.sim, [filtered]);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const l of this.listeners) l();
  }

  private advance(): void {
    if (this.mode === "replay" && this.player) {
      this.sim.state = this.player.stepOnce();
      if (this.player.tick >= this.player.replay.finalTick) this.pause();
      return;
    }
    if (this.mode === "manual" && this.selected && isDecisionTick(this.sim.state.tick, this.sim.config)) {
      this.sim.submit(keyboardCommands(this.sim.state, this.selected, this.keys, this.pending));
      this.pending = { kick: false, tackle: false, hands: false };
    }
    this.runner.tick();
    this.recorder.observe(this.sim.state);
    if (this.sim.clock.finished && this.mode !== "scenario") this.pause();
    if (this.mode === "scenario" && this.scenario?.done(this.sim.state.tick)) this.pause();
  }

  play(): void {
    if (this.playing || (this.sim.clock.finished && this.mode !== "scenario" && this.mode !== "replay")) return;
    if (this.player && this.player.tick >= this.player.replay.finalTick) return;
    this.playing = true;
    this.lastTime = performance.now();
    this.acc = 0;
    const loop = (now: number) => {
      if (!this.playing) return;
      this.acc += Math.min(0.25, (now - this.lastTime) / 1000) * this.speed;
      this.lastTime = now;
      const dt = 1 / this.sim.config.tickRate;
      let n = 0;
      while (this.acc >= dt && n < 600 && this.playing) {
        this.advance();
        this.acc -= dt;
        n++;
      }
      if (n > 0) this.emit();
      if (this.playing) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.emit();
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  stepOnce(): void {
    this.pause();
    this.advance();
    this.emit();
  }

  /** Advance n ticks immediately (used by the walkthrough and tests). */
  stepMany(n: number): void {
    for (let i = 0; i < n; i++) this.advance();
    this.emit();
  }

  reset(seed: number = this.sim.seed): void {
    this.pause();
    this.lastVerify = null;
    if (this.mode === "replay" && this.player) {
      this.seek(0);
      return;
    }
    this.sim.reset(seed);
    this.recorder = new ReplayRecorder();
    this.recorder.observe(this.sim.state);
    if (this.scenario) this.scenario = createScenarioSource(this.scenario.scenario);
    this.buildRunner();
    this.lastVerify = null;
    this.emit();
  }

  /** Switch to a scripted scenario (fresh world for the current seed). */
  runScenario(id: string, seed: number = this.sim.seed): void {
    this.mode = "scenario";
    this.scenario = createScenarioSource(getScenario(id));
    this.reset(seed);
    this.play();
  }

  setSpeed(s: number): void {
    this.speed = s;
    this.emit();
  }
  setMode(m: InputMode): void {
    if (m === this.mode) return;
    this.mode = m;
    if (m !== "scenario") this.scenario = null;
    if (m !== "replay") {
      this.player = null;
      this.lastReplayVerify = null;
    }
    this.reset();
  }

  setFit(on: boolean): void {
    this.fit = on;
    this.emit();
  }

  // ── replay ───────────────────────────────────────────────────────────────

  /** Events so far (live) or up to the playhead (replay). */
  get events(): readonly LoggedEvent[] {
    return this.player ? this.player.eventsUpTo() : this.sim.events;
  }
  get rejections(): ReadonlyArray<{ tick: number; command: unknown; reason: string }> {
    return this.player ? this.player.replay.engineRejections.filter((r) => r.tick < this.player!.tick) : this.sim.rejections;
  }
  /** Ticks in a full match (for the timeline). */
  get totalTicks(): number {
    if (this.player) return this.player.replay.finalTick;
    const c = this.sim.config;
    return c.match.preMatchTicks + 2 * c.halfDurationSec * c.tickRate + c.match.halftimeTicks;
  }

  private toView(d: RecordedDecision | null, live?: { debug?: { mode?: string; notes?: string[]; lines?: DecisionView["lines"] } | null }): DecisionView | null {
    if (!d) return null;
    return { tick: d.tick, status: d.status, actions: d.actions, rejected: d.rejected, mode: (live?.debug?.mode ?? d.mode) || null, notes: live?.debug?.notes ?? d.notes ?? [], lines: live?.debug?.lines ?? d.lines ?? [] };
  }

  /** The team's current decision, identical shape in live and replay modes. */
  decision(team: TeamId): DecisionView | null {
    if (this.player) return this.toView(this.player.decisionAt(team, this.player.tick - 1));
    const c = this.controllers[team];
    const l = c?.last;
    if (!l) return null;
    return this.toView({ tick: l.tick, team, status: l.status, actions: l.actions, rejected: l.rejected, mode: l.debug?.mode ?? null, notes: l.debug?.notes ?? [] }, { debug: l.debug ?? null });
  }

  /** Recent decisions of a team (for the per-player action log). */
  decisionsSince(team: TeamId, fromTick: number): RecordedDecision[] {
    if (this.player) return this.player.replay.decisions.filter((d) => d.team === team && d.tick >= fromTick && d.tick < this.player!.tick);
    const c = this.controllers[team];
    return (c?.history ?? []).filter((d) => d.tick >= fromTick).map((d) => ({ tick: d.tick, team, status: d.status, actions: d.actions, rejected: d.rejected }));
  }

  /** Build a replay file from the live run so far. */
  saveReplay(): ReplayFile {
    return buildReplay(this.sim, this.recorder, this.controllers);
  }

  /** Open a replay (text or parsed). Controllers are not executed. */
  openReplay(input: string | ReplayFile): void {
    const r = typeof input === "string" ? parseReplay(input) : input;
    this.pause();
    this.disposeControllers();
    this.mode = "replay";
    this.scenario = null;
    this.player = new ReplayPlayer(r);
    this.sim = new Simulation(r.seed, r.config);
    this.sim.state = this.player.state;
    this.lastReplayVerify = null;
    this.lastVerify = null;
    this.emit();
  }

  seek(tick: number): void {
    if (!this.player) return;
    this.sim.state = this.player.seek(tick);
    this.emit();
  }

  verifyReplay(): VerifyReport | null {
    if (!this.player) return null;
    this.lastReplayVerify = this.player.verify();
    this.emit();
    return this.lastReplayVerify;
  }
  select(id: PlayerId | null): void {
    this.selected = id;
    this.emit();
  }
  setOverlays(on: boolean): void {
    this.overlays = on;
    this.emit();
  }

  /** Replay the accepted command stream headlessly and compare hashes. */
  verify(): VerifyResult {
    const tick = this.sim.state.tick;
    const replayed = hashState(Simulation.replay(this.sim.seed, this.sim.log, tick, this.sim.config));
    const live = this.sim.hash();
    this.lastVerify = { tick, live, replayed, match: live === replayed };
    this.emit();
    return this.lastVerify;
  }
}
