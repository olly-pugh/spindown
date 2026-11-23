// Real-world ground: heightmaps decoded from the map data, aerial imagery draped over the terrain, and the
// close-up detail textures blended in near the camera so the 10 m imagery is not a blur underfoot.
//
// Imagery: Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016),
// CC BY 4.0. The imagery is the ground's colour from ~100 m out; nearer the camera tiling grass, moor and
// limestone textures (tinted by the imagery) take over.
import * as THREE from 'three';
import { rng } from '../../core/world/noise.js';
import { HeightGrid } from '../../core/world/heightgrid.js';

export { HeightGrid };

/**
 * Nested heightmaps, finest wins: `dem(x, z)` in world coordinates (z = −north). Each finer level is blended in
 * over `fades[k]` metres inside its edge so there is no step where they meet.
 */
export function nestedTerrain(levels, fades) {
  const grids = levels.map((g) => new HeightGrid(g));
  return {
    grids,
    dem(x, z) {
      const y = -z;
      let h = grids[0].at(x, y);
      for (let k = 1; k < grids.length; k++) {
        const w = grids[k].weight(x, y, fades[k]);
        if (w > 0) h += (grids[k].at(x, y) - h) * w;
      }
      return h;
    },
  };
}

/** A byte raster over a world rectangle, for ground classes and water: polygons filled, lines stroked. */
export class Raster {
  constructor(x0, z0, x1, z1, cell) {
    this.x0 = x0;
    this.z0 = z0;
    this.cell = cell;
    this.nx = Math.ceil((x1 - x0) / cell);
    this.nz = Math.ceil((z1 - z0) / cell);
    this.a = new Uint8Array(this.nx * this.nz);
  }

  get(x, z) {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return 0;
    return this.a[j * this.nx + i];
  }

  /** Fills a polygon given as flat world [x, z, ...] (scanline, even-odd). */
  fill(ring, value) {
    const n = ring.length / 2;
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 1; i < ring.length; i += 2) {
      zMin = Math.min(zMin, ring[i]);
      zMax = Math.max(zMax, ring[i]);
    }
    const j0 = Math.max(0, Math.floor((zMin - this.z0) / this.cell)), j1 = Math.min(this.nz - 1, Math.ceil((zMax - this.z0) / this.cell));
    const xs = [];
    for (let j = j0; j <= j1; j++) {
      const z = this.z0 + (j + 0.5) * this.cell;
      xs.length = 0;
      for (let i = 0, k = n - 1; i < n; k = i++) {
        const za = ring[i * 2 + 1], zb = ring[k * 2 + 1];
        if ((za > z) !== (zb > z)) xs.push(ring[i * 2] + ((z - za) / (zb - za)) * (ring[k * 2] - ring[i * 2]));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - this.x0) / this.cell - 0.5)), i1 = Math.min(this.nx - 1, Math.floor((xs[k + 1] - this.x0) / this.cell - 0.5));
        if (i1 >= i0) this.a.fill(value, j * this.nx + i0, j * this.nx + i1 + 1);
      }
    }
  }

  /** Marks cells within `half` metres of a polyline flat world [x, z, ...]. */
  stroke(pts, half, value) {
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(len / (this.cell * 0.5)));
      for (let s = 0; s <= steps; s++) {
        const x = ax + ((bx - ax) * s) / steps, z = az + ((bz - az) * s) / steps;
        const r = Math.ceil(half / this.cell);
        const ci = Math.floor((x - this.x0) / this.cell), cj = Math.floor((z - this.z0) / this.cell);
        for (let dj = -r; dj <= r; dj++) {
          for (let di = -r; di <= r; di++) {
            const ii = ci + di, jj = cj + dj;
            if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.nz) continue;
            const cx = this.x0 + (ii + 0.5) * this.cell, cz = this.z0 + (jj + 0.5) * this.cell;
            if ((cx - x) ** 2 + (cz - z) ** 2 <= half * half + this.cell * this.cell * 0.25) this.a[jj * this.nx + ii] = value;
          }
        }
      }
    }
  }
}

// ---- Close-up ground textures (drawn once, tiling) ---------------------------------------------------------

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function blobs(g, s, n, cols, r0, r1, alpha, seed) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = r() * s, y = r() * s, rad = r0 + r() * (r1 - r0);
    for (const ox of [-s, 0, s]) {
      for (const oy of [-s, 0, s]) {
        const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
        grd.addColorStop(0, cols[Math.floor(r() * cols.length)]);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalAlpha = alpha;
        g.fillStyle = grd;
        g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
      }
    }
  }
  g.globalAlpha = 1;
}

/**
 * Neutral (near-grey, mean ~0.75) detail maps; the imagery supplies the colour. Packed: grass sward with tufts,
 * rough moor grass, and limestone (clints and grikes, weathered grey with lichen).
 */
