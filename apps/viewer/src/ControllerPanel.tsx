import type { ControllerDiagnostic, SandboxedController } from "@autosoccer/controller-runtime";
import { useState } from "react";
import type { ViewerEngine } from "./engine.ts";
import { PRESETS } from "./presets.ts";

function fmtAction(a: unknown): string {
  if (typeof a !== "object" || a === null) return JSON.stringify(a);
  const o = a as Record<string, unknown>;
  const pl = o.player !== undefined ? String(o.player).replace(/^(blue|red)-/, "#") : "";
  const dir = o.direction as { x: number; y: number } | undefined;
  switch (o.type) {
    case "moveTo": return `moveTo ${pl} (${Number(o.x).toFixed(1)}, ${Number(o.y).toFixed(1)})${o.sprint ? " sprint" : ""}${o.dribble ? " dribble" : ""}`;
    case "kick":
    case "releaseBall": return `${o.type} ${pl} → (${dir ? `${Number(dir.x).toFixed(1)}, ${Number(dir.y).toFixed(1)}` : "?"}) p=${Number(o.power).toFixed(2)}`;
    case "sprint": return `sprint ${pl} ${o.on ? "on" : "off"}`;
    default: return `${String(o.type)} ${pl}`;
  }
}

const KIND_CLASS: Record<string, string> = {
  error: "bad", timeout: "bad", "out-of-memory": "bad", "invalid-output": "bad", disabled: "bad",
  "invalid-action": "warn", "engine-rejected": "warn", log: "muted", lifecycle: "ok",
};

function TeamColumn({ engine, team }: { engine: ViewerEngine; team: "blue" | "red" }) {
  const c: SandboxedController | null = engine.controllers[team];
  const slot = engine.scripts[team];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(slot.source);
  const last = c?.last;
  const diags: ControllerDiagnostic[] = c ? c.diagnostics.slice(-7).reverse() : [];

  return (
    <div className={`ctrl ${team}`} data-testid={`ctrl-${team}`}>
      <div className="ctrl-head">
        <b className={team}>{team.toUpperCase()}</b>
        <span className="mono">{c ? `${c.name}${c.version ? ` v${c.version}` : ""}` : "—"}</span>
        <span className={`badge ${c?.disabled ? "bad" : "ok"}`} data-testid={`status-${team}`}>{c?.disabled ? "FALLBACK (disabled)" : "SANDBOXED · OK"}</span>
        <select
          data-testid={`preset-${team}`}
          value={slot.label}
          onChange={(e) => {
            const label = e.target.value;
            setDraft(PRESETS[label]!);
            engine.setScript(team, { label, source: PRESETS[label]! });
          }}
        >
          {Object.keys(PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
          {!PRESETS[slot.label] && <option value={slot.label}>{slot.label}</option>}
        </select>
        <button data-testid={`edit-${team}`} onClick={() => { setDraft(slot.source); setEditing(!editing); }}>{editing ? "Close editor" : "Edit script"}</button>
      </div>
      {editing ? (
        <div className="editor">
          <textarea data-testid={`editor-${team}`} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          <button data-testid={`apply-${team}`} onClick={() => { engine.setScript(team, { label: `${slot.label.replace(/ \(edited\)$/, "")} (edited)`, source: draft }); }}>Apply &amp; restart match</button>
        </div>
      ) : (
        <div className="ctrl-body">
          <div className="small muted">updates {c?.updates ?? 0} · avg CPU {c && c.updates ? (c.totalOps / c.updates).toFixed(2) : "0"} / {80} budget units</div>
          {last?.debug?.mode && (
            <div className="decision" data-testid={`decision-${team}`}>
              <b>{last.debug.mode}</b>
              {(last.debug.notes ?? []).slice(0, 3).map((n, i) => <div key={i} className="small">{n}</div>)}
            </div>
          )}
          <div className="small">
            <b>last decision</b> {last ? `t=${last.tick} · ${last.status}` : "—"}
            {last && last.actions && <> · {last.actions.length} actions → {last.commands.length} commands</>}
          </div>
          <div className="actions mono small" data-testid={`actions-${team}`}>
            {(last?.actions ?? []).slice(0, 5).map((a, i) => <div key={i}>{fmtAction(a)}</div>)}
            {last?.status === "fallback" && <div className="bad">built-in safe controller is playing for {team}</div>}
          </div>
          <div className="diags small" data-testid={`diags-${team}`}>
            {diags.map((d, i) => (
              <div key={i} className={KIND_CLASS[d.kind] ?? ""}><span className="mono muted">{String(d.tick).padStart(5)}</span> {d.kind}: {d.message}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ControllerPanel({ engine }: { engine: ViewerEngine }) {
  return (
    <div className="ctrl-panel">
      <TeamColumn engine={engine} team="blue" />
      <TeamColumn engine={engine} team="red" />
    </div>
  );
}
