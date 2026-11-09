import type { ControllerDebug } from "@autosoccer/controller-sdk";
import type { LoggedEvent, PlayerId, SimConfig, WorldState } from "@autosoccer/sim-core";
import { defendedSide } from "@autosoccer/sim-core";
import { Application, Container, Graphics, Text } from "pixi.js";
import { useEffect, useRef } from "react";

export const PX_PER_M = 18;
const MARGIN_M = 3;

const COLORS = {
  grass: 0x2e7d32,
  grassAlt: 0x2a7330,
  runOff: 0x245f28,
  line: 0xffffff,
  blue: 0x1e63d6,
  red: 0xd62f2f,
  gk: 0xf2c94c,
  ball: 0xffffff,
  select: 0xffeb3b,
  velocity: 0x00e5ff,
  target: 0xffffff,
};

interface Props {
  state: WorldState;
  events: readonly LoggedEvent[];
  /** Controller decision traces to draw (SDK debug output), per team. */
  debug?: { blue: ControllerDebug | null; red: ControllerDebug | null } | null;
  config: SimConfig;
  selected: PlayerId | null;
  overlays: boolean;
  onSelect: (id: PlayerId | null) => void;
}

/** World metres → canvas pixels (origin at pitch centre). */
function toPx(cfg: SimConfig) {
  const ox = (cfg.pitch.length / 2 + MARGIN_M) * PX_PER_M;
  const oy = (cfg.pitch.width / 2 + MARGIN_M) * PX_PER_M;
  return (x: number, y: number) => [ox + x * PX_PER_M, oy + y * PX_PER_M] as const;
}

function drawPitch(g: Graphics, cfg: SimConfig): void {
  const p = toPx(cfg);
  const { length: L, width: W, goalWidth, goalDepth, penaltyAreaDepth, penaltyAreaWidth, centreCircleRadius } = cfg.pitch;
  const fullW = (L + MARGIN_M * 2) * PX_PER_M;
  const fullH = (W + MARGIN_M * 2) * PX_PER_M;
  g.rect(0, 0, fullW, fullH).fill(COLORS.runOff);
  // Mowing stripes, 5 m wide.
  for (let i = 0; i < L / 5; i++) {
    const [x0, y0] = p(-L / 2 + i * 5, -W / 2);
    g.rect(x0, y0, 5 * PX_PER_M, W * PX_PER_M).fill(i % 2 ? COLORS.grass : COLORS.grassAlt);
  }
  const line = { width: 2, color: COLORS.line, alpha: 0.9 };
  const [tlx, tly] = p(-L / 2, -W / 2);
  g.rect(tlx, tly, L * PX_PER_M, W * PX_PER_M).stroke(line);
  const [hx0, hy0] = p(0, -W / 2);
  const [, hy1] = p(0, W / 2);
  g.moveTo(hx0, hy0).lineTo(hx0, hy1).stroke(line);
  const [cx, cy] = p(0, 0);
  g.circle(cx, cy, centreCircleRadius * PX_PER_M).stroke(line);
  g.circle(cx, cy, 3).fill(COLORS.line);
  for (const side of [-1, 1]) {
    const gx = (side * L) / 2;
    const [ax, ay] = p(side < 0 ? gx : gx - penaltyAreaDepth, -penaltyAreaWidth / 2);
    g.rect(ax, ay, penaltyAreaDepth * PX_PER_M, penaltyAreaWidth * PX_PER_M).stroke(line);
    const [nx, ny] = p(side < 0 ? gx - goalDepth : gx, -goalWidth / 2);
    g.rect(nx, ny, goalDepth * PX_PER_M, goalWidth * PX_PER_M)
      .fill({ color: 0xffffff, alpha: 0.18 })
      .stroke({ width: 3, color: 0xffffff });
  }
}

