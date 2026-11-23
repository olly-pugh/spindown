// Unpacks the people meshes written by scripts/people/build-people.mjs (see meshkit.mjs `pack`): a JSON header and
// typed arrays, turned into three.js geometries that share the one buffer.
import * as THREE from 'three';

const TYPES = { f32: Float32Array, i8: Int8Array, u8: Uint8Array, i16: Int16Array, u16: Uint16Array, u32: Uint32Array, i32: Int32Array };

/** bytes: Uint8Array. Returns {meta, geometries: {name: BufferGeometry}}. */
export function unpack(bytes) {
  // Typed array views need aligned offsets: copy into a fresh buffer if the input isn't 4-byte aligned.
  if (bytes.byteOffset % 4) bytes = bytes.slice();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x31504c50) throw new Error('Not a people pack');
  const n = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n)));
  const base = bytes.byteOffset + 8 + n + ((4 - (n % 4)) % 4);
  const view = (d) => new TYPES[d.type](bytes.buffer, base + d.offset, d.length);
  const geometries = {};
  for (const [name, m] of Object.entries(meta.meshes)) {
    const g = new THREE.BufferGeometry();
    for (const [k, d] of Object.entries(m.attributes)) {
      if (d.quant) {
        // 16-bit positions about a centre: back to metres.
        const q = view(d), out = new Float32Array(q.length), { c, s } = d.quant;
        for (let i = 0; i < q.length; i++) out[i] = (q[i] / 32767) * s + c[i % 3];
        g.setAttribute(k, new THREE.BufferAttribute(out, 3));
      } else g.setAttribute(k, new THREE.BufferAttribute(view(d), d.size, d.normalized));
    }
    g.setIndex(new THREE.BufferAttribute(view(m.index), 1));
    g.computeBoundingSphere();
    geometries[name] = g;
  }
  return { meta, geometries };
}
