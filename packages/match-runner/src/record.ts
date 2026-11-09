/**
 * Build replay files from a finished (or in-progress) run.
 */
import type { SandboxedController } from "@autosoccer/controller-runtime";
import { SDK_VERSION } from "@autosoccer/controller-sdk";
import type { Simulation, TeamId } from "@autosoccer/sim-core";
import type { ControllerIdentity, RecordedDecision, RecordedDiagnostic, ReplayFile, ReplayRecorder } from "@autosoccer/telemetry";
import { runtimeId } from "@autosoccer/telemetry";

export function controllerIdentity(c: SandboxedController): ControllerIdentity {
  return { team: c.team, name: c.name, version: c.version, label: c.label, sourceHash: c.sourceHash, disabled: c.disabled };
}

export function decisionsOf(c: SandboxedController): RecordedDecision[] {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return c.history.map((d) => ({
    tick: d.tick,
    team: c.team,
    status: d.status,
    actions: d.actions,
    rejected: d.rejected,
    mode: d.debug?.mode ?? null,
    notes: d.debug?.notes ?? [],
    lines: (d.debug?.lines ?? []).map((l) => ({ from: { x: r2(l.from.x), y: r2(l.from.y) }, to: { x: r2(l.to.x), y: r2(l.to.y) }, kind: l.kind })),
  }));
}

export function buildReplay(sim: Simulation, recorder: ReplayRecorder, controllers: Partial<Record<TeamId, SandboxedController | null>> = {}): ReplayFile {
  const cs = Object.values(controllers).filter((c): c is SandboxedController => !!c);
  const ids: Partial<Record<TeamId, ControllerIdentity>> = {};
  for (const c of cs) ids[c.team] = controllerIdentity(c);
  const decisions = cs.flatMap(decisionsOf).sort((a, b) => a.tick - b.tick || (a.team < b.team ? -1 : 1));
  const diagnostics: RecordedDiagnostic[] = cs.flatMap((c) => c.diagnostics.map((d) => ({ tick: d.tick, team: d.team, kind: d.kind, message: d.message })));
  return recorder.finish({
    seed: sim.seed,
    config: sim.config,
    state: sim.state,
    commands: sim.log,
    engineRejections: sim.rejections.map((r) => ({ tick: r.tick, command: r.command, reason: r.reason })),
    events: sim.events,
    decisions,
    diagnostics,
    controllers: ids,
    sdkVersion: SDK_VERSION,
    runtime: runtimeId(),
  });
}
