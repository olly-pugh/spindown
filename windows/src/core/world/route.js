// A closed-loop course: a smoothed centreline with elevation, sampled by distance along it.
// World coordinates: x east, z south (three.js convention, so north is −z), y up, all in metres.

export class Route {
  /**
   * points: flat [x, z, x, z, ...] closed loop (last point need not repeat the first).
   * elevation(d, x, z) -> metres. step: resampling interval.
   */
  constructor({ id, name, points, elevation = () => 0, step = 2, surface = null }) {
    this.id = id;
    this.name = name;
    this.surfaceAt = surface ?? (() => 'asphalt');
    // Cumulative distance along the raw polyline.
    const n = points.length / 2;
    const raw = [];
    let total = 0;
    for (let i = 0; i <= n; i++) {
      const x = points[(i % n) * 2], z = points[(i % n) * 2 + 1];
      if (i > 0) {
        const px = raw[raw.length - 1].x, pz = raw[raw.length - 1].z;
        total += Math.hypot(x - px, z - pz);
      }
      raw.push({ x, z, d: total });
    }
    this.length = total;
    const count = Math.max(8, Math.round(total / step));
    this.step = total / count;
    this.count = count;
    this.xs = new Float64Array(count + 1);
    this.zs = new Float64Array(count + 1);
    this.ys = new Float64Array(count + 1);
    let j = 0;
    for (let i = 0; i <= count; i++) {
      const d = i * this.step;
      while (j < raw.length - 2 && raw[j + 1].d < d) j++;
      const a = raw[j], b = raw[j + 1];
      const f = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
      this.xs[i] = a.x + (b.x - a.x) * f;
      this.zs[i] = a.z + (b.z - a.z) * f;
    }
    for (let i = 0; i <= count; i++) this.ys[i] = elevation(i * this.step, this.xs[i], this.zs[i]);
    // Smooth the elevation so gradients are rideable and continuous (moving average over ~40 m, twice).
    for (let pass = 0; pass < 2; pass++) {
      const w = Math.max(1, Math.round(20 / this.step));
      const src = Float64Array.from(this.ys);
      for (let i = 0; i <= count; i++) {
        let s = 0;
        for (let k = -w; k <= w; k++) s += src[(((i + k) % count) + count) % count];
        this.ys[i] = s / (2 * w + 1);
      }
      this.ys[count] = this.ys[0];
    }
    this.minY = Math.min(...this.ys);
    this.maxY = Math.max(...this.ys);
    let climb = 0;
    for (let i = 1; i <= count; i++) climb += Math.max(0, this.ys[i] - this.ys[i - 1]);
    this.climb = climb;
  }

  wrap(d) {
    const L = this.length;
    return ((d % L) + L) % L;
  }

  /** Interpolated index for a distance. */
  index(d) {
    const t = this.wrap(d) / this.step;
    const i = Math.min(this.count - 1, Math.floor(t));
    return [i, t - i];
  }

  /** Position on the centreline, or `lateral` metres to the right of it (facing the direction of travel). */
  position(d, lateral = 0, out = {}) {
    const [i, f] = this.index(d);
    const x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * f;
    const z = this.zs[i] + (this.zs[i + 1] - this.zs[i]) * f;
    const y = this.ys[i] + (this.ys[i + 1] - this.ys[i]) * f;
    const h = this.heading(d);
    // Heading h: direction of travel as an angle, dx = sin h, dz = −cos h. Right-hand normal: (cos h, sin h).
    out.x = x + Math.cos(h) * lateral;
    out.z = z + Math.sin(h) * lateral;
    out.y = y;
    out.heading = h;
    return out;
  }

  /** Direction of travel at d, smoothed over ±6 m: angle such that forward = (sin h, −cos h). */
  heading(d) {
    const a = this.rawPoint(d - 6), b = this.rawPoint(d + 6);
    return Math.atan2(b.x - a.x, -(b.z - a.z));
  }

  rawPoint(d) {
    const [i, f] = this.index(d);
    return { x: this.xs[i] + (this.xs[i + 1] - this.xs[i]) * f, z: this.zs[i] + (this.zs[i + 1] - this.zs[i]) * f };
  }

  elevation(d) {
    const [i, f] = this.index(d);
    return this.ys[i] + (this.ys[i + 1] - this.ys[i]) * f;
  }

  /** Gradient (rise/run) at d, over a 20 m window. */
  gradient(d) {
    return (this.elevation(d + 10) - this.elevation(d - 10)) / 20;
  }

  /** Signed curvature (1/m) at d: positive turning right. Used for leaning into corners. */
  curvature(d) {
    let dh = this.heading(d + 8) - this.heading(d - 8);
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    return dh / 16;
  }

  surface(d) {
    return this.surfaceAt(this.wrap(d));
  }

  /** Bounding box of the centreline. */
  bounds() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i <= this.count; i++) {
      minX = Math.min(minX, this.xs[i]);
      maxX = Math.max(maxX, this.xs[i]);
      minZ = Math.min(minZ, this.zs[i]);
      maxZ = Math.max(maxZ, this.zs[i]);
    }
    return { minX, maxX, minZ, maxZ };
  }

  /** Distance from (x, z) to the centreline and the route distance of the nearest point (coarse + refine). */
  nearest(x, z) {
    let best = Infinity, bi = 0;
    const stride = 4;
    for (let i = 0; i < this.count; i += stride) {
      const dd = (this.xs[i] - x) ** 2 + (this.zs[i] - z) ** 2;
      if (dd < best) {
        best = dd;
        bi = i;
      }
    }
    for (let i = bi - stride; i <= bi + stride; i++) {
      const k = ((i % this.count) + this.count) % this.count;
      const dd = (this.xs[k] - x) ** 2 + (this.zs[k] - z) ** 2;
      if (dd < best) {
        best = dd;
        bi = k;
      }
    }
    return { distance: Math.sqrt(best), along: bi * this.step };
  }
}

/**
 * A spatial index of the route centreline for fast "how far from the road" queries when placing scenery.
 */
export class RouteGrid {
  constructor(route, cell = 40) {
    this.route = route;
    this.cell = cell;
    this.map = new Map();
    for (let i = 0; i < route.count; i++) {
      const key = this.key(Math.floor(route.xs[i] / cell), Math.floor(route.zs[i] / cell));
      let list = this.map.get(key);
      if (!list) this.map.set(key, (list = []));
      list.push(i);
    }
  }

  key(cx, cz) {
    return cx * 100003 + cz;
  }

  /** Distance to the nearest centreline point within `radius` (Infinity if none) and its route distance. */
  query(x, z, radius = 80) {
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let best = Infinity, bi = -1;
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const list = this.map.get(this.key(cx + i, cz + j));
        if (!list) continue;
        for (const k of list) {
          const dd = (this.route.xs[k] - x) ** 2 + (this.route.zs[k] - z) ** 2;
          if (dd < best) {
            best = dd;
            bi = k;
          }
        }
      }
    }
    return { distance: Math.sqrt(best), along: bi < 0 ? 0 : bi * this.route.step, index: bi };
  }
}
