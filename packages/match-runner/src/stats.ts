/**
 * Match statistics derived from the event log (and optional per-second samples).
 * Used to compare team action profiles (e.g. Blue possession vs Red counter).
 */
import type { LoggedEvent, SimConfig, SimEvent, TeamId, WorldState } from "@autosoccer/sim-core";
import { DEFAULT_CONFIG } from "@autosoccer/sim-core";

export interface TeamStats {
  goals: number;
  passes: number;
  passesCompleted: number;
  passesIntercepted: number;
  avgPassLength: number;
  forwardPassShare: number;
  shots: number;
  shotsOnTarget: number;
  avgShotDistance: number;
  dribbleTouches: number;
  tackles: number;
  tacklesWon: number;
  interceptions: number;
  keeperCatches: number;
  keeperReleases: number;
  fouls: number;
  restartsTaken: number;
  restartFallbacks: number;
  /** Share of sampled time this team had last touched the ball. */
  possession: number;
  /** Mean distance of outfield players from their own goal line (m): team "height". */
  avgTeamHeight: number;
}

export interface Sample {
  tick: number;
  lastTouch: TeamId | null;
  height: Record<TeamId, number>;
}

/** Per-second sample: who has the ball and how high each team stands. */
export function sampleState(s: WorldState, cfg: SimConfig = DEFAULT_CONFIG): Sample {
  const h = (t: TeamId) => {
    const sign = s.match.defends[t] === "left" ? 1 : -1;
    const ps = s.players.filter((p) => p.team === t && p.role !== "GK");
    return ps.reduce((a, p) => a + (sign * p.x + cfg.pitch.length / 2), 0) / ps.length;
  };
  const lt = s.ball.lastTouch;
  return { tick: s.tick, lastTouch: lt ? (lt.startsWith("blue") ? "blue" : "red") : null, height: { blue: h("blue"), red: h("red") } };
}

const teamOf = (id: string): TeamId => (id.startsWith("blue") ? "blue" : "red");
const TOUCH = new Set<SimEvent["type"]>(["kick", "trap", "dribbleTouch", "catch", "tackle", "release"]);

function touchBy(e: SimEvent): string | null {
  if (!TOUCH.has(e.type)) return null;
  if ((e.type === "catch" || e.type === "tackle") && !e.success) return null;
  return (e as { playerId: string }).playerId;
}

export function analyzeMatch(events: readonly LoggedEvent[], samples: readonly Sample[] = [], cfg: SimConfig = DEFAULT_CONFIG): Record<TeamId, TeamStats> {
  const blank = (): TeamStats => ({
    goals: 0, passes: 0, passesCompleted: 0, passesIntercepted: 0, avgPassLength: 0, forwardPassShare: 0, shots: 0, shotsOnTarget: 0, avgShotDistance: 0,
    dribbleTouches: 0, tackles: 0, tacklesWon: 0, interceptions: 0, keeperCatches: 0, keeperReleases: 0, fouls: 0, restartsTaken: 0, restartFallbacks: 0, possession: 0, avgTeamHeight: 0,
  });
  const st: Record<TeamId, TeamStats> = { blue: blank(), red: blank() };
  const passLen: Record<TeamId, number[]> = { blue: [], red: [] };
  const fwdPasses: Record<TeamId, number> = { blue: 0, red: 0 };
  const shotDist: Record<TeamId, number[]> = { blue: [], red: [] };
  const halfL = cfg.pitch.length / 2;
  let secondHalfFrom = Infinity;
  for (const le of events) if (le.event.type === "sidesSwitched") secondHalfFrom = le.tick;
  // Blue attacks +x in the first half (FIRST_HALF_DEFENDS), −x after the switch.
  const attack = (t: TeamId, tick: number) => (t === "blue" ? 1 : -1) * (tick >= secondHalfFrom ? -1 : 1);

  for (let i = 0; i < events.length; i++) {
    const le = events[i]!;
    const e = le.event;
    switch (e.type) {
      case "goalScored": st[e.team].goals++; break;
      case "dribbleTouch": st[teamOf(e.playerId)].dribbleTouches++; break;
      case "tackle": st[teamOf(e.playerId)].tackles++; if (e.success) st[teamOf(e.playerId)].tacklesWon++; break;
      case "trap": if (e.interception) st[teamOf(e.playerId)].interceptions++; break;
      case "catch": if (e.success) st[teamOf(e.playerId)].keeperCatches++; break;
      case "release": st[teamOf(e.playerId)].keeperReleases++; break;
      case "foul": st[teamOf(e.by)].fouls++; break;
      case "restartTaken": if (e.fallback) st[e.team].restartFallbacks++; else st[e.team].restartsTaken++; break;
      case "kick": {
        const t = teamOf(e.playerId);
        const sgn = attack(t, le.tick);
        const goalX = sgn * halfL;
        // Shot: aimed at the opponents' goal mouth from within 30 m.
        const tLine = (goalX - le.ballX) / (e.dirX || 1e-9);
        const yAtLine = le.ballY + e.dirY * tLine;
        const distToGoal = Math.hypot(goalX - le.ballX, le.ballY);
        if (tLine > 0 && distToGoal < 30 && Math.abs(yAtLine) < cfg.pitch.goalWidth / 2 + 1.5) {
          st[t].shots++;
          shotDist[t].push(distToGoal);
          if (Math.abs(yAtLine) < cfg.pitch.goalWidth / 2) st[t].shotsOnTarget++;
          break;
        }
        // Otherwise a pass: resolved by the next touch.
        st[t].passes++;
        for (let j = i + 1; j < events.length && events[j]!.tick - le.tick < 240; j++) {
          const by = touchBy(events[j]!.event);
          if (events[j]!.event.type === "ballOut" || events[j]!.event.type === "foul") break;
          if (!by) continue;
          if (by === e.playerId) continue; // own follow-up touch
          if (teamOf(by) === t) {
            st[t].passesCompleted++;
            passLen[t].push(Math.hypot(events[j]!.ballX - le.ballX, events[j]!.ballY - le.ballY));
            if ((events[j]!.ballX - le.ballX) * sgn > 2) fwdPasses[t]++;
          } else st[t].passesIntercepted++;
          break;
        }
        break;
      }
    }
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  for (const t of ["blue", "red"] as const) {
    st[t].avgPassLength = avg(passLen[t]);
    st[t].forwardPassShare = st[t].passesCompleted ? fwdPasses[t] / st[t].passesCompleted : 0;
    st[t].avgShotDistance = avg(shotDist[t]);
    const owned = samples.filter((s) => s.lastTouch !== null);
    st[t].possession = owned.length ? owned.filter((s) => s.lastTouch === t).length / owned.length : 0;
    st[t].avgTeamHeight = avg(samples.map((s) => s.height[t]));
  }
  return st;
}
