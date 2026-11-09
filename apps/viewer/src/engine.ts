import type { CommandSource } from "@autosoccer/controller-sdk";
import { CommandRunner, createPlaygroundScript, keyboardCommand, type KeyState } from "@autosoccer/controller-runtime";
import type { PlayerId } from "@autosoccer/sim-core";
import { DEFAULT_CONFIG, hashState, isDecisionTick, Simulation } from "@autosoccer/sim-core";

export type InputMode = "script" | "manual";

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
  selected: PlayerId | null = null;
  overlays = true;
  keys: KeyState = { up: false, down: false, left: false, right: false, sprint: false };
  lastVerify: VerifyResult | null = null;
  private listeners = new Set<() => void>();
  private raf = 0;
  private lastTime = 0;
  private acc = 0;

  constructor(seed: number) {
    this.sim = new Simulation(seed, DEFAULT_CONFIG);
    this.buildRunner();
  }

  private buildRunner(): void {
    const script = createPlaygroundScript(this.sim.seed);
    // In manual mode the selected player is driven by the keyboard instead.
    const filtered: CommandSource = {
      name: script.name,
      team: script.team,
      decide: (ctx) => {
        const cmds = script.decide(ctx);
        return this.mode === "manual" && this.selected ? cmds.filter((c) => c.playerId !== this.selected) : cmds;
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
    if (this.mode === "manual" && this.selected && isDecisionTick(this.sim.state.tick, this.sim.config)) {
      const c = keyboardCommand(this.sim.state, this.selected, this.keys);
      if (c) this.sim.submit([c]);
    }
    this.runner.tick();
    if (this.sim.clock.finished) this.pause();
  }

  play(): void {
    if (this.playing || this.sim.clock.finished) return;
    this.playing = true;
    this.lastTime = performance.now();
    this.acc = 0;
    const loop = (now: number) => {
      if (!this.playing) return;
      this.acc += Math.min(0.25, (now - this.lastTime) / 1000) * this.speed;
      this.lastTime = now;
      const dt = 1 / this.sim.config.tickRate;
      let n = 0;
      while (this.acc >= dt && n < 600) {
        this.advance();
        this.acc -= dt;
        n++;
      }
      if (n > 0) this.emit();
      this.raf = requestAnimationFrame(loop);
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
    this.sim.reset(seed);
    this.buildRunner();
    this.lastVerify = null;
    this.emit();
  }

  setSpeed(s: number): void {
    this.speed = s;
    this.emit();
  }
  setMode(m: InputMode): void {
    this.mode = m;
    this.emit();
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
