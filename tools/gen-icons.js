/* tools/gen-icons.js — writes the PWA icons. `node tools/gen-icons.js`
 *
 * Hand-rolled PNG encoder on top of node:zlib, so there is no image
 * dependency to install, audit or keep current for a project whose entire
 * point is that it has no build step.
 *
 * The mark is the app's own progress ring: a three-quarter arc with a dot at
 * its head, on a gradient field.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

/* ── PNG encoding ─────────────────────────────────────────────────────────── */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // Each scanline is prefixed with filter type 0 (none) — the image is tiny
  // and gradient-heavy, so filtering buys almost nothing here.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── Drawing ──────────────────────────────────────────────────────────────── */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded rectangle centred in the tile. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to a stroked arc, with round caps at both ends. */
function sdArc(px, py, cx, cy, radius, halfWidth, a0, a1) {
  const dx = px - cx, dy = py - cy;
  let ang = Math.atan2(dy, dx);
  const TAU = Math.PI * 2;
  const norm = (a) => ((a % TAU) + TAU) % TAU;
  const s = norm(a0), e = norm(a1), a = norm(ang);
  const inside = s <= e ? a >= s && a <= e : a >= s || a <= e;
  if (inside) return Math.abs(Math.hypot(dx, dy) - radius) - halfWidth;
  // Outside the sweep: fall back to the nearer round cap.
  const cap = (ax) => Math.hypot(px - (cx + Math.cos(ax) * radius), py - (cy + Math.sin(ax) * radius)) - halfWidth;
  return Math.min(cap(a0), cap(a1));
}

const PALETTE = { from: [124, 122, 255], to: [74, 72, 214], ink: [255, 255, 255] };

/**
 * @param size    pixel dimensions
 * @param maskable pad the artwork into the 80% safe zone and fill the square
 */
function drawIcon(size, { maskable = false, square = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 3;                       // supersampling factor per axis
  const c = size / 2;
  const scale = maskable ? 0.66 : 0.82;
  const ringR = (size * scale) / 2 - size * 0.085;
  const ringW = size * (maskable ? 0.075 : 0.088);
  const corner = size * 0.235;
  // Three-quarter sweep, starting bottom-left, so the gap reads as deliberate.
  const a0 = Math.PI * 0.78, a1 = Math.PI * 0.42;
  const dotA = a1;
  const dotR = ringW * 0.62;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S;
          const py = y + (sy + 0.5) / S;

          // Background field
          const dBg = square || maskable
            ? -1
            : sdRoundRect(px, py, c, c, size / 2, size / 2, corner);
          const bgA = clamp01(0.5 - dBg);
          const t = clamp01((px + py) / (size * 2));
          let R = mix(PALETTE.from[0], PALETTE.to[0], t);
          let G = mix(PALETTE.from[1], PALETTE.to[1], t);
          let B = mix(PALETTE.from[2], PALETTE.to[2], t);
          let A = bgA;

          // The ring, drawn over the field
          const dRing = sdArc(px, py, c, c, ringR, ringW / 2, a0, a1);
          const dDot = Math.hypot(px - (c + Math.cos(dotA) * ringR), py - (c + Math.sin(dotA) * ringR)) - dotR;
          const inkA = Math.max(clamp01(0.5 - dRing), clamp01(0.5 - dDot)) * A;
          R = mix(R, PALETTE.ink[0], inkA);
          G = mix(G, PALETTE.ink[1], inkA);
          B = mix(B, PALETTE.ink[2], inkA);

          r += R; g += G; b += B; a += A;
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(r / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(b / n);
      buf[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePNG(size, size, buf);
}

const write = (name, data) => { writeFileSync(join(OUT, name), data); console.log(`  ${name}  ${(data.length / 1024).toFixed(1)} KB`); };

console.log('icons →');
write('icon-192.png', drawIcon(192));
write('icon-512.png', drawIcon(512));
write('maskable-512.png', drawIcon(512, { maskable: true }));
write('apple-touch-icon.png', drawIcon(180, { square: true }));

/* The favicon stays vector — it is the one icon that gets scaled to 16px. */
writeFileSync(join(OUT, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7C7AFF"/><stop offset="1" stop-color="#4A48D6"/>
  </linearGradient></defs>
  <rect width="64" height="64" rx="15" fill="url(#g)"/>
  <circle cx="32" cy="32" r="18" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"
    stroke-dasharray="85 113" transform="rotate(140 32 32)"/>
  <circle cx="45.8" cy="43.6" r="3.6" fill="#fff"/>
</svg>
`);
console.log('  favicon.svg');
