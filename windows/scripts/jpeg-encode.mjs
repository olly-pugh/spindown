// A small baseline JPEG encoder for the map build scripts (no dependencies): 8-bit RGB or greyscale in,
// JFIF bytes out, 4:4:4 (no chroma subsampling, so normal maps keep their detail), standard Huffman tables.
//
//   encodeJpeg({ width, height, channels: 3 | 1, data: Uint8Array }, quality = 90) -> Buffer

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const LUM_Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const CHR_Q = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
// Standard Huffman tables (ITU T.81 Annex K): code counts per length 1..16, then the values.
const DC_LUM = [[0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]];
const DC_CHR = [[0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]];
const AC_LUM = [[0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa]];
const AC_CHR = [[0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa]];

/** Huffman codes {value: [code, length]} from counts and values. */
function buildCodes([counts, values]) {
  const codes = new Map();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) codes.set(values[k++], [code++, len]);
    code <<= 1;
  }
  return codes;
}

function scaledTable(base, quality) {
  const q = Math.min(100, Math.max(1, quality));
  const s = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100))));
}

// Separable float DCT-II on an 8×8 block (row-major), output scaled so DC = 8 × mean.
const COS = new Float64Array(64);
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
const CU = (u) => (u === 0 ? Math.SQRT1_2 : 1);
function dct(block, out) {
  const tmp = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[x * 8 + u];
      tmp[y * 8 + u] = (s * CU(u)) / 2;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS[y * 8 + v];
      out[v * 8 + u] = (s * CU(v)) / 2;
    }
  }
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.n = 0;
  }
  put(code, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      if (++this.n === 8) {
        this.bytes.push(this.acc);
        if (this.acc === 0xff) this.bytes.push(0);
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  flush() {
    if (this.n > 0) this.put((1 << (8 - this.n)) - 1, 8 - this.n);
  }
}

function magnitude(v) {
  const a = Math.abs(v);
  let n = 0;
  while (a >> n) n++;
  return [n, v < 0 ? v + (1 << n) - 1 : v];
}

export function encodeJpeg({ width, height, channels = 3, data }, quality = 90) {
  const comps = channels === 1 ? 1 : 3;
  const qL = scaledTable(LUM_Q, quality), qC = scaledTable(CHR_Q, quality);
  const dcL = buildCodes(DC_LUM), acL = buildCodes(AC_LUM), dcC = buildCodes(DC_CHR), acC = buildCodes(AC_CHR);
  const head = [];
  const u16 = (v) => head.push((v >> 8) & 255, v & 255);
  head.push(0xff, 0xd8);
  head.push(0xff, 0xe0); u16(16); head.push(0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0); u16(1); u16(1); head.push(0, 0);
  for (const [id, t] of comps === 1 ? [[0, qL]] : [[0, qL], [1, qC]]) {
    head.push(0xff, 0xdb); u16(67); head.push(id);
    for (let i = 0; i < 64; i++) head.push(t[ZIGZAG[i]]);
  }
  head.push(0xff, 0xc0); u16(8 + 3 * comps); head.push(8); u16(height); u16(width); head.push(comps);
  for (let c = 0; c < comps; c++) head.push(c + 1, 0x11, c === 0 ? 0 : 1);
  for (const [cls, id, t] of comps === 1 ? [[0, 0, DC_LUM], [1, 0, AC_LUM]] : [[0, 0, DC_LUM], [1, 0, AC_LUM], [0, 1, DC_CHR], [1, 1, AC_CHR]]) {
    head.push(0xff, 0xc4); u16(3 + 16 + t[1].length); head.push((cls << 4) | id, ...t[0], ...t[1]);
  }
  head.push(0xff, 0xda); u16(6 + 2 * comps); head.push(comps);
  for (let c = 0; c < comps; c++) head.push(c + 1, c === 0 ? 0 : 0x11);
  head.push(0, 63, 0);

  const bw = new BitWriter();
  const pred = [0, 0, 0];
  const block = new Float64Array(64), coef = new Float64Array(64);
  const planes = [];
  for (let c = 0; c < comps; c++) planes.push(new Float32Array(64));
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(height - 1, by + y);
        for (let x = 0; x < 8; x++) {
          const sx = Math.min(width - 1, bx + x);
          const o = (sy * width + sx) * channels;
          if (comps === 1) planes[0][y * 8 + x] = data[o] - 128;
          else {
            const r = data[o], g = data[o + 1], b = data[o + 2];
            planes[0][y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
            planes[1][y * 8 + x] = -0.168736 * r - 0.331264 * g + 0.5 * b;
            planes[2][y * 8 + x] = 0.5 * r - 0.418688 * g - 0.081312 * b;
          }
        }
      }
      for (let c = 0; c < comps; c++) {
        for (let i = 0; i < 64; i++) block[i] = planes[c][i];
        dct(block, coef);
        const q = c === 0 ? qL : qC, dc = c === 0 ? dcL : dcC, ac = c === 0 ? acL : acC;
        const zz = new Int32Array(64);
        for (let i = 0; i < 64; i++) zz[i] = Math.round(coef[ZIGZAG[i]] / q[ZIGZAG[i]]);
        const diff = zz[0] - pred[c];
        pred[c] = zz[0];
        const [dn, dv] = magnitude(diff);
        bw.put(...dc.get(dn));
        if (dn) bw.put(dv, dn);
        let run = 0;
        for (let i = 1; i < 64; i++) {
          if (zz[i] === 0) {
            run++;
            continue;
          }
          while (run > 15) {
            bw.put(...ac.get(0xf0));
            run -= 16;
          }
          const [an, av] = magnitude(zz[i]);
          bw.put(...ac.get((run << 4) | an));
          bw.put(av, an);
          run = 0;
        }
        if (run > 0) bw.put(...ac.get(0x00));
      }
    }
  }
  bw.flush();
  return Buffer.concat([Buffer.from(head), Buffer.from(bw.bytes), Buffer.from([0xff, 0xd9])]);
}
