// Mark Potts's fire trail: roaring flames off his back wheel, a 20-40 m streak of fire burning on the road behind
// him, a glow on the tarmac, sparks flying off and smoke rolling up. One instanced draw call: each particle is a
// quad whose spawn point and time are written once into a ring buffer when it is emitted; the vertex shader moves,
// grows, fades and flickers it from the shared clock, so per frame the CPU only writes the few new particles
// (no allocation). Fire is drawn additively and smoke as ordinary transparency in the same pass, using
// premultiplied alpha. On medium and high graphics a point light rides with him to light the road and riders
// nearby; it is always in the scene (adding or removing a light would recompile every shader).
import * as THREE from 'three';

const N = 2048; // ring buffer of particles
const FLAME = 0, STREAK = 1, GLOW = 2, SPARK = 3, SMOKE = 4, BURN = 5;
/** Emission per metre ridden and per second, by kind. */
const PER_M = [2.2, 17, 1.8, 2.2, 1.5, 3.4];
const PER_S = [50, 8, 3, 26, 12, 4];

const vertexShader = /* glsl */ `
uniform float uTime;
attribute vec4 aSpawn; // world xyz, spawn time
attribute vec4 aParam; // life (s), seed 0..1, kind, size (m)
attribute vec3 aVel;   // m/s
varying vec2 vUv;
varying float vAge;
varying float vKind;
varying float vSeed;
varying float vFade;
void main() {
  float life = aParam.x, seed = aParam.y, kind = aParam.z, size = aParam.w;
  float t = uTime - aSpawn.w;
  float age = t / life;
  vUv = uv; vAge = age; vKind = kind; vSeed = seed; vFade = 0.0;
  if (age < 0.0 || age >= 1.0 || life <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec3 c = aSpawn.xyz + (kind > 4.5 ? vec3(0.0) : aVel * t);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec2 q = position.xy;
  float flick = 0.8 + 0.2 * sin(uTime * 41.0 + seed * 71.0) * sin(uTime * 17.0 + seed * 13.0);
  vec3 p;
  // Turbulence: the fire sways and churns as it goes.
  vec3 sway = right * (sin(uTime * 5.3 + seed * 23.0) * 0.6 + sin(uTime * 11.7 + seed * 7.0) * 0.4) * 0.12 * age;
  if (kind < 0.5) {
    // Flames pouring off the back wheel: growing as they stream back, kept below his back.
    float w = size * (0.8 + 0.5 * age) * flick;
    float h = size * 2.1 * (0.45 + 0.75 * age) * (0.85 + 0.3 * flick);
    p = c + sway + right * q.x * w + up * (q.y + 0.5) * h;
  } else if (kind < 1.5) {
    // The burning streak: two lines of flame along his tyre tracks, dying down along the trail.
    float k = 1.0 - age;
    float w = size * (0.6 + 0.4 * k);
    float h = size * 2.2 * (0.3 + 0.7 * k * sqrt(k)) * flick;
    p = c + sway + right * q.x * w + up * (q.y + 0.5) * h;
  } else if (kind > 4.5) {
    // A ribbon of fire lying on the road along the line he rode (aVel holds the direction of travel here).
    vec3 fwd = normalize(vec3(aVel.x, 0.0, aVel.z) + vec3(1e-4, 0.0, 0.0));
    vec3 side = vec3(-fwd.z, 0.0, fwd.x);
    p = c + fwd * q.y * size * 2.6 + side * q.x * size * (1.0 - 0.3 * age) + up * 0.04;
  } else if (kind < 2.5) {
    // Glow on the road surface.
    float s = size * (1.0 + 0.4 * age);
    p = c + vec3(q.x * s, 0.05, q.y * s);
  } else if (kind < 3.5) {
    // Sparks, under a little gravity, stretched along their flight.
    c.y -= 3.0 * t * t;
    p = c + right * q.x * size + camUp * q.y * size * 3.0;
  } else {
    // Smoke, billowing out as it rises.
    float s = size * (0.5 + 2.0 * age);
    p = c + sway * 3.0 + right * q.x * s + camUp * q.y * s;
  }
  vec4 mv = viewMatrix * vec4(p, 1.0);
  // Fade out far away, and right in front of the lens (the side camera stands close to his line).
  vFade = (1.0 - smoothstep(220.0, 380.0, -mv.z)) * smoothstep(1.2, 4.5, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const fragmentShader = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vAge;
varying float vKind;
varying float vSeed;
varying float vFade;
vec3 fireRamp(float h) {
  vec3 c = mix(vec3(0.45, 0.02, 0.0), vec3(1.0, 0.28, 0.02), smoothstep(0.0, 0.4, h));
  c = mix(c, vec3(1.0, 0.72, 0.18), smoothstep(0.35, 0.75, h));
  return mix(c, vec3(1.0, 0.98, 0.88), smoothstep(0.75, 1.0, h));
}
void main() {
  vec2 uv = vUv - 0.5;
  float y = vUv.y;
  vec4 o;
  if (vKind < 1.5) {
    // A flame tongue: broad at the base, licking to a point, wobbling as it goes.
    float wob = sin(y * 9.0 - uTime * 19.0 + vSeed * 40.0) * 0.1 * y + sin(y * 4.0 - uTime * 7.0 + vSeed * 9.0) * 0.06 * y;
    float x = (uv.x + wob) / max(0.04, 1.0 - y * 0.92);
    float soft = 0.08 + 0.3 * vAge;
    float body = smoothstep(0.5, soft, abs(x)) * smoothstep(0.0, 0.1 + 0.2 * vAge, y) * smoothstep(1.0, 0.4 - 0.2 * vAge, y);
    float core = vKind < 0.5 ? 1.35 : 1.05;
    float heat = body * (1.0 - vAge * 0.85) * (1.2 - y * 0.75) * core;
    vec3 col = fireRamp(clamp(heat, 0.0, 1.0)) * body * (vKind < 0.5 ? 1.5 : 1.1) * smoothstep(1.0, 0.55, vAge);
    o = vec4(col, 0.0);
  } else if (vKind > 4.5) {
    // Fire burning flat on the tarmac: hot in the middle of the band, flickering along it.
    float across = 1.0 - abs(uv.x) * 2.0;
    float along = 1.0 - abs(uv.y) * 2.0;
    float n = 0.65 + 0.35 * sin(uv.y * 23.0 + uTime * 13.0 + vSeed * 50.0) * sin(uv.x * 9.0 - uTime * 7.0 + vSeed * 20.0);
    float m = smoothstep(0.0, 0.7, across) * smoothstep(0.0, 0.35, along) * n;
    float heat = m * (1.05 - vAge * 0.9);
    o = vec4(fireRamp(clamp(heat, 0.0, 1.0)) * m * 0.75 * (1.0 - vAge * vAge), 0.0);
  } else if (vKind < 2.5) {
    float r = length(uv) * 2.0;
    float g = (1.0 - r) * (1.0 - r) * step(r, 1.0) * (1.0 - vAge * vAge) * 0.6;
    o = vec4(vec3(1.0, 0.34, 0.04) * g, 0.0);
  } else if (vKind < 3.5) {
    float r = length(uv) * 2.0;
    float g = smoothstep(1.0, 0.0, r) * (1.0 - vAge);
    o = vec4(vec3(1.0, 0.8, 0.35) * g * 3.5, 0.0);
  } else {
    float r = length(uv) * 2.0;
    float a = smoothstep(1.0, 0.1, r) * 0.6 * smoothstep(0.0, 0.1, vAge) * (1.0 - vAge);
    vec3 col = mix(vec3(0.24, 0.14, 0.08), vec3(0.1, 0.1, 0.1), smoothstep(0.0, 0.3, vAge));
    o = vec4(col * a, a);
  }
  gl_FragColor = o * vFade;
}`;

