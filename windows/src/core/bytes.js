// Little-endian byte helpers. Port of InRideKit/Protocol/Bytes.swift.

export class ByteReader {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }
  u8() {
    return this.bytes[this.offset++];
  }
  u16() {
    return this.u8() | (this.u8() << 8);
  }
  u24() {
    return (this.u8() | (this.u8() << 8) | (this.u8() << 16)) >>> 0;
  }
  u32() {
    return (this.u16() + this.u16() * 0x10000) >>> 0;
  }
}

export class ByteWriter {
  constructor() {
    this.bytes = [];
  }
  u8(v) {
    this.bytes.push(v & 0xff);
  }
  u16(v) {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff);
  }
  u24(v) {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff);
  }
  u32(v) {
    v = v >>> 0;
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  append(other) {
    for (const b of other) this.bytes.push(b & 0xff);
  }
}

/** "0a 1b ff" style, for logs and diagnostics. */
export function hex(bytes, separator = ' ') {
  return Array.from(bytes || [], (b) => b.toString(16).padStart(2, '0')).join(separator);
}

/** Parses "0a1bff", "0a 1b ff" or "0x0a,0x1b". Returns null on any invalid input. */
export function parseHex(text) {
  const cleaned = String(text)
    .toLowerCase()
    .replaceAll('0x', '')
    .replace(/[ ,:\-\n\t]/g, '');
  if (cleaned.length % 2 !== 0) return null;
  const out = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    const pair = cleaned.slice(i, i + 2);
    if (!/^[0-9a-f]{2}$/.test(pair)) return null;
    out.push(parseInt(pair, 16));
  }
  return out;
}

/** Swift's `.rounded()`: half away from zero. */
export function roundHalfAway(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}
