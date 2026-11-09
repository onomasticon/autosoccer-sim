#!/usr/bin/env node
/**
 * Records the M1 captioned video walkthrough + screenshots by driving the real
 * viewer in Chromium. Requires the dev server (`bun run dev`) on :5173.
 *
 *   node scripts/record-walkthrough.mjs [outDir]
 *
 * Produces <outDir>/walkthrough.webm|mp4|gif and numbered PNG screenshots.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const VIEWER = process.env.VIEWER_URL ?? "http://127.0.0.1:5173/?seed=42";
const outDir = resolve(process.argv[2] ?? "docs/media/m1");
const rawDir = join(outDir, ".raw");
mkdirSync(rawDir, { recursive: true });

const GOLDEN = JSON.parse(readFileSync(new URL("../tests/golden.json", import.meta.url), "utf8"));
const W = 1400;
const H = 880;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: rawDir, size: { width: W, height: H } } });
const page = await context.newPage();
const log = (...a) => console.log("[walkthrough]", ...a);
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(VIEWER);
await page.waitForSelector("canvas");
await page.addStyleTag({
  content: `#caption{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:1100px;background:rgba(0,0,0,.82);color:#fff;
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

const engine = (fn, arg) => page.evaluate(fn, arg);
const tick = () => engine(() => window.__engine.sim.state.tick);
const hash = () => page.locator("[data-testid=hash]").innerText();
let shot = 0;
async function screenshot(name) {
  shot++;
  const file = join(outDir, `${String(shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  log("screenshot", file);
}

/** Click on the canvas at the given world position. */
async function clickWorld(x, y) {
  const box = await page.locator("canvas").boundingBox();
  await page.mouse.click(box.x + (x + 25 + 3) * 18, box.y + (y + 16 + 3) * 18);
}

async function playUntil(targetTick) {
  await page.click("[data-testid=play]");
  while ((await tick()) < targetTick - 40) await wait(50);
  await page.click("[data-testid=play]"); // pause
  const t = await tick();
  if (t < targetTick) await engine((n) => window.__engine.stepMany(n), targetTick - t);
  else if (t > targetTick) throw new Error(`overshot target tick ${t} > ${targetTick}`);
}

// 1. Launch
await caption("autosoccer-sim M1 — deterministic physics playground", "bun run dev · React + PixiJS viewer driven by @autosoccer/sim-core · seed 42");
await wait(3500);
await screenshot("launch");
await caption("50 × 32 m pitch, 4 m goals, keeper areas · 5v5 (gold ring = goalkeeper) · ball at centre", "Positions come from sim state; seed adds small formation jitter");
await wait(4000);

// 2. Play
await caption("▶ Play — fixed 60 Hz physics, commands applied on 10 Hz decision ticks", "A seeded playground script sends moveTo/sprint commands; players accelerate, turn, sprint and collide");
await page.click("[data-testid=play]");
await wait(6000);
await screenshot("playing");
await caption("Overlays: cyan = velocity (0.5 s), white = movement target, orange = ball velocity", "Bars under players = stamina (green ≥ sprint threshold). No ball attachment: contacts push the free ball");
await wait(5000);

// 3. Inspect a player
const p = await engine(() => window.__engine.sim.state.players.find((q) => q.id === "blue-4"));
await clickWorld(p.x, p.y);
await caption("Click a player to inspect it: position, speed, heading, stamina, current intent", "Contacts counter shows player–player, player–ball and ball–wall collisions this tick");
await wait(5000);
await screenshot("inspector");

// 4. Pause + step
await page.click("[data-testid=play]");
const pausedAt = await tick();
await caption(`⏸ Paused at tick ${pausedAt} — the clock and world are frozen`);
await wait(3000);
for (let i = 1; i <= 5; i++) {
  await page.click("[data-testid=step]");
  await caption(`⏭ Single step ${i}/5 → tick ${await tick()}`, "One fixed 1/60 s physics tick per click");
  await wait(900);
}
await screenshot("stepped");

