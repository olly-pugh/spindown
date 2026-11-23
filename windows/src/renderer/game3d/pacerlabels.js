// The pacers' labels: a big pill in each pacer's colour reading its watts ("200 W"), floating over the ghost.
// All of them are one instanced draw call over one small texture atlas. The vertex shader turns each to face the
// camera and grows it with distance, so it stays readable from far back in the chase camera (it keeps the same size
// on screen from about 12 m to 90 m, then shrinks and fades out by 450 m).
import * as THREE from 'three';

const CELL_W = 512, CELL_H = 160;

const vertexShader = /* glsl */ `
attribute vec4 aAt;   // world position over the rider's head, w = 1 shown / 0 hidden
attribute float aCell;
uniform float uCells;
varying vec2 vUv;
varying float vFade;
void main() {
  vUv = vec2(uv.x, (uv.y + aCell) / uCells);
  vFade = 0.0;
  if (aAt.w < 0.5) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec4 centre = viewMatrix * vec4(aAt.xyz, 1.0);
  float dist = -centre.z;
  float grow = clamp(dist / 12.0, 1.0, 7.5);
  float h = 0.55 * grow;
  // Bottom-centre anchored, lifted a little more as it grows so it clears the rider.
  vec2 q = vec2(position.x * h * ${(CELL_W / CELL_H).toFixed(3)}, (position.y + 0.5) * h + 0.12 * grow);
  centre.xy += q;
  vFade = (1.0 - smoothstep(300.0, 450.0, dist)) * smoothstep(2.5, 6.0, dist);
  gl_Position = projectionMatrix * centre;
}`;

const fragmentShader = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying float vFade;
void main() {
  vec4 c = texture2D(uMap, vUv);
  gl_FragColor = vec4(c.rgb, c.a * vFade);
  if (gl_FragColor.a < 0.01) discard;
}`;

/** pacers: PACERS from content.js (watts and colour). */
function atlas(pacers) {
  const c = document.createElement('canvas');
  c.width = CELL_W;
  c.height = CELL_H * pacers.length;
  const g = c.getContext('2d');
  pacers.forEach((p, i) => {
    // Row i from the top of the canvas (so cell n − 1 − i counting up in texture v, see aCell).
    const y0 = i * CELL_H;
    const x = 14, y = y0 + 14, w = CELL_W - 28, h = CELL_H - 28, r = h / 2;
    const pill = () => {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    };
    g.save();
    g.shadowColor = p.color;
    g.shadowBlur = 14;
    pill();
    g.fillStyle = 'rgba(12, 14, 18, 0.82)';
    g.fill();
    g.restore();
    pill();
    g.lineWidth = 9;
    g.strokeStyle = p.color;
    g.stroke();
    g.fillStyle = p.color;
    g.font = '800 92px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`${p.watts} W`, CELL_W / 2, y0 + CELL_H / 2 + 4);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace; // written straight to the screen, unconverted
  tex.anisotropy = 4;
  return tex;
}

export class PacerLabels {
  constructor(parent, pacers) {
    this.pacers = pacers;
    const n = pacers.length;
    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    g.setAttribute('uv', base.attributes.uv);
    // Placed positions by pacer, then written out farthest first each frame so nearer labels draw on top.
    this.placed = new Float32Array(n * 4);
    this.order = new Int8Array(n);
    this.dist = new Float32Array(n);
    this.at = new Float32Array(n * 4);
    this.cell = new Float32Array(n);
    this.aAt = new THREE.InstancedBufferAttribute(this.at, 4).setUsage(THREE.DynamicDrawUsage);
    this.aCell = new THREE.InstancedBufferAttribute(this.cell, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aAt', this.aAt);
    g.setAttribute('aCell', this.aCell);
    g.instanceCount = n;
    this.texture = atlas(pacers);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.texture }, uCells: { value: n } },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    parent.add(this.mesh);
  }

  /** Starts a frame: everything hidden until placed. */
  begin() {
    for (let i = 3; i < this.placed.length; i += 4) this.placed[i] = 0;
  }

  /** Places pacer `index`'s label over a point (world). */
  place(index, x, y, z) {
    const o = index * 4;
    this.placed[o] = x;
    this.placed[o + 1] = y;
    this.placed[o + 2] = z;
    this.placed[o + 3] = 1;
  }

  /** camera: the view camera, to draw the labels back to front. */
  end(camera) {
    const n = this.pacers.length, P = this.placed, c = camera.position;
    for (let i = 0; i < n; i++) {
      this.order[i] = i;
      this.dist[i] = (P[i * 4] - c.x) ** 2 + (P[i * 4 + 1] - c.y) ** 2 + (P[i * 4 + 2] - c.z) ** 2;
    }
    for (let i = 1; i < n; i++) {
      const k = this.order[i];
      let j = i - 1;
      while (j >= 0 && this.dist[this.order[j]] < this.dist[k]) {
        this.order[j + 1] = this.order[j];
        j--;
      }
      this.order[j + 1] = k;
    }
    for (let i = 0; i < n; i++) {
      const k = this.order[i];
      for (let e = 0; e < 4; e++) this.at[i * 4 + e] = P[k * 4 + e];
      this.cell[i] = n - 1 - k;
    }
    this.aAt.needsUpdate = true;
    this.aCell.needsUpdate = true;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
