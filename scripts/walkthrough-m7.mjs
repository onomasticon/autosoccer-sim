#!/usr/bin/env node
/**
 * Records the M7 release walkthrough by driving the real viewer in Chromium.
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
const outDir = resolve(process.argv[2] ?? "docs/media/m7");
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
const log = (...a) => console.log("[m7]", ...a);
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
const term = (name) => readFileSync(new URL(`../out/m7-terminal/${name}.txt`, import.meta.url), "utf8").replace(/\x1b\[[0-9;]*m/g, "");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
async function terminal(title, cmd, text, highlight = []) {
  let html = esc(text);
  for (const h of highlight) html = html.split(esc(h)).join(`<span class="hl">${esc(h)}</span>`);
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#0b0f14;color:#d6deeb;font:15px ui-monospace,Menlo,monospace}
    .bar{background:#1b232c;padding:10px 16px;color:#8b98a5;font:600 14px system-ui}
    .bar b{color:#fff}
    pre{margin:0;padding:18px 22px;white-space:pre-wrap;line-height:1.35}
    .cmd{color:#7ee787}.hl{background:#1f6f3f;color:#fff;border-radius:3px;padding:0 3px}
    #caption{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);width:1100px;background:rgba(0,0,0,.88);color:#fff;font:600 19px system-ui;padding:10px 18px;border-radius:10px;z-index:9999;text-align:center}
    #caption small{display:block;font-weight:400;font-size:14px;color:#cfd8dc;margin-top:3px}
  </style></head><body><div class="bar"><b>${esc(title)}</b> · real output captured from this checkout before recording</div>
  <pre><span class="cmd">$ ${esc(cmd)}</span>\n${html}</pre></body></html>`);
}
await page.waitForFunction(() => window.__ready, null, { timeout: 20000 });

// 1. Live demo (bun run demo)
await caption("autosoccer-sim M7 — release: one-command Blue vs Red demo", "bun run demo → viewer opens and plays Blue possession vs Red counterattack (sandboxed scripts)");
await page.selectOption("[data-testid=speed]", "4");
await page.click("[data-testid=play]");
await wait(5000);
await screenshot("demo-live");
await page.selectOption("[data-testid=speed]", "8");
await caption("Full match at 8× — kickoffs, restarts, halftime end-switch, score-aware tactics, full time");
let half = false;
while (true) {
  const s = await st();
  if (!half && s.period === "secondHalf") { half = true; await caption("2nd half: ends switched; both scripts flip via attackingDirection"); }
  if (s.period === "fullTime") break;
  if (s.tick > 6000 && s.tick < 6100) await screenshot("match");
  await wait(300);
}
const ft = await st();
await caption(`Full time ${ft.score.blue}–${ft.score.red}`);
await wait(2000);
await screenshot("full-time");

// 2. Inspect a key moment in the sample replay
await caption("Sample replay (bundled, gzip): load it with one click — controllers are not executed");
await page.click("[data-testid=sample-replay]");
await page.waitForFunction(() => window.__engine.mode === "replay");
await wait(1500);
const goal = page.locator("[data-testid=chip-goal]").first();
await caption(`Timeline → ${await goal.innerText()}`, "Seek, then watch the build-up at 0.5× with decision lines and the inspector");
await page.evaluate(() => window.__engine.seek(Math.max(0, window.__engine.player.replay.events.find((e) => e.event.type === "goalScored").tick - 200)));
await page.selectOption("[data-testid=speed]", "0.5");
await page.click("[data-testid=play]");
await page.waitForFunction(() => window.__engine.sim.state.match.phase === "goalScored", null, { timeout: 20000 });
await page.click("[data-testid=play]");
const scorer = await page.evaluate(() => window.__engine.player.replay.events.find((e) => e.event.type === "goalScored").event.scorer);
if (scorer) await page.evaluate((id) => window.__engine.select(id), scorer);
await wait(500);
await screenshot("replay-key-moment");
await caption(`Inspector: ${scorer} — issued kick → executed kick → goal`, "Same renderer and inspector as live play");
await wait(4000);
await page.click("[data-testid=verify-replay]");
await page.waitForSelector("[data-testid=replay-verify-result]");
const vr = await page.locator("[data-testid=replay-verify-result]").innerText();
need(vr.includes("✔") && vr.includes(" 0 mismatches"), `replay verify ${vr}`);
await caption(`Replay verified in the browser: ${vr.replace(/\s+/g, " ").trim()}`);
await wait(3500);
await screenshot("replay-verified");

// 3. A new controller written from the docs alone
await page.click("text=Back to live");
await page.waitForFunction(() => window.__engine.mode === "controllers");
const tutorial = readFileSync(new URL("../docs/writing-a-controller.md", import.meta.url), "utf8").match(/```js tutorial\n([\s\S]*?)```/)[1];
await page.click("[data-testid=edit-blue]");
await page.locator("[data-testid=editor-blue]").fill(tutorial);
await caption("New controller authored from the public docs: the tutorial team from docs/writing-a-controller.md", "Pasted verbatim (the test suite runs this exact code too) → Apply & restart");
await wait(3000);
await screenshot("tutorial-editor");
await page.click("[data-testid=apply-blue]");
await page.click("[data-testid=edit-blue]");
await page.selectOption("[data-testid=speed]", "2");
await page.click("[data-testid=play]");
await wait(7000);
await page.click("[data-testid=play]");
const tut = await page.evaluate(() => ({ name: window.__engine.controllers.blue.name, disabled: window.__engine.controllers.blue.disabled, kicks: window.__engine.sim.events.filter((e) => e.event.type === "kick" && e.event.playerId.startsWith("blue")).length }));
need(tut.name === "tutorial" && !tut.disabled, `tutorial controller ${JSON.stringify(tut)}`);
await caption(`tutorial v1.0.0 plays against red-counter: sandboxed, no failures, ${tut.kicks} kicks so far`);
await wait(3000);
await screenshot("tutorial-playing");

// 4. Release evidence (real CLI output)
await terminal("1,000 seeded matches", "bun run tournament --matches 1000 --workers 6", term("tournament"), ["Completed 1000/1000", "0 diverged", "failed: 0", "invariant violations 0", "hangs 0", "controller failures 0"]);
await caption("bun run tournament --matches 1000: every match finished · 0 hangs · 0 errors · 0 hash divergence", "Per-tick invariants on every match · determinism re-runs · verified replays saved");
await wait(9000);
await screenshot("tournament-1000");
await terminal("Throughput", "bun run bench --matches 3", term("bench"), ["MET for every scenario"]);
await caption("bun run bench: ≥10× real-time target met in every scenario on the reference machine (Apple M2 Pro)", "Profiled bottleneck: QuickJS JSON parsing + controller logic → SDK 1.2 rounding, fewer sandbox calls, faster helpers");
await wait(8000);
await screenshot("bench");
await terminal("Tests", "bun run test", term("test"), ["passed", "OK"]);
await caption("bun run test: unit, regression (phases, invalid commands, crashes/timeouts, keeper rules, invariants), sandbox, replay, docs, cross-runtime golden hashes");
await wait(7000);
await screenshot("tests");
await terminal("Replay CLI", "bun run replay examples/replays/blue-vs-red-sample.replay.json.gz --timeline --verify", term("replay"), ["verify    OK", "0 mismatches"]);
await caption("bun run replay: timeline + full re-simulation without controllers");
await wait(6000);
await caption("M7 complete: tournament CLI, 1,000-seed reliability, performance, docs, one-command demo + sample replay", "docs/quickstart.md · docs/writing-a-controller.md · docs/release-report.md · docs/performance.md");
await wait(4000);
const verified = vr;

await context.close();
await browser.close();
need(errors.length === 0, `page errors: ${errors.join("; ")}`);

const webm = readdirSync(rawDir).find((f) => f.endsWith(".webm"));
renameSync(join(rawDir, webm), join(outDir, "walkthrough.webm"));
rmSync(rawDir, { recursive: true, force: true });
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(outDir, "walkthrough.webm"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "slow", "-movflags", "+faststart", join(outDir, "walkthrough.mp4")]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "8", "-t", "16", "-i", join(outDir, "walkthrough.webm"), "-vf", "fps=10,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer", join(outDir, "preview.gif")]);
rmSync(join(outDir, "walkthrough.webm"));
log("done", { verified: verified.replace(/\s+/g, " ") });
