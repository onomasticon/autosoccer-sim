/**
 * @autosoccer/controller-runtime — runs command sources against a Simulation
 * at the controller cadence. M1 runs in-process debug sources with error
 * isolation; sandboxed untrusted controllers arrive in M4.
 */
import type { CommandSource } from "@autosoccer/controller-sdk";
import type { EngineCommand, Simulation, WorldState } from "@autosoccer/sim-core";
import { dhypot, isDecisionTick, Rng } from "@autosoccer/sim-core";

export interface SourceDiagnostic {
  readonly tick: number;
  readonly source: string;
  readonly kind: "error" | "foreign-player";
  readonly message: string;
}

/**
 * Drives a simulation: on each decision tick asks every source for commands,
 * filters commands for players the source doesn't own, submits the rest.
 */
export class CommandRunner {
  readonly diagnostics: SourceDiagnostic[] = [];
  constructor(
    readonly sim: Simulation,
    readonly sources: CommandSource[],
  ) {}

  tick(): WorldState {
    const s = this.sim.state;
    if (isDecisionTick(s.tick, this.sim.config)) {
      for (const src of this.sources) {
        let cmds: readonly EngineCommand[] = [];
        try {
          cmds = src.decide({ tick: s.tick, state: s });
        } catch (err) {
          this.diagnostics.push({ tick: s.tick, source: src.name, kind: "error", message: String(err) });
          continue;
        }
        const own = cmds.filter((c) => {
          const ok = src.team === "both" || (typeof c?.playerId === "string" && c.playerId.startsWith(`${src.team}-`));
          if (!ok) this.diagnostics.push({ tick: s.tick, source: src.name, kind: "foreign-player", message: `dropped command for ${String(c?.playerId)}` });
          return ok;
        });
        this.sim.submit(own);
      }
    }
    return this.sim.tick();
  }

  run(ticks: number): WorldState {
    for (let i = 0; i < ticks; i++) this.tick();
    return this.sim.state;
  }
}

/**
 * Seeded "playground" script used by the M1 demo and tests. Not a tactical
 * controller: each decision tick, the two players of each team nearest to the
 * ball run at it (occasionally sprinting), others drift around their kickoff
 * spots. This produces lots of player-player and player-ball contacts.
 */
export function createPlaygroundScript(seed: number): CommandSource {
  const rng = new Rng(seed ^ 0x5eed);
  const homes = new Map<string, { x: number; y: number }>();
  return {
    name: "playground",
    team: "both",
    decide({ state, tick }) {
      if (homes.size === 0) for (const p of state.players) homes.set(p.id, { x: p.x, y: p.y });
      // Re-plan every 0.5 s (5 decision ticks) to give players time to move.
      if (tick % 30 !== 0) return [];
      const out: EngineCommand[] = [];
      const { ball } = state;
      for (const team of ["blue", "red"] as const) {
        const mates = state.players.filter((p) => p.team === team);
        const byDist = [...mates].sort(
          (a, b) => dhypot(a.x - ball.x, a.y - ball.y) - dhypot(b.x - ball.x, b.y - ball.y) || (a.id < b.id ? -1 : 1),
        );
        const chasers = new Set(byDist.slice(0, 2).map((p) => p.id));
        for (const p of mates) {
          if (chasers.has(p.id) && p.role !== "GK") {
            // Aim slightly behind the ball relative to the opponent goal so contacts push it forward.
            const goalX = team === "blue" ? 25 : -25;
            const dx = goalX - ball.x;
            const dy = -ball.y;
            const d = dhypot(dx, dy) || 1;
            out.push({ type: "moveTo", playerId: p.id, x: ball.x - (dx / d) * 0.2, y: ball.y - (dy / d) * 0.2, sprint: rng.bool(0.4) });
          } else {
            const h = homes.get(p.id)!;
            const spread = p.role === "GK" ? 1.5 : 6;
            out.push({
              type: "moveTo",
              playerId: p.id,
              x: h.x + rng.range(-spread, spread) + (p.role === "GK" ? 0 : ball.x * 0.3),
              y: h.y + rng.range(-spread, spread) + (p.role === "GK" ? ball.y * 0.1 : ball.y * 0.2),
              sprint: false,
            });
          }
        }
      }
      return out;
    },
  };
}

export interface KeyState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
}

/**
 * Keyboard debug control for one player: held direction keys produce a moveTo
 * a few metres ahead in that direction; no keys produces a stop.
 */
export function keyboardCommand(state: WorldState, playerId: EngineCommand["playerId"], keys: KeyState): EngineCommand | null {
  const p = state.players.find((q) => q.id === playerId);
  if (!p) return null;
  const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (dx === 0 && dy === 0) return { type: "stop", playerId };
  const d = dhypot(dx, dy);
  return { type: "moveTo", playerId, x: p.x + (dx / d) * 4, y: p.y + (dy / d) * 4, sprint: keys.sprint };
}
