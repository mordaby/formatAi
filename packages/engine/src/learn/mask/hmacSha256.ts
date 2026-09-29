// Pure, synchronous HMAC-SHA256 (RFC 2104 over the SHA-256 in sha256.ts).
// No Node/DOM APIs and no randomness; the key is always supplied by the
// caller (the web app creates it with crypto.getRandomValues per session —
// nothing in this package generates keys).

import { sha256 } from './sha256';

const BLOCK_SIZE = 64; // SHA-256's block size in bytes.
const OPAD = 0x5c;
const IPAD = 0x36;

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** HMAC-SHA256(key, message), returning the 32-byte MAC. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  let blockKey = key;
  if (blockKey.length > BLOCK_SIZE) {
    blockKey = sha256(blockKey);
  }
  if (blockKey.length < BLOCK_SIZE) {
    const padded = new Uint8Array(BLOCK_SIZE);
    padded.set(blockKey);
    blockKey = padded;
  }

  const innerPad = new Uint8Array(BLOCK_SIZE);
  const outerPad = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i++) {
    const k = blockKey[i]!;
    innerPad[i] = k ^ IPAD;
    outerPad[i] = k ^ OPAD;
  }

  const inner = sha256(concatBytes(innerPad, message));
  return sha256(concatBytes(outerPad, inner));
}
