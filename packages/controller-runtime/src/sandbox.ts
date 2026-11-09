/**
 * Sandboxed controller host.
 *
 * Each controller runs in its own QuickJS runtime compiled to WebAssembly, so it
 * has no access to the host: no network, filesystem, timers, process, DOM or
 * module loading, and no shared heap with the engine, the viewer or the other
 * team. Data crosses the boundary only as JSON strings.
 *
 * Determinism: QuickJS runs inside WASM (IEEE-754 math identical on every host),
 * `Math.random` is replaced with a PRNG seeded from the match seed and team, and
 * `Date` is removed. CPU limits are counted in QuickJS interrupt checks (a
 * deterministic operation budget), with a wall-clock cap only as a last-resort
 * safety net. Memory is capped per controller.
 *
 * Failures (exceptions, budget exhaustion, out-of-memory, invalid output) are
 * reported as structured diagnostics; that update contributes no actions
 * (players keep their current movement and the engine's restart fallback still
 * applies). After repeated failures, or a fatal one, the controller is disabled
 * and a built-in safe controller plays for that team for the rest of the match.
 */
import type { QuickJSContext, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten-core";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import type { CommandSource, DecisionContext } from "@autosoccer/controller-sdk";
import { buildMatchInfo, buildMatchResult, buildObservation, translateActions } from "@autosoccer/controller-sdk";
import type { EngineCommand, SimConfig, TeamId, WorldState } from "@autosoccer/sim-core";
import { DEFAULT_CONFIG } from "@autosoccer/sim-core";
import { createSafeController } from "./restarts.ts";

let modulePromise: Promise<QuickJSWASMModule> | null = null;
/** Load the QuickJS WASM module once (async); everything after is synchronous. */
export function loadSandbox(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  return modulePromise;
}

export interface SandboxLimits {
  /** Bytes of heap per controller. */
  memoryBytes: number;
  stackBytes: number;
  /** Interrupt checks allowed per call (≈3k simple loop iterations each). Deterministic. */
  opsInitialize: number;
  opsUpdate: number;
  opsMatchEnd: number;
  /** Hard wall-clock cap per call (ms), a non-deterministic last resort. */
  wallMs: number;
  /** Consecutive failed updates before the controller is disabled. */
  maxConsecutiveFailures: number;
  /** Max console lines captured per match. */
  maxLogLines: number;
  /** Max bytes of JSON accepted from one update. */
  maxOutputBytes: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  opsInitialize: 400,
  opsUpdate: 80,
  opsMatchEnd: 80,
  wallMs: 250,
  maxConsecutiveFailures: 3,
  maxLogLines: 200,
  maxOutputBytes: 64 * 1024,
};

export type DiagnosticKind = "error" | "timeout" | "out-of-memory" | "invalid-output" | "invalid-action" | "engine-rejected" | "disabled" | "log" | "lifecycle";

export interface ControllerDiagnostic {
  tick: number;
  team: TeamId;
  kind: DiagnosticKind;
  message: string;
  detail?: unknown;
}

/** What happened on the controller's most recent decision (for the inspector). */
export interface DecisionRecord {
  tick: number;
  /** Raw actions returned by the script (parsed JSON), or null on failure. */
  actions: unknown[] | null;
  commands: EngineCommand[];
  rejected: Array<{ action: unknown; reason: string }>;
  opsUsed: number;
  status: "ok" | "failed" | "fallback";
}

const BOOTSTRAP = `
"use strict";
(function () {
  // Deterministic PRNG (sfc32) replaces Math.random; seeded by the host.
  let a = 0, b = 0, c = 0, d = 0;
  globalThis.__seedRandom = function (s0, s1, s2, s3) { a = s0 >>> 0; b = s1 >>> 0; c = s2 >>> 0; d = s3 >>> 0; for (let i = 0; i < 12; i++) rnd(); };
  function rnd() {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0; a = (b ^ (b >>> 9)) >>> 0; b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0; c = (c + t) >>> 0;
    return t / 4294967296;
  }
  Math.random = rnd;
  // No wall-clock time inside controllers.
  delete globalThis.Date;
  const logs = [];
  const fmt = (args) => args.map((x) => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch (e) { return String(x); } }).join(" ");
  globalThis.console = { log: (...a) => logs.push(fmt(a)), warn: (...a) => logs.push("warn: " + fmt(a)), error: (...a) => logs.push("error: " + fmt(a)), info: (...a) => logs.push(fmt(a)) };
  globalThis.__drainLogs = () => { const out = JSON.stringify(logs.slice(0, 50)); logs.length = 0; return out; };
  let def = null;
  globalThis.defineController = function (d) {
    if (def) throw new Error("defineController called twice");
    if (!d || typeof d.update !== "function") throw new Error("defineController needs an object with an update(observation) function");
    def = d;
  };
  const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k in o) deepFreeze(o[k]); } return o; };
  globalThis.__call = function (method, json) {
    if (!def) throw new Error("no controller defined: call defineController({ update(obs) { ... } })");
    const fn = def[method];
    if (typeof fn !== "function") return "null";
    const arg = deepFreeze(JSON.parse(json));
    const out = fn.call(def, arg);
    return method === "update" ? JSON.stringify(out === undefined ? [] : out) : "null";
  };
  globalThis.__meta = () => JSON.stringify({ name: def && typeof def.name === "string" ? def.name : null, version: def && typeof def.version === "string" ? def.version : null });
})();
`;

export interface SandboxedControllerOptions {
  team: TeamId;
  source: string;
  /** Label for diagnostics (e.g. file name). */
  label?: string;
  config?: SimConfig;
  limits?: Partial<SandboxLimits>;
  /** Replacement when the controller is disabled. Defaults to the safe controller. */
  fallback?: CommandSource;
}

export class SandboxedController implements CommandSource {
  readonly team: TeamId;
  readonly label: string;
  name: string;
  version: string | null = null;
  readonly diagnostics: ControllerDiagnostic[] = [];
  last: DecisionRecord | null = null;
  disabled = false;
  failuresInARow = 0;
  totalOps = 0;
  updates = 0;
  private rt: QuickJSRuntime;
  private ctx: QuickJSContext;
  private ops = 0;
  private opsLimit = 0;
  private deadline = 0;
  private initialized = false;
  private ended = false;
  private logLines = 0;
  private readonly limits: SandboxLimits;
  private readonly cfg: SimConfig;
  private readonly fallback: CommandSource;
  private loadError: string | null = null;

  constructor(qjs: QuickJSWASMModule, opts: SandboxedControllerOptions) {
    this.team = opts.team;
    this.label = opts.label ?? `${opts.team} controller`;
    this.name = this.label;
    this.cfg = opts.config ?? DEFAULT_CONFIG;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.fallback = opts.fallback ?? createSafeController(opts.team, this.cfg);
    this.rt = qjs.newRuntime();
    this.rt.setMemoryLimit(this.limits.memoryBytes);
    this.rt.setMaxStackSize(this.limits.stackBytes);
    this.rt.setInterruptHandler(() => {
      this.ops++;
      return this.ops > this.opsLimit || performance.now() > this.deadline;
    });
    this.ctx = this.rt.newContext();
    this.evalOrFail(BOOTSTRAP, "bootstrap", this.limits.opsInitialize);
    if (this.loadError === null) this.evalOrFail(opts.source, this.label, this.limits.opsInitialize);
    if (this.loadError === null) {
      const meta = this.callRaw("__meta", [], this.limits.opsInitialize);
      if (meta.ok) {
        const m = JSON.parse(meta.value) as { name: string | null; version: string | null };
        if (m.name) this.name = m.name;
        this.version = m.version;
      }
    }
  }

  // ── low-level calls ──────────────────────────────────────────────────────

  private arm(opsLimit: number): void {
    this.ops = 0;
    this.opsLimit = opsLimit;
    this.deadline = performance.now() + this.limits.wallMs;
  }

  private classify(err: unknown): { kind: DiagnosticKind; message: string } {
    const e = err as { name?: string; message?: string };
    const msg = `${e?.name ?? "Error"}: ${e?.message ?? String(err)}`;
    if (e?.message === "interrupted") return { kind: "timeout", message: this.ops > this.opsLimit ? `exceeded CPU budget (${this.opsLimit} interrupt checks)` : `exceeded wall-clock cap (${this.limits.wallMs} ms)` };
    if (/out of memory/i.test(e?.message ?? "")) return { kind: "out-of-memory", message: `exceeded memory limit (${this.limits.memoryBytes} bytes)` };
    if (/stack overflow/i.test(e?.message ?? "")) return { kind: "error", message: "stack overflow" };
    return { kind: "error", message: msg };
  }

  private evalOrFail(code: string, filename: string, ops: number): void {
    this.arm(ops);
    const r = this.ctx.evalCode(code, filename);
    this.totalOps += this.ops;
    if (r.error) {
      const err = this.ctx.dump(r.error);
      r.error.dispose();
      const c = this.classify(err);
      this.loadError = `${c.kind}: ${c.message}`;
      this.diag(0, c.kind, `failed to load script: ${c.message}`, err);
      this.disable(0, "script failed to load");
    } else r.value.dispose();
  }

  private callRaw(fn: string, args: string[], ops: number): { ok: true; value: string } | { ok: false; kind: DiagnosticKind; message: string } {
    this.arm(ops);
    const fnHandle = this.ctx.getProp(this.ctx.global, fn);
    const argHandles = args.map((a) => this.ctx.newString(a));
    let result: { ok: true; value: string } | { ok: false; kind: DiagnosticKind; message: string };
    try {
      const r = this.ctx.callFunction(fnHandle, this.ctx.undefined, ...argHandles);
      if (r.error) {
        const err = this.ctx.dump(r.error);
        r.error.dispose();
        result = { ok: false, ...this.classify(err) };
      } else {
        const v = this.ctx.getString(r.value);
        r.value.dispose();
        result = { ok: true, value: v };
      }
    } catch (hostErr) {
      // Host-level failure (e.g. the runtime aborted on OOM while marshalling).
      result = { ok: false, ...this.classify(hostErr) };
    } finally {
      fnHandle.dispose();
      for (const h of argHandles) h.dispose();
    }
    this.totalOps += this.ops;
    return result;
  }

  private drainLogs(tick: number): void {
    const r = this.callRaw("__drainLogs", [], 20);
    if (!r.ok) return;
    for (const line of JSON.parse(r.value) as string[]) {
      if (this.logLines++ >= this.limits.maxLogLines) return;
      this.diag(tick, "log", line);
    }
  }

  private diag(tick: number, kind: DiagnosticKind, message: string, detail?: unknown): void {
    this.diagnostics.push({ tick, team: this.team, kind, message, detail });
  }

  private disable(tick: number, why: string): void {
    if (this.disabled) return;
    this.disabled = true;
    this.diag(tick, "disabled", `controller disabled (${why}); built-in safe controller takes over for ${this.team}`);
  }

  private fail(tick: number, kind: DiagnosticKind, message: string, fatal = false): void {
    this.diag(tick, kind, message);
    this.failuresInARow++;
    if (fatal || kind === "out-of-memory") this.disable(tick, kind);
    else if (this.failuresInARow >= this.limits.maxConsecutiveFailures) this.disable(tick, `${this.failuresInARow} consecutive failures`);
  }

  // ── CommandSource ────────────────────────────────────────────────────────

  decide(dc: DecisionContext): readonly EngineCommand[] {
    const { state, tick } = dc;
    const inPlay = state.match.period === "firstHalf" || state.match.period === "secondHalf";

    if (!this.disabled && !this.initialized) {
      this.initialized = true;
      const r = this.callRaw("__call", ["initialize", JSON.stringify(buildMatchInfo(state, this.team, this.cfg))], this.limits.opsInitialize);
      this.drainLogs(tick);
      if (!r.ok) this.fail(tick, r.kind, `initialize: ${r.message}`, true);
      else this.diag(tick, "lifecycle", "initialize ok");
    }

    if (this.disabled) {
      const cmds = this.fallback.decide(dc);
      this.last = { tick, actions: null, commands: [...cmds], rejected: [], opsUsed: 0, status: "fallback" };
      return cmds;
    }
    if (!inPlay) return [];

    for (const rj of dc.rejected ?? []) this.diag(rj.tick, "engine-rejected", rj.reason, rj.command);
    const obs = buildObservation(state, this.team, dc.events ?? [], dc.rejected ?? [], this.cfg);
    const r = this.callRaw("__call", ["update", JSON.stringify(obs)], this.limits.opsUpdate);
    this.updates++;
    const opsUsed = this.ops;
    this.drainLogs(tick);
    if (!r.ok) {
      this.fail(tick, r.kind, `update: ${r.message}`);
      this.last = { tick, actions: null, commands: [], rejected: [], opsUsed, status: "failed" };
      return this.disabled ? this.fallback.decide(dc) : [];
    }
    if (r.value.length > this.limits.maxOutputBytes) {
      this.fail(tick, "invalid-output", `update returned ${r.value.length} bytes (max ${this.limits.maxOutputBytes})`);
      this.last = { tick, actions: null, commands: [], rejected: [], opsUsed, status: "failed" };
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.value);
    } catch {
      this.fail(tick, "invalid-output", "update returned something that isn't JSON-serialisable");
      return [];
    }
    const t = translateActions(parsed, this.team, state);
    for (const rj of t.rejected) this.diag(tick, "invalid-action", rj.reason, rj.action);
    this.failuresInARow = 0;
    const actions = Array.isArray(parsed) ? parsed : ((parsed as { actions?: unknown[] })?.actions ?? []);
    this.last = { tick, actions, commands: t.commands, rejected: t.rejected, opsUsed, status: "ok" };
    return t.commands;
  }

  onMatchEnd(state: WorldState): void {
    if (this.ended) return;
    this.ended = true;
    if (this.disabled || !this.initialized) return;
    const r = this.callRaw("__call", ["onMatchEnd", JSON.stringify(buildMatchResult(state, this.team))], this.limits.opsMatchEnd);
    this.drainLogs(state.tick);
    if (!r.ok) this.diag(state.tick, r.kind, `onMatchEnd: ${r.message}`);
    else this.diag(state.tick, "lifecycle", "onMatchEnd ok");
  }

  dispose(): void {
    try {
      this.ctx.dispose();
      this.rt.dispose();
    } catch {
      /* runtime may already be unusable after an abort */
    }
  }

  /** Seed the in-sandbox Math.random from the match seed (called by the factory). */
  seedRandom(seed: number): void {
    const s = [seed ^ 0x9e3779b9, seed * 31 + (this.team === "blue" ? 1 : 2), 0x85ebca6b ^ (this.team === "blue" ? 0xb1 : 0x7e), 0xc2b2ae35];
    const fn = this.ctx.getProp(this.ctx.global, "__seedRandom");
    const hs = s.map((v) => this.ctx.newNumber(v >>> 0));
    const r = this.ctx.callFunction(fn, this.ctx.undefined, ...hs);
    if (r.error) r.error.dispose();
    else r.value.dispose();
    fn.dispose();
    for (const h of hs) h.dispose();
  }
}

/** Create a sandboxed controller for a team from script source. */
export async function createSandboxedController(opts: SandboxedControllerOptions & { seed: number }): Promise<SandboxedController> {
  const qjs = await loadSandbox();
  const c = new SandboxedController(qjs, opts);
  c.seedRandom(opts.seed);
  return c;
}
