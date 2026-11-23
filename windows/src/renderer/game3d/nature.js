// Natural materials and objects for the real-world landscapes: limestone faces, close-up ground textures, rocks
// and boulders, scree, becks and tarns, grass, rushes and bracken near the camera.
//
// Photographic textures from Poly Haven (https://polyhaven.com), all CC0 (public domain): "Rock Boulder Dry",
// "Mossy Rock", "Grass Ground", "Rocky Terrain 02", "Sparse Grass", "Gray Rocks" and "River Small Rocks".
import * as THREE from 'three';
import limestoneUrl from './data/tex/limestone.jpg';
import limestoneNormalUrl from './data/tex/limestone-n.jpg';
import lichenUrl from './data/tex/lichen.jpg';

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
