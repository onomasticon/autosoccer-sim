import { SCENARIOS } from "@autosoccer/controller-runtime";
import type { LoggedEvent } from "@autosoccer/sim-core";
import { ENGINE_VERSION, hashState } from "@autosoccer/sim-core";
import { useEffect, useMemo, useReducer, useState } from "react";
import { ViewerEngine } from "./engine.ts";
import { PitchView } from "./PitchView.tsx";

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function describeEvent(le: LoggedEvent): string {
  const e = le.event;
  switch (e.type) {
    case "kick": return `${e.playerId} kick p=${e.power.toFixed(2)} ${e.speed.toFixed(1)} m/s err ${((e.errorRad * 180) / Math.PI).toFixed(1)}°`;
    case "dribbleTouch": return `${e.playerId} dribble touch`;
    case "trap": return `${e.playerId} ${e.interception ? "INTERCEPTS" : "traps"} (${e.incomingSpeed.toFixed(1)} m/s)`;
    case "trapMiss": return `${e.playerId} miscontrols (${e.incomingSpeed.toFixed(1)} m/s)`;
    case "tackle": return `${e.playerId} tackle ${e.success ? "WON" : "missed → grounded"}${e.victim ? ` vs ${e.victim}` : ""}`;
    case "catch": return `${e.playerId} ${e.success ? "CATCHES" : "fumbles"} (${e.incomingSpeed.toFixed(1)} m/s)`;
    case "release": return `${e.playerId} ${e.auto ? "drops (6 s limit)" : "releases"}`;
    case "goal": return `GOAL — ball crossed the ${e.side} goal line`;
  }
}

const initialSeed = Number(new URLSearchParams(location.search).get("seed") ?? 42);