export function PitchView({ state, events, debug, config, selected, overlays, onSelect }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const appRef = useRef<{ app: Application; dyn: Graphics; labels: Container; texts: Map<string, Text> } | null>(null);
  const trail = useRef<Array<{ tick: number; x: number; y: number }>>([]);
  const propsRef = useRef<Props>({ state, events, debug, config, selected, overlays, onSelect });
  propsRef.current = { state, events, debug, config, selected, overlays, onSelect };

  useEffect(() => {
    let destroyed = false;
    const app = new Application();
    const width = (config.pitch.length + MARGIN_M * 2) * PX_PER_M;
    const height = (config.pitch.width + MARGIN_M * 2) * PX_PER_M;
    app.init({ width, height, antialias: true, background: COLORS.runOff, preserveDrawingBuffer: true }).then(() => {
      if (destroyed) {
        app.destroy(true);
        return;
      }
      host.current!.appendChild(app.canvas);
      app.canvas.dataset.testid = "pitch";
      const pitch = new Graphics();
      drawPitch(pitch, config);
      const dyn = new Graphics();
      const labels = new Container();
      app.stage.addChild(pitch, dyn, labels);
      app.stage.eventMode = "static";
      app.stage.hitArea = app.screen;
      app.stage.on("pointerdown", (e) => {
        const { state: s, config: c, onSelect: sel } = propsRef.current;
        const mx = e.global.x / PX_PER_M - (c.pitch.length / 2 + MARGIN_M);
        const my = e.global.y / PX_PER_M - (c.pitch.width / 2 + MARGIN_M);
        let best: PlayerId | null = null;
        let bestD = 1.2;
        for (const pl of s.players) {
          const d = Math.hypot(pl.x - mx, pl.y - my);
          if (d < bestD) {
            bestD = d;
            best = pl.id;
          }
        }
        sel(best);
      });
      appRef.current = { app, dyn, labels, texts: new Map() };
      render();
    });
    return () => {
      destroyed = true;
      if (appRef.current) {
        appRef.current.app.destroy(true, { children: true });
        appRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  function render() {
    const r = appRef.current;
    if (!r) return;
    const { state: s, events: evs, debug: dbg, config: c, selected: selId, overlays: ov } = propsRef.current;
    const p = toPx(c);
    const g = r.dyn;
    g.clear();
    const pr = c.player.radius * PX_PER_M;

    // Goal flash.
    if (s.ball.inGoal) {
      const side = s.ball.inGoal === "left" ? -1 : 1;
      const [gx, gy] = p(side < 0 ? -c.pitch.length / 2 - c.pitch.goalDepth : c.pitch.length / 2, -c.pitch.goalWidth / 2);
      g.rect(gx, gy, c.pitch.goalDepth * PX_PER_M, c.pitch.goalWidth * PX_PER_M).fill({ color: 0xffeb3b, alpha: 0.75 });
    }

    // Controller decision traces (passes, shots, runs, press/cover assignments).
    if (dbg) {
      for (const team of ["blue", "red"] as const) {
        const d = dbg[team];
        if (!d?.lines) continue;
        const base = team === "blue" ? 0x8ab4ff : 0xff8a8a;
        for (const l of d.lines) {
          const [x0, y0] = p(l.from.x, l.from.y);
          const [x1, y1] = p(l.to.x, l.to.y);
          const color = l.kind === "shot" ? 0xffeb3b : l.kind === "pass" ? base : l.kind === "press" ? 0xff9800 : 0xb0bec5;
          const width = l.kind === "pass" || l.kind === "shot" ? 3 : 2;
          // Dashed line.
          const len = Math.hypot(x1 - x0, y1 - y0);
          const n = Math.max(1, Math.floor(len / 8));
          for (let i = 0; i < n; i += 2) {
            const a = i / n, b = Math.min(1, (i + 1) / n);
            g.moveTo(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a).lineTo(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b).stroke({ width, color, alpha: 0.95 });
          }
          if (l.kind === "pass" || l.kind === "shot") g.circle(x1, y1, 4).fill(color);
        }
      }
    }

    // Pending restart: spot, exclusion zone, taker.
    const rs = s.match.restart;
    if (rs) {
      const [rx, ry] = p(rs.x, rs.y);
      const rad = (rs.type === "kickoff" ? c.pitch.centreCircleRadius : c.match.restartDistance) * PX_PER_M;
      g.circle(rx, ry, rad).fill({ color: rs.team === "blue" ? COLORS.blue : COLORS.red, alpha: 0.12 }).stroke({ width: 2, color: rs.team === "blue" ? COLORS.blue : COLORS.red, alpha: 0.8 });
      g.circle(rx, ry, 6).stroke({ width: 2, color: 0xffffff });
      const tk = s.players.find((q) => q.id === rs.taker);
      if (tk) {
        const [tx, ty] = p(tk.x, tk.y);
        g.circle(tx, ty, c.player.radius * PX_PER_M + 8).stroke({ width: 3, color: 0x00e5ff });
      }
    }

    if (ov) {
      // Contact ranges + legal keeper area for the selected player.
      const sp = s.players.find((q) => q.id === selId);
      if (sp) {
        const [sx, sy] = p(sp.x, sp.y);
        g.circle(sx, sy, c.action.kickRange * PX_PER_M).stroke({ width: 1.5, color: 0xffffff, alpha: 0.7 });
        g.circle(sx, sy, c.action.tackleReach * PX_PER_M).stroke({ width: 1.5, color: 0xff9800, alpha: 0.7 });
        if (sp.role === "GK") {
          g.circle(sx, sy, c.action.catchReach * PX_PER_M).stroke({ width: 1.5, color: COLORS.gk, alpha: 0.9 });
          const left = defendedSide(sp.team, s.match) === "left";
          const [ax, ay] = p(left ? -c.pitch.length / 2 : c.pitch.length / 2 - c.pitch.penaltyAreaDepth, -c.pitch.penaltyAreaWidth / 2);
          g.rect(ax, ay, c.pitch.penaltyAreaDepth * PX_PER_M, c.pitch.penaltyAreaWidth * PX_PER_M).fill({ color: COLORS.gk, alpha: 0.12 });
        }
      }
      // Kick / release vectors for 0.75 s after they happen.
      for (const le of evs.slice(-30)) {
        if (s.tick - le.tick > 45) continue;
        if (le.event.type === "kick") {
          const e = le.event;
          const [x0, y0] = p(le.ballX, le.ballY);
          const [x1, y1] = p(le.ballX + e.dirX * e.speed * 0.3, le.ballY + e.dirY * e.speed * 0.3);
          g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 3, color: 0xff4081, alpha: 0.9 });
          g.circle(x1, y1, 4).fill(0xff4081);
        }
      }
      for (const pl of s.players) {
        const [x, y] = p(pl.x, pl.y);
        if (pl.intent.targetX !== null && pl.intent.targetY !== null) {
          const [tx, ty] = p(pl.intent.targetX, pl.intent.targetY);
          g.moveTo(x, y).lineTo(tx, ty).stroke({ width: 1, color: COLORS.target, alpha: 0.25 });
          g.circle(tx, ty, 2.5).fill({ color: COLORS.target, alpha: 0.4 });
        }
        // Velocity vector: 0.5 s look-ahead.
        const [vx, vy] = p(pl.x + pl.vx * 0.5, pl.y + pl.vy * 0.5);
        g.moveTo(x, y).lineTo(vx, vy).stroke({ width: 2, color: COLORS.velocity, alpha: 0.9 });
      }
      const [bx, by] = p(s.ball.x, s.ball.y);
      const [bvx, bvy] = p(s.ball.x + s.ball.vx * 0.5, s.ball.y + s.ball.vy * 0.5);
      g.moveTo(bx, by).lineTo(bvx, bvy).stroke({ width: 2, color: 0xff9800, alpha: 0.9 });
    }

    for (const pl of s.players) {
      const [x, y] = p(pl.x, pl.y);
      const color = pl.team === "blue" ? COLORS.blue : COLORS.red;
      if (pl.id === selId) g.circle(x, y, pr + 5).stroke({ width: 3, color: COLORS.select });
      // Collision circle at true radius, plus a heading tick.
      g.circle(x, y, pr).fill({ color, alpha: pl.stunned > 0 ? 0.4 : 1 }).stroke({ width: pl.role === "GK" ? 3 : 1.5, color: pl.role === "GK" ? COLORS.gk : 0x000000 });
      if (pl.stunned > 0) {
        g.moveTo(x - pr, y - pr).lineTo(x + pr, y + pr).moveTo(x + pr, y - pr).lineTo(x - pr, y + pr).stroke({ width: 2, color: 0xffffff });
      }
      g.moveTo(x, y)
        .lineTo(x + Math.cos(pl.heading) * (pr + 4), y + Math.sin(pl.heading) * (pr + 4))
        .stroke({ width: 2, color: 0xffffff });
      // Stamina bar.
      g.rect(x - pr, y + pr + 3, 2 * pr, 3).fill({ color: 0x000000, alpha: 0.5 });
      g.rect(x - pr, y + pr + 3, 2 * pr * pl.stamina, 3).fill(pl.stamina > c.player.sprintThreshold ? 0x76ff03 : 0xff5252);

      let t = r.texts.get(pl.id);
      if (!t) {
        t = new Text({ text: `${pl.team === "blue" ? "B" : "R"}${pl.number}`, style: { fontFamily: "monospace", fontSize: 11, fill: 0xffffff, fontWeight: "bold" } });
        t.anchor.set(0.5, 1);
        r.labels.addChild(t);
        r.texts.set(pl.id, t);
      }
      t.position.set(x, y - pr - 2);
    }

    // Ball trail (last ~0.6 s), reset when time jumps backwards (reset/seek).
    const tr = trail.current;
    if (tr.length && (s.tick < tr[tr.length - 1]!.tick || s.tick - tr[tr.length - 1]!.tick > 120)) tr.length = 0;
    if (!tr.length || tr[tr.length - 1]!.tick !== s.tick) tr.push({ tick: s.tick, x: s.ball.x, y: s.ball.y });
    while (tr.length > 36) tr.shift();
    tr.forEach((q, i) => {
      if (s.tick - q.tick > 36) return;
      const [tx, ty] = p(q.x, q.y);
      g.circle(tx, ty, 1.5 + (i / tr.length) * 2.5).fill({ color: 0xffffff, alpha: (i / tr.length) * 0.35 });
    });

    // Goal animation: expanding rings from the goal mouth for 2 s.
    if (s.match.phase === "goalScored" && s.ball.inGoal) {
      const goalEv = [...evs].reverse().find((e) => e.event.type === "goalScored");
      const elapsed = goalEv ? s.tick - goalEv.tick : 0;
      const [gx, gy] = p((s.ball.inGoal === "left" ? -1 : 1) * c.pitch.length / 2, 0);
      for (let k = 0; k < 3; k++) {
        const e = elapsed - k * 15;
        if (e < 0) continue;
        const rad = 10 + e * 1.6;
        g.circle(gx, gy, rad).stroke({ width: 4, color: 0xffd54f, alpha: Math.max(0, 1 - e / 110) });
      }
    }

    const [bx, by] = p(s.ball.x, s.ball.y);
    // True ball radius is 2 px at this scale; draw a 5 px marker so it stays visible.
    g.circle(bx, by, Math.max(5, c.ball.radius * PX_PER_M)).fill(COLORS.ball).stroke({ width: 1.5, color: 0x000000 });
    if (s.ball.heldBy) g.circle(bx, by, 8).stroke({ width: 2, color: COLORS.gk });
  }

  useEffect(() => {
    render();
  });

  return <div ref={host} style={{ lineHeight: 0 }} />;
}
