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
        uniform sampler2D nearMap, farMap, wallMap, grassMap, moorMap, rockMap;
        uniform vec4 nearRect, farRect, wallRect, grade;
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
        diffuseColor.rgb *= col;
      `);
  };
  m.customProgramCacheKey = () => 'terrain-imagery-v3';
  return m;
}

/** Loads an imagery JPEG (URL from the bundle) as a texture, ready for the terrain material. */
export function imageryTexture(url, anisotropy = 8) {
  const t = new THREE.TextureLoader().load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