// 5. Repeatability with the same seed
await caption("Repeatability: reset seed 42 and run to tick 600", "Same seed + same command stream must give the same state hash");
await page.fill("[data-testid=seed]", "42");
await page.click("[data-testid=reset]");
await page.selectOption("[data-testid=speed]", "4");
await wait(1200);
await playUntil(600);
const hashA = await hashState();
await caption(`Run A: tick 600 → hash ${hashA}`);
await wait(3000);
await screenshot("run-a");
await page.click("[data-testid=reset]");
await caption("Reset with seed 42 again — identical starting world", "Watch: identical motion to run A");
await wait(2000);
await playUntil(600);
const hashB = await hashState();
await caption(`Run B: tick 600 → hash ${hashB}  ${hashA === hashB ? "✔ identical to run A" : "✘ DIFFERENT"}`);
await wait(4000);
await screenshot("run-b");
if (hashA !== hashB) throw new Error("hash mismatch between run A and run B");
const golden = GOLDEN["seed=42,seconds=10"];
await caption(`Headless Bun golden for seed 42 @ tick 600: ${golden}  ${golden === hashB ? "✔ same as this browser" : "✘ differs"}`,
  "Viewer (Chrome/V8) and headless runner (Bun/JSC) share sim-core and deterministic math → identical hashes");
await wait(4500);
if (golden !== hashB) throw new Error("browser hash differs from headless golden");

await page.fill("[data-testid=seed]", "7");
await page.click("[data-testid=reset]");
await playUntil(600);
const hashC = await hashState();
if (hashC !== GOLDEN["seed=7,seconds=10"]) throw new Error("seed 7 differs from golden");
await caption(`Seed 7 for comparison: tick 600 → hash ${hashC} (matches headless golden)`, "Different seed ⇒ different formation jitter and script choices ⇒ different hash");
await wait(3500);

// 6. Manual control + verify
await page.fill("[data-testid=seed]", "42");
await page.click("[data-testid=reset]");
await page.selectOption("[data-testid=speed]", "1");
const p2 = await engine(() => window.__engine.sim.state.players.find((q) => q.id === "blue-5"));
await clickWorld(p2.x, p2.y);
await page.click("[data-testid=manual]");
await caption("Manual debug control: WASD/arrows move the selected player, Shift sprints", "Keyboard input becomes moveTo/stop commands on the same 10 Hz command stream");
await page.click("[data-testid=play]");
await page.keyboard.down("ShiftLeft");
await page.keyboard.down("KeyD");
await wait(1800);
await page.keyboard.up("KeyD");
await page.keyboard.down("KeyS");
await wait(1200);
await page.keyboard.up("KeyS");
await page.keyboard.up("ShiftLeft");
await page.keyboard.down("KeyA");
await wait(1500);
await page.keyboard.up("KeyA");
await wait(1000);
await page.click("[data-testid=play]");
await screenshot("manual");
await caption("Verify determinism: replay the recorded command stream from a fresh world, no script, no keyboard");
await wait(1500);
await page.click("[data-testid=verify]");
await wait(3500);
await screenshot("verify");
const verified = await page.locator("[data-testid=verify-result]").innerText();
if (!verified.includes("MATCH") || verified.includes("MISMATCH")) throw new Error(`verify failed: ${verified}`);

await caption("M1 complete: shared sim-core, deterministic hashes, visible physics, pause/step/reset", "Headless: bun run headless --seed 42 --verify · Tests: bun run test");
await wait(4000);

async function hashState() {
  return hash();
}

await context.close();
await browser.close();

const webm = readdirSync(rawDir).find((f) => f.endsWith(".webm"));
renameSync(join(rawDir, webm), join(outDir, "walkthrough.webm"));
rmSync(rawDir, { recursive: true, force: true });
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(outDir, "walkthrough.webm"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "slow", "-movflags", "+faststart", join(outDir, "walkthrough.mp4")]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "8", "-t", "14", "-i", join(outDir, "walkthrough.webm"), "-vf", "fps=10,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer", join(outDir, "preview.gif")]);
rmSync(join(outDir, "walkthrough.webm"));
log("done", { hashA, hashB, hashC, verified: verified.replace(/\s+/g, " ") });
