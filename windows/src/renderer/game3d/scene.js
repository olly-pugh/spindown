// The 3D view of Spindown World: renderer, sky and sun, fog, weather, cameras, riders and power-up tokens.
// It only draws what the simulation (core/world/sim.js) says; it never changes the ride or the recording.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RiderModel } from './rider.js';
import { FlameTrail } from './flames.js';
import { PacerLabels } from './pacerlabels.js';
import { buildDales } from './dales.js';
import { buildYork } from './york.js';
import * as C from './common.js';
import { CROWD_TIME, CROWD_CAMERA, setCrowdDetail } from './crowd.js';
import * as T from './textures.js';
import { POWERUPS, PACERS } from '../../core/world/content.js';

export const QUALITY = {
  low: { pixelRatio: 0.75, shadows: false, shadowSize: 0, antialias: false, terrainStep: 16, treeDensity: 0.4, maxTrees: 1200, sceneryRadius: 300, far: 2600, fogNear: 120, fogFar: 1300, texDetail: 0.5 },
  medium: { pixelRatio: 1, shadows: true, shadowSize: 2048, antialias: true, terrainStep: 12, treeDensity: 0.75, maxTrees: 2600, sceneryRadius: 450, far: 5000, fogNear: 220, fogFar: 2600, texDetail: 1 },
  high: { pixelRatio: 1.5, shadows: true, shadowSize: 4096, antialias: true, terrainStep: 10, treeDensity: 1, maxTrees: 4200, sceneryRadius: 600, far: 7000, fogNear: 300, fogFar: 3800, texDetail: 1 },
};
// Natural ground cover near the camera (groundcover.js): detail level (0 verge grass and boulders only, 1, 2) and
// how far plants and boulders reach (metres).
Object.assign(QUALITY.low, { cover: 0, coverRadius: 28, rockRadius: 90 });
Object.assign(QUALITY.medium, { cover: 1, coverRadius: 45, rockRadius: 140 });
Object.assign(QUALITY.high, { cover: 2, coverRadius: 65, rockRadius: 200 });

/** Sun position and light colour for each time of day; weather tweaks haze and light. */
const TIMES = {
  morning: { elevation: 24, azimuth: 115, sun: '#fff0d2', intensity: 5.6, hemi: 0.62, turbidity: 5, rayleigh: 1.5, exposure: 0.5, fog: '#c6d9e6' },
  midday: { elevation: 52, azimuth: 175, sun: '#fffaf0', intensity: 6.0, hemi: 0.68, turbidity: 4, rayleigh: 1.2, exposure: 0.47, fog: '#c2d8ea' },
  evening: { elevation: 9, azimuth: 255, sun: '#ffc27e', intensity: 5.4, hemi: 0.5, turbidity: 8, rayleigh: 2.4, exposure: 0.58, fog: '#e6bd98' },
};

