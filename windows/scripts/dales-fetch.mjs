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
