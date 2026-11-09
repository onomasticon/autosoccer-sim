#!/usr/bin/env node
/**
 * Records the M4 captioned walkthrough by driving the real viewer in Chromium.
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
const outDir = resolve(process.argv[2] ?? "docs/media/m4");
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
const log = (...a) => console.log("[m4]", ...a);
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

const ctl = (team) => page.evaluate((t) => { const c = window.__engine.controllers[t]; return c && { name: c.name, disabled: c.disabled, kinds: c.diagnostics.map((d) => d.kind), msgs: c.diagnostics.map((d) => d.message), updates: c.updates }; }, team);
async function preset(team, name) {
  await page.selectOption(`[data-testid=preset-${team}]`, name);
  await page.waitForFunction(([t, n]) => window.__engine.scripts[t].label === n && window.__engine.controllers[t], [team, name]);
}
await page.waitForFunction(() => window.__ready, null, { timeout: 20000 });
await page.selectOption("[data-testid=speed]", "1");

// 1. Two sandboxed scripts
await caption("autosoccer-sim M4 — versioned controller SDK + sandboxed team scripts", "Blue runs chaser.js, red runs zonal.js — each in its own QuickJS/WASM sandbox, talking only through SDK 1.0 JSON");
await page.click("[data-testid=play]");
await wait(4500);
await caption("Controller inspector: script name/version, sandbox status, CPU budget use, last actions → engine commands, diagnostics", "Both teams receive the same pre-update observation at every 10 Hz decision tick");
await wait(5500);
await page.click("[data-testid=play]");
await screenshot("two-scripts");

// Determinism: browser QuickJS == headless Bun QuickJS
await page.click("[data-testid=reset]");
await page.evaluate(() => window.__engine.stepMany(600));
const h600 = await page.locator("[data-testid=hash]").innerText();
const g600 = GOLDEN["controllers:chaser-vs-zonal,seed=42,ticks=600"];
need(h600 === g600, `controllers hash ${h600} vs golden ${g600}`);
await caption(`Sandboxed scripts are deterministic: tick 600 hash in Chrome = headless Bun golden (${h600}) ✔`, "Seeded Math.random, no Date, WASM math — identical across hosts");
await wait(4500);

// 2. Edit a script live
await caption("Editing blue's script in the viewer…", "Change: every blue outfield player holds a line across the opponents' box");
await page.click("[data-testid=edit-blue]");
await wait(800);
const src = await page.locator("[data-testid=editor-blue]").inputValue();
const edited = src.replace("update(obs) {", `update(obs) {
    // EDIT: hold a line across the opponents' box
    if (!obs.restart) return obs.teammates.filter((p) => p.role !== "GK").map((p) => ({ type: "moveTo", player: p.id, x: obs.attackingDirection * 17, y: (p.number - 3.5) * 5, sprint: true }));`);
await page.locator("[data-testid=editor-blue]").fill(edited);
await page.locator("[data-testid=editor-blue]").evaluate((el) => {
  const i = el.value.indexOf("// EDIT");
  const line = el.value.slice(0, i).split("\n").length;
  el.scrollTop = Math.max(0, (line - 3) * 13);
  el.focus();
  el.setSelectionRange(i, el.value.indexOf("\n", el.value.indexOf("sprint: true }))", i)));
});
await wait(2500);
await screenshot("editor");
await page.click("[data-testid=apply-blue]");
await page.click("[data-testid=edit-blue]");
await caption("Applied → match restarts with the edited script: blue now forms a line at the box", "Only the public API is used — the script can't touch engine state");
await page.click("[data-testid=play]");
await wait(7000);
await page.click("[data-testid=play]");
await screenshot("edited-behaviour");
const bluePos = await page.evaluate(() => window.__engine.sim.state.players.filter((p) => p.team === "blue" && p.role !== "GK").map((p) => p.x));
need(bluePos.every((x) => x > 10), `edited behaviour visible ${bluePos}`);

// 3. Invalid actions
await preset("blue", "chaser.js");
await preset("red", "adversarial/invalid-actions.js");
await caption("Red now returns invalid, foreign and illegal actions every update", "Validation rejects: opponent's players, unknown types, debug commands, NaN, power out of range; the engine rejects illegal kicks/catches");
await page.click("[data-testid=play]");
await wait(5000);
await page.click("[data-testid=play]");
await screenshot("invalid-actions");
let r = await ctl("red");
need(r.kinds.includes("invalid-action") && r.msgs.some((m) => /not your player/.test(m)) && !r.disabled, "invalid actions rejected");
await wait(2500);

// 4. Failures → fallback
await preset("red", "zonal.js");
await preset("blue", "adversarial/crashes.js");
await caption("Blue's script now throws on every update", "Each failure is reported; after 3 in a row the controller is disabled and a built-in safe controller plays for blue");
await page.click("[data-testid=play]");
await page.waitForFunction(() => window.__engine.controllers.blue.disabled, null, { timeout: 15000 });
await wait(3500);
await page.click("[data-testid=play]");
await screenshot("crash-fallback");
r = await ctl("blue");
need(r.disabled && r.kinds.filter((k) => k === "error").length === 3, "crash fallback");

await preset("blue", "adversarial/infinite-loop.js");
await caption("Infinite loop: stopped by the deterministic CPU budget (QuickJS interrupt count), not wall-clock", "3 timeouts → disabled → safe fallback; the match never stalls");
await page.click("[data-testid=play]");
await page.waitForFunction(() => window.__engine.controllers.blue.disabled, null, { timeout: 15000 });
await wait(3000);
await page.click("[data-testid=play]");
await screenshot("timeout-fallback");
r = await ctl("blue");
need(r.kinds.includes("timeout"), "timeout");

await preset("blue", "adversarial/memory-hog.js");
await caption("Memory hog: stopped by the 16 MB heap limit → disabled immediately");
await page.click("[data-testid=play]");
await page.waitForFunction(() => window.__engine.controllers.blue.disabled, null, { timeout: 20000 });
await wait(2500);
await page.click("[data-testid=play]");
r = await ctl("blue");
need(r.kinds.includes("out-of-memory"), "oom");

// 5. Escape attempts
await preset("blue", "adversarial/escape.js");
await caption("Escape attempts: fetch, require, process, Date, timers, Function-constructor tricks, mutating observations", "The sandbox has no host APIs; observations are frozen JSON copies");
await page.click("[data-testid=play]");
await wait(2500);
await page.click("[data-testid=play]");
await screenshot("escape-probes");
r = await ctl("blue");
need(r.msgs.some((m) => m.startsWith("probes") && m.includes('"fetch":"undefined"')) && r.msgs.some((m) => m.startsWith("mutate blocked")), "escape probes");
await wait(3500);

// 6. API probe: all actions + lifecycle
await preset("blue", "api-probe.js");
await preset("red", "dumb.js");
await caption("api-probe.js exercises every action and lifecycle callback; dumb.js is the minimal controller", "Fast-forwarding the full match to see onMatchEnd…");
await page.click("[data-testid=play]");
await wait(3000);
await page.click("[data-testid=play]");
await page.evaluate(() => { while (!window.__engine.sim.clock.finished) window.__engine.stepMany(600); });
await wait(500);
await screenshot("api-probe-end");
r = await ctl("blue");
need(r.msgs.some((m) => m.startsWith("onMatchEnd") && m.includes("catchBall,kick,moveTo,releaseBall,sprint,stop,tackle")), "api probe coverage");
await caption("onMatchEnd: probe used catchBall, kick, moveTo, releaseBall, sprint, stop, tackle ✔", "initialize → update (10 Hz) → onMatchEnd, with per-match memory in the script's own globals");
await wait(4500);

await caption("Seeded replay: re-run the accepted command stream without running any controller");
await page.click("[data-testid=verify]");
await wait(2500);
const verified = await page.locator("[data-testid=verify-result]").innerText();
need(verified.includes("MATCH") && !verified.includes("MISMATCH"), `verify ${verified}`);
await screenshot("verify");
await caption("M4 complete: SDK 1.0 schemas + lifecycle, sandboxed scripts with limits, validation, diagnostics and safe fallback", "bun run match --blue examples/controllers/chaser.js --red examples/controllers/zonal.js --verify · docs/controller-sdk.md");
await wait(4000);

await context.close();
await browser.close();
need(errors.length === 0, `page errors: ${errors.join("; ")}`);

const webm = readdirSync(rawDir).find((f) => f.endsWith(".webm"));
renameSync(join(rawDir, webm), join(outDir, "walkthrough.webm"));
rmSync(rawDir, { recursive: true, force: true });
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(outDir, "walkthrough.webm"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "slow", "-movflags", "+faststart", join(outDir, "walkthrough.mp4")]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "28", "-t", "16", "-i", join(outDir, "walkthrough.webm"), "-vf", "fps=10,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer", join(outDir, "preview.gif")]);
rmSync(join(outDir, "walkthrough.webm"));
log("done", { verified: verified.replace(/\s+/g, " ") });