export class WorldScene {
  constructor(canvas, { quality = 'medium' } = {}) {
    this.canvas = canvas;
    this.qualityName = quality;
    this.q = QUALITY[quality] ?? QUALITY.medium;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.q.antialias, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = this.q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.q.pixelRatio));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.15, this.q.far);
    this.riders = new Map(); // sim rider id -> RiderModel
    this.cameraMode = 'chase';
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camInit = false;
    this.cinematic = { mode: 'side', since: 0 };
    this.tokens = [];
    this.time = 0;
    this.rain = null;

    // Lights.
    this.sun = new THREE.DirectionalLight('#ffffff', 2.6);
    this.sun.castShadow = this.q.shadows;
    if (this.q.shadows) {
      this.sun.shadow.mapSize.set(this.q.shadowSize, this.q.shadowSize);
      const s = this.sun.shadow.camera;
      s.left = -70;
      s.right = 70;
      s.top = 70;
      s.bottom = -70;
      s.near = 1;
      s.far = 600;
      s.updateProjectionMatrix();
      this.sun.shadow.bias = -0.0003;
      this.sun.shadow.normalBias = 0.05;
    }
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight('#d6e6ff', '#7a7458', 0.7);
    this.scene.add(this.hemi);

    // Sky.
    this.sky = new Sky();
    this.sky.scale.setScalar(this.q.far * 0.9);
    this.scene.add(this.sky);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.skyScene = new THREE.Scene();
    this.envTarget = null;

    // Rider effects: Mark Potts's fire (its light only on medium and high) and the pacers' labels.
    this.effectsGroup = new THREE.Group();
    this.scene.add(this.effectsGroup);
    this.flames = new FlameTrail(this.effectsGroup, CROWD_TIME, { light: quality !== 'low' });
    this.flameRider = null;
    this.pacerLabels = new PacerLabels(this.effectsGroup, PACERS);
  }

  /** Builds a world. route from worlds.js; data: the map data for that world. Returns stats for diagnostics. */
  setWorld(route, data) {
    if (this.world) {
      this.scene.remove(this.world.group);
      disposeTree(this.world.group);
    }
    const t0 = performance.now();
    T.setDetail(this.q.texDetail ?? 1);
    setCrowdDetail(this.qualityName);
    this.route = route;
    this.world = route.world === 'york' ? buildYork(route, data, this.q) : buildDales(route, data, this.q);
    this.scene.add(this.world.group);
    // Power-up tokens at the spots.
    for (const t of this.tokens) this.scene.remove(t);
    this.tokens = route.powerupSpots.map((at, i) => {
      const tok = C.powerupToken();
      const lateral = [-1.2, 0, 1.2][i % 3];
      const p = route.position(at, lateral);
      tok.position.set(p.x, p.y, p.z);
      tok.userData.at = at;
      this.scene.add(tok);
      return tok;
    });
    this.buildMs = Math.round(performance.now() - t0);
    this.camInit = false;
    return { buildMs: this.buildMs, buildings: this.world.buildingCount ?? 0 };
  }

  /** time: 'morning'|'midday'|'evening'; weather: 'fair'|'overcast'|'rain'. */
  setAtmosphere(time = 'morning', weather = 'fair') {
    const t = TIMES[time] ?? TIMES.morning;
    const overcast = weather !== 'fair';
    const u = this.sky.material.uniforms;
    u.turbidity.value = overcast ? 14 : t.turbidity;
    u.rayleigh.value = overcast ? 0.6 : t.rayleigh;
    u.mieCoefficient.value = overcast ? 0.02 : 0.005;
    u.mieDirectionalG.value = 0.8;
    if (u.cloudCoverage) {
      u.cloudCoverage.value = weather === 'rain' ? 0.95 : overcast ? 0.85 : time === 'evening' ? 0.5 : 0.42;
      u.cloudDensity.value = overcast ? 0.75 : 0.5;
    }
    const phi = THREE.MathUtils.degToRad(90 - t.elevation), theta = THREE.MathUtils.degToRad(t.azimuth);
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);
    this.sun.color.set(t.sun);
    this.sun.intensity = overcast ? t.intensity * 0.22 : t.intensity;
    this.hemi.intensity = overcast ? t.hemi * 2.6 : t.hemi;
    this.renderer.toneMappingExposure = overcast ? t.exposure * 1.15 : t.exposure;
    // Environment lighting from the sky, for reflections on water and bikes.
    this.skyScene.clear();
    const skyCopy = new Sky();
    skyCopy.material.uniforms = THREE.UniformsUtils.clone(u);
    skyCopy.scale.setScalar(1000);
    this.skyScene.add(skyCopy);
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = this.pmrem.fromScene(this.skyScene, 0, 0.1, 2000);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = overcast ? 0.75 : 0.5;
    // Fog matched to the horizon.
    const fogColour = new THREE.Color(overcast ? '#b1b8be' : t.fog);
    this.scene.fog = new THREE.Fog(fogColour, this.q.fogNear * (weather === 'rain' ? 0.5 : 1), this.q.fogFar * (weather === 'rain' ? 0.45 : overcast ? 0.7 : 1));
    this.scene.background = null;
    this.world?.atmosphere?.(this); // per-world haze and draw distance (the Dales' distant fells)
    // Rain streaks near the camera.
    if (this.rain) {
      this.scene.remove(this.rain);
      this.rain.geometry.dispose();
      this.rain = null;
    }
    if (weather === 'rain') {
      const n = 2500, pos = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) {
        const x = (Math.random() - 0.5) * 60, y = Math.random() * 30, z = (Math.random() - 0.5) * 60;
        pos.set([x, y, z, x + 0.05, y - 0.7, z], i * 6);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#c9d4dc', transparent: true, opacity: 0.45 }));
      this.rain.frustumCulled = false;
      this.scene.add(this.rain);
    }
    this.atmosphere = { time, weather };
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio()) || this.canvas.height !== Math.round(h * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Creates or updates a model for every rider in the simulation. */
  syncRiders(sim) {
    const seen = new Set();
    const p = {};
    this.flameRider = null;
    this.pacerLabels.begin();
    for (const r of sim.riders) {
      seen.add(r.id);
      if (r.flames) this.flameRider = r;
      let model = this.riders.get(r.id);
      if (!model || model.kitKey !== kitKey(r.kit)) {
        if (model) {
          this.scene.remove(model.root);
          model.dispose();
        }
        model = new RiderModel(r.kit, { ghost: r.isGhost || !!r.pacer, ghostColour: r.pacer?.color ?? null, shadows: this.q.shadows, skin: skinFor(r.id), hair: hairFor(r.id), body: bodyFor(r) });
        model.pacer = !!r.pacer;
        model.kitKey = kitKey(r.kit);
        // Builds: Big Bird is tall (and rides a bigger bike), Barrel Rider is broad.
        if (r.build === 'tall') model.root.scale.setScalar(1.12);
        else if (r.build === 'broad') model.root.scale.set(1.3, 1.02, 1.08);
        this.riders.set(r.id, model);
        this.scene.add(model.root);
      }
      model.root.visible = !r.hidden;
      this.route.position(r.d, r.lateral, p);
      model.root.position.set(p.x, p.y + 0.06, p.z);
      // Pitch with the gradient, yaw along the road.
      const g = this.route.gradient(r.d);
      model.root.rotation.set(Math.atan(g), -p.heading, 0, 'YXZ');
      model.setPose(r.crank, r.wheel, r.lean);
      if (r.pacer && !r.hidden) this.pacerLabels.place(PACERS.indexOf(r.pacer), p.x, p.y + 1.85, p.z);
    }
    this.pacerLabels.end(this.camera);
    // Full detail for the riders nearest the camera; the rest use the lighter body. Pacer ghosts take no detailed
    // slot: they use the middle level within 28 m and the light one beyond.
    const cam = this.camera.position;
    const near = [];
    for (const m of this.riders.values()) {
      if (!m.root.visible) continue;
      const d2 = m.root.position.distanceToSquared(cam);
      if (m.pacer) m.setDetail(d2 < 28 * 28, Math.sqrt(d2));
      else near.push([m, d2]);
    }
    near.sort((a, b) => a[1] - b[1]);
    // Low: the nearest two riders (your own among them) get the middle level at most.
    const low = this.qualityName === 'low';
    const limit = low ? 2 : this.qualityName === 'high' ? 10 : 6;
    near.forEach(([m, d2], i) => {
      m.setDetail(i < limit && d2 < 28 * 28, low ? Infinity : Math.sqrt(d2) * (this.qualityName === 'high' ? 0.7 : 1));
      // Sun shadows only within 35 m (the shadow map covers 70 m either way; beyond, the blob is enough).
      m.setShadow(d2 < 35 * 35);
    });
    for (const [id, model] of this.riders) {
      if (!seen.has(id)) {
        this.scene.remove(model.root);
        model.dispose();
        this.riders.delete(id);
      }
    }
  }

  /** Camera modes: chase, close, first, side, aerial, cinematic. */
  updateCamera(sim, dt) {
    const pl = sim.player;
    const route = this.route;
    let mode = this.cameraMode;
    if (mode === 'cinematic') {
      this.cinematic.since += dt;
      if (this.cinematic.since > 9) {
        const order = ['side', 'front', 'aerial', 'chase', 'low'];
        this.cinematic.mode = order[(order.indexOf(this.cinematic.mode) + 1) % order.length];
        this.cinematic.since = 0;
        this.camInit = false;
      }
      mode = this.cinematic.mode;
    }
    const at = route.position(pl.d, pl.lateral);
    const look = new THREE.Vector3(at.x, at.y + 1.1, at.z);
    let want;
    const behind = (dist, up, lateral = 0) => {
      const b = route.position(pl.d - dist, pl.lateral + lateral);
      return new THREE.Vector3(b.x, Math.max(b.y, at.y) + up, b.z);
    };
    switch (mode) {
      case 'close': want = behind(3.4, 1.65); break;
      case 'first': {
        const e = route.position(pl.d + 0.1, pl.lateral);
        want = new THREE.Vector3(e.x, e.y + 1.62, e.z);
        const ahead = route.position(pl.d + 18, pl.lateral);
        look.set(ahead.x, ahead.y + 1.2, ahead.z);
        break;
      }
      case 'side': {
        // From across the road (spectators stand on the right-hand pavement).
        const s = route.position(pl.d + 1, -(this.world.roadHalf ?? 3) + 0.6);
        want = new THREE.Vector3(s.x, s.y + 1.3, s.z);
        break;
      }
      case 'front': {
        const f = route.position(pl.d + 7, pl.lateral - 1.2);
        want = new THREE.Vector3(f.x, f.y + 1.3, f.z);
        break;
      }
      case 'low': want = behind(2.2, 0.55, 1.4); break;
      case 'aerial': want = behind(28, 24); look.y -= 0.5; break;
      default: want = behind(6.2, 2.5);
    }
    if (mode !== 'first') {
      // Look a little ahead of the rider.
      const ahead = route.position(pl.d + 8, pl.lateral);
      look.lerp(new THREE.Vector3(ahead.x, ahead.y + 1.0, ahead.z), mode === 'chase' || mode === 'close' ? 0.35 : 0);
    }
    // Keep the camera above the ground (Dales slopes).
    const ground = this.world.heightAt(want.x, want.z);
    if (want.y < ground + 0.8) want.y = ground + 0.8;
    // A camera cut: show and hide scenery chunks for the new view this frame (the crowd picks each person's
    // level of detail from the camera, so stale chunk visibility would leave nearby people missing).
    if (!this.camInit) this.cullTimer = 0;
    const k = this.camInit ? 1 - Math.exp(-dt * (mode === 'first' ? 30 : 6)) : 1;
    this.camPos.lerp(want, k);
    this.camLook.lerp(look, this.camInit ? 1 - Math.exp(-dt * 10) : 1);
    this.camInit = true;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    // Hide your own rider's head in first person.
    const model = this.riders.get(pl.id);
    if (model) model.root.visible = mode !== 'first';
    // Sun and shadow box follow the rider.
    if (this.sunDir) {
      this.sun.position.set(at.x + this.sunDir.x * 200, at.y + this.sunDir.y * 200, at.z + this.sunDir.z * 200);
      this.sun.target.position.set(at.x, at.y, at.z);
    }
    this.sky.position.copy(this.camera.position);
    // Keep the shadow map still as the rider moves: snap the sun's target to whole shadow texels.
    if (this.sunDir && this.q.shadows) {
      const snap = 140 / this.q.shadowSize * 4;
      const tx = Math.round(at.x / snap) * snap, tz = Math.round(at.z / snap) * snap;
      this.sun.position.set(tx + this.sunDir.x * 200, at.y + this.sunDir.y * 200, tz + this.sunDir.z * 200);
      this.sun.target.position.set(tx, at.y, tz);
    }
    this.cullTimer = (this.cullTimer ?? 0) - dt;
    if (this.cullTimer <= 0) {
      this.cullTimer = 0.4;
      C.cullChunks(this.world.group, this.camera);
    }
    if (this.rain) this.rain.position.set(this.camera.position.x, this.camera.position.y - 10, this.camera.position.z);
  }

  /** Spins power-up tokens; hides the one the player just took until they come round again. */
  updateTokens(sim, dt) {
    this.time += dt;
    CROWD_TIME.value = this.time;
    CROWD_CAMERA.value.copy(this.camera.position);
    if (this.flameRider) this.flames.update(sim.route, this.flameRider, this.camera, dt);
    else if (this.flames.light) this.flames.light.intensity = 0;
    this.world?.update?.(this.time, this.camera);
    const skyU = this.sky.material.uniforms;
    if (skyU.time) skyU.time.value = this.time;
    const lapPos = sim.route.wrap(sim.player.d);
    this.tokens.forEach((t, i) => {
      t.userData.ring.rotation.y = this.time * 2 + i;
      t.position.y = sim.route.elevation(t.userData.at) + Math.sin(this.time * 2 + i) * 0.12;
      const behind = lapPos - t.userData.at;
      t.visible = !(sim.player.lastSpot === i && behind > 0 && behind < 400);
      if (!t.userData.icon) {
        t.userData.icon = POWERUPS[i % POWERUPS.length].icon;
        t.userData.draw('🎁');
      }
    });
    if (this.rain) {
      const a = this.rain.geometry.attributes.position;
      for (let i = 0; i < a.count; i += 2) {
        let y = a.getY(i) - dt * 22;
        if (y < 0) y += 30;
        a.setY(i, y);
        a.setY(i + 1, y - 0.7);
      }
      a.needsUpdate = true;
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Screen position (CSS px) of a point above a rider's head, or null if behind the camera / off screen. */
  project(sim, rider, out = {}) {
    const p = this.route.position(rider.d, rider.lateral);
    const v = new THREE.Vector3(p.x, p.y + 2.1, p.z).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    out.x = (v.x * 0.5 + 0.5) * w;
    out.y = (-v.y * 0.5 + 0.5) * h;
    out.distance = this.camera.position.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
    if (out.x < -50 || out.x > w + 50 || out.y < -50 || out.y > h + 50) return null;
    return out;
  }

  /** Mean brightness and variety of the last frame (for automated checks that something is drawn). */
  pixelStats() {
    this.render(); // the drawing buffer is cleared after each presented frame, so draw one to read back
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(4 * 64);
    let sum = 0, min = 255, max = 0;
    for (let i = 0; i < 8; i++) {
      gl.readPixels(Math.floor((w * (i + 0.5)) / 8), Math.floor(h / 2), 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let k = 0; k < px.length; k += 4) {
        const l = (px[k] + px[k + 1] + px[k + 2]) / 3;
        sum += l;
        min = Math.min(min, l);
        max = Math.max(max, l);
      }
    }
    return { mean: sum / (8 * 64), min, max };
  }

  dispose() {
    for (const m of this.riders.values()) m.dispose();
    this.flames.dispose();
    this.pacerLabels.dispose();
    disposeTree(this.scene);
    if (this.envTarget) this.envTarget.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }
}

function kitKey(kit) {
  return kit ? `${kit.jersey?.id}|${kit.helmet?.id}|${kit.bike?.id}|${kit.wheels?.id}` : '';
}

const SKINS = ['#f1c7a5', '#e0ac8a', '#c68863', '#8d5a3b', '#f5d2b8', '#a86f4c'];
function skinFor(id) {
  return SKINS[id % SKINS.length];
}
const HAIR = ['#3a2718', '#7a5632', '#c9a066', '#1d1a18', '#9a9a9a', '#5a3a22', '#a65e2e'];
/** About a third of the other riders are women; your own rider (and your ghost) stays as it is. */
function bodyFor(r) {
  if (r.body) return r.body;
  if (r.isPlayer || r.isGhost) return 'm';
  return (r.id * 7 + 3) % 10 < 3 ? 'f' : 'm';
}
function hairFor(id) {
  return HAIR[(id * 3 + 1) % HAIR.length];
}

function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
  });
}
