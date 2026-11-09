import type { PlayerId } from "@autosoccer/sim-core";
import type { ViewerEngine } from "./engine.ts";

type Row = { tick: number; kind: "issued" | "invalid" | "rejected" | "executed"; text: string };

const refMatches = (ref: unknown, id: PlayerId) => ref === id || (typeof ref === "number" && `${id.split("-")[0]}-${ref}` === id);

function fmt(a: Record<string, unknown>): string {
  const dir = a.direction as { x: number; y: number } | undefined;
  switch (a.type) {
    case "moveTo": return `moveTo (${Number(a.x).toFixed(1)}, ${Number(a.y).toFixed(1)})${a.sprint ? " sprint" : ""}${a.dribble ? " dribble" : ""}`;
    case "kick":
    case "releaseBall": return `${a.type} → (${dir ? `${Number(dir.x).toFixed(2)}, ${Number(dir.y).toFixed(2)}` : "?"}) p=${Number(a.power).toFixed(2)}`;
    case "sprint": return `sprint ${a.on ? "on" : "off"}`;
    default: return String(a.type);
  }
}

/**
 * Per-player action log for the selected player: what the controller ISSUED,
 * what SDK validation rejected (INVALID), what the engine REJECTED, and what
 * actually EXECUTED (engine events). Works the same live and in replays.
 */
export function ActionLog({ engine }: { engine: ViewerEngine }) {
  const id = engine.selected;
  if (!id) return <p className="muted small">Select a player to see issued vs executed actions.</p>;
  const team = id.startsWith("blue") ? "blue" : "red";
  const now = engine.sim.state.tick;
  const from = Math.max(0, now - 300);
  const rows: Row[] = [];
  for (const d of engine.decisionsSince(team, from)) {
    for (const a of d.actions ?? []) {
      const o = a as Record<string, unknown>;
      if (o && refMatches(o.player, id) && o.type !== "moveTo") rows.push({ tick: d.tick, kind: "issued", text: fmt(o) });
    }
    for (const r of d.rejected) {
      const o = r.action as Record<string, unknown> | null;
      if (o && refMatches(o.player, id)) rows.push({ tick: d.tick, kind: "invalid", text: `${String(o.type)}: ${r.reason}` });
    }
  }
  for (const r of engine.rejections) {
    if (r.tick < from) continue;
    const c = r.command as { playerId?: string; type?: string };
    if (c?.playerId === id) rows.push({ tick: r.tick, kind: "rejected", text: `${c.type}: ${r.reason}` });
  }
  for (const le of engine.events) {
    if (le.tick < from) continue;
    const e = le.event as { type: string; playerId?: string; success?: boolean; speed?: number; interception?: boolean };
    if (e.playerId !== id) continue;
    const extra = e.type === "kick" ? ` ${e.speed?.toFixed(1)} m/s` : e.success === false ? " (failed)" : e.interception ? " (interception)" : "";
    rows.push({ tick: le.tick, kind: "executed", text: `${e.type}${extra}` });
  }
  rows.sort((a, b) => b.tick - a.tick || (a.kind < b.kind ? -1 : 1));
  return (
    <div className="action-log" data-testid="action-log">
      {rows.length === 0 && <div className="muted small">No ball actions in the last 5 s (movement only).</div>}
      {rows.slice(0, 9).map((r, i) => (
        <div key={i} className={`al ${r.kind}`}>
          <span className="mono muted">{String(r.tick).padStart(5)}</span> <b>{r.kind.toUpperCase()}</b> {r.text}
        </div>
      ))}
    </div>
  );
}
