/**
 * Simulation configuration. All distances are metres, times are seconds,
 * speeds are m/s and accelerations m/s². Origin is the pitch centre; +x points
 * toward the red goal (right side of the viewer at kickoff), +y points down.
 */
export interface PitchConfig {
  /** Touchline length (goal line to goal line). */
  length: number;
  /** Goal line length (touchline to touchline). */
  width: number;
  /** Goal mouth width, centred on the goal line. */
  goalWidth: number;
  /** Depth of the goal net behind the goal line (visual + future rules). */
  goalDepth: number;
  /** Penalty (keeper) area depth from the goal line. */
  penaltyAreaDepth: number;
  /** Penalty (keeper) area width. */
  penaltyAreaWidth: number;
  centreCircleRadius: number;
  /** Free run-off area around the pitch that players may occupy. */
  runOff: number;
}

export interface PlayerPhysicsConfig {
  radius: number;
  mass: number;
  /** Top speed while jogging. */
  maxSpeed: number;
  /** Top speed while sprinting with stamina available. */
  sprintSpeed: number;
  /** Maximum change of velocity magnitude per second. */
  acceleration: number;
  /** Braking deceleration when stopping or overspeeding. */
  deceleration: number;
  /** Maximum turn rate (rad/s) at standstill. */
  turnRate: number;
  /** Turn rate at top sprint speed (interpolated by speed). */
  turnRateAtSprint: number;
  /** Stamina is in [0, 1]. Drain per second while sprinting. */
  staminaDrain: number;
  /** Recovery per second when not sprinting. */
  staminaRecovery: number;
  /** Minimum stamina needed to start sprinting. */
  sprintThreshold: number;
  /** Distance within which a moveTo target counts as reached. */
  arriveRadius: number;
}

export interface BallPhysicsConfig {
  radius: number;
  mass: number;
  /** Constant rolling resistance deceleration (m/s²). */
  rollingFriction: number;
  /** Velocity-proportional drag (1/s). */
  linearDrag: number;
  /** Speeds below this snap to zero. */
  stopSpeed: number;
  /** Restitution against pitch boundary walls. */
  wallRestitution: number;
  /** Restitution of ball-player contacts. */
  playerRestitution: number;
}

/** Ball-action rules (M2). Distances are measured centre-to-centre. */
export interface ActionConfig {
  /** Max player→ball distance for a kick / dribble touch / trap. */
  kickRange: number;
  /** Kicks must be within this angle (rad) of the player's heading. */
  kickMaxAngle: number;
  minKickSpeed: number;
  maxKickSpeed: number;
  /** Std-dev-like max angular error (rad) at full power and zero stamina. */
  kickErrorMax: number;
  /** Ticks before the same player can touch the ball again after a kick. */
  kickCooldownTicks: number;
  /** Dribble touches: distance window and resulting ball speed above player speed. */
  dribbleRange: number;
  dribbleTouchBoost: number;
  dribbleCooldownTicks: number;
  /** Incoming balls faster than this (relative) can't be trapped. */
  trapMaxSpeed: number;
  /** Relative speed above which a ball counts as "incoming" for trapping. */
  trapMinSpeed: number;
  trapCooldownTicks: number;
  tackleReach: number;
  tackleCooldownTicks: number;
  /** Ticks a player is grounded after a failed tackle. */
  tackleFailStunTicks: number;
  tackleKnockSpeed: number;
  catchReach: number;
  catchMaxSpeed: number;
  catchCooldownTicks: number;
  /** Keeper must release within this many ticks or the ball is dropped. */
  maxHoldTicks: number;
  maxReleaseSpeed: number;
}

export interface SimConfig {
  /** Physics steps per second (fixed). */
  tickRate: number;
  /** Controller decisions per second. Must divide tickRate. */
  controllerRate: number;
  halfDurationSec: number;
  halves: number;
  playersPerTeam: number;
  pitch: PitchConfig;
  player: PlayerPhysicsConfig;
  ball: BallPhysicsConfig;
  action: ActionConfig;
  /** Max random offset (m) applied to kickoff formation positions from the seed. */
  formationJitter: number;
}

