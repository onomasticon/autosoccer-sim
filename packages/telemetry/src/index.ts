/**
 * @autosoccer/telemetry — structured records of a run: metadata, periodic
 * hash checkpoints and the accepted command stream. Serialises to JSONL.
 */
import type { CommandLogEntry, SimConfig, WorldState } from "@autosoccer/sim-core";
import { ENGINE_VERSION, hashState } from "@autosoccer/sim-core";

export type TelemetryRecord =
  | { kind: "meta"; engineVersion: string; seed: number; tickRate: number; controllerRate: number; runtime: string }
  | { kind: "checkpoint"; tick: number; hash: string; ball: { x: number; y: number }; contacts: WorldState["contacts"] }
  | { kind: "commands"; tick: number; count: number }
  | { kind: "summary"; ticks: number; finalHash: string; wallMs: number; contacts: { playerPlayer: number; playerBall: number; ballWall: number } };

export function runtimeId(): string {
  const g = globalThis as { Bun?: { version: string }; process?: { versions?: { node?: string } } };
  if (g.Bun) return `bun-${g.Bun.version}`;
  if (g.process?.versions?.node) return `node-${g.process.versions.node}`;
  return "browser";
}

export class TelemetryRecorder {
  readonly records: TelemetryRecord[] = [];
  private totals = { playerPlayer: 0, playerBall: 0, ballWall: 0 };

  constructor(
    seed: number,
    config: SimConfig,
    readonly checkpointEvery = 60,
  ) {
    this.records.push({
      kind: "meta",
      engineVersion: ENGINE_VERSION,
      seed,
      tickRate: config.tickRate,
      controllerRate: config.controllerRate,
      runtime: runtimeId(),
    });
  }

  observe(state: WorldState): void {
    this.totals.playerPlayer += state.contacts.playerPlayer;
    this.totals.playerBall += state.contacts.playerBall;
    this.totals.ballWall += state.contacts.ballWall;
    if (state.tick % this.checkpointEvery === 0) {
      this.records.push({ kind: "checkpoint", tick: state.tick, hash: hashState(state), ball: { x: state.ball.x, y: state.ball.y }, contacts: state.contacts });
    }
  }

  finish(state: WorldState, log: readonly CommandLogEntry[], wallMs: number): TelemetryRecord & { kind: "summary" } {
    for (const e of log) this.records.push({ kind: "commands", tick: e.tick, count: e.commands.length });
    const summary = { kind: "summary" as const, ticks: state.tick, finalHash: hashState(state), wallMs, contacts: { ...this.totals } };
    this.records.push(summary);
    return summary;
  }

  checkpoints(): Array<{ tick: number; hash: string }> {
    return this.records.flatMap((r) => (r.kind === "checkpoint" ? [{ tick: r.tick, hash: r.hash }] : []));
  }

  toJSONL(): string {
    return this.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  }
}