export function groundTextures() {
  const grass = canvasTexture(512, (g, s) => {
    g.fillStyle = '#bfc2b4';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 70, ['#a9ad9c', '#d3d5c8', '#b5b8a6', '#c9cbbd'], 20, 90, 0.35, 3);
    const r = rng(8);
    g.lineWidth = 1;
    for (let i = 0; i < 16000; i++) {
      const x = r() * s, y = r() * s;
      g.strokeStyle = r() < 0.5 ? 'rgba(70,78,60,0.35)' : 'rgba(240,244,228,0.35)';
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 4, y - 2 - r() * 6);
      g.stroke();
    }
  });
  const moor = canvasTexture(512, (g, s) => {
    g.fillStyle = '#b8b4a6';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 90, ['#8f8a7a', '#d0cbbb', '#a39d8b', '#c2bfb2', '#7d7a6e'], 10, 60, 0.45, 5);
    const r = rng(9);
    for (let i = 0; i < 9000; i++) {
      const x = r() * s, y = r() * s;
      g.strokeStyle = r() < 0.6 ? 'rgba(60,56,46,0.4)' : 'rgba(236,230,212,0.35)';
      g.lineWidth = 1 + r();
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 7, y - 3 - r() * 9);
      g.stroke();
    }
  });
  const rock = canvasTexture(512, (g, s) => {
    g.fillStyle = '#c4c2bc';
    g.fillRect(0, 0, s, s);
    blobs(g, s, 60, ['#a8a59d', '#dcdad4', '#b7b4ab', '#9c9a8e', '#d2d0c6'], 15, 80, 0.45, 11);
    const r = rng(12);
    // Grikes: dark fissures in a rough grid, a little wavy.
    g.strokeStyle = 'rgba(40,40,38,0.75)';
    for (let k = 0; k < 2; k++) {
      for (let i = 0; i < 9; i++) {
        g.lineWidth = 2 + r() * 3;
        g.beginPath();
        let a = (i + r() * 0.6) * (s / 9), b = 0;
        g.moveTo(k ? b : a, k ? a : b);
        while (b < s) {
          b += 20 + r() * 30;
          a += (r() - 0.5) * 14;
          g.lineTo(k ? b : a, k ? a : b);
        }
        g.stroke();
      }
    }
    // Lichen and pits.
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = r() < 0.3 ? 'rgba(150,150,110,0.35)' : r() < 0.6 ? 'rgba(70,70,66,0.35)' : 'rgba(250,250,245,0.35)';
      const w = 1 + r() * 3;
      g.fillRect(r() * s, r() * s, w, w);
    }
  });
  return { grass, moor, rock };
}

const PAINT_GLSL = `
        // Beyond the modelled city: gardens, parks, woods, yards, streets, railways, hedges and water from the map.
        float outside = smoothstep(0.0, 25.0, -rectEdge(pd, cityRect));
        // Inside the modelled city the land use still tones the ground between its buildings (yards, car parks).
        float outsideL = mix(0.7, 1.0, outside);
        vec2 luv = rectUv(pd, landRect);
        if (luv.x > 0.0 && luv.y > 0.0 && luv.x < 1.0 && luv.y < 1.0) {
          vec4 lu = texture2D(landMap, luv);
          float ind = min(lu.r, lu.g), wat = min(lu.g, lu.b);
          float res = lu.r - ind, grn = lu.g - ind - wat, wood = lu.b - wat;
          vec4 ln = texture2D(lineMap, rectUv(pd, lineRect));
          float n3 = tph(floor(pd / 3.0)), n9 = tph(floor(pd / 9.0) + 3.7);
          vec3 lawn = vec3(0.075, 0.12, 0.035) * (0.8 + 0.4 * n9);
          vec3 paving = vec3(0.13, 0.128, 0.12) * (0.85 + 0.3 * n3);
          vec3 garden = mix(lawn, paving, step(0.7, n3) * 0.8);
          col = mix(col, garden, res * 0.75 * outsideL);
          col = mix(col, vec3(0.105, 0.105, 0.1) * (0.75 + 0.5 * n9), ind * 0.85 * outsideL);
          col = mix(col, vec3(0.07, 0.13, 0.035) * (0.9 + 0.2 * n9), grn * 0.6 * outsideL);
          col = mix(col, vec3(0.035, 0.06, 0.02), wood * 0.75 * outsideL);
          float pave = smoothstep(0.2, 0.5, ln.r), carr = smoothstep(0.62, 0.95, ln.r);
          col = mix(col, vec3(0.16, 0.158, 0.15), pave * outside);
          col = mix(col, vec3(0.075, 0.075, 0.08), carr * outside);
          col = mix(col, vec3(0.15, 0.13, 0.11), ln.g * outside);
          col = mix(col, vec3(0.03, 0.055, 0.02), ln.b * 0.9 * outside);
          paintWater = smoothstep(0.35, 0.75, wat) * outside;
          col = mix(col, vec3(0.025, 0.04, 0.045), paintWater);
        }`;

/**
 * The terrain material: aerial imagery as the base colour (graded to sit with the sun lighting), detail
 * textures near the camera, limestone on steep faces and rock ground, wall lines painted in the distance.
 * opts: {near: {texture, rect}, far: {texture, rect}, walls?: {texture, rect}} with rects {x0, y0, x1, y1} in
 * data coords (x east, y north). Vertex attribute `detail` (vec3): r = rock, g = moor, b = verge.
 */
