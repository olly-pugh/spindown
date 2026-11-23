// Cycling physics for Spindown World: how fast a rider goes for a given power on a given road.
// Standard road-cycling model: P·η = v·(m·g·sinθ + m·g·cosθ·Crr + ½·ρ·CdA·(1−draft)·v²) + m_eff·a·v.
// Pure functions, unit tested; the renderer only draws the result.

export const G = 9.80665;
export const AIR_DENSITY = 1.225; // kg/m³ at sea level, 15 °C
export const DRIVETRAIN_EFFICIENCY = 0.975;
export const WHEEL_INERTIA_MASS = 1.4; // kg: rotating wheels feel heavier when accelerating
export const MAX_SPEED = 120 / 3.6;

/** Default rider: 75 kg, road bike on the hoods. */
export const DEFAULT_RIDER = { mass: 75, cda: 0.32, crr: 0.0045 };

/**
 * Effective parameters for a rider on a bike with wheels and any active power-up effects.
 * bike: {mass, cda (multiplier), crr (multiplier)}; wheels: {mass, cda (multiplier)}; effects: {cda, mass, power, draft} multipliers/offsets.
 */
export function riderParams({ riderMass = DEFAULT_RIDER.mass, bike = null, wheels = null, effects = null, surface = 'asphalt' } = {}) {
  const bikeMass = (bike?.mass ?? 8.5) + (wheels?.mass ?? 1.8);
  // Bigger riders punch a bigger hole in the air: frontal area grows roughly with mass^0.6.
  let cda = DEFAULT_RIDER.cda * (riderMass / DEFAULT_RIDER.mass) ** 0.6 * (bike?.cda ?? 1) * (wheels?.cda ?? 1);
  let crr = DEFAULT_RIDER.crr * (bike?.crr ?? 1) * (surface === 'cobbles' ? 2.2 * (bike?.cobbles ?? 1) : surface === 'gravel' ? 1.6 : 1);
  let mass = riderMass + bikeMass;
  let powerFactor = 1;
  let draftFactor = 1;
  if (effects) {
    cda *= effects.cda ?? 1;
    mass += effects.mass ?? 0;
    powerFactor *= effects.power ?? 1;
    draftFactor *= effects.draft ?? 1;
  }
  return { mass: Math.max(40, mass), cda, crr, powerFactor, draftFactor };
}

/** Resistive force (N) at speed v (m/s) on a gradient (rise/run). */
export function resistance(v, gradient, p, draft = 0) {
  const theta = Math.atan(gradient);
  const gravity = p.mass * G * Math.sin(theta);
  const rolling = p.mass * G * Math.cos(theta) * p.crr * (v > 0.05 ? 1 : 0);
  const aero = 0.5 * AIR_DENSITY * p.cda * (1 - draft) * v * Math.abs(v);
  return gravity + rolling + aero;
}

/**
 * Advances speed by dt seconds. power in watts, gradient as rise/run, draft 0..0.5 (fractional drag saving).
 * Returns the new speed (m/s), never negative (riders do not roll backwards).
 */
export function stepSpeed(v, power, gradient, dt, p, draft = 0) {
  const steps = Math.max(1, Math.ceil(dt / 0.05));
  const h = dt / steps;
  const mEff = p.mass + WHEEL_INERTIA_MASS;
  for (let i = 0; i < steps; i++) {
    // Force is power over speed, held finite near a standstill (0.4 m/s: enough to get going up a 20% lane).
    const drive = (Math.max(0, power) * DRIVETRAIN_EFFICIENCY * (p.powerFactor ?? 1)) / Math.max(v, 0.4);
    const a = (drive - resistance(v, gradient, p, draft)) / mEff;
    v = Math.min(MAX_SPEED, Math.max(0, v + a * h));
  }
  return v;
}

/** Steady-state speed (m/s) for a power on a gradient, by bisection. */
export function steadySpeed(power, gradient, p, draft = 0) {
  let lo = 0, hi = MAX_SPEED;
  const net = (v) => power * DRIVETRAIN_EFFICIENCY * (p.powerFactor ?? 1) - v * resistance(v, gradient, p, draft);
  if (net(0.01) <= 0) return 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (net(mid) > 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Power (W) needed to hold speed v (m/s) on a gradient. */
export function powerForSpeed(v, gradient, p, draft = 0) {
  return Math.max(0, (v * resistance(v, gradient, p, draft)) / (DRIVETRAIN_EFFICIENCY * (p.powerFactor ?? 1)));
}

/**
 * Drafting saving behind another rider: `gap` is metres from the rider ahead's rear wheel to your front wheel,
 * `lateral` metres of sideways offset. Up to ~33% straight behind at 0.5 m,
 * fading to nothing by 12 m or 1.2 m to the side. Deeper in a bunch saves a little more.
 */
export function draftFraction(gap, lateral, ridersAhead = 1) {
  if (gap < 0 || gap > 12) return 0;
  const along = gap <= 0.6 ? 1 : Math.max(0, 1 - (gap - 0.6) / 11.4) ** 1.4;
  const side = Math.max(0, 1 - (Math.abs(lateral) / 1.2) ** 2);
  const bunch = Math.min(1.25, 1 + 0.08 * Math.max(0, ridersAhead - 1));
  return Math.min(0.45, 0.33 * along * side * bunch);
}

/** Cadence a rider would pedal at, for animating bots: ~92 rpm on the flat, lower uphill, 0 when coasting. */
export function cadenceFor(power, gradient) {
  if (power < 15) return 0;
  return Math.max(60, Math.min(105, 92 - gradient * 250 + (power > 400 ? 6 : 0)));
}