/** Centre-line position (and the frame's heading) at distance d, without allocating. */
function centre(route, d, out) {
  const L = route.length;
  const t = (((d % L) + L) % L) / route.step;
  const i = Math.min(route.count - 1, Math.floor(t));
  const f = t - i;
  out.x = route.xs[i] + (route.xs[i + 1] - route.xs[i]) * f;
  out.y = route.ys[i] + (route.ys[i + 1] - route.ys[i]) * f;
  out.z = route.zs[i] + (route.zs[i + 1] - route.zs[i]) * f;
  return out;
}

function upload(attr, size, all, lo, hi) {
  attr.clearUpdateRanges();
  if (all) attr.addUpdateRange(0, N * size);
  else attr.addUpdateRange(lo * size, (hi - lo + 1) * size);
  attr.needsUpdate = true;
}

export class FlameTrail {
  /** scene: THREE.Scene; time: {value} shared clock; light: whether to add the point light (medium/high). */
  constructor(scene, time, { light = true } = {}) {
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    g.setAttribute('uv', base.attributes.uv);
    this.spawn = new Float32Array(N * 4);
    this.param = new Float32Array(N * 4);
    this.vel = new Float32Array(N * 3);
    this.aSpawn = new THREE.InstancedBufferAttribute(this.spawn, 4).setUsage(THREE.DynamicDrawUsage);
    this.aParam = new THREE.InstancedBufferAttribute(this.param, 4).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aSpawn', this.aSpawn);
    g.setAttribute('aParam', this.aParam);
    g.setAttribute('aVel', this.aVel);
    g.instanceCount = N;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: time },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide, // the flat quads on the road face down as built
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
    if (light) {
      this.light = new THREE.PointLight('#ff7a1c', 0, 16, 1.6);
      scene.add(this.light);
    }
    this.scene = scene;
    this.time = time;
    this.head = 0;
    this.lastD = null;
    this.carry = new Float32Array(5);
    this._a = { x: 0, y: 0, z: 0 };
    this._b = { x: 0, y: 0, z: 0 };
    this._c = { x: 0, y: 0, z: 0 };
  }

  /** rider: the sim rider on fire; camera: for range checks; dt: game seconds since last frame. */
  update(route, rider, camera, dt) {
    const now = this.time.value;
    const c = centre(route, rider.d, this._c);
    const dx = c.x - camera.position.x, dz = c.z - camera.position.z;
    const near = !rider.hidden && dx * dx + dz * dz < 450 * 450;
    if (this.light) {
      if (near && dx * dx + dz * dz < 90 * 90) {
        const flick = 0.8 + 0.2 * Math.sin(now * 37) * Math.sin(now * 11.3);
        this.light.intensity = 55 * flick;
      } else this.light.intensity = 0;
    }
    if (!near || !(dt > 0)) {
      if (!near) this.lastD = null;
      return;
    }
    // Heading from the road either side (forward = (fx, fz), right = (−fz, fx)).
    const a = centre(route, rider.d - 4, this._a), b = centre(route, rider.d + 4, this._b);
    let fx = b.x - a.x, fz = b.z - a.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    const rx = -fz, rz = fx;
    const v = Math.max(0, rider.v);
    const from = this.lastD == null || Math.abs(rider.d - this.lastD) > 60 ? rider.d - v * dt : this.lastD;
    const moved = rider.d - from;
    this.lastD = rider.d;
    if (this.light) {
      const rear = centre(route, rider.d - 2.2, this._a);
      this.light.position.set(rear.x + rx * rider.lateral, rear.y + 0.9, rear.z + rz * rider.lateral);
    }
    // Trail length grows with speed: 20 m when slow, 40 m flat out.
    const trail = Math.min(40, Math.max(20, v * 2.6));
    const streakLife = Math.min(3.2, Math.max(1.0, trail / Math.max(v, 5)));
    let lo = N, hi = -1, wrapped = false;
    for (let kind = 0; kind < 6; kind++) {
      this.carry[kind] += PER_M[kind] * moved + PER_S[kind] * dt;
      let n = Math.floor(this.carry[kind]);
      this.carry[kind] -= n;
      n = Math.min(n, 160);
      for (let k = 0; k < n; k++) {
        const f = (k + Math.random()) / n;
        const d = from + moved * f;
        const R = Math.random;
        const seed = R();
        let lat = rider.lateral, back = 0.45, up = 0.05, life = 1, size = 1, vx = 0, vy = 0, vz = 0, vf = 0;
        switch (kind) {
          case FLAME: back = 0.6 + R() * 0.5; lat += (R() - 0.5) * 0.45; up = 0.02 + R() * 0.2; life = 0.3 + R() * 0.3; size = 0.3 + R() * 0.3; vf = v * (0.25 + R() * 0.3); vy = 0.4 + R() * 0.6; break;
          case STREAK: back = 0.9 + R() * 0.3; lat += (k & 1 ? 0.22 : -0.22) + (R() - 0.5) * 0.2; life = streakLife * (0.8 + R() * 0.3); size = 0.28 + R() * 0.3; break;
          case BURN: back = 1.2; up = 0.12; lat += (R() - 0.5) * 0.12; life = streakLife * (1.0 + R() * 0.2); size = 0.75 + R() * 0.3; vx = 0; vy = 0; break;
          case GLOW: back = 2; up = 0.12; lat += (R() - 0.5) * 0.4; life = streakLife; size = 3.2 + R() * 1.6; break;
          case SPARK: back = 0.4 + R() * 0.4; up = 0.3 + R() * 0.4; life = 0.5 + R() * 0.7; size = 0.035 + R() * 0.03; vf = v * (0.35 + R() * 0.5); vy = 1.5 + R() * 3.5; vx = (R() - 0.5) * 4; break;
          default: back = 2 + R() * 3; up = 1.2 + R() * 0.6; life = 1.8 + R() * 1.6; size = 0.9 + R() * 0.8; vf = v * 0.12; vy = 1.1 + R() * 1.0; vx = (R() - 0.5) * 1.2;
        }
        const p = centre(route, d - back, this._a);
        const i = this.head;
        this.head = (this.head + 1) % N;
        if (this.head === 0) wrapped = true;
        lo = Math.min(lo, i);
        hi = Math.max(hi, i);
        this.spawn[i * 4] = p.x + rx * lat;
        this.spawn[i * 4 + 1] = p.y + up;
        this.spawn[i * 4 + 2] = p.z + rz * lat;
        this.spawn[i * 4 + 3] = now - dt * (1 - f);
        this.param[i * 4] = life;
        this.param[i * 4 + 1] = seed;
        this.param[i * 4 + 2] = kind;
        this.param[i * 4 + 3] = size;
        this.vel[i * 3] = kind === BURN ? fx : fx * vf + rx * vx;
        this.vel[i * 3 + 1] = vy;
        this.vel[i * 3 + 2] = kind === BURN ? fz : fz * vf + rz * vx;
      }
    }
    if (hi < 0) return;
    // Upload only what changed (the whole buffer if the ring wrapped this frame).
    upload(this.aSpawn, 4, wrapped, lo, hi);
    upload(this.aParam, 4, wrapped, lo, hi);
    upload(this.aVel, 3, wrapped, lo, hi);
  }

  dispose() {
    this.scene.remove(this.mesh);
    if (this.light) this.scene.remove(this.light);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