export const DEFAULT_CONFIG: SimConfig = Object.freeze({
  tickRate: 60,
  controllerRate: 10,
  halfDurationSec: 120,
  halves: 2,
  playersPerTeam: 5,
  pitch: Object.freeze({
    length: 50,
    width: 32,
    goalWidth: 4,
    goalDepth: 1.2,
    penaltyAreaDepth: 6,
    penaltyAreaWidth: 14,
    centreCircleRadius: 4,
    runOff: 2,
  }),
  player: Object.freeze({
    radius: 0.4,
    mass: 75,
    maxSpeed: 6,
    sprintSpeed: 8.5,
    acceleration: 7,
    deceleration: 10,
    turnRate: 10,
    turnRateAtSprint: 3.5,
    staminaDrain: 0.12,
    staminaRecovery: 0.05,
    sprintThreshold: 0.15,
    arriveRadius: 0.25,
  }),
  ball: Object.freeze({
    radius: 0.11,
    mass: 0.43,
    rollingFriction: 0.9,
    linearDrag: 0.25,
    stopSpeed: 0.05,
    wallRestitution: 0.6,
    playerRestitution: 0.55,
  }),
  action: Object.freeze({
    kickRange: 0.85,
    kickMaxAngle: (110 * Math.PI) / 180,
    minKickSpeed: 4,
    maxKickSpeed: 26,
    kickErrorMax: 0.12,
    kickCooldownTicks: 12,
    dribbleRange: 0.9,
    dribbleTouchBoost: 0.9,
    dribbleCooldownTicks: 10,
    trapMaxSpeed: 22,
    trapMinSpeed: 1.5,
    trapCooldownTicks: 10,
    tackleReach: 1.3,
    tackleCooldownTicks: 45,
    tackleFailStunTicks: 36,
    tackleKnockSpeed: 7,
    catchReach: 1.4,
    catchMaxSpeed: 28,
    catchCooldownTicks: 30,
    maxHoldTicks: 360,
    maxReleaseSpeed: 22,
  }),
  formationJitter: 0.6,
}) as SimConfig;

export type ConfigOverrides = {
  [K in keyof SimConfig]?: SimConfig[K] extends object ? Partial<SimConfig[K]> : SimConfig[K];
};

export function makeConfig(overrides: ConfigOverrides = {}): SimConfig {
  const cfg: SimConfig = {
    ...DEFAULT_CONFIG,
    ...(overrides as Partial<SimConfig>),
    pitch: { ...DEFAULT_CONFIG.pitch, ...overrides.pitch },
    player: { ...DEFAULT_CONFIG.player, ...overrides.player },
    ball: { ...DEFAULT_CONFIG.ball, ...overrides.ball },
    action: { ...DEFAULT_CONFIG.action, ...overrides.action },
  };
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: SimConfig): void {
  if (!Number.isInteger(cfg.tickRate) || cfg.tickRate <= 0) throw new Error("tickRate must be a positive integer");
  if (!Number.isInteger(cfg.controllerRate) || cfg.controllerRate <= 0) throw new Error("controllerRate must be a positive integer");
  if (cfg.tickRate % cfg.controllerRate !== 0) throw new Error("controllerRate must divide tickRate");
  if (cfg.playersPerTeam !== 5) throw new Error("Only 5v5 is supported");
  if (cfg.halfDurationSec <= 0 || cfg.halves <= 0) throw new Error("match duration must be positive");
}

/** Physics ticks between controller decisions (6 at 60 Hz / 10 Hz). */
export function ticksPerDecision(cfg: SimConfig): number {
  return cfg.tickRate / cfg.controllerRate;
}
