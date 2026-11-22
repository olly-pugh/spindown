// Shared fetch helpers for the Dales map build (scripts/build-dales.mjs): OpenStreetMap through the Overpass
// API and Mapzen/AWS Terrarium elevation tiles, both cached under scripts/dales-cache/ (git-ignored).
//
// Terrain: Mapzen Terrain Tiles on AWS (Terrarium encoding: metres = R*256 + G + B/256 - 32768), public data
// (https://registry.opendata.aws/terrain-tiles/; a blend of SRTM, GMTED, ETOPO1 and regional national datasets).
// Map data © OpenStreetMap contributors, ODbL.
// Aerial imagery: Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data
// 2016), CC BY 4.0 (https://s2maps.eu). Only the 2016 layer (s2cloudless_3857) is CC BY; later years are NC-SA.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const USER_AGENT = 'spindown-map-build/1.0';
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Environment Agency LIDAR ---------------------------------------------------------------------
// LIDAR Composite DTM 1 m (bare earth) for England, Open Government Licence v3.0:
// © Environment Agency copyright and/or database right. Fetched through the EA's open WCS in WGS84 lat/lon,
// resampled by the server to the requested pixel size, as uncompressed float32 TIFFs.
const LIDAR_WCS = 'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs';
const LIDAR_COVERAGE = '13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m';

/** Minimal TIFF reader for the WCS output: one band of float32, strips or tiles, no compression. */
export function readFloatTiff(buf) {
  const le = buf.toString('ascii', 0, 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f32 = (o) => (le ? buf.readFloatLE(o) : buf.readFloatBE(o));
  const ifd = u32(4);
  const tags = {};
  const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < u16(ifd); i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    if (![256, 257, 259, 273, 278, 322, 323, 324, 339, 258].includes(tag)) continue;
    const off = size[type] * count <= 4 ? e + 8 : u32(e + 8);
    const vals = [];
    for (let k = 0; k < count; k++) vals.push(type === 3 ? u16(off + k * 2) : u32(off + k * 4));
    tags[tag] = vals;
  }
  const w = tags[256][0], h = tags[257][0];
  if ((tags[259]?.[0] ?? 1) !== 1 || tags[258]?.[0] !== 32 || tags[339]?.[0] !== 3) throw new Error('unsupported TIFF (want uncompressed float32)');
  const data = new Float32Array(w * h);
  if (tags[324]) {
    const tw = tags[322][0], th = tags[323][0], across = Math.ceil(w / tw);
    tags[324].forEach((off, t) => {
      const tx = (t % across) * tw, ty = Math.floor(t / across) * th;
      for (let y = 0; y < th && ty + y < h; y++) for (let x = 0; x < tw && tx + x < w; x++) data[(ty + y) * w + tx + x] = f32(off + (y * tw + x) * 4);
    });
  } else {
    const rps = tags[278]?.[0] ?? h;
    let k = 0;
    tags[273].forEach((off, s) => {
      const n = Math.min(rps, h - s * rps) * w;
      for (let i = 0; i < n; i++) data[k++] = f32(off + i * 4);
    });
  }
  return { w, h, data };
}

/**
 * LIDAR heights over a lat/lon box at about `metres` per pixel, fetched in tiles (cached under
 * cacheDir/lidar). `at(lat, lon)` is bilinear, or NaN where there is no data (open water, gaps).
 */
export class Lidar {
  constructor(cacheDir) {
    this.dir = path.join(cacheDir, 'lidar');
    this.rasters = [];
  }

