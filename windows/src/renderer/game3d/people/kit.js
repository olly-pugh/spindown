// The cyclist's skin and kit, drawn per pixel. The body mesh carries its rest-pose position (`rest`) and how much
// each vertex belongs to the arms, legs, head and hands (`kit`); from those the shader decides, with crisp
// anti-aliased edges, where the jersey (with its pattern, side panels, collar, cuffs, zip and logos), the bib
// shorts (with leg grippers) and the socks are, and lets the MakeHuman skin texture show everywhere else.
// Seams, hems and fabric folds are bumped into the normal. One shader for every kit: kits only change uniforms.
import * as THREE from 'three';
import { skinTexture } from './assets.js';

export const PATTERNS = { plain: 0, band: 1, hoops: 2, stripes: 3, sash: 4, halves: 5, dots: 6 };

let logoTex = null;
/** White "SPINDOWN" wordmarks on transparent: row 0 wide (back, sleeves), row 1 small (chest). */
function logoTexture() {
  if (logoTex) return logoTex;
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 1024, 256);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'italic 900 104px "Segoe UI", Arial, sans-serif';
  g.fillText('SPINDOWN', 512, 64);
  g.font = 'italic 800 64px "Segoe UI", Arial, sans-serif';
  g.fillText('SPINDOWN', 512, 192);
  logoTex = new THREE.CanvasTexture(c);
  logoTex.anisotropy = 8;
  logoTex.flipY = false;
  return logoTex;
}

/** Average linear colour of each skin texture (filled in when it loads), so tints map it to a rider's tone. */
const skinMeans = new Map();
function skinMean(tex) {
  if (!skinMeans.has(tex)) {
    const mean = { value: new THREE.Color(0.62, 0.42, 0.33) };
    skinMeans.set(tex, mean);
    const measure = () => {
      const img = tex.image;
      if (!img || !img.width) return false;
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 32, 32);
      // Sample only the torso part of the pelt (it fills the middle of the texture).
      const d = g.getImageData(8, 8, 12, 10).data;
      const s = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k];
      const n = d.length / 4;
      mean.value.setRGB(s[0] / n / 255, s[1] / n / 255, s[2] / n / 255, THREE.SRGBColorSpace);
      return true;
    };
    if (!measure()) {
      const t = setInterval(() => { if (measure()) clearInterval(t); }, 200);
    }
  }
  return skinMeans.get(tex);
}

const toneOf = (hex) => {
  const c = new THREE.Color(hex);
  const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
  return l < 0.12 ? 'dark' : l < 0.3 ? 'mid' : 'light';
};

/**
 * Material for the body. kit: {jersey: {body, sleeve, accent, pattern}}, skin: hex, landmarks: from the pack.
 */
