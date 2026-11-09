import apiProbe from "../../../examples/controllers/api-probe.js?raw";
import bluePossession from "../../../examples/controllers/blue-possession.js?raw";
import random from "../../../examples/controllers/random.js?raw";
import redCounter from "../../../examples/controllers/red-counter.js?raw";
import badInit from "../../../examples/controllers/adversarial/bad-init.js?raw";
import crashes from "../../../examples/controllers/adversarial/crashes.js?raw";
import escape from "../../../examples/controllers/adversarial/escape.js?raw";
import infiniteLoop from "../../../examples/controllers/adversarial/infinite-loop.js?raw";
import invalidActions from "../../../examples/controllers/adversarial/invalid-actions.js?raw";
import memoryHog from "../../../examples/controllers/adversarial/memory-hog.js?raw";
import chaser from "../../../examples/controllers/chaser.js?raw";
import dumb from "../../../examples/controllers/dumb.js?raw";
import zonal from "../../../examples/controllers/zonal.js?raw";

/** Example controller scripts bundled into the viewer (same files the CLI/tests use). */
export const PRESETS: Record<string, string> = {
  "blue-possession.js": bluePossession,
  "red-counter.js": redCounter,
  "chaser.js": chaser,
  "zonal.js": zonal,
  "dumb.js": dumb,
  "api-probe.js": apiProbe,
  "random.js": random,
  "adversarial/invalid-actions.js": invalidActions,
  "adversarial/crashes.js": crashes,
  "adversarial/infinite-loop.js": infiniteLoop,
  "adversarial/memory-hog.js": memoryHog,
  "adversarial/bad-init.js": badInit,
  "adversarial/escape.js": escape,
};
