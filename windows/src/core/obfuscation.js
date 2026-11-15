// The inRide power characteristic is lightly obfuscated: the top two bits of byte 0 pick one of four
// permutation tables, bytes 1...19 are XORed with a key derived from two other tables, then reordered.
// Line-for-line port of `inride_process_power_data` in Kinetic's inRide.c (via InRideObfuscation.swift).

export const PACKET_LENGTH = 20;

export const INDICES = [
  [14, 15, 12, 16, 11, 5, 17, 3, 2, 1, 19, 13, 6, 4, 8, 9, 10, 18, 7],
  [12, 14, 8, 11, 16, 4, 7, 13, 18, 1, 3, 19, 6, 15, 9, 5, 10, 17, 2],
  [11, 5, 1, 9, 4, 18, 7, 15, 6, 2, 10, 12, 16, 3, 14, 13, 19, 17, 8],
  [13, 5, 18, 1, 3, 12, 15, 10, 14, 19, 16, 8, 6, 11, 2, 9, 4, 17, 7],
];

/** Rotation selector carried in the top two bits of byte 0. */
export function rotationOf(packet) {
  return (packet[0] & 0xc0) >> 6;
}

function xorKey(rotation, index) {
  const a = (rotation + 1) % 4;
  const b = (a + 1) % 4;
  return (INDICES[a][index - 1] + INDICES[b][index - 1]) & 0xff;
}

/** Returns the plain packet, in the field order the decoder expects. */
export function deobfuscate(packet) {
  if (packet.length !== PACKET_LENGTH) throw new Error(`Expected 20 bytes, got ${packet.length}`);
  const rotation = rotationOf(packet);
  const unxored = Array.from(packet);
  for (let i = 1; i < PACKET_LENGTH; i++) unxored[i] = packet[i] ^ xorKey(rotation, i);
  const plain = new Array(PACKET_LENGTH).fill(0);
  plain[0] = unxored[0];
  for (let i = 0; i < PACKET_LENGTH - 1; i++) plain[i + 1] = unxored[INDICES[rotation][i]];
  return plain;
}

/** Exact inverse of `deobfuscate`. Used by the simulator and tests. Rotation is taken from plain[0]. */
export function obfuscate(plain) {
  if (plain.length !== PACKET_LENGTH) throw new Error(`Expected 20 bytes, got ${plain.length}`);
  const rotation = rotationOf(plain);
  const unxored = new Array(PACKET_LENGTH).fill(0);
  unxored[0] = plain[0];
  for (let i = 0; i < PACKET_LENGTH - 1; i++) unxored[INDICES[rotation][i]] = plain[i + 1];
  const packet = Array.from(unxored);
  for (let i = 1; i < PACKET_LENGTH; i++) packet[i] = unxored[i] ^ xorKey(rotation, i);
  return packet;
}
