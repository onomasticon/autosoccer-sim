#!/usr/bin/env node
/**
 * Records the M6 captioned walkthrough by driving the real viewer in Chromium.
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
const outDir = resolve(process.argv[2] ?? "docs/media/m6");
const rawDir = join(outDir, ".raw");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(rawDir, { recursive: true });

const W = 1440;
const H = 1180;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, acceptDownloads: true, recordVideo: { dir: rawDir, size: { width: W, height: H } } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const log = (...a) => console.log("[m6]", ...a);
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

const st = () => page.evaluate(() => { const s = window.__engine.sim.state; return { tick: s.tick, period: s.match.period, phase: s.match.phase, score: s.match.score }; });
const replayPath = join(outDir, ".raw", "match.replay.json");
await page.waitForFunction(() => window.__ready, null, { timeout: 20000 });

// 1. Live viewer: speeds, pause/step
await caption("autosoccer-sim M6 — match viewer, replay recording and decision timeline", "Live: Blue possession vs Red counter · the timeline records goals, fouls and restarts as they happen");
await page.selectOption("[data-testid=speed]", "1");
await page.click("[data-testid=play]");
await wait(3500);
for (const sp of ["0.25", "4", "8"]) {
  await page.selectOption("[data-testid=speed]", sp);
  await caption(`Playback speed ${sp}×`, "0.25× to 8× · fixed 60 Hz simulation; speed only changes how many ticks run per frame");
  await wait(sp === "8" ? 5000 : 3000);
}
await page.click("[data-testid=play]");
const t0 = (await st()).tick;
await caption(`⏸ Paused at tick ${t0} — single-step one tick at a time`);
for (let i = 0; i < 3; i++) { await page.click("[data-testid=step]"); await wait(500); }
await screenshot("live-timeline");

// 2. Inspector: issued vs executed vs validation errors
await page.selectOption("[data-testid=preset-red]", "adversarial/invalid-actions.js");
await page.waitForFunction(() => window.__engine.scripts.red.label.includes("invalid"));
await page.selectOption("[data-testid=speed]", "1");
await page.click("[data-testid=play]");
await wait(4000);
await page.click("[data-testid=play]");
await page.evaluate(() => window.__engine.select("red-2"));
await caption("Inspector · issued vs executed: red-2's ISSUED kicks are REJECTED by the engine; malformed actions are INVALID (SDK validation)", "Executed actions (green) are engine events — the same log works live and in replays");
await wait(4500);
await screenshot("action-log-rejections");
const rows = await page.locator("[data-testid=action-log] .al").allInnerTexts();
need(rows.some((r) => r.includes("REJECTED")) && rows.some((r) => r.includes("ISSUED")), `action log ${rows.slice(0, 3)}`);

await page.selectOption("[data-testid=preset-red]", "red-counter.js");
await page.waitForFunction(() => window.__engine.scripts.red.label === "red-counter.js");
await page.click("[data-testid=play]");
await page.waitForFunction(() => window.__engine.sim.events.some((e) => e.event.type === "kick" && e.event.playerId === "blue-4"), null, { timeout: 30000 });
await page.click("[data-testid=play]");
await page.evaluate(() => window.__engine.select("blue-4"));
await caption("blue-4: ISSUED kick → EXECUTED kick (with speed) · overlays show velocities, ranges and decision lines");
await wait(3500);
await screenshot("action-log-executed");

// 3. Record a full match and save it
await caption("Recording a full Blue vs Red match (fast-forward to full time)…", "Every live run records: versions, seed, config, controller identities, validated commands, events, decisions, snapshots, hashes");
await page.evaluate(() => { while (!window.__engine.sim.clock.finished) window.__engine.stepMany(600); });
const ft = await st();
await wait(1500);
await caption(`Full time ${ft.score.blue}–${ft.score.red} · 💾 Save replay`);
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-testid=save-replay]")]);
await dl.saveAs(replayPath);
await wait(2500);
await screenshot("full-time-saved");

// 4. Reload and open the replay (no controllers run)
await page.goto(VIEWER);
await page.waitForFunction(() => window.__ready, null, { timeout: 20000 });
await page.addStyleTag({ content: `#caption{position:fixed;left:520px;bottom:22px;transform:translateX(-50%);width:960px;background:rgba(0,0,0,.85);color:#fff;font:600 19px system-ui;padding:10px 18px;border-radius:10px;z-index:9999;text-align:center}#caption small{display:block;font-weight:400;font-size:14px;color:#cfd8dc;margin-top:3px}` });
await caption("Page reloaded → 📂 Load replay", "Replay mode never executes the controllers — it re-steps the engine with the recorded command stream");
await wait(2000);
await page.setInputFiles("[data-testid=load-replay]", replayPath);
await page.waitForFunction(() => window.__engine.mode === "replay");
await wait(2500);
await screenshot("replay-loaded");

// Seek to the first goal via its timeline chip
const goalChip = page.locator("[data-testid=chip-goal]").first();
need(await goalChip.count(), "goal chip present");
await caption(`Timeline: click the goal marker → seek to ${await goalChip.innerText()}`, "Seeking loads the nearest 10 s snapshot and steps forward deterministically");
await page.evaluate(() => window.__engine.seek(Math.max(0, window.__engine.player.replay.events.find((e) => e.event.type === "goalScored").tick - 240)));
await page.selectOption("[data-testid=speed]", "1");
await page.click("[data-testid=play]");
await page.waitForFunction(() => window.__engine.sim.state.match.phase === "goalScored", null, { timeout: 15000 });
await wait(800);
await page.click("[data-testid=play]");
await screenshot("replay-goal");
await wait(2000);
await goalChip.click();
await wait(1500);
need((await st()).phase === "goalScored", "seek to goal");

// Scrub to a restart with the slider
const rTick = await page.evaluate(() => window.__engine.player.replay.events.filter((e) => e.event.type === "restartAwarded" && e.event.restart === "corner")[0]?.tick ?? window.__engine.player.replay.events.find((e) => e.event.type === "restartAwarded" && e.event.restart !== "kickoff").tick);
await caption("Scrubbing with the slider to a corner — renderer, overlays, inspector and decision lines are the same as live");
for (const f of [0.15, 0.4, 0.65]) { await page.locator("[data-testid=scrub]").fill(String(Math.round(f * ft.tick))); await wait(700); }
await page.locator("[data-testid=scrub]").fill(String(rTick + 50));
await wait(1200);
await page.selectOption("[data-testid=speed]", "0.5");
await page.click("[data-testid=play]");
await wait(3000);
await page.click("[data-testid=play]");
await page.evaluate(() => window.__engine.select("blue-5"));
await screenshot("replay-restart");
await wait(2500);

// Verify
await caption("Verify replay: re-simulate the entire match from seed + commands and compare every recorded state hash");
await page.click("[data-testid=verify-replay]");
await page.waitForSelector("[data-testid=replay-verify-result]");
const vr = await page.locator("[data-testid=replay-verify-result]").innerText();
need(vr.includes("✔") && vr.includes(" 0 mismatches"), `replay verify ${vr}`);
await wait(3500);
await screenshot("replay-verified");

await page.click("[data-testid=fit]");
await caption("Fit to window: the same pitch scaled to the viewport");
await wait(3000);
await page.click("[data-testid=fit]");
await caption("M6 complete: live + replay viewer, speeds, stepping, inspector (issued/executed/invalid), timeline seek, verified replays", "CLI: bun run match --record m.json · bun run replay m.json --timeline --at goal:1 --verify");
await wait(3500);
const verified = vr;

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
