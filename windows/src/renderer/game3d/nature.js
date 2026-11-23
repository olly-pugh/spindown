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
    for (let i = 0; i < data.length; i += 4) data.set(fill, i);
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
        vec3 li = texture2D(lichenMap, vBWorld.xz / 2.3).rgb;
        stone = mix(stone, li, smoothstep(0.5, 0.95, vBNormal.y) * 0.45);
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
