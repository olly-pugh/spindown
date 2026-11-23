// Rides ridden in Spindown World: what is saved about them, their name and the text sent with uploads.
//
// Only the course, the mode, a race's name and the rider's own place are kept. Other riders (bots, regulars,
// pacers) are never named here, so their names cannot reach the saved ride, the FIT file, Garmin or Strava.

export const PLAIN_DESCRIPTION = 'Indoor ride on a Kinetic Road Machine (inRide), recorded with Spindown.';

/** What a ride record keeps about its world (record.world), from the live simulation. */
export function worldRideInfo(sim, { workout = null } = {}) {
  const route = sim.route;
  const info = {
    world: route.world === 'york' ? 'york' : 'dales',
    course: String(route.name ?? route.title ?? ''),
    title: String(route.title ?? ''),
    mode: workout ? 'workout' : sim.mode === 'race' ? 'race' : 'free',
  };
  if (workout?.name) info.workout = String(workout.name);
  if (sim.mode === 'race' && sim.race?.preset) {
    info.race = String(sim.race.preset.name);
    const field = typeof sim.standings === 'function' ? sim.standings().length : sim.riders?.filter((r) => !r.isGhost).length;
    if (Number.isInteger(field) && field > 0) info.field = field;
    const place = sim.race.playerPlace;
    if (Number.isInteger(place) && place > 0) info.place = place;
  }
  return info;
}

export const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

function courseName(world) {
  const c = world.course || (world.world === 'york' ? 'York Inner Ring' : 'Malham Cove and Tarn');
  return /loop|ring|circuit/i.test(c) ? c : `${c} loop`;
}

/** e.g. "Spindown – Malham Cove and Tarn loop", "Spindown – York Grand Prix". */
export function worldRideName(world) {
  if (world.mode === 'race' && world.race) return `Spindown – ${world.race}`;
  if (world.mode === 'workout' && world.workout) return `Spindown – ${world.workout}, ${courseName(world)}`;
  return `Spindown – ${courseName(world)}`;
}

/** Name and description for Strava. A plain ride keeps its name and the usual description. */
export function uploadText(record) {
  const world = record.world;
  if (!world) return { name: record.name, description: PLAIN_DESCRIPTION };
  const place = world.world === 'york' ? 'York' : 'Malham, Yorkshire Dales';
  let what = `Virtual ride in Spindown World on the ${courseName(world)} (${place}), on real roads from OpenStreetMap.`;
  if (world.mode === 'race' && world.race) {
    what += world.place ? ` ${world.race}: finished ${ordinal(world.place)}${world.field ? ` of ${world.field}` : ''}.` : ` Rode the ${world.race}.`;
  } else if (world.mode === 'workout' && world.workout) {
    what += ` Workout: ${world.workout}.`;
  }
  return { name: record.name || worldRideName(world), description: `${what} Kinetic Road Machine (inRide) trainer, recorded with Spindown.` };
}
