#!/usr/bin/env node
/**
 * Records the M3 captioned walkthrough by driving the real viewer in Chromium.
 * Requires the dev server (`bun run dev`) on :5173.
 *
 *   node scripts/walkthrough-m2.mjs [outDir]
 *
 * Every scenario outcome shown in a caption is read back from the viewer's
 * event log; the script fails if an expected event or rejection is missing.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const VIEWER = process.env.VIEWER_URL ?? "http://127.0.0.1:5173/?seed=42";
const GOLDEN = JSON.parse(readFileSync(new URL("../tests/golden.json", import.meta.url), "utf8"));
const outDir = resolve(process.argv[2] ?? "docs/media/m3");
const rawDir = join(outDir, ".raw");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(rawDir, { recursive: true });

const W = 1440;
const H = 960;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: rawDir, size: { width: W, height: H } } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const log = (...a) => console.log("[m3]", ...a);
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(VIEWER);
await page.waitForSelector("canvas");
await page.addStyleTag({
  content: `#caption{position:fixed;left:520px;bottom:22px;transform:translateX(-50%);width:960px;background:rgba(0,0,0,.85);color:#fff;
  font:600 19px system-ui;padding:10px 18px;border-radius:10px;z-index:9999;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.5)}
  #caption small{display:block;font-weight:400;font-size:14px;color:#cfd8dc;margin-top:3px}`,
});

async function caption(text, sub = "") {
  await page.evaluate(([t, s]) => {
    let el = document.getElementById("caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "caption";
      document.body.appendChild(el);
    }
    el.innerHTML = t + (s ? `<small>${s}</small>` : "");
  }, [text, sub]);
  log(text);
}

let shot = 0;
async function screenshot(name) {
  shot++;
  const file = join(outDir, `${String(shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  log("screenshot", file);
}

const ev = () => page.evaluate(() => window.__engine.sim.events.map((e) => e.event));
const rej = () => page.evaluate(() => window.__engine.sim.rejections.map((r) => ({ type: r.command.type, playerId: r.command.playerId, reason: r.reason })));
const select = (id) => page.evaluate((i) => window.__engine.select(i), id);

async function runScenario(id, selectId, speed = "1") {
  await page.selectOption("[data-testid=speed]", speed);
  await page.selectOption("[data-testid=scenario]", id);
  await page.click("[data-testid=run-scenario]");
  if (selectId) await select(selectId);
}
async function waitScenarioDone(timeout = 20000) {
  await page.waitForFunction(() => !window.__engine.playing, null, { timeout });
}
function need(cond, msg) {
  if (!cond) throw new Error(`walkthrough expectation failed: ${msg}`);
}

const SOAK = (() => { try { return JSON.parse(readFileSync(new URL("../out/soak-1000.json", import.meta.url), "utf8")); } catch { return null; } })();
const phase = () => page.evaluate(() => window.__engine.sim.state.match.phase);
const evs = () => page.evaluate(() => window.__engine.sim.events.map((e) => e.event));
async function waitFor(fn, timeout = 30000) { await page.waitForFunction(fn, null, { timeout }); }

// 1. Full match flow in script mode
await caption("autosoccer-sim M3 — full match state machine, rules and restart lifecycle", "Scoreboard: score · attacking direction · period · phase · match clock (2 × 120 s)");
await wait(3500);
await screenshot("pre-match");
await caption("Pre-match → first-half kickoff: everyone in own half, opponents outside the centre circle", "Coin toss (seeded) decides who kicks off; the cyan ring marks the designated taker");
await page.click("[data-testid=play]");
await waitFor(() => window.__engine.sim.state.match.phase === "kickoff");
await page.click("[data-testid=play]");
await wait(600);
await screenshot("kickoff");
await wait(2500);
await caption("Accelerated play (4×): restarts are awarded and taken automatically", "Ball fully over a line → restart for the other team; the ball settles, is placed, and only the taker may kick");
await page.selectOption("[data-testid=speed]", "4");
await page.click("[data-testid=play]");
await waitFor(() => ["kickIn", "corner", "goalKick"].includes(window.__engine.sim.state.match.phase) && window.__engine.sim.state.tick >= window.__engine.sim.state.match.restart.readyTick, 60000);
await page.click("[data-testid=play]");
await screenshot("live-restart");
await wait(3500);
await page.click("[data-testid=play]");
await wait(9000);
await page.click("[data-testid=play]");

// 2. Scenarios for every phase
async function scenario(id, speed, text, sub, shots = []) {
  await caption(text, sub);
  await page.selectOption("[data-testid=speed]", speed);
  await page.selectOption("[data-testid=scenario]", id);
  await page.click("[data-testid=run-scenario]");
  for (const s of shots) {
    await waitFor(s.when, 30000);
    if (s.caption) await caption(s.caption[0], s.caption[1]);
    if (s.pause) { await page.click("[data-testid=play]"); }
    await wait(300);
    await screenshot(s.name);
    if (s.pause) { await wait(s.pause); await page.click("[data-testid=play]"); }
  }
  await waitFor(() => !window.__engine.playing, 30000);
  await wait(800);
}

await scenario("m3-goal-kickoff", "1", "Goal → score → kickoff: the whole ball over the line between the posts", "Scorer is the last touch; the conceding team kicks off after the celebration", [
  { name: "goal", when: () => window.__engine.sim.state.match.phase === "goalScored", pause: 2500 },
  { name: "goal-kickoff", when: () => window.__engine.sim.state.match.phase === "kickoff", caption: ["Conceding team (red) kicks off — engine-placed kickoff formation", "Score 1–0 and 'restartTaken' appear in the event log"], pause: 2500 },
]);
let e = await evs();
need(e.some((x) => x.type === "goalScored" && x.team === "blue") && e.some((x) => x.type === "restartTaken" && x.restart === "kickoff" && x.team === "red" && !x.fallback), "goal + kickoff");

await scenario("m3-kick-in", "1", "Touchline → kick-in for the other team at the crossing point", "The 4 m zone keeps red away; red players inside it are walked out (never teleported)", [
  { name: "kick-in", when: () => window.__engine.sim.state.match.phase === "kickIn" && window.__engine.sim.state.tick >= window.__engine.sim.state.match.restart.readyTick, pause: 2500 },
]);
e = await evs();
need(e.some((x) => x.type === "restartTaken" && x.restart === "kickIn" && !x.fallback), "kick-in taken");

await scenario("m3-corner", "2", "Defender's last touch over its own goal line → corner", "Taken from the nearest corner by the nearest attacker", [
  { name: "corner", when: () => window.__engine.sim.state.match.phase === "corner" && window.__engine.sim.state.tick >= window.__engine.sim.state.match.restart.readyTick, pause: 2000 },
]);
e = await evs();
need(e.some((x) => x.type === "restartTaken" && x.restart === "corner"), "corner taken");

await scenario("m3-goal-kick", "2", "Attacker's shot wide → goal kick", "Goal kicks are always taken by the defending goalkeeper from the goal-kick spot", [
  { name: "goal-kick", when: () => window.__engine.sim.state.match.phase === "goalKick" && window.__engine.sim.state.tick >= window.__engine.sim.state.match.restart.readyTick, pause: 2000 },
]);
e = await evs();
need(e.some((x) => x.type === "restartTaken" && x.restart === "goalKick" && x.taker === "red-1"), "goal kick by keeper");

await scenario("m3-foul", "1", "Foul → free kick: a failed tackle that makes contact", "Free kick to the fouled team at the ball; no penalties in this ruleset (fouls in the area move to its edge)", [
  { name: "free-kick", when: () => window.__engine.sim.state.match.phase === "freeKick", pause: 2500 },
]);
e = await evs();
need(e.some((x) => x.type === "foul") && e.some((x) => x.type === "restartTaken" && x.restart === "freeKick"), "foul + free kick");

await scenario("m3-timeout", "2", "Restart timeout: blue's taker never moves", "After 6 s the engine takes the kick-in itself (pass to nearest teammate) — bad controllers can't stall a match", [
  { name: "timeout-pending", when: () => window.__engine.sim.state.match.phase === "kickIn" && window.__engine.sim.state.tick >= window.__engine.sim.state.match.restart.readyTick + 120 },
]);
e = await evs();
need(e.some((x) => x.type === "restartTaken" && x.fallback), "fallback");
await caption("✔ restartTaken (engine fallback: timeout) — play resumes", "Every restart has a deadline, so no phase can deadlock");
await wait(3000);

await scenario("m3-halftime", "1", "Halftime: clock set 3 s before 2:00 of the first half", "Whistle → half-time break → teams switch ends → the other team kicks off", [
  { name: "halftime", when: () => window.__engine.sim.state.match.period === "halftime", pause: 2500 },
  { name: "second-half-kickoff", when: () => window.__engine.sim.state.match.period === "secondHalf" && window.__engine.sim.state.match.phase === "kickoff", caption: ["Second half: blue now attacks ← and defends the right goal; red kicks off", "Arrows in the scoreboard show attacking direction; keeper areas flip too"], pause: 3500 },
]);
e = await evs();
need(e.some((x) => x.type === "sidesSwitched"), "sides switched");

await scenario("m3-full-time", "1", "Final whistle at 2:00 of the second half", "After full time every action is rejected: 'play is stopped (fullTime)'", []);
await screenshot("full-time");
const rj = await page.evaluate(() => window.__engine.sim.rejections.map((r) => r.reason));
need(rj.includes("play is stopped (fullTime)"), "full-time rejection");
await wait(3000);

// 3. Determinism + soak
await caption("Seeded replay of the whole command stream reproduces the state hash");
await page.click("[data-testid=verify]");
await wait(2500);
const verified = await page.locator("[data-testid=verify-result]").innerText();
need(verified.includes("MATCH") && !verified.includes("MISMATCH"), `verify ${verified}`);
await screenshot("verify");
if (SOAK) {
  await caption(`Soak: ${SOAK.completed}/${SOAK.matches} seeded full matches reached FULL TIME · ${SOAK.deadlocks.length} deadlocks · ${SOAK.errors.length} errors`, "Safe, idle and chaos controllers × running and stop-on-dead-ball clocks · bun run soak --matches 1000");
  await wait(5000);
}
await caption("M3 complete: periods + phases, clock, score, sides, out of play, restarts with takers and distances, fouls, fallbacks", "bun run test · bun run soak · bun run headless --seed 42 --verify");
await wait(3500);

await context.close();
await browser.close();
need(errors.length === 0, `page errors: ${errors.join("; ")}`);

const webm = readdirSync(rawDir).find((f) => f.endsWith(".webm"));
renameSync(join(rawDir, webm), join(outDir, "walkthrough.webm"));
rmSync(rawDir, { recursive: true, force: true });
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(outDir, "walkthrough.webm"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "slow", "-movflags", "+faststart", join(outDir, "walkthrough.mp4")]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "62", "-t", "16", "-i", join(outDir, "walkthrough.webm"), "-vf", "fps=10,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer", join(outDir, "preview.gif")]);
rmSync(join(outDir, "walkthrough.webm"));
log("done", { verified: verified.replace(/\s+/g, " ") });
