/**
 * @autosoccer/controller-runtime — runs command sources against a Simulation
 * at the controller cadence. Runs in-process debug sources with error
 * isolation; sandboxed untrusted controllers arrive in M4.
 */
import type { CommandSource } from "@autosoccer/controller-sdk";
import type { EngineCommand, PlayerId, SimConfig, Simulation, WorldState } from "@autosoccer/sim-core";
import { DEFAULT_CONFIG, dcos, dhypot, dsin, inOwnPenaltyArea, isDecisionTick, Rng } from "@autosoccer/sim-core";

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
          if (src.team === "both") return true; // debug/harness sources only
          const pid = c && "playerId" in c ? c.playerId : undefined;
          const ok = typeof pid === "string" && pid.startsWith(`${src.team}-`);
          if (!ok) this.diagnostics.push({ tick: s.tick, source: src.name, kind: "foreign-player", message: `dropped ${String(c?.type)} command for ${String(pid ?? "world")}` });
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
 * Seeded "playground" script used by the demo and tests. Not a tactical
 * controller (those are M5): the two players of each team nearest the ball
 * chase it with dribble on; in range they shoot or pass, opponents near the
 * ball attempt tackles, keepers catch in their area and throw out after a
 * moment, and everyone else drifts around their kickoff spot.
 */
export function createPlaygroundScript(seed: number, config: SimConfig = DEFAULT_CONFIG): CommandSource {
  const rng = new Rng(seed ^ 0x5eed);
  const homes = new Map<string, { x: number; y: number }>();
  const ac = config.action;
  return {
    name: "playground",
    team: "both",
    decide({ state, tick }) {
      if (homes.size === 0) for (const p of state.players) homes.set(p.id, { x: p.x, y: p.y });
      const out: EngineCommand[] = [];
      const { ball } = state;
      const replan = tick % 30 === 0;

      // Ball actions are considered every decision tick (10 Hz).
      for (const p of state.players) {
        const d = dhypot(ball.x - p.x, ball.y - p.y);
        const goalX = p.team === "blue" ? 25 : -25;
        if (ball.heldBy === p.id) {
          if (state.ball.holdTicks > 60 + rng.int(0, 60)) {
            const mate = state.players.filter((q) => q.team === p.team && q.id !== p.id)[rng.int(0, 4)]!;
            out.push({ type: "release", playerId: p.id, dirX: mate.x - p.x, dirY: mate.y - p.y, power: 0.5 });
          }
          continue;
        }
        if (ball.heldBy !== null) continue;
        if (p.role === "GK" && d <= ac.catchReach && inOwnPenaltyArea(p.team, ball.x, ball.y, config)) {
          out.push({ type: "catch", playerId: p.id });
          continue;
        }
        if (d <= ac.kickRange && p.touchCooldown === 0 && p.role !== "GK") {
          const toGoal = dhypot(goalX - p.x, -p.y);
          const facing = dcos(p.heading) * Math.sign(goalX) > -0.2; // roughly facing the opponent goal
          if (toGoal < 20 && facing && rng.bool(0.6)) {
            out.push({ type: "kick", playerId: p.id, dirX: goalX - p.x, dirY: rng.range(-1.8, 1.8) - p.y, power: rng.range(0.6, 1) });
          } else if (rng.bool(0.6)) {
            // Pass to a teammate inside the kicker's facing cone, preferring ones further upfield.
            const hx = dcos(p.heading);
            const hy = dsin(p.heading);
            const mates = state.players
              .filter((q) => q.team === p.team && q.id !== p.id && q.role !== "GK")
              .filter((q) => (q.x - p.x) * hx + (q.y - p.y) * hy > 0.3 * dhypot(q.x - p.x, q.y - p.y));
            const mate = mates[rng.int(0, Math.max(1, mates.length))];
            if (mate) out.push({ type: "kick", playerId: p.id, dirX: mate.x - p.x, dirY: mate.y - p.y, power: Math.min(0.8, dhypot(mate.x - p.x, mate.y - p.y) / 45 + 0.12) });
          }
          continue;
        }
        if (d <= ac.tackleReach && p.tackleCooldown === 0 && ball.lastTouch && !ball.lastTouch.startsWith(p.team) && rng.bool(0.12)) {
          out.push({ type: "tackle", playerId: p.id });
        }
      }

      // Re-plan movement every 0.5 s (5 decision ticks) to give players time to move.
      if (!replan) return out;
      for (const team of ["blue", "red"] as const) {
        const mates = state.players.filter((p) => p.team === team);
        const byDist = [...mates].sort(
          (a, b) => dhypot(a.x - ball.x, a.y - ball.y) - dhypot(b.x - ball.x, b.y - ball.y) || (a.id < b.id ? -1 : 1),
        );
        const outfield = byDist.filter((p) => p.role !== "GK");
        const chaser = outfield[0]!;
        const support = outfield[1]!;
        const goalX = team === "blue" ? 25 : -25;
        for (const p of mates) {
          if (p.id === chaser.id) {
            // Aim slightly behind the ball relative to the opponent goal, then dribble at it.
            const dx = goalX - ball.x;
            const dy = -ball.y;
            const d = dhypot(dx, dy) || 1;
            // Dribble ~40% of the time; otherwise approach without dribbling so the
            // ball stays within kick range for a pass or shot at the next decision tick.
            out.push({ type: "moveTo", playerId: p.id, x: ball.x - (dx / d) * 0.3, y: ball.y - (dy / d) * 0.3, sprint: rng.bool(0.4), dribble: rng.bool(0.4) });
          } else if (p.id === support.id) {
            // Offer a pass: ahead of the ball and to the more open side.
            const side = ball.y > 0 ? -1 : 1;
            out.push({ type: "moveTo", playerId: p.id, x: ball.x + Math.sign(goalX) * rng.range(5, 10), y: ball.y + side * rng.range(4, 8), sprint: rng.bool(0.3) });
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
  dribble: boolean;
}

export interface KeyActions {
  kick: boolean;
  tackle: boolean;
  /** Catch if free, release if holding. */
  hands: boolean;
}

/**
 * Keyboard debug control for one player: held direction keys produce a moveTo
 * a few metres ahead in that direction; no keys produces a stop. One-shot
 * action keys kick (in the facing direction), tackle, or catch/release.
 */
export function keyboardCommands(state: WorldState, playerId: PlayerId, keys: KeyState, actions: KeyActions = { kick: false, tackle: false, hands: false }): EngineCommand[] {
  const p = state.players.find((q) => q.id === playerId);
  if (!p) return [];
  const out: EngineCommand[] = [];
  const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (dx === 0 && dy === 0) out.push({ type: "stop", playerId });
  else {
    const d = dhypot(dx, dy);
    out.push({ type: "moveTo", playerId, x: p.x + (dx / d) * 4, y: p.y + (dy / d) * 4, sprint: keys.sprint, dribble: keys.dribble });
  }
  const fx = dcos(p.heading);
  const fy = dsin(p.heading);
  if (actions.kick) out.push({ type: "kick", playerId, dirX: fx, dirY: fy, power: keys.sprint ? 0.9 : 0.45 });
  if (actions.tackle) out.push({ type: "tackle", playerId });
  if (actions.hands) {
    out.push(state.ball.heldBy === playerId ? { type: "release", playerId, dirX: fx, dirY: fy, power: 0.5 } : { type: "catch", playerId });
  }
  return out;
}

export * from "./scenarios.ts";
