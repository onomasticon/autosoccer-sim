import { ENGINE_VERSION, hashState } from "@autosoccer/sim-core";
import { useEffect, useMemo, useReducer, useState } from "react";
import { ViewerEngine } from "./engine.ts";
import { PitchView } from "./PitchView.tsx";

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const initialSeed = Number(new URLSearchParams(location.search).get("seed") ?? 42);

export function App() {
  const engine = useMemo(() => new ViewerEngine(initialSeed), []);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [seedInput, setSeedInput] = useState(String(initialSeed));

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

  return (
    <div className="app">
      <header>
        <h1>autosoccer-sim</h1>
        <span className="muted">engine v{ENGINE_VERSION} · M1 physics playground</span>
        <div className="clock" data-testid="clock">
          {clock.finished ? "FULL TIME" : `H${clock.half}`} {fmtClock(clock.secondsInHalf)}
        </div>
      </header>
      <main>
        <PitchView state={s} config={sim.config} selected={engine.selected} overlays={engine.overlays} onSelect={(id) => engine.select(id)} />
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
              <label><input data-testid="manual" type="radio" checked={engine.mode === "manual"} onChange={() => engine.setMode("manual")} /> Manual (WASD/arrows, Shift sprint)</label>
            </div>
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
          <section data-testid="inspector">
            <h3>Player</h3>
            {sel ? (
              <div className="stats">
                <div><span>ID</span><b>{sel.id} ({sel.role})</b></div>
                <div><span>Pos</span><b className="mono">{sel.x.toFixed(2)}, {sel.y.toFixed(2)}</b></div>
                <div><span>Speed</span><b>{Math.hypot(sel.vx, sel.vy).toFixed(2)} m/s</b></div>
                <div><span>Heading</span><b>{((sel.heading * 180) / Math.PI).toFixed(0)}°</b></div>
                <div><span>Stamina</span><b>{(sel.stamina * 100).toFixed(0)}%</b></div>
                <div><span>Intent</span><b className="mono">{sel.intent.targetX === null ? "stop" : `→ (${sel.intent.targetX.toFixed(1)}, ${sel.intent.targetY!.toFixed(1)})${sel.intent.sprint ? " sprint" : ""}`}</b></div>
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
