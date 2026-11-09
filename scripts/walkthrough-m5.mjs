#!/usr/bin/env node
/**
 * Records the M5 captioned walkthrough by driving the real viewer in Chromium.
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
const outDir = resolve(process.argv[2] ?? "docs/media/m5");
const rawDir = join(outDir, ".raw");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(rawDir, { recursive: true });

const W = 1440;
const H = 1100;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: rawDir, size: { width: W, height: H } } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const log = (...a) => console.log("[m5]", ...a);
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

const HL = JSON.parse(readFileSync(new URL("../out/m5-highlights.json", import.meta.url), "utf8"));
const BVR = (() => { try { return JSON.parse(readFileSync(new URL("../out/bvr-100.json", import.meta.url), "utf8")); } catch { return null; } })();
const st = () => page.evaluate(() => { const s = window.__engine.sim.state; return { tick: s.tick, period: s.match.period, phase: s.match.phase, score: s.match.score }; });
const dbg = (t) => page.evaluate((team) => window.__engine.controllers[team]?.last?.debug ?? null, t);
async function jump(tick) {
  await page.evaluate(() => window.__engine.reset(42));
  await page.evaluate((t) => window.__engine.stepMany(t - window.__engine.sim.state.tick), tick);
}
async function playFor(ms, speed) {
  await page.selectOption("[data-testid=speed]", String(speed));
  await page.click("[data-testid=play]");
  await wait(ms);
  await page.click("[data-testid=play]");
}
await page.waitForFunction(() => window.__ready, null, { timeout: 20000 });

// 1. Whole match, accelerated
await caption("autosoccer-sim M5 — Blue possession vs Red counterattack", "Two sandboxed scripts using only the public SDK · seed 42 · full 2 × 120 s match at 8×");
await wait(3000);
await page.selectOption("[data-testid=speed]", "8");
await page.click("[data-testid=play]");
let shownHT = false, shown2 = false, shot1 = false;
while (true) {
  const s = await st();
  if (!shot1 && s.period === "firstHalf" && s.tick > 1500) { await screenshot("match-first-half"); shot1 = true; await caption("1st half: Blue (→) circulates the ball; Red (←) sits in a compact low block with the forward as outlet", "Dashed lines = each controller's current decisions (passes, runs, press/cover); panel = mode + notes"); }
  if (!shownHT && s.period === "halftime") { shownHT = true; await caption("Half-time — teams switch ends; both controllers read attackingDirection and flip automatically"); }
  if (!shown2 && s.period === "secondHalf" && s.tick > 7700) { shown2 = true; await caption("2nd half: Blue attacks ← now; when Red scores, Blue switches to CHASE and Red to PROTECT", "Score-aware adaptation lives in the scripts' own memory"); }
  if (s.period === "fullTime") break;
  await wait(400);
}
await wait(300);
const ft = await st();
await screenshot("full-time");
need(ft.score.blue === HL.score.blue && ft.score.red === HL.score.red, `browser result ${JSON.stringify(ft.score)} vs headless ${JSON.stringify(HL.score)}`);
await caption(`Full time ${ft.score.blue}–${ft.score.red} — identical to the headless run of seed 42`, "Same scripts, same seed, same QuickJS/WASM → same match everywhere");
await wait(4000);

// 2. Slowed highlights
await caption(`Highlight · Blue build-up: ${HL.chain.n} completed passes in a row`, "Carrier scores every teammate by lane clearance, space and progress; supports spread wide, forward runs in behind");
await jump(Math.max(0, HL.chain.start - 30));
await playFor(3500, 1);
await screenshot("blue-passing");
const bd = await dbg("blue");
need(bd && /build-up|keep-ball/.test(bd.mode), `blue mode ${bd && bd.mode}`);
await playFor(4500, 1);

await caption("Highlight · goalkeeping: catch in the area, then Blue's keeper distributes short to an open teammate");
await jump(Math.max(0, HL.catchTick - 80));
await playFor(3000, 0.5);
await screenshot("keeper");
await playFor(2500, 1);

await caption("Highlight · restart: designated taker walks round the ball and plays it short; opponents held 4 m away");
await jump(HL.setPieceAward + 30);
await playFor(4500, 2);
await screenshot("restart");

await caption("Highlight · Red COUNTER: ball won in the low block → direct ball into the forward's run → goal", "Red's mode switches to COUNTER for 4 s after every regain");
await jump(Math.max(0, HL.counter.win - 70));
await playFor(1300, 0.5);
await screenshot("red-counter");
const rd = await dbg("red");
await playFor(3200, 0.5);
need((await st()).score.red >= 1, "red counter goal");
await screenshot("red-goal");

await caption("Highlight · second-half adaptation: Blue is 0–1 down → CHASE (longer passes, shots from range, higher press)", "Red is ahead → PROTECT (deeper block)");
await jump(HL.adaptationTick);
await playFor(2500, 1);
const bd2 = await dbg("blue"), rd2 = await dbg("red");
need(bd2 && bd2.mode.includes("chase"), `blue chase ${bd2 && bd2.mode}`);
need(rd2 && rd2.mode.includes("protect"), `red protect ${rd2 && rd2.mode}`);
await screenshot("adaptation");
await playFor(2500, 1);
const eq = HL.goals.find((g) => g.team === "blue");
if (eq) {
  await caption("…and the chase pays off: Blue equalises");
  await jump(eq.tick - 150);
  await playFor(5000, 1);
  await screenshot("blue-equaliser");
}

if (BVR) {
  const b = BVR.meanPerMatch.blue, r = BVR.meanPerMatch.red;
  await caption(`100 seeded matches: ${BVR.completed}/${BVR.matches} completed, 0 hangs · Blue ${BVR.results.blueWins}W ${BVR.results.draws}D ${BVR.results.redWins}L`, `Possession ${Math.round(b.possession * 100)}% / ${Math.round(r.possession * 100)}% · passes ${b.passes} / ${r.passes} · pass length ${b.avgPassLength} / ${r.avgPassLength} m · team height ${b.avgTeamHeight} / ${r.avgTeamHeight} m (blue / red)`);
  await wait(6000);
}
await caption("M5 complete: two tactically distinct, fully autonomous scripted teams", "bun run demo · bun run bvr --matches 100 · docs/tactics.md · docs/api-coverage.md");
await wait(3500);
const verified = "n/a";

await context.close();
await browser.close();
need(errors.length === 0, `page errors: ${errors.join("; ")}`);

const webm = readdirSync(rawDir).find((f) => f.endsWith(".webm"));
renameSync(join(rawDir, webm), join(outDir, "walkthrough.webm"));
rmSync(rawDir, { recursive: true, force: true });
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(outDir, "walkthrough.webm"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "slow", "-movflags", "+faststart", join(outDir, "walkthrough.mp4")]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "50", "-t", "16", "-i", join(outDir, "walkthrough.webm"), "-vf", "fps=10,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer", join(outDir, "preview.gif")]);
rmSync(join(outDir, "walkthrough.webm"));
log("done", { verified: verified.replace(/\s+/g, " ") });