export function App() {
  const engine = useMemo(() => new ViewerEngine(initialSeed), []);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [seedInput, setSeedInput] = useState(String(initialSeed));
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id);

  useEffect(() => engine.subscribe(force), [engine]);
  useEffect(() => {
    (window as unknown as { __engine: ViewerEngine }).__engine = engine;
    const map: Record<string, keyof typeof engine.keys> = {
      KeyW: "up", ArrowUp: "up", KeyS: "down", ArrowDown: "down",
      KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
      ShiftLeft: "sprint", ShiftRight: "sprint",
    };
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      const k = map[e.code];
      if (k) {
        engine.keys[k] = down;
        e.preventDefault();
      } else if (down && e.code === "KeyE") {
        engine.keys.dribble = !engine.keys.dribble;
        engine.select(engine.selected);
      } else if (down && e.code === "KeyJ") {
        engine.pending.kick = true;
      } else if (down && e.code === "KeyK") {
        engine.pending.tackle = true;
      } else if (down && e.code === "KeyL") {
        engine.pending.hands = true;
      } else if (down && e.code === "Space") {
        engine.toggle();
        e.preventDefault();
      } else if (down && e.code === "Period") {
        engine.stepOnce();
      }
    };
    const kd = onKey(true);
    const ku = onKey(false);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, [engine]);

  const { sim } = engine;
  const s = sim.state;
  const clock = sim.clock;
  const sel = s.players.find((p) => p.id === engine.selected);
  const hash = hashState(s);
  const v = engine.lastVerify;
  const log = [
    ...sim.events.slice(-12).map((le) => ({ tick: le.tick, text: describeEvent(le), kind: le.event.type === "goal" ? "goal" : "event" })),
    ...sim.rejections.slice(-8).map((r) => ({ tick: r.tick, text: `✘ ${(r.command as { playerId?: string }).playerId ?? ""} ${(r.command as { type?: string }).type}: ${r.reason}`, kind: "rejected" })),
  ]
    .sort((a, b) => b.tick - a.tick)
    .slice(0, 9);

  return (
    <div className="app">
      <header>
        <h1>autosoccer-sim</h1>
        <span className="muted">engine v{ENGINE_VERSION} · M2 soccer actions playground</span>
        <div className="clock" data-testid="clock">
          {clock.finished ? "FULL TIME" : `H${clock.half}`} {fmtClock(clock.secondsInHalf)}
        </div>
      </header>
      <main>
        <PitchView state={s} events={sim.events} config={sim.config} selected={engine.selected} overlays={engine.overlays} onSelect={(id) => engine.select(id)} />
        <aside>
          <section>
            <div className="row">
              <button data-testid="play" onClick={() => engine.toggle()}>{engine.playing ? "⏸ Pause" : "▶ Play"}</button>
              <button data-testid="step" onClick={() => engine.stepOnce()}>⏭ Step</button>
              <button data-testid="reset" onClick={() => engine.reset(Number(seedInput) || 0)}>↺ Reset</button>
            </div>
            <div className="row">
              <label>Seed <input data-testid="seed" value={seedInput} onChange={(e) => setSeedInput(e.target.value)} size={8} /></label>
              <label>Speed{" "}
                <select data-testid="speed" value={engine.speed} onChange={(e) => engine.setSpeed(Number(e.target.value))}>
                  {[0.25, 0.5, 1, 2, 4, 8].map((x) => <option key={x} value={x}>{x}×</option>)}
                </select>
              </label>
            </div>
            <div className="row">
              <label><input type="radio" checked={engine.mode === "script"} onChange={() => engine.setMode("script")} /> Script</label>
              <label><input data-testid="manual" type="radio" checked={engine.mode === "manual"} onChange={() => engine.setMode("manual")} /> Manual</label>
            </div>
            <div className="row">
              <select data-testid="scenario" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
                {SCENARIOS.map((sc) => <option key={sc.id} value={sc.id}>{sc.title}</option>)}
              </select>
              <button data-testid="run-scenario" onClick={() => engine.runScenario(scenarioId, Number(seedInput) || 0)}>Run scenario</button>
            </div>
            {engine.mode === "scenario" && engine.scenario && (
              <div className="scenario" data-testid="scenario-step">
                <b>{engine.scenario.scenario.title}</b> — {engine.scenario.currentStep ?? "waiting"}
              </div>
            )}
            {engine.mode === "manual" && (
              <div className="muted small">WASD/arrows move · Shift sprint · E dribble {engine.keys.dribble ? "ON" : "off"} · J kick · K tackle · L catch/release</div>
            )}
            <label><input type="checkbox" checked={engine.overlays} onChange={(e) => engine.setOverlays(e.target.checked)} /> Overlays (velocity, targets)</label>
          </section>
          <section className="stats" data-testid="stats">
            <div><span>Seed</span><b data-testid="seed-display">{s.seed}</b></div>
            <div><span>Tick</span><b data-testid="tick">{s.tick}</b></div>
            <div><span>Sim time</span><b>{clock.totalSeconds.toFixed(2)} s</b></div>
            <div><span>State hash</span><b className="mono" data-testid="hash">{hash}</b></div>
            <div><span>Commands logged</span><b>{sim.log.reduce((n, e) => n + e.commands.length, 0)}</b></div>
            <div><span>Contacts (tick)</span><b>P–P {s.contacts.playerPlayer} · P–B {s.contacts.playerBall} · wall {s.contacts.ballWall}</b></div>
            <div><span>Ball</span><b className="mono">({s.ball.x.toFixed(2)}, {s.ball.y.toFixed(2)}) |v| {Math.hypot(s.ball.vx, s.ball.vy).toFixed(2)}</b></div>
            <div><span>Ball state</span><b>{s.ball.heldBy ? `held by ${s.ball.heldBy}` : s.ball.inGoal ? `in ${s.ball.inGoal} goal` : "free"}{s.ball.lastTouch ? ` · last ${s.ball.lastTouch}` : ""}</b></div>
          </section>
          <section>
            <button data-testid="verify" onClick={() => engine.verify()}>Verify determinism</button>
            {v && (
              <div data-testid="verify-result" className={v.match ? "ok" : "bad"}>
                {v.match ? "✔ MATCH" : "✘ MISMATCH"} at tick {v.tick}
                <div className="mono small">live&nbsp;&nbsp;&nbsp;&nbsp;{v.live}</div>
                <div className="mono small">replay&nbsp;&nbsp;{v.replayed}</div>
              </div>
            )}
          </section>
          <section data-testid="event-log">
            <h3>Events &amp; diagnostics</h3>
            {log.length === 0 && <p className="muted">No ball actions yet.</p>}
            {log.map((l, i) => (
              <div key={i} className={`log ${l.kind}`}><span className="mono">{String(l.tick).padStart(5)}</span> {l.text}</div>
            ))}
          </section>
          <section data-testid="inspector">
            <h3>Player</h3>
            {sel ? (
              <div className="stats">
                <div><span>ID</span><b>{sel.id} ({sel.role})</b></div>
                <div><span>Pos</span><b className="mono">{sel.x.toFixed(2)}, {sel.y.toFixed(2)}</b></div>
                <div><span>Speed</span><b>{Math.hypot(sel.vx, sel.vy).toFixed(2)} m/s</b></div>
                <div><span>Heading</span><b>{((sel.heading * 180) / Math.PI).toFixed(0)}°</b></div>
                <div><span>Stamina</span><b>{(sel.stamina * 100).toFixed(0)}%</b></div>
                <div><span>Intent</span><b className="mono">{sel.intent.targetX === null ? "stop" : `→ (${sel.intent.targetX.toFixed(1)}, ${sel.intent.targetY!.toFixed(1)})${sel.intent.sprint ? " sprint" : ""}${sel.intent.dribble ? " dribble" : ""}`}</b></div>
                <div><span>Ball dist</span><b>{Math.hypot(s.ball.x - sel.x, s.ball.y - sel.y).toFixed(2)} m</b></div>
                <div><span>Cooldowns</span><b className="mono">touch {sel.touchCooldown} · tackle {sel.tackleCooldown}{sel.role === "GK" ? ` · catch ${sel.catchCooldown}` : ""}</b></div>
                <div><span>Status</span><b>{sel.stunned > 0 ? `grounded ${sel.stunned}t` : s.ball.heldBy === sel.id ? `holding ball ${s.ball.holdTicks}t` : "ok"}</b></div>
              </div>
            ) : (
              <p className="muted">Click a player to inspect / control.</p>
            )}
          </section>
        </aside>
      </main>
    </div>
  );
}
