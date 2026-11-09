/**
 * Deterministic math for the simulation.
 *
 * `Math.sin/cos/atan2/hypot/exp/pow` are NOT specified to be correctly rounded,
 * and V8 (Node/Chrome) and JavaScriptCore (Bun/Safari) return different last
 * bits — enough to make state hashes diverge across runtimes within seconds.
 * Everything here uses only + − × ÷ and Math.sqrt, which IEEE-754 requires to
 * be correctly rounded, so results are bit-identical on every conforming JS
 * engine. Accuracy is ~1e-9 or better, far below anything the game can see.
 *
 * Rule: sim-core and anything that produces commands must use these, never
 * the Math.* transcendental functions.
 */

export const PI = 3.141592653589793;
export const HALF_PI = PI / 2;
export const TWO_PI = PI * 2;
const SQRT3 = Math.sqrt(3);
const TAN_PI_12 = 2 - SQRT3; // tan(15°)

/** sqrt(x² + y²) without Math.hypot (whose rounding is engine-specific). */
export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Reduce to (-π, π]. Uses `%` (exact fmod) only. */
export function dwrap(a: number): number {
  let r = a % TWO_PI;
  if (r <= -PI) r += TWO_PI;
  else if (r > PI) r -= TWO_PI;
  return r;
}

/** sin on [-π/2, π/2] via odd Taylor series to x^15 (error < 1e-12). */
function sinCore(x: number): number {
  const x2 = x * x;
  return (
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 *
            (1 / 120 +
              x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000))))))))
  );
}

export function dsin(a: number): number {
  let x = dwrap(a);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  return sinCore(x);
}

export function dcos(a: number): number {
  return dsin(a + HALF_PI);
}

/** atan for |z| ≤ tan(15°) via odd Taylor series to z^19 (error < 1e-12). */
function atanSmall(z: number): number {
  const z2 = z * z;
  let s = 0;
  for (let k = 19; k >= 3; k -= 2) s = z2 * ((k % 4 === 1 ? 1 : -1) / k + s);
  return z * (1 + s);
}

function datanPos(z: number): number {
  // z ≥ 0
  let invert = false;
  if (z > 1) {
    z = 1 / z;
    invert = true;
  }
  let r: number;
  if (z > TAN_PI_12) {
    // atan(z) = π/6 + atan((z√3 − 1)/(z + √3))
    r = PI / 6 + atanSmall((z * SQRT3 - 1) / (z + SQRT3));
  } else {
    r = atanSmall(z);
  }
  return invert ? HALF_PI - r : r;
}

export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  if (x === 0) return y > 0 ? HALF_PI : -HALF_PI;
  const a = datanPos(Math.abs(y / x));
  if (x > 0) return y >= 0 ? a : -a;
  return y >= 0 ? PI - a : -(PI - a);
}
