// Natural materials and objects for the real-world landscapes: limestone faces, close-up ground textures, rocks
// and boulders, scree, becks and tarns, grass, rushes and bracken near the camera.
//
// Photographic textures from Poly Haven (https://polyhaven.com), all CC0 (public domain): "Rock Boulder Dry",
// "Mossy Rock", "Grass Ground", "Rocky Terrain 02", "Sparse Grass", "Gray Rocks" and "River Small Rocks".
import * as THREE from 'three';
import limestoneUrl from './data/tex/limestone.jpg';
import limestoneNormalUrl from './data/tex/limestone-n.jpg';
import lichenUrl from './data/tex/lichen.jpg';
import pastureUrl from './data/tex/pasture.jpg';
import pastureNUrl from './data/tex/pasture-n.jpg';
import limegrassUrl from './data/tex/limegrass.jpg';
import limegrassNUrl from './data/tex/limegrass-n.jpg';
import roughUrl from './data/tex/rough.jpg';
import roughNUrl from './data/tex/rough-n.jpg';
import screeUrl from './data/tex/scree.jpg';
import screeNUrl from './data/tex/scree-n.jpg';
import gravelUrl from './data/tex/gravel.jpg';
import gravelNUrl from './data/tex/gravel-n.jpg';

/**
 * The close-up ground photos as two texture arrays (one sampler each, so the terrain shader stays within the 16
 * texture units older graphics chips allow): colour (1024²) and normals (512²), layers in GROUND_LAYERS order.
 * `means` holds each layer's average colour (linear) once loaded, so the shader can use the photos for texture and
 * the aerial imagery for colour.
 */
export const GROUND_LAYERS = ['pasture', 'limegrass', 'rough', 'limestone', 'scree', 'gravel'];
let groundArrays = null;
export function groundDetailArrays() {
  if (groundArrays) return groundArrays;
  const colourUrls = [pastureUrl, limegrassUrl, roughUrl, limestoneUrl, screeUrl, gravelUrl];
  const normalUrls = [pastureNUrl, limegrassNUrl, roughNUrl, limestoneNormalUrl, screeNUrl, gravelNUrl];
  const make = (size, fill, srgb) => {
    const n = colourUrls.length;
    const data = new Uint8Array(size * size * 4 * n);
    new Uint32Array(data.buffer).fill(fill[0] | (fill[1] << 8) | (fill[2] << 16) | (fill[3] << 24));
    const t = new THREE.DataArrayTexture(data, size, size, n);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const colour = make(1024, [188, 188, 188, 255], true);
  const normal = make(512, [128, 128, 255, 255], false);
  const means = colourUrls.map(() => new THREE.Vector3(0.5, 0.5, 0.5));
  groundArrays = { colour, normal, means, ready: false };
  const load = (url, size, tex, layer, mean) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, size, size);
      const px = g.getImageData(0, 0, size, size).data;
      tex.image.data.set(px, layer * size * size * 4);
      if (mean) {
        // Average colour in linear light.
        let r = 0, gg = 0, b = 0;
        const toLin = (v) => Math.pow(v / 255, 2.2);
        for (let i = 0; i < px.length; i += 64) {
          r += toLin(px[i]);
          gg += toLin(px[i + 1]);
          b += toLin(px[i + 2]);
        }
        const n = px.length / 64;
        mean.set(r / n, gg / n, b / n);
      }
      resolve();
    };
    img.onerror = () => resolve();
    img.src = url;
  });
  Promise.all([
    ...colourUrls.map((u, i) => load(u, 1024, colour, i, means[i])),
    ...normalUrls.map((u, i) => load(u, 512, normal, i, null)),
  ]).then(() => {
    colour.needsUpdate = true;
    normal.needsUpdate = true;
    groundArrays.ready = true;
  });
  return groundArrays;
}

const cache = new Map();
/** A repeating photo texture (loaded once per URL and settings). */
export function loadTex(url, srgb = true, repeat = 1) {
  const key = `${url}|${srgb}|${repeat}`;
  if (cache.has(key)) return cache.get(key);
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.repeat.set(repeat, repeat);
  cache.set(key, t);
  return t;
}

// ---- Water ------------------------------------------------------------------------------------------------

