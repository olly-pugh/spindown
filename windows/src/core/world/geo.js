// Real-world positions for the game's courses.
//
// The map builders (scripts/build-dales.mjs, build-york.mjs, build-york-*.mjs, dales-lidar1m.mjs) project
// OpenStreetMap and terrain data onto local metres with the same simple equirectangular projection about each
// world's origin (data.origin):
//     x = (lon − lon0) · cos(lat0) · 111320        (metres east)
//     y = (lat − lat0) · 110540                     (metres north)
// and the game flips y into three.js world space as z = −y (see yorkWorldPoints in worlds.js and W() in the
// renderer's dales.js / york.js). These are the exact inverse, so a recorded track lies on the real roads.

export const METRES_PER_DEG_LAT = 110540;
export const METRES_PER_DEG_LON_EQUATOR = 111320;

const metresPerDegLon = (origin) => Math.cos((origin.lat * Math.PI) / 180) * METRES_PER_DEG_LON_EQUATOR;

/** World x (east) / z (south) metres to {lat, lon} degrees. */
export function worldToLatLon(origin, x, z) {
  return { lat: origin.lat + -z / METRES_PER_DEG_LAT, lon: origin.lon + x / metresPerDegLon(origin) };
}

/** {lat, lon} degrees to world {x (east), z (south)} metres: the projection the map builders used. */
export function latLonToWorld(origin, lat, lon) {
  return { x: (lon - origin.lon) * metresPerDegLon(origin), z: -(lat - origin.lat) * METRES_PER_DEG_LAT };
}

/**
 * The rider's real position on a course: {lat, lon, alt}, from distance d along the route and the lateral
 * offset from the centreline. Altitude is the route's road height (metres above sea level in the Dales; York's
 * gentle LIDAR relief on the game's 12 m street level).
 */
export function routeLatLon(route, origin, d, lateral = 0) {
  const p = route.position(d, lateral);
  const { lat, lon } = worldToLatLon(origin, p.x, p.z);
  return { lat, lon, alt: p.y };
}
