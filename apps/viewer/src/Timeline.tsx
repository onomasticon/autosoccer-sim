import { timelineMarkers } from "@autosoccer/telemetry";
import type { ViewerEngine } from "./engine.ts";

const COLOR: Record<string, string> = { goal: "#ffd54f", foul: "#ff5252", restart: "#e0e0e0", period: "#90caf9", catch: "#a5d6a7", tackle: "#ffab91" };

/**
 * Match timeline: period bands, markers for goals / fouls / restarts / keeper
 * catches / tackles, and the playhead. In replay mode it's a scrubber: drag or
 * click anywhere (or on a marker chip) to seek.
 */
export function Timeline({ engine }: { engine: ViewerEngine }) {
  const total = engine.totalTicks;
  const tick = engine.sim.state.tick;
  const replay = engine.player?.replay;
  const markers = timelineMarkers(replay ? replay.events : engine.events);
  const seekable = !!replay;
  const pct = (t: number) => `${Math.min(100, (t / total) * 100)}%`;
  const ht = markers.find((m) => m.kind === "period" && m.label === "halftime");
  const sh = markers.find((m) => m.kind === "period" && m.label === "secondHalf");
  const chips = markers.filter((m) => m.kind === "goal" || m.kind === "foul" || m.kind === "restart");
  return (
    <div className="timeline" data-testid="timeline">
      <div className="tl-head small">
        <b>Timeline</b>
        <span className="muted">{seekable ? "replay · click or drag to seek" : "live · recording"}</span>
        <span className="mono muted">tick {tick} / {total}</span>
      </div>
      <div
        className={`tl-track ${seekable ? "seekable" : ""}`}
        data-testid="timeline-track"
        onClick={(e) => {
          if (!seekable) return;
          const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          engine.seek(Math.round(((e.clientX - r.left) / r.width) * total));
        }}
      >
        {ht && <div className="tl-band" style={{ left: pct(ht.tick), width: pct((sh?.tick ?? ht.tick + 180) - ht.tick) }} title="half-time" />}
        {markers.map((m, i) => (
          <div key={i} className={`tl-mark ${m.kind}`} style={{ left: pct(m.tick), background: m.kind === "goal" ? COLOR.goal : m.team === "blue" ? "#6ea8ff" : m.team === "red" ? "#ff7b7b" : COLOR[m.kind] }} title={`${m.tick} ${m.label}`} />
        ))}
        <div className="tl-head-mark" style={{ left: pct(tick) }} />
      </div>
      {seekable && (
        <input data-testid="scrub" className="tl-scrub" type="range" min={0} max={total} value={tick} onChange={(e) => engine.seek(Number(e.target.value))} />
      )}
      <div className="tl-chips">
        {chips.slice(-40).map((m, i) => (
          <button key={i} className={`chip ${m.kind}`} data-testid={`chip-${m.kind}`} disabled={!seekable} onClick={() => engine.seek(m.tick + 1)} title={`tick ${m.tick}`}>
            {m.kind === "goal" ? "⚽ " : m.kind === "foul" ? "✋ " : ""}
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