let rippleTex = null;
/** A tiling normal map of small wind ripples (procedural, drawn once). */
export function rippleNormals() {
  if (rippleTex) return rippleTex;
  const S = 256;
  const h = new Float32Array(S * S);
  // A sum of waves with whole numbers of periods across the tile, so it repeats seamlessly.
  const waves = [];
  let seed = 3;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 28; k++) {
    const kx = Math.round((r() - 0.5) * 18), ky = Math.round((r() - 0.5) * 18);
    if (!kx && !ky) continue;
    waves.push([kx, ky, 1 / Math.hypot(kx, ky), r() * 6.283]);
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0;
      for (const [kx, ky, a, p] of waves) v += a * Math.sin(((kx * x + ky * y) / S) * 6.283 + p);
      h[y * S + x] = v;
    }
  }
  const px = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = h[y * S + ((x + 1) % S)] - h[y * S + ((x + S - 1) % S)], dy = h[((y + 1) % S) * S + x] - h[((y + S - 1) % S) * S + x];
      const nx = -dx * 0.9, ny = -dy * 0.9, l = Math.hypot(nx, ny, 1);
      const o = (y * S + x) * 4;
      px[o] = Math.round(127.5 + (nx / l) * 127.5);
      px[o + 1] = Math.round(127.5 + (ny / l) * 127.5);
      px[o + 2] = Math.round(127.5 + (1 / l) * 127.5);
      px[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(px, S, S);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  rippleTex = t;
  return t;
}

/**
 * A tarn or a reservoir: deep, dark peaty blue-grey water reflecting the sky, wind ripples moving across it (the
 * normal map's offset is animated by the caller), deeper colour away from the shore (vertex attribute `depth` 0..1).
 */
export function lakeMaterial() {
  const normalMap = rippleNormals();
  const m = new THREE.MeshStandardMaterial({ color: '#16242b', roughness: 0.08, metalness: 0, normalMap, normalScale: new THREE.Vector2(0.22, 0.22), envMapIntensity: 0.9 });
  m.userData.ripple = normalMap;
  return m;
}

/**
 * Becks: shallow, clear, peat-tinted water over a stony bed, so the stones show through near the camera and the
 * surface catches the sky further off. uv = (across 0..1, along in metres); `flow` scrolls the ripples downstream.
 */
export function beckWaterMaterial() {
  const normalMap = rippleNormals();
  const m = new THREE.MeshStandardMaterial({ color: '#33382f', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.5, normalMap, normalScale: new THREE.Vector2(0.28, 0.28), envMapIntensity: 1.2, depthWrite: false });
  const flow = { value: 0 };
  m.userData.flow = flow;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.beckFlow = flow;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
        uniform float beckFlow;
        varying float vBeckAcross;`).replace('#include <uv_vertex>', `#include <uv_vertex>
        vBeckAcross = uv.x;
        #ifdef USE_NORMALMAP
          vNormalMapUv = vec2(uv.x * 0.6, uv.y / 3.0 - beckFlow * 0.45);
        #endif`);
    // Clearer (more transparent) where the water is shallow, at the edges.
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
        varying float vBeckAcross;`).replace('#include <opaque_fragment>', `
        float edgeK = 1.0 - smoothstep(0.0, 0.3, min(vBeckAcross, 1.0 - vBeckAcross));
        // Fresnel: clear looking down into it, a mirror of the sky at a glance.
        float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 4.0);
        diffuseColor.a = mix(diffuseColor.a * (1.0 - 0.55 * edgeK), 0.97, fres);
        #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'beck-water-v1';
  return m;
}