  async fetch({ s, w, n, e }, metres, maxPx = 1400) {
    const kx = Math.cos((((s + n) / 2) * Math.PI) / 180) * 111320, ky = 110540;
    const W = ((e - w) * kx) / metres, H = ((n - s) * ky) / metres;
    const nx = Math.ceil(W / maxPx), ny = Math.ceil(H / maxPx);
    let fetched = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const box = { s: s + ((n - s) * j) / ny, n: s + ((n - s) * (j + 1)) / ny, w: w + ((e - w) * i) / nx, e: w + ((e - w) * (i + 1)) / nx };
        const px = Math.round(W / nx), py = Math.round(H / ny);
        const file = path.join(this.dir, `dtm_${[box.s, box.w, box.n, box.e].map((v) => v.toFixed(5)).join('_')}_${px}x${py}.tif`);
        if (!fs.existsSync(file)) {
          const url = `${LIDAR_WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${LIDAR_COVERAGE}&subset=Lat(${box.s},${box.n})&subset=Long(${box.w},${box.e})&subsettingCrs=http://www.opengis.net/def/crs/EPSG/0/4326&outputCrs=http://www.opengis.net/def/crs/EPSG/0/4326&scaleSize=i(${px}),j(${py})&format=image/tiff`;
          for (let attempt = 0; ; attempt++) {
            try {
              const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(300_000) });
              const type = res.headers.get('content-type') || '';
              if (!res.ok || !type.includes('tiff')) throw new Error(`HTTP ${res.status} ${type} ${(await res.text()).slice(0, 200)}`);
              fs.mkdirSync(this.dir, { recursive: true });
              fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
              fetched++;
              break;
            } catch (err) {
              if (attempt >= 3) throw new Error(`LIDAR: ${err.message}`);
              await sleep(5000);
            }
          }
        }
        const t = readFloatTiff(fs.readFileSync(file));
        for (let k = 0; k < t.data.length; k++) if (!(t.data[k] > -100 && t.data[k] < 3000)) t.data[k] = NaN;
        this.rasters.push({ s: box.s, n: box.n, west: box.w, east: box.e, nx: t.w, ny: t.h, data: t.data });
      }
    }
    console.log(`LIDAR ${metres} m: ${nx * ny} tiles (${fetched} downloaded)`);
  }

  at(lat, lon) {
    // Finest raster first (they are fetched finest first).
    for (const r of this.rasters) {
      if (lat < r.s || lat > r.n || lon < r.west || lon > r.east) continue;
      // Pixel-is-area: pixel (i, j) has its centre at (west + (i+0.5)·dx, n − (j+0.5)·dy).
      const x = ((lon - r.west) / (r.east - r.west)) * r.nx - 0.5, y = ((r.n - lat) / (r.n - r.s)) * r.ny - 0.5;
      const i = Math.max(0, Math.min(r.nx - 2, Math.floor(x))), j = Math.max(0, Math.min(r.ny - 2, Math.floor(y)));
      const u = Math.min(1, Math.max(0, x - i)), v = Math.min(1, Math.max(0, y - j));
      const a = r.data[j * r.nx + i], b = r.data[j * r.nx + i + 1], c = r.data[(j + 1) * r.nx + i], d = r.data[(j + 1) * r.nx + i + 1];
      const h = (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
      if (Number.isFinite(h)) return h;
      // Near a gap: the nearest valid corner.
      for (const q of [a, b, c, d]) if (Number.isFinite(q)) return q;
    }
    return NaN;
  }
}

const WMS = 'https://tiles.maps.eox.at/wms';
const R_EARTH = 6378137;
const mercX = (lon) => (R_EARTH * lon * Math.PI) / 180;
const mercY = (lat) => R_EARTH * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/**
 * Sentinel-2 cloudless 2016 (EOX, CC BY 4.0) for a lat/lon box, as one JPEG straight from EOX's WMS in Web
 * Mercator at `metresPerPixel` (Mercator metres; 9.55 is the native zoom-14 level). Over a box a few km tall the
 * Mercator image maps onto the local equirectangular metres linearly to within a few metres, well under a
 * Sentinel-2 pixel (10 m). Cached under cacheDir/imagery. Returns {width, height, buf}.
 */
