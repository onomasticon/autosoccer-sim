#!/usr/bin/env node
/**
 * Records the M2 captioned walkthrough by driving the real viewer in Chromium.
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
const outDir = resolve(process.argv[2] ?? "docs/media/m2");
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
const log = (...a) => console.log("[m2]", ...a);
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

// 1. Intro + playground
await caption("autosoccer-sim M2 — physical soccer actions + debug inspector", "bun run dev · engine v0.2.0 · seed 42");
await wait(3000);
await caption("Playground script: dribbling, passing, shooting, tackling, keeper catches — all through engine commands", "Event log (right) shows every executed action and every rejected command with its reason");
await page.click("[data-testid=play]");
await select("blue-4");
await wait(9000);
await screenshot("playground");
await caption("Selected player overlays: white = kick/touch range (0.85 m), orange = tackle reach (1.3 m)", "Inspector: distance to ball, touch/tackle/catch cooldowns, grounded/holding status");
await wait(5000);
await page.click("[data-testid=play]");

// 2. Scenarios
await caption("Scenario 1 · Pass and trap — B4 plays a ground pass, B5 cushions the incoming ball", "Scenario harness places players with debug commands, then issues ordinary engine commands");
await runScenario("pass", "blue-5", "0.5");
await waitScenarioDone();
let e = await ev();
need(e.some((x) => x.type === "kick") && e.some((x) => x.type === "trap" && x.playerId === "blue-5"), "pass + trap");
await screenshot("pass-trap");
await wait(1500);

await caption("Scenario 2 · Dribble — dribble intent takes small touches to keep the ball ahead, through a turn", "The ball is never attached: every touch is an impulse on a free ball");
await runScenario("dribble", "blue-4", "1");
await waitScenarioDone();
e = await ev();
need(e.filter((x) => x.type === "dribbleTouch").length > 5, "dribble touches");
await screenshot("dribble");
await wait(1000);

await caption("Scenario 3 · Interception — R2 passes to R5, B2 steps into the lane and traps it", "Trap of a ball last touched by the other team is flagged as an interception");
await runScenario("intercept", "blue-2", "0.5");
await waitScenarioDone();
e = await ev();
need(e.some((x) => x.type === "trap" && x.interception), "interception");
await screenshot("interception");
await wait(1500);

await caption("Scenario 4 · Tackle — B3 tackles R4's dribble when the ball enters tackle reach", "Success is a seeded roll that improves the closer the ball is; a miss grounds the tackler");
await runScenario("tackle", "blue-3", "0.5");
await waitScenarioDone();
e = await ev();
const tk = e.find((x) => x.type === "tackle");
need(tk, "tackle event");
await caption(`Tackle ${tk.success ? "WON — ball knocked away from R4" : "missed — B3 grounded"} (seed 42)`, "Same seed ⇒ same roll every time");
await screenshot("tackle");
await wait(3000);

await caption("Scenario 5 · Shot and goal-line crossing — B5 shoots at full power past R1", "Goal = the whole ball crosses the goal line between the posts; the net absorbs it");
await runScenario("shoot", "blue-5", "0.5");
await waitScenarioDone();
e = await ev();
need(e.some((x) => x.type === "goal" && x.side === "right"), "goal");
await screenshot("goal");
await wait(2500);

await caption("Scenario 6 · Keeper catch & release — R5 shoots, B1 catches inside its area, holds, throws to B2", "Gold ring = catch reach; shaded box = the only area where B1 may catch or carry the ball");
await runScenario("keeper", "blue-1", "1");
await page.waitForFunction(() => window.__engine.sim.state.ball.heldBy === "blue-1", null, { timeout: 15000 });
await wait(600);
await screenshot("keeper-holding");
await waitScenarioDone();
e = await ev();
need(e.some((x) => x.type === "catch" && x.success) && e.some((x) => x.type === "release" && !x.auto), "catch + release");
await wait(1500);

await caption("Scenario 7 · Rejected kicks — out of range, then outside the 110° facing cone; then a legal kick", "Rejected commands never change state: they are reported with a reason");
await runScenario("illegal-kick", "blue-4", "1");
await waitScenarioDone();
let r = await rej();
need(r.some((x) => /out of kick range/.test(x.reason)) && r.some((x) => /from facing/.test(x.reason)), "kick rejections");
await screenshot("rejected-kicks");
await wait(3500);

await caption("Scenario 8 · Rejected catches — B1 outside its area, then outfield B4; then a legal catch", "Keeper rules: goalkeeper only, ball and keeper inside own penalty area, within reach, not too fast");
await runScenario("illegal-catch", "blue-1", "1");
await waitScenarioDone();
r = await rej();
need(r.some((x) => /outside the goalkeeper's own penalty area/.test(x.reason)) && r.some((x) => x.reason === "only goalkeepers can catch"), "catch rejections");
await screenshot("rejected-catches");
await wait(3500);

// 3. Determinism
await caption("Seeded replay: re-run the recorded command stream (incl. debug placements) from a fresh world");
await page.click("[data-testid=verify]");
await wait(2500);
const verified = await page.locator("[data-testid=verify-result]").innerText();
need(verified.includes("MATCH") && !verified.includes("MISMATCH"), `verify ${verified}`);
await screenshot("verify");

await page.click("[data-testid=manual]");
await page.click("[data-testid=manual]"); // stays manual; switch back to script below resets world
await page.click("text=Script");
await page.fill("[data-testid=seed]", "42");
await page.click("[data-testid=reset]");
await page.evaluate(() => window.__engine.stepMany(600));
const hash600 = await page.locator("[data-testid=hash]").innerText();
const golden = GOLDEN["seed=42,seconds=10"];
need(hash600 === golden, `browser ${hash600} vs golden ${golden}`);
await caption(`Playground seed 42 @ tick 600 in Chrome: ${hash600} = headless Bun golden ✔`, "Physics with actions stays bit-identical across browser and headless runtimes");
await wait(4500);
await caption("M2 complete: kicks, dribbles, traps/interceptions, tackles, keeper catch/release, goal crossing, overlays, diagnostics", "bun run test · bun run headless --seed 42 --verify");
await wait(3500);

await context.close();
await browser.close();
need(errors.length === 0, `page errors: ${errors.join("; ")}`);

const webm = readdirSync(rawDir).find((f) => f.endsWith(".webm"));
renameSync(join(rawDir, webm), join(outDir, "walkthrough.webm"));
rmSync(rawDir, { recursive: true, force: true });
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(outDir, "walkthrough.webm"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "slow", "-movflags", "+faststart", join(outDir, "walkthrough.mp4")]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "33", "-t", "16", "-i", join(outDir, "walkthrough.webm"), "-vf", "fps=10,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer", join(outDir, "preview.gif")]);
rmSync(join(outDir, "walkthrough.webm"));
log("done", { tackle: tk.success, hash600, verified: verified.replace(/\s+/g, " ") });
