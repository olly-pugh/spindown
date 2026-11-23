// The people assets bundled into the app (esbuild: .bin as bytes, images as data URLs). Decoded once, shared.
// All are derived from MakeHuman 1.1 assets released under CC0 (see LICENSE.md in this folder).
import * as THREE from 'three';
import riderBin from './rider.bin';
import skinLight from './skin-light.jpg';
import skinMid from './skin-mid.jpg';
import skinDark from './skin-dark.jpg';
import hairShort from './hair-short.png';
import browsPng from './brows.png';
import { unpack } from './pack.js';

let rider = null;
/** {meta, geometries} for the cyclist. */
export function riderAssets() {
  if (!rider) rider = unpack(riderBin);
  return rider;
}

const textures = new Map();
function texture(url, { colour = true } = {}) {
  if (!textures.has(url)) {
    const t = new THREE.TextureLoader().load(url);
    t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    t.flipY = true;
    textures.set(url, t);
  }
  return textures.get(url);
}

/** Skin textures: light, mid and dark base skins (tinted per rider). */
export const skinTexture = (tone) => texture(tone === 'dark' ? skinDark : tone === 'mid' ? skinMid : skinLight);
export const hairTexture = () => texture(hairShort, { colour: false });
export const browTexture = () => texture(browsPng, { colour: false });