export function kitMaterial(kit, skin, landmarks, { beard = 0, hair = '#3a2718' } = {}) {
  const tex = skinTexture(toneOf(skin));
  const L = landmarks;
  const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const J = kit.jersey;
  const body = new THREE.Color(J.body), sleeve = new THREE.Color(J.sleeve), accent = new THREE.Color(J.accent);
  // Logo colour: the accent if it contrasts with the body, else white or near black.
  const lum = (c) => c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
  const logo = Math.abs(lum(accent) - lum(body)) > 0.15 ? accent.clone() : lum(body) > 0.4 ? new THREE.Color('#151515') : new THREE.Color('#f4f4f4');
  const uniforms = {
    uSkin: { value: tex },
    uSkinMean: skinMean(tex),
    uSkinTone: { value: new THREE.Color(skin) },
    uLogo: { value: logoTexture() },
    uBody: { value: body },
    uSleeve: { value: sleeve },
    uAccent: { value: accent },
    uLogoCol: { value: logo },
    uShorts: { value: new THREE.Color('#141518') },
    uSock: { value: new THREE.Color('#f1f1ee') },
    uPattern: { value: PATTERNS[J.pattern] ?? 0 },
    uBeard: { value: beard },
    uHairCol: { value: new THREE.Color(hair) },
    uShoulder: { value: v3(L.shoulderR) },
    uWrist: { value: v3(L.wristR) },
    uHip: { value: v3(L.hipR) },
    uAnkle: { value: v3(L.ankleR) },
    uNeck: { value: v3(L.neck) },
    uWaist: { value: v3(L.waist) },
  };
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 rest;
        attribute vec4 kit;
        varying vec3 vRest;
        varying vec4 vKit;
        varying vec2 vSkinUv;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vRest = rest;
        vKit = kit;
        vSkinUv = uv;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uSkin, uLogo;
        uniform vec3 uSkinMean, uSkinTone, uBody, uSleeve, uAccent, uLogoCol, uShorts, uSock;
        uniform float uPattern, uBeard;
        uniform vec3 uHairCol;
        uniform vec3 uShoulder, uWrist, uHip, uAnkle, uNeck, uWaist;
        varying vec3 vRest;
        varying vec4 vKit;
        varying vec2 vSkinUv;
        float kitRough;
        float kitHeight;
        float kitSheen;
        // Anti-aliased step: 0 below e, 1 above, over about a pixel.
        float aastep(float e, float x) { float w = max(fwidth(x), 1e-5) * 0.75; return smoothstep(e - w, e + w, x); }
        float band(float a, float b, float x) { return aastep(a, x) * (1.0 - aastep(b, x)); }
        vec3 kitColour(out float isKit) {
          vec3 p = vRest;
          vec3 q = vec3(abs(p.x), p.y, p.z);           // mirror onto the right side
          float side = sign(p.x + 1e-6);
          float armW = vKit.x, legW = vKit.y, headW = vKit.z, handW = vKit.w;
          // Along-limb coordinates.
          vec3 AS = uWrist - uShoulder;
          float armT = dot(q - uShoulder, AS) / dot(AS, AS);
          vec3 LS = uAnkle - uHip;
          float legT = dot(q - uHip, LS) / dot(LS, LS);
          float front = step(p.z, 0.0);               // the face looks down -z
          vec3 skinCol = texture2D(uSkin, vSkinUv).rgb;
          skinCol *= uSkinTone / max(uSkinMean, vec3(0.02));
          // Stubble or a beard: jaw, cheeks below the cheekbones, chin and upper lip; not the lips or nose.
          if (uBeard > 0.01 && headW > 0.5) {
            vec3 h = p - uNeck;                                   // relative to the base of the neck (rest pose)
            float ax = abs(h.x);
            float face = smoothstep(-0.02, -0.07, h.z);           // the front of the head
            float below = 1.0 - smoothstep(0.095, 0.115, h.y + max(0.0, ax - 0.035) * 0.9);   // under the cheekbones
            float jaw = smoothstep(0.015, 0.035, h.y);            // above the throat
            float lips = (1.0 - smoothstep(0.012, 0.03, length(vec2(h.x * 0.9, h.y - 0.072)))) * smoothstep(-0.115, -0.13, h.z);
            float nose = 1.0 - smoothstep(0.012, 0.02, length(vec2(h.x, (h.y - 0.1) * 0.6))) ;
            float m = face * below * jaw * (1.0 - lips) * (1.0 - nose * 0.0);
            m *= mix(0.78, 1.0, step(0.5, uBeard));               // stubble is lighter than a beard
            float grain = fract(sin(dot(floor(p.xy * 2600.0) + floor(p.z * 2600.0), vec2(12.9898, 78.233))) * 43758.5453);
            float amt = clamp(m * (0.6 + 0.4 * grain), 0.0, 1.0);
            skinCol = mix(skinCol, skinCol * mix(vec3(1.0), uHairCol * 2.4, 0.9), amt * mix(0.62, 0.9, step(0.5, uBeard)));
          }
          kitHeight = 0.0;
          kitSheen = 0.0;
          kitRough = 0.52;
          isKit = 0.0;
          // ---- Legs: shorts to the hem, skin, then socks ----
          float onLeg = aastep(0.5, legW);
          float hem = 0.37, sockTop = 0.84;
          float shortsLeg = 1.0 - aastep(hem, legT);
          float gripper = band(hem - 0.035, hem, legT);
          float sock = aastep(sockTop, legT);
          // ---- Torso: jersey above its hem, shorts below; jersey sleeves to the cuff ----
          float hemY = uHip.y + 0.035 + 0.012 * smoothstep(0.0, 0.08, p.z);
          float jerseyTorso = aastep(hemY, p.y);
          float neckTop = uNeck.y + 0.022 - 0.025 * front;   // collar: higher at the back
          float collar = band(neckTop - 0.018, neckTop, p.y) * (1.0 - onLeg);
          float aboveCollar = aastep(neckTop, p.y);
          float onArm = aastep(0.5, armW);
          float sleeveEnd = 0.36;
          float sleeve = (1.0 - aastep(sleeveEnd, armT)) * onArm;
          float cuff = band(sleeveEnd - 0.05, sleeveEnd, armT) * onArm;
          // Jersey coverage: torso (not legs, not head) or sleeve.
          float torso = (1.0 - onLeg) * (1.0 - onArm) * (1.0 - aboveCollar);
          float jersey = max(torso * jerseyTorso, sleeve);
          float shorts = max(torso * (1.0 - jerseyTorso), onLeg * shortsLeg);
          // ---- Jersey pattern ----
          float u = clamp((p.y - hemY) / (uNeck.y - hemY), 0.0, 1.0);   // waist 0 .. collar 1
          vec3 jc = mix(uBody, uSleeve, onArm);
          float acc = 0.0;
          if (uPattern > 0.5 && uPattern < 1.5) acc = band(0.52, 0.7, u) * (1.0 - onArm);
          else if (uPattern < 2.5 && uPattern > 1.5) acc = step(0.5, fract(u * 4.0)) * (1.0 - onArm);
          else if (uPattern < 3.5 && uPattern > 2.5) acc = (band(-0.022, 0.022, p.x) + band(0.07, 0.1, q.x)) * (1.0 - onArm);
          else if (uPattern < 4.5 && uPattern > 3.5) { float d = p.x * side * 0.0 + p.x - (u - 0.5) * 0.36 * (front * 2.0 - 1.0); acc = band(-0.055, 0.055, d) * (1.0 - onArm); }
          else if (uPattern < 5.5 && uPattern > 4.5) acc = aastep(0.0, p.x);
          else if (uPattern > 5.5) { vec2 g = vec2(p.x * 22.0, p.y * 22.0 + step(0.5, fract(p.x * 11.0)) * 0.5); vec2 f = fract(g) - 0.5; acc = 1.0 - aastep(0.26, length(f)); acc *= (1.0 - aastep(0.5, headW)); }
          jc = mix(jc, uAccent, clamp(acc, 0.0, 1.0));
          // Side panels: a shade darker down the flanks; collar and cuffs in the accent.
          float flank = aastep(0.112, q.x) * (1.0 - onArm) * (1.0 - aastep(0.62, u));
          jc *= 1.0 - 0.18 * flank;
          jc = mix(jc, uAccent, max(collar, cuff));
          // Zip down the front centre, three pockets at the back.
          float zip = band(-0.0025, 0.0025, p.x) * front * (1.0 - onArm) * torso * jerseyTorso;
          jc = mix(jc, jc * 0.35, zip);
          float pocketTop = hemY + 0.13;
          float pocket = (1.0 - front) * band(hemY + 0.01, pocketTop, p.y) * (1.0 - onArm);
          float pocketEdge = (1.0 - front) * band(pocketTop - 0.006, pocketTop, p.y) * (1.0 - onArm) * (1.0 - aastep(0.12, q.x));
          jc = mix(jc, jc * 0.82, pocketEdge);
          // Logos: across the upper back, on the right chest and down each sleeve.
          vec2 lb = vec2((p.x + 0.13) / 0.26, (p.y - (uNeck.y - 0.235)) / 0.07);
          float back = (1.0 - front) * (1.0 - onArm);
          float logo = 0.0;
          if (lb.x > 0.0 && lb.x < 1.0 && lb.y > 0.0 && lb.y < 1.0) logo = texture2D(uLogo, vec2(lb.x, (1.0 - lb.y) * 0.5)).a * back;
          vec2 lc = vec2((p.x - 0.035) / 0.1, (p.y - (uNeck.y - 0.16)) / 0.032);
          if (lc.x > 0.0 && lc.x < 1.0 && lc.y > 0.0 && lc.y < 1.0) logo = max(logo, texture2D(uLogo, vec2(lc.x, 0.5 + (1.0 - lc.y) * 0.5)).a * front * (1.0 - onArm));
          jc = mix(jc, uLogoCol, logo);
          // Shorts: black with a coloured gripper and a reflective stripe up the side of each leg.
          vec3 sc = uShorts;
          sc = mix(sc, uAccent, gripper * onLeg);
          float sideStripe = onLeg * band(-0.006, 0.006, (q.z - mix(uHip.z, uAnkle.z, legT)) ) * (1.0 - aastep(hem - 0.04, legT)) * step(uHip.x, q.x - 0.03);
          sc = mix(sc, vec3(0.45), sideStripe);
          // Socks: white with an accent stripe at the top.
          vec3 sk = mix(uSock, uAccent, band(sockTop + 0.015, sockTop + 0.035, legT));
          // ---- Compose ----
          vec3 col = skinCol;
          float sockM = sock * onLeg;
          col = mix(col, sk, sockM);
          col = mix(col, sc, shorts);
          col = mix(col, jc, jersey);
          isKit = clamp(jersey + shorts + sockM, 0.0, 1.0);
          kitRough = mix(0.5, mix(0.56, 0.4, shorts), isKit);
          kitRough = mix(kitRough, 0.85, sockM);
          kitRough = mix(kitRough, 0.35, logo * jersey);
          kitSheen = isKit * (1.0 - sockM);
          // Bump: hems stand proud of the skin, seams are grooves, folds ripple across the stomach.
          kitHeight += 0.0012 * isKit;
          kitHeight += 0.0008 * (gripper * onLeg + cuff + collar);
          kitHeight -= 0.0006 * pocketEdge * torso;
          kitHeight -= 0.0004 * zip;
          float folds = front * (1.0 - onArm) * jerseyTorso * smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.25, 0.45, u));
          kitHeight += 0.0009 * folds * sin(p.y * 160.0 + sin(p.x * 30.0) * 1.5);
          float lowerBack = (1.0 - front) * jerseyTorso * (1.0 - smoothstep(0.1, 0.3, u)) * (1.0 - onArm);
          kitHeight += 0.0006 * lowerBack * sin(p.y * 210.0 + p.x * 20.0);
          return col;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float isKit;
        diffuseColor.rgb = kitColour(isKit);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = kitRough;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // Bump from kitHeight (metres) using screen-space derivatives.
          vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
          float dhx = dFdx(kitHeight), dhy = dFdy(kitHeight);
          vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
          float det = dot(dpdx, r1);
          vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
          normal = normalize(abs(det) * normal - grad * 1.0);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // Lycra sheen: a soft lift at grazing angles.
          float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
          totalEmissiveRadiance += diffuseColor.rgb * kitSheen * fres * 0.18;
        }`);
  };
  m.customProgramCacheKey = () => 'spindown-kit-v2';
  return m;
}