export async function sentinelImage({ s, w, n, e }, metresPerPixel, cacheDir) {
  const bbox = [mercX(w), mercY(s), mercX(e), mercY(n)];
  const width = Math.round((bbox[2] - bbox[0]) / metresPerPixel), height = Math.round((bbox[3] - bbox[1]) / metresPerPixel);
  const file = path.join(cacheDir, 'imagery', `s2-2016_${[s, w, n, e].map((v) => v.toFixed(5)).join('_')}_${width}x${height}.jpg`);
  if (fs.existsSync(file)) return { width, height, buf: fs.readFileSync(file) };
  const url = `${WMS}?service=WMS&request=GetMap&version=1.1.1&layers=s2cloudless_3857&styles=&srs=EPSG:3857&bbox=${bbox.map((v) => v.toFixed(2)).join(',')}&width=${width}&height=${height}&format=image/jpeg`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(180_000) });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.includes('jpeg')) throw new Error(`HTTP ${res.status} ${type}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      console.log(`Imagery ${path.basename(file)}: ${width}×${height} px, ${(buf.length / 1024).toFixed(0)} KB`);
      return { width, height, buf };
    } catch (err) {
      if (attempt >= 3) throw new Error(`imagery: ${err.message}`);
      await sleep(3000);
    }
  }
}

/** Runs an Overpass query, cached in `file` unless `refresh`. Tries each endpoint, then waits and retries. */
export async function overpass(query, file, { refresh = false } = {}) {
  if (!refresh && fs.existsSync(file)) {
    console.log(`Using cached ${path.basename(file)} (pass --refresh to refetch)`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const body = new URLSearchParams({ data: query }).toString();
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        console.log(`Fetching ${url} ...`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(400_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
        const text = await res.text();
        const json = JSON.parse(text);
        if (!Array.isArray(json.elements) || json.elements.length === 0) throw new Error('empty response');
        if (json.remark && /runtime error|timed out/i.test(json.remark)) throw new Error(json.remark);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        console.log(`Cached ${json.elements.length} elements (${(text.length / 1e6).toFixed(1)} MB)`);
        return json;
      } catch (err) {
        lastErr = err;
        console.warn(`  failed: ${err.message}`);
      }
    }
    await sleep(20000 * (attempt + 1));
  }
  throw new Error(`All Overpass endpoints failed: ${lastErr?.message}`);
}

/** Minimal PNG decoder for 8-bit RGB/RGBA, non-interlaced (what the Terrarium tiles are). */
export function decodePNG(buf) {
  let p = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const bpp = type === 2 ? 3 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[o + i - bpp] : 0;
      const b = y ? out[o - stride + i] : 0;
      const c = i >= bpp && y ? out[o - stride + i - bpp] : 0;
      let v = raw[src + i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[o + i] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

/**
 * Elevation sampler over Terrarium tiles at one zoom level. `prefetch(bbox)` downloads (and caches) every tile
 * covering a lat/lon box; `at(lat, lon)` is then bilinear in tile pixels (metres above sea level).
 */
export class Terrarium {
  constructor(zoom, cacheDir) {
    this.z = zoom;
    this.dir = path.join(cacheDir, 'tiles', String(zoom));
    this.tiles = new Map();
    this.n = 2 ** zoom;
  }

  pixel(lat, lon) {
    const r = (lat * Math.PI) / 180;
    return [((lon + 180) / 360) * this.n * 256, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * this.n * 256];
  }

  async prefetch({ s, w, n, e }) {
    const [x0, y0] = this.pixel(n, w), [x1, y1] = this.pixel(s, e);
    const jobs = [];
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor(y1 / 256); ty++) for (let tx = Math.floor(x0 / 256); tx <= Math.floor(x1 / 256); tx++) jobs.push([tx, ty]);
    let fetched = 0;
    for (let i = 0; i < jobs.length; i += 8) {
      await Promise.all(jobs.slice(i, i + 8).map(async ([tx, ty]) => {
        const file = path.join(this.dir, `${tx}_${ty}.png`);
        if (!fs.existsSync(file)) {
          for (let attempt = 0; ; attempt++) {
            try {
              const res = await fetch(TILE_URL(this.z, tx, ty), { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              fs.mkdirSync(this.dir, { recursive: true });
              fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
              fetched++;
              break;
            } catch (err) {
              if (attempt >= 3) throw new Error(`tile ${this.z}/${tx}/${ty}: ${err.message}`);
              await sleep(2000);
            }
          }
        }
        const png = decodePNG(fs.readFileSync(file));
        const hts = new Float32Array(256 * 256);
        for (let k = 0; k < 256 * 256; k++) {
          const o = k * png.bpp;
          hts[k] = png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
        }
        this.tiles.set(`${tx}_${ty}`, hts);
      }));
    }
    console.log(`Terrain z${this.z}: ${jobs.length} tiles (${fetched} downloaded)`);
  }

  /** Height of one whole pixel (global pixel coordinates). */
  px(gx, gy) {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = this.tiles.get(`${tx}_${ty}`);
    if (!t) throw new Error(`terrain tile ${this.z}/${tx}/${ty} not loaded`);
    return t[(gy - ty * 256) * 256 + (gx - tx * 256)];
  }

  at(lat, lon) {
    // Pixel centres sit at +0.5.
    const [fx, fy] = this.pixel(lat, lon);
    const x = fx - 0.5, y = fy - 0.5;
    const i = Math.floor(x), j = Math.floor(y);
    const u = x - i, v = y - j;
    const a = this.px(i, j), b = this.px(i + 1, j), c = this.px(i, j + 1), d = this.px(i + 1, j + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }
}