export function terrainMaterial(opts, extra = {}) {
  const tex = groundTextures();
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.96, metalness: 0, ...extra });
  const rectVec = (r) => new THREE.Vector4(r.x0, r.y0, r.x1, r.y1);
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;
  const uniforms = {
    nearMap: { value: opts.near.texture },
    nearRect: { value: rectVec(opts.near.rect) },
    farMap: { value: opts.far.texture },
    farRect: { value: rectVec(opts.far.rect) },
    wallMap: { value: opts.walls?.texture ?? blank },
    wallRect: { value: rectVec(opts.walls?.rect ?? opts.near.rect) },
    grassMap: { value: opts.detailMap ?? tex.grass },
    moorMap: { value: tex.moor },
    rockMap: { value: tex.rock },
    grade: { value: new THREE.Vector4(opts.saturation ?? 0.6, opts.gamma ?? 0.8, opts.gain ?? 2.25, 0) },
    tint: { value: new THREE.Vector3(...(opts.tint ?? [1.42, 1.08, 0.56])) },
    // Painted ground beyond a modelled city (outskirts.js): land use and lines textures, and the city's rect.
    landMap: { value: opts.paint?.landuse.texture ?? blank },
    landRect: { value: rectVec(opts.paint?.landuse.rect ?? opts.near.rect) },
    lineMap: { value: opts.paint?.lines.texture ?? blank },
    lineRect: { value: rectVec(opts.paint?.lines.rect ?? opts.near.rect) },
    cityRect: { value: rectVec(opts.paint?.city ?? { x0: 0, y0: 0, x1: 0, y1: 0 }) },
  };
  const PAINT = !!opts.paint;
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 detail;
        varying vec3 vTerrainPos;
        varying vec3 vTerrainDetail;
        varying vec3 vTerrainNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTerrainDetail = detail;
        vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D nearMap, farMap, wallMap, grassMap, moorMap, rockMap, landMap, lineMap;
        uniform vec4 nearRect, farRect, wallRect, grade, landRect, lineRect, cityRect;
        float tph(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        uniform vec3 tint;
        varying vec3 vTerrainPos;
        varying vec3 vTerrainDetail;
        varying vec3 vTerrainNormal;
        vec2 rectUv(vec2 p, vec4 r) { return (p - r.xy) / (r.zw - r.xy); }
        float rectEdge(vec2 p, vec4 r) { vec2 d = min(p - r.xy, r.zw - p); return min(d.x, d.y); }`)
      .replace('#include <map_fragment>', `
        vec2 pd = vec2(vTerrainPos.x, -vTerrainPos.z);
        vec3 sat = texture2D(farMap, rectUv(pd, farRect)).rgb;
        float wNear = smoothstep(0.0, 300.0, rectEdge(pd, nearRect));
        if (wNear > 0.0) sat = mix(sat, texture2D(nearMap, rectUv(pd, nearRect)).rgb, wNear);
        // Grade the imagery: a touch less saturated (Sentinel greens run hot), lifted mid-tones.
        float lum = dot(sat, vec3(0.2126, 0.7152, 0.0722));
        sat = mix(vec3(lum), sat, grade.x);
        sat = pow(max(sat, vec3(0.0)), vec3(grade.y)) * grade.z * tint;
        // A soft knee: bright roofs and concrete in the imagery stay a light grey instead of glaring cream.
        sat = min(sat, vec3(0.28) + max(sat - vec3(0.28), vec3(0.0)) * 0.3);
        float dist = distance(cameraPosition, vTerrainPos);
        float nearK = 1.0 - smoothstep(35.0, 170.0, dist);
        float slope = 1.0 - clamp(vTerrainNormal.y, 0.0, 1.0);
        float rockW = clamp(vTerrainDetail.r + smoothstep(0.32, 0.55, slope), 0.0, 1.0);
        float moorW = clamp(vTerrainDetail.g, 0.0, 1.0) * (1.0 - rockW);
        vec3 g1 = texture2D(grassMap, pd / 2.3).rgb, g2 = texture2D(grassMap, pd / 11.7 + 0.37).rgb;
        // Each detail map is divided by its own mean (its smallest mip), so it adds texture, not colour.
        vec3 grassMean = textureLod(grassMap, vec2(0.5), 12.0).rgb, moorMean = textureLod(moorMap, vec2(0.5), 12.0).rgb, rockMean = textureLod(rockMap, vec2(0.5), 12.0).rgb;
        vec3 grass = (g1 * 0.55 + g2 * 0.45) / grassMean;
        grass = clamp(1.0 + (grass - 1.0) * 1.8, 0.35, 1.8); // stronger sward texture
        vec3 mo = (texture2D(moorMap, pd / 4.3).rgb * 0.6 + texture2D(moorMap, pd / 19.0).rgb * 0.4) / moorMean;
        mo = clamp(1.0 + (mo - 1.0) * 1.4, 0.35, 1.8);
        // Rock: triplanar, so cliff faces show bedding and joints instead of a smear.
        vec3 an = abs(vTerrainNormal);
        an /= (an.x + an.y + an.z);
        vec3 rTop = texture2D(rockMap, pd / 5.0).rgb * 0.65 + texture2D(rockMap, pd / 23.0 + 0.5).rgb * 0.35;
        // On faces the map is stretched along the strike so the joints read as horizontal limestone bedding.
        vec3 rX = texture2D(rockMap, vec2(vTerrainPos.z / 19.0, vTerrainPos.y / 3.2)).rgb;
        vec3 rZ = texture2D(rockMap, vec2(vTerrainPos.x / 19.0, vTerrainPos.y / 3.2)).rgb;
        vec3 rk = (rTop * an.y + rX * an.x + rZ * an.z) / rockMean;
        rk = clamp(1.0 + (rk - 1.0) * 1.3, 0.3, 1.6);
        vec3 det = mix(mix(grass, mo, moorW), rk, rockW);
        // Patches at the scale of a field corner (rushes, thistles, worn and lush ground) the imagery is too
        // coarse to show, fading out with distance.
        float patchN = texture2D(moorMap, pd / 61.0 + 0.21).r * 0.6 + texture2D(grassMap, pd / 27.0).r * 0.4;
        vec3 patchTint = mix(vec3(0.9, 0.95, 0.8), vec3(1.12, 1.06, 0.9), smoothstep(0.55, 0.85, patchN));
        // Far: the imagery (with a little grain). Near: the detail texture carries the imagery colour.
        vec3 col = sat * mix(vec3(1.0), det * mix(vec3(1.0), patchTint, 0.8), 0.15 + 0.75 * nearK);
        // Limestone shows grey-white whatever the imagery says on faces too steep for it to see.
        vec3 lime = vec3(0.60, 0.60, 0.56) * rk;
        col = mix(col, lime, rockW * mix(0.25, 0.85, smoothstep(0.3, 0.75, slope)));
        // Verges: the 10 m imagery smears the road's grey over them; keep them grass-green near the road.
        col = mix(col, sat * vec3(0.92, 1.05, 0.82) * grass, vTerrainDetail.b * 0.6);
        // The dry-stone wall network, painted where the 3D walls are too far away to draw.
        float wl = texture2D(wallMap, rectUv(pd, wallRect)).r * smoothstep(0.0, 50.0, rectEdge(pd, wallRect));
        col = mix(col, col * 0.62 + vec3(0.02), wl * smoothstep(150.0, 600.0, dist));
        float paintWater = 0.0;
        ${PAINT ? PAINT_GLSL : ''}
        diffuseColor.rgb *= col;
      `);
  };
  if (PAINT) {
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (shader) => {
      prev(shader);
      // Water is smooth: it mirrors the sky.
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n        roughnessFactor = mix(roughnessFactor, 0.06, paintWater);');
    };
  }
  m.customProgramCacheKey = () => (PAINT ? 'terrain-imagery-v3-paint' : 'terrain-imagery-v3');
  return m;
}

// ---- The land material: imagery, LIDAR relief, ground classes and photo detail ---------------------------

const rectVec = (r) => new THREE.Vector4(r.x0, r.y0, r.x1, r.y1);

/**
 * World-space terrain normals sampled from a height function over a rectangle (data coords), as a texture: so
 * the land is lit by its real shape whatever the detail of the mesh drawing it (no seams or popping in the
 * lighting where terrain tiles of different detail meet). RG = normal x, z; B = curvature (0.5 flat).
 */
export function normalTexture(height, rect, cell) {
  const nx = Math.round((rect.x1 - rect.x0) / cell) + 1, ny = Math.round((rect.y1 - rect.y0) / cell) + 1;
  const h = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = height(rect.x0 + i * cell, rect.y0 + j * cell);
  const at = (i, j) => h[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  const px = new Uint8Array(nx * ny * 4);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const dzdx = (at(i + 1, j) - at(i - 1, j)) / (2 * cell), dzdy = (at(i, j + 1) - at(i, j - 1)) / (2 * cell);
      let wx = -dzdx, wz = dzdy;
      const len = Math.hypot(wx, 1, wz);
      wx /= len;
      wz /= len;
      const lap = (at(i - 1, j) + at(i + 1, j) + at(i, j - 1) + at(i, j + 1) - 4 * at(i, j)) / (cell * cell);
      const o = (j * nx + i) * 4;
      px[o] = Math.round(127.5 + wx * 127.5);
      px[o + 1] = Math.round(127.5 + wz * 127.5);
      px[o + 2] = Math.max(0, Math.min(255, Math.round(128 - lap * 600)));
      px[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(px, nx, ny);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  // Texel centres sit on the samples.
  return { texture: t, rect: { x0: rect.x0 - cell / 2, y0: rect.y0 - cell / 2, x1: rect.x0 + (nx - 0.5) * cell, y1: rect.y0 + (ny - 0.5) * cell } };
}

/**
 * Ground-class weights from a class raster (rows north to south), softened: RGBA = rock, scree, rough grazing or
 * moor, limestone pavement. `weights[cls]` gives [r, g, b, a] for each class value.
 */
export function classTexture(raster, weights) {
  const { nx, nz } = raster;
  const px = new Uint8Array(nx * nz * 4);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const w = weights[raster.a[j * nx + i]];
      if (!w) continue;
      // Texture rows run south to north (v = 0 at the south edge, like the imagery).
      const o = ((nz - 1 - j) * nx + i) * 4;
      for (let k = 0; k < 4; k++) px[o + k] = w[k] * 255;
    }
  }
  // (Edges are softened in the shader: bilinear filtering plus a jitter of a couple of metres.)
  const t = new THREE.DataTexture(px, nx, nz);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  const x1 = raster.x0 + nx * raster.cell, z1 = raster.z0 + nz * raster.cell;
  return { texture: t, rect: { x0: raster.x0, y0: -z1, x1, y1: -raster.z0 } };
}

/** Distance to the road (metres, to 255) from a RouteField, as a texture. */
export function roadDistanceTexture(field) {
  const { nx, nz, cell } = field;
  const px = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) px[(nz - 1 - j) * nx + i] = Math.min(255, Math.round(Math.sqrt(field.dist[j * nx + i])));
  const t = new THREE.DataTexture(px, nx, nz, THREE.RedFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  const x0 = field.x0 - cell / 2, z0 = field.z0 - cell / 2;
  return { texture: t, rect: { x0, y0: -(z0 + nz * cell), x1: x0 + nx * cell, y1: -z0 } };
}

/**
 * The Dales land: aerial imagery for colour, the LIDAR relief for shape, ground classes for what the ground is
 * made of, and photographs of real turf, rough grass, limestone and scree near the camera (tinted by the imagery,
 * so a field keeps its real colour), with limestone pavement's clints and grikes drawn on the pavements.
 * opts: {near, far, walls?, relief?, farNormal?, classes?, road?: {texture, rect}, layers: groundDetailArrays()}
 * plus grading as terrainMaterial. Vertex attribute `detail` (vec3): r = rock, g = moor, b = verge.
 * `userData.uniforms.reliefStrength` (1) can be turned down for surfaces the LIDAR does not know (road beds).
 */
export function landMaterial(opts, extra = {}) {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.97, metalness: 0, ...extra });
  const blank = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  blank.needsUpdate = true;
  const L = opts.layers;
  const uniforms = {
    nearMap: { value: opts.near.texture },
    nearRect: { value: rectVec(opts.near.rect) },
    farMap: { value: opts.far.texture },
    farRect: { value: rectVec(opts.far.rect) },
    wallMap: { value: opts.walls?.texture ?? blank },
    wallRect: { value: rectVec(opts.walls?.rect ?? opts.near.rect) },
    reliefMap: { value: opts.relief?.texture ?? blank },
    reliefRect: { value: rectVec(opts.relief?.rect ?? { x0: 0, y0: 0, x1: 0, y1: 0 }) },
    farNMap: { value: opts.farNormal?.texture ?? blank },
    farNRect: { value: rectVec(opts.farNormal?.rect ?? { x0: 0, y0: 0, x1: 0, y1: 0 }) },
    classMap: { value: opts.classes?.texture ?? blank },
    classRect: { value: rectVec(opts.classes?.rect ?? { x0: 0, y0: 0, x1: 0, y1: 0 }) },
    roadMap: { value: opts.road?.texture ?? blank },
    roadRect: { value: rectVec(opts.road?.rect ?? { x0: 0, y0: 0, x1: 0, y1: 0 }) },
    detailArr: { value: L.colour },
    normalArr: { value: L.normal },
    layerMean: { value: L.means },
    grade: { value: new THREE.Vector4(opts.saturation ?? 0.6, opts.gamma ?? 0.8, opts.gain ?? 2.25, 0) },
    tint: { value: new THREE.Vector3(...(opts.tint ?? [1.42, 1.08, 0.56])) },
    reliefStrength: { value: 1 },
  };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 detail;
        varying vec3 vTerrainPos;
        varying vec3 vTerrainDetail;
        varying vec3 vTerrainNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTerrainDetail = detail;
        vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        precision highp sampler2DArray;
        #define LAND_DETAIL ${Math.max(0, Math.min(2, opts.detail ?? 2))}
        uniform sampler2D nearMap, farMap, wallMap, reliefMap, farNMap, classMap, roadMap;
        uniform sampler2DArray detailArr, normalArr;
        uniform vec3 layerMean[5];
        uniform vec4 nearRect, farRect, wallRect, reliefRect, farNRect, classRect, roadRect, grade;
        uniform vec3 tint;
        uniform float reliefStrength;
        varying vec3 vTerrainPos;
        varying vec3 vTerrainDetail;
        varying vec3 vTerrainNormal;
        vec2 rectUv(vec2 p, vec4 r) { return (p - r.xy) / (r.zw - r.xy); }
        float rectEdge(vec2 p, vec4 r) { vec2 d = min(p - r.xy, r.zw - p); return min(d.x, d.y); }
        float lh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float lh1(float x) { return fract(sin(x * 91.7) * 43758.5453); }
        // Photo layer k at two scales (the second rotated) so it never visibly repeats.
        vec3 layerTex(vec2 p, float k, float scale) {
          vec3 a = texture(detailArr, vec3(p / scale, k)).rgb;
          #if LAND_DETAIL >= 2
          // A second, rotated scale hides the repeat (high quality only: it doubles the samples).
          vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p / (scale * 3.3) + vec2(0.31, 0.17);
          vec3 b = texture(detailArr, vec3(q, k)).rgb;
          return mix(a, b, 0.42);
          #else
          return a;
          #endif
        }
        vec2 layerNrm(vec2 p, float k, float scale) {
          return texture(normalArr, vec3(p / scale, k)).xy * 2.0 - 1.0;
        }
        vec3 vegDetail(vec3 t, vec3 mean) {
          float tl = dot(t, vec3(0.2126, 0.7152, 0.0722)), ml = dot(mean, vec3(0.2126, 0.7152, 0.0722));
          vec3 hue = (t / max(tl, 1e-3)) / (mean / max(ml, 1e-3));
          return clamp(tl / ml, 0.3, 2.0) * mix(vec3(1.0), clamp(hue, vec3(0.6), vec3(1.5)), 0.35);
        }
        // Limestone pavement: clints between grikes, along the two joint sets of the Malham pavements.
        // An integer hash, identical in groundcover.js (which puts 3D clints on this same lattice).
        float ihash(int x) {
          uint h = uint(x + 1000000) * 0x9E3779B1u;
          h ^= h >> 15u;
          h *= 0x85EBCA77u;
          h ^= h >> 13u;
          return float(h & 0xFFFFu) / 65535.0;
        }
        // Limestone pavement: clints between grikes, along the two joint sets of the Malham pavements. The
        // lattice (see groundcover.js clintLattice): joints every 2.3 m one way, rows 1.4-3.8 m the other.
        float grikes(vec2 p, out float tone) {
          vec2 q = vec2(0.94 * p.x + 0.34 * p.y, -0.34 * p.x + 0.94 * p.y);
          float wx = q.x + 0.3 * sin(q.y * 0.61) + 0.14 * sin(q.y * 1.7);
          float col = floor(wx / 2.3);
          float dJ = (0.5 - abs(fract(wx / 2.3) - 0.5)) * 2.3;
          float sp = 1.4 + 2.4 * ihash(int(col));
          float wy = q.y + ihash(int(col) + 7919) * sp + 0.25 * sin(q.x * 1.3);
          float dC = (0.5 - abs(fract(wy / sp) - 0.5)) * sp;
          float d = min(dJ, dC * 1.15);
          float aa = fwidth(d) * 1.2 + 0.02;
          tone = ihash(int(col) * 131 + int(floor(wy / sp)));
          return 1.0 - smoothstep(0.2 - aa, 0.2 + aa, d);
        }`)
      .replace('#include <map_fragment>', `
        vec2 pd = vec2(vTerrainPos.x, -vTerrainPos.z);
        float dist = distance(cameraPosition, vTerrainPos);
        float nearK = 1.0 - smoothstep(30.0, 230.0, dist);
        // ---- Shape: the LIDAR relief (2 m) near the loop, the terrain (20 m) beyond; the mesh's own normal only
        // next to the road, whose cuttings and embankments the survey does not know.
        vec3 tN = normalize(vTerrainNormal);
        float curv = 0.0;
        vec2 fuv = rectUv(pd, farNRect);
        if (fuv.x > 0.0 && fuv.y > 0.0 && fuv.x < 1.0 && fuv.y < 1.0) {
          vec3 fr = texture2D(farNMap, fuv).rgb;
          vec2 fxz = fr.rg * 2.0 - 1.0;
          tN = vec3(fxz.x, sqrt(max(0.05, 1.0 - dot(fxz, fxz))), fxz.y);
          curv = (fr.b - 0.5) * 2.0;
        }
        float wRel = smoothstep(0.0, 150.0, rectEdge(pd, reliefRect));
        if (wRel > 0.0) {
          vec3 rl = texture2D(reliefMap, rectUv(pd, reliefRect)).rgb;
          vec2 rxz = rl.rg * 2.0 - 1.0;
          vec3 rn = vec3(rxz.x, sqrt(max(0.05, 1.0 - dot(rxz, rxz))), rxz.y);
          tN = normalize(mix(tN, rn, wRel));
          curv = mix(curv, (rl.b - 0.5) * 2.0, wRel);
        }
        float roadD = 255.0;
        vec2 ruv = rectUv(pd, roadRect);
        if (ruv.x > 0.0 && ruv.y > 0.0 && ruv.x < 1.0 && ruv.y < 1.0) roadD = texture2D(roadMap, ruv).r * 255.0;
        float meshW = max(1.0 - reliefStrength, 1.0 - smoothstep(14.0, 34.0, roadD));
        tN = normalize(mix(tN, normalize(vTerrainNormal), meshW));
        float slope = 1.0 - clamp(tN.y, 0.0, 1.0);
        // ---- Colour from the imagery, graded to sit with the sun ----
        vec3 sat = texture2D(farMap, rectUv(pd, farRect)).rgb;
        float wNear = smoothstep(0.0, 300.0, rectEdge(pd, nearRect));
        if (wNear > 0.0) sat = mix(sat, texture2D(nearMap, rectUv(pd, nearRect)).rgb, wNear);
        float lum = dot(sat, vec3(0.2126, 0.7152, 0.0722));
        // Bare rock is the palest, greyest ground in the imagery: how much of a mapped rock area is really bare.
        float bare = smoothstep(0.035, 0.075, lum) * (1.0 - smoothstep(0.02, 0.08, sat.g - sat.b));
        sat = mix(vec3(lum), sat, grade.x);
        sat = pow(max(sat, vec3(0.0)), vec3(grade.y)) * grade.z * tint;
        // ---- What the ground is: classes from the map, rock where it is steep or an edge ----
        vec4 cw = vec4(0.0);
        // Ragged class edges: the raster is 4 m, real boundaries wander.
        vec2 jit = vec2(lh(floor(pd / 3.0)), lh(floor(pd / 3.0) + 11.0)) * 4.0 - 2.0;
        vec2 cuv = rectUv(pd + jit, classRect);
        if (cuv.x > 0.0 && cuv.y > 0.0 && cuv.x < 1.0 && cuv.y < 1.0) cw = texture2D(classMap, cuv);
        cw.r = max(cw.r, vTerrainDetail.r * 0.5);
        cw.b = max(cw.b, vTerrainDetail.g);
        float patchN = lh(floor(pd / 9.0)) * 0.5 + lh(floor(pd / 23.0) + 7.0) * 0.5;
        // Mapped rock is mostly turf with rock showing through: bare where the imagery is pale, on edges and steep
        // ground (from the relief); pavements stay mostly bare.
        float exposure = clamp(0.18 + 0.82 * bare + max(0.0, curv) * 0.9 + smoothstep(0.12, 0.35, slope) * 0.6, 0.0, 1.0);
        // Flat bare rock on the limestone is pavement (OSM maps most of it simply as bare rock).
        float pave = max(cw.a, cw.r * (1.0 - smoothstep(0.05, 0.14, slope)));
        float rockClass = max(cw.r * exposure, pave * (0.6 + 0.4 * exposure));
        float wRock = clamp(rockClass + smoothstep(0.30, 0.52, slope + (patchN - 0.5) * 0.08) + max(0.0, curv - 0.25) * 1.2 * smoothstep(0.08, 0.2, slope), 0.0, 1.0);
        float wScree = clamp(cw.g, 0.0, 1.0) * (1.0 - wRock);
        float wRough = clamp(cw.b, 0.0, 1.0) * (1.0 - wRock - wScree);
        // On the plateau the turf is limestone grassland, thin over the rock; lower down it is meadow and pasture.
        float hi = smoothstep(300.0, 370.0, vTerrainPos.y + (patchN - 0.5) * 30.0);
        float wVeg = 1.0 - wRock - wScree;
        float wPast = max(0.0, wVeg - wRough) * (1.0 - hi);
        float wLime = max(0.0, wVeg - wRough) * hi;
        // ---- Photo detail near the camera ----
        vec3 vegDet = vec3(1.0);
        vec2 dn = vec2(0.0);
        if (nearK > 0.0) {
          // Each photo gives its brightness pattern and a little of its own hue variation; the imagery gives the
          // colour (dividing by a photo's mean colour outright would amplify its weak blue channel into purple).
          vec3 acc = vec3(0.0);
          float wsum = 0.0;
          if (wPast > 0.02) { acc += vegDetail(layerTex(pd, 0.0, 2.5), layerMean[0]) * wPast; dn += layerNrm(pd, 0.0, 2.5) * wPast; wsum += wPast; }
          if (wLime > 0.02) { acc += vegDetail(layerTex(pd, 1.0, 3.2), layerMean[1]) * wLime; dn += layerNrm(pd, 1.0, 3.2) * wLime; wsum += wLime; }
          if (wRough > 0.02) { acc += vegDetail(layerTex(pd, 2.0, 2.0), layerMean[2]) * wRough; dn += layerNrm(pd, 2.0, 2.0) * wRough; wsum += wRough; }
          if (wsum > 0.0) vegDet = clamp(1.0 + (acc / wsum - 1.0) * 1.5, 0.3, 2.2);
        }
        // Patches at the scale of a field corner the imagery is too coarse to show: lusher and worn ground.
        float pn = lh(floor(pd / 6.0) + 0.5) * 0.35 + lh(floor(pd / 2.0)) * 0.15 + patchN * 0.5;
        vec3 patchTint = mix(vec3(0.88, 0.95, 0.80), vec3(1.10, 1.05, 0.92), smoothstep(0.35, 0.75, pn));
        vec3 veg = sat * mix(vec3(1.0), vegDet * mix(vec3(1.0), patchTint, 0.6), 0.12 + 0.88 * nearK);
        // Rock and scree keep their own colour (the imagery cannot see a face or the grey of a scree).
        vec3 rockC = vec3(0.42, 0.40, 0.36);
        vec3 screeC = vec3(0.34, 0.34, 0.33);
        vec3 mineral = vec3(0.0);
        float wMin = wRock + wScree;
        if (wMin > 0.01) {
          vec3 rT = (nearK > 0.0) ? layerTex(pd, 3.0, 1.9) / layerMean[3] : vec3(1.0);
          float rl = dot(rT, vec3(0.333));
          rT = mix(vec3(rl), rT, 0.35);
          vec3 sT = (nearK > 0.0 && wScree > 0.01) ? layerTex(pd, 4.0, 1.8) / layerMean[4] : vec3(1.0);
          vec3 rock = rockC * mix(vec3(1.0), rT, 0.25 + 0.75 * nearK) * (0.9 + 0.2 * patchN);
          // Limestone pavement: pale clints, dark grikes with moss and grass in them.
          if (pave > 0.05) {
            float tone;
            float gk = grikes(pd, tone);
            float far = smoothstep(120.0, 380.0, dist);
            vec3 clint = rock * (0.92 + 0.22 * tone);
            // Grikes: deep, shadowed cracks with ferns and grass in them.
            vec3 grikeC = mix(vec3(0.018, 0.022, 0.015), vec3(0.05, 0.08, 0.03), tone);
            vec3 paveC = mix(mix(clint, grikeC, gk), clint * 0.86, far);
            rock = mix(rock, paveC, smoothstep(0.05, 0.4, pave));
            dn += vec2(0.0);
          }
          vec3 scree = screeC * mix(vec3(1.0), sT, 0.25 + 0.75 * nearK);
          mineral = (rock * wRock + scree * wScree) / wMin;
          // From afar a scar or pavement is the pale, patchy grey-green the imagery shows, not solid stone.
          mineral = mix(mineral, sat * 1.3 + vec3(0.03, 0.03, 0.02), smoothstep(350.0, 1800.0, dist) * 0.75);
          if (nearK > 0.0) dn += layerNrm(pd, wScree > wRock ? 4.0 : 3.0, 1.9) * wMin;
        }
        // Tufts of grass between the rocks at the edges of outcrops and scree.
        vec3 col = mix(veg, mineral, clamp(wMin * 1.15, 0.0, 1.0));
        // Hollows a little darker and lusher, edges a little paler: the relief the imagery blurs.
        col *= 1.0 - clamp(-curv, 0.0, 1.0) * 0.18 + clamp(curv, 0.0, 1.0) * 0.06;
        // Verges: the 10 m imagery smears the road's grey over them; keep them grass-green near the road.
        col = mix(col, sat * vec3(0.92, 1.05, 0.82) * vegDet, vTerrainDetail.b * 0.6 * (1.0 - wMin));
        // The dry-stone wall network, painted where the 3D walls are too far away to draw.
        float wl = texture2D(wallMap, rectUv(pd, wallRect)).r * smoothstep(0.0, 50.0, rectEdge(pd, wallRect));
        col = mix(col, col * 0.62 + vec3(0.02), wl * smoothstep(150.0, 600.0, dist));
        diffuseColor.rgb *= col;
        // Detail bumps from the photos, fading with distance.
        #if LAND_DETAIL >= 1
        tN = normalize(tN + vec3(dn.x, 0.0, -dn.y) * 0.55 * nearK * reliefStrength);
        #endif
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(tN, 0.0)).xyz);`);
  };
  m.customProgramCacheKey = () => `land-v1-${opts.detail ?? 2}`;
  return m;
}