/** The beck bed: wet river stones (world-space UVs in `uv`, metres), dark and glistening. */
export function beckBedMaterial() {
  const map = loadTex(gravelUrl, true, 1 / 1.6);
  const normalMap = loadTex(gravelNUrl, false, 1 / 1.6);
  return new THREE.MeshStandardMaterial({ color: '#c9c6bc', map, normalMap, normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.45, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
}

/**
 * Limestone boulders and blocks (instanced, no UVs): the rock photo projected from three sides, lichen on top, a
 * darker skirt where they sit in the turf. Instance colour tints each stone.
 */
export function boulderMaterial() {
  const map = loadTex(limestoneUrl, true, 1);
  const lichen = loadTex(lichenUrl, true, 1);
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.rockMap = { value: map };
    shader.uniforms.lichenMap = { value: lichen };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vBWorld;
        varying vec3 vBNormal;
        varying float vBLocalY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBLocalY = position.y;
        #ifdef USE_INSTANCING
          vBWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          vBNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
        #else
          vBWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vBNormal = normalize(mat3(modelMatrix) * objectNormal);
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D rockMap, lichenMap;
        varying vec3 vBWorld;
        varying vec3 vBNormal;
        varying float vBLocalY;`)
      .replace('#include <map_fragment>', `
        vec3 bw = abs(normalize(vBNormal));
        bw = pow(bw, vec3(4.0));
        bw /= (bw.x + bw.y + bw.z);
        vec3 tx = texture2D(rockMap, vBWorld.zy / 1.6).rgb, ty = texture2D(rockMap, vBWorld.xz / 1.6).rgb, tz = texture2D(rockMap, vBWorld.xy / 1.6).rgb;
        vec3 rt = tx * bw.x + ty * bw.y + tz * bw.z;
        float rl = dot(rt, vec3(0.299, 0.587, 0.114));
        vec3 stone = mix(vec3(rl), rt, 0.3) * 1.25;
        // Tops weather smooth (the photo's fine cracks streak at grazing angles): less texture, lichen patches.
        float top = smoothstep(0.5, 0.95, vBNormal.y);
        stone = mix(stone, vec3(dot(stone, vec3(0.333)) * 0.95 + 0.03), top * 0.55);
        vec3 li = texture2D(lichenMap, vBWorld.xz / 2.3).rgb;
        float patchL = smoothstep(0.45, 0.75, texture2D(lichenMap, vBWorld.xz / 9.0 + 0.3).g * 1.6);
        stone = mix(stone, li * 0.9, top * (0.2 + 0.35 * patchL));
        // Earthy and darker where it sits in the ground.
        stone *= mix(0.55, 1.0, smoothstep(-0.45, 0.05, vBLocalY));
        diffuseColor.rgb *= stone;
      `);
  };
  m.customProgramCacheKey = () => 'boulder-v1';
  return m;
}

/**
 * Pale grey Carboniferous limestone for the faces: the photo texture greyed to the stone's colour, each bed its own
 * shade, dark bedding grooves and joints, black water streaks running down from the lip and the overhangs, lichen
 * near the top and grass on the ledges. Vertex attribute `rockInfo`: x bed tint, y groove shade, z metres below the
 * lip, w warm/cool shift; uv in metres (along the face, height).
 */
export function limestoneFaceMaterial() {
  const map = loadTex(limestoneUrl, true, 1 / 2.6);
  const normalMap = loadTex(limestoneNormalUrl, false, 1 / 2.6);
  const lichen = loadTex(lichenUrl, true, 1);
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', map, normalMap, normalScale: new THREE.Vector2(1.1, 1.1), roughness: 0.93, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.lichenMap = { value: lichen };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 rockInfo;
        varying vec4 vRock;
        varying vec2 vRockUv;
        varying vec3 vRockWorldN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRock = rockInfo;
        vRockUv = uv;
        vRockWorldN = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D lichenMap;
        varying vec4 vRock;
        varying vec2 vRockUv;
        varying vec3 vRockWorldN;
        float rh1(float x) { return fract(sin(x * 127.1) * 43758.5453); }
        float rn1(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(rh1(i), rh1(i + 1.0), f); }`)
      .replace('#include <map_fragment>', `
        // Two scales of the photo so it does not repeat across a 80 m face.
        vec3 t1 = texture2D(map, vMapUv).rgb;
        vec3 t2 = texture2D(map, vRockUv / 11.3 + vec2(0.37, 0.61)).rgb;
        vec3 tex = mix(t1, t2, 0.35);
        float lum = dot(tex, vec3(0.299, 0.587, 0.114));
        // The photo is a warm sandstone-ish grey; limestone is a cool pale grey.
        vec3 stone = mix(vec3(lum), tex, 0.28) * vec3(0.99, 1.0, 1.03);
        stone *= 1.38 * vRock.x;
        stone *= 1.0 + vRock.w * vec3(0.10, 0.04, -0.06);
        // Bedding grooves and joints in shadow.
        stone *= mix(0.42, 1.0, vRock.y);
        // Water streaks: dark stripes running down from the lip and overhangs, strongest near the top.
        float s = vRockUv.x;
        float streak = rn1(s * 0.9) * 0.6 + rn1(s * 0.23 + 7.0) * 0.4;
        streak = smoothstep(0.52, 0.8, streak) * exp(-vRock.z / 28.0) * (0.55 + 0.45 * rn1(s * 0.07 + 3.0));
        stone = mix(stone, vec3(0.13, 0.135, 0.12), streak * 0.82);
        // Lichen and moss: greener near the top and on anything facing up.
        vec3 li = texture2D(lichenMap, vRockUv / 3.7).rgb;
        float up = smoothstep(0.35, 0.8, vRockWorldN.y);
        float lichenW = clamp((1.0 - vRock.z / 6.0) * 0.35 + up * 0.5, 0.0, 0.7) * smoothstep(0.35, 0.65, rn1(s * 0.31 + vRockUv.y * 0.2));
        stone = mix(stone, li * 1.1, lichenW * 0.6);
        // Grass on ledges.
        stone = mix(stone, vec3(0.20, 0.26, 0.11), smoothstep(0.62, 0.9, vRockWorldN.y) * 0.85);
        diffuseColor.rgb *= stone;
      `);
  };
  m.customProgramCacheKey = () => 'limestone-face-v1';
  return m;
}