/**
 * The aerial imagery on the CPU, for colouring things placed on the ground (grass, rushes) like the land under them,
 * with the same grading as the land material. `colour(x, y, out)` (data coords) gives linear RGB, or false until
 * the image has loaded (`onLoad` is called then).
 */
export class ImagerySampler {
  constructor(url, rect, grade, onLoad) {
    this.rect = rect;
    this.grade = { saturation: 0.6, gamma: 0.8, gain: 2.25, tint: [1.42, 1.08, 0.56], ...grade };
    this.px = null;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      this.w = img.width;
      this.h = img.height;
      this.px = g.getImageData(0, 0, img.width, img.height).data;
      onLoad?.();
    };
    img.src = url;
  }

  colour(x, y, out) {
    if (!this.px) return false;
    const r = this.rect;
    const u = (x - r.x0) / (r.x1 - r.x0), v = 1 - (y - r.y0) / (r.y1 - r.y0);
    if (u < 0 || v < 0 || u > 1 || v > 1) return false;
    const i = Math.min(this.w - 1, Math.floor(u * this.w)), j = Math.min(this.h - 1, Math.floor(v * this.h));
    const o = (j * this.w + i) * 4, lin = (b) => Math.pow(b / 255, 2.2);
    let cr = lin(this.px[o]), cg = lin(this.px[o + 1]), cb = lin(this.px[o + 2]);
    const g = this.grade, l = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
    cr = l + (cr - l) * g.saturation;
    cg = l + (cg - l) * g.saturation;
    cb = l + (cb - l) * g.saturation;
    out[0] = Math.pow(Math.max(0, cr), g.gamma) * g.gain * g.tint[0];
    out[1] = Math.pow(Math.max(0, cg), g.gamma) * g.gain * g.tint[1];
    out[2] = Math.pow(Math.max(0, cb), g.gamma) * g.gain * g.tint[2];
    out[3] = l;
    return true;
  }
}

/** Loads an imagery JPEG (URL from the bundle) as a texture, ready for the terrain material. */
export function imageryTexture(url, anisotropy = 8) {
  const t = new THREE.TextureLoader().load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
