// Lingvisto — PWA icon generator. The mark is two speech bubbles drawn as pure
// geometry: one filled, one outlined, overlapping. Two voices rather than one —
// which is what the app is. No font, no image file, no dependencies, so every
// size renders exactly rather than being resampled.
//   node tools/gen-icons.mjs      (run from the lingvisto/ directory)
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'public', 'icons');

/* ---------- minimal PNG encoder ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- palette ---------- */
const CREAM = [0xfc, 0xfa, 0xf5];
const STOPS = [
  { at: 0.00, rgb: [0x4f, 0x8f, 0x6e] },
  { at: 0.52, rgb: [0x2e, 0x75, 0x50] },
  { at: 1.00, rgb: [0x0e, 0x3a, 0x23] },
];

function gradientAt(t) {
  const u = Math.min(1, Math.max(0, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (u <= STOPS[i].at) {
      const a = STOPS[i - 1];
      const b = STOPS[i];
      const k = (u - a.at) / (b.at - a.at);
      return [0, 1, 2].map((c) => Math.round(a.rgb[c] + (b.rgb[c] - a.rgb[c]) * k));
    }
  }
  return STOPS[STOPS.length - 1].rgb;
}

/* ---------- bubble geometry ----------
   Glyph space is [-1, 1] on both axes, y pointing down. The back bubble sits
   up and left as an outline; the front one sits down and right, filled, with a
   tail. Where the front passes over the back, the back's outline is cut with a
   small gap so the two read as separate objects rather than one blob —
   the same trick a sign painter uses for overlapping letters.               */

const BACK = { cx: -0.28, cy: -0.42, hw: 0.52, hh: 0.345, r: 0.165 };
const FRONT = { cx: 0.20, cy: 0.20, hw: 0.62, hh: 0.40, r: 0.185 };
const STROKE = 0.058;   // half-width of the back bubble's outline
const GAP = 0.072;      // clearance cut around the front bubble

// Tail of the front bubble: a triangle whose base sits well inside the body so
// the two fuse into one shape, dropping to a point below the lower-left corner.
// Keep the base wide relative to the drop — a long thin tail reads as a spike
// rather than as speech, and disappears entirely at favicon size.
const TAIL = [
  [-0.36, 0.30],
  [0.02, 0.30],
  [-0.44, 0.80],
];

// Signed distance to a rounded rectangle; negative inside.
function sdRoundRect(px, py, b) {
  const qx = Math.abs(px - b.cx) - (b.hw - b.r);
  const qy = Math.abs(py - b.cy) - (b.hh - b.r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - b.r;
}

function inTriangle(px, py, [a, b, c]) {
  const sign = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// Is (x, y) inside the mark?
function insideMark(x, y) {
  const dFront = sdRoundRect(x, y, FRONT);
  const frontFilled = dFront <= 0 || inTriangle(x, y, TAIL);
  if (frontFilled) return true;

  const dBack = sdRoundRect(x, y, BACK);
  const onBackStroke = Math.abs(dBack) <= STROKE;
  if (!onBackStroke) return false;
  // Cut the outline where the front bubble (or its tail) comes close.
  if (dFront < GAP) return false;
  if (inTriangle(x, y, TAIL.map(([tx, ty]) => [tx, ty]))) return false;
  return true;
}

/* ---------- raster ---------- */
const SS = 4; // supersampling factor per axis

function renderIcon(size, { inset = 0.70, background = CREAM, transparent = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const radiusPx = (size * inset) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const gTop = cy - radiusPx;
  const gSpan = radiusPx * 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      let gAcc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (insideMark((x - cx) / radiusPx, (y - cy) / radiusPx)) {
            hits++;
            gAcc += (y - gTop) / gSpan;
          }
        }
      }
      const i = (py * size + px) * 4;
      const cov = hits / (SS * SS);
      if (cov === 0) {
        rgba[i] = background[0];
        rgba[i + 1] = background[1];
        rgba[i + 2] = background[2];
        rgba[i + 3] = transparent ? 0 : 255;
        continue;
      }
      const ink = gradientAt(gAcc / hits);
      if (transparent) {
        rgba[i] = ink[0];
        rgba[i + 1] = ink[1];
        rgba[i + 2] = ink[2];
        rgba[i + 3] = Math.round(cov * 255);
      } else {
        for (let c = 0; c < 3; c++) {
          rgba[i + c] = Math.round(ink[c] * cov + background[c] * (1 - cov));
        }
        rgba[i + 3] = 255;
      }
    }
  }
  return encodePNG(size, size, rgba);
}

/* ---------- SVG twin ----------
   Same constants, expressed as real paths so the vector mark and the PNGs
   cannot drift apart. The gap is a mask rather than a second fill, so the
   thing works on any background including transparency.                    */
function svgMark({ transparent = true } = {}) {
  const S = 100;
  const K = 41;          // glyph radius in SVG units
  const C = S / 2;
  const f = (n) => (C + n * K).toFixed(2);
  const u = (n) => (n * K).toFixed(2);

  const rrect = (b) => {
    const x = f(b.cx - b.hw);
    const y = f(b.cy - b.hh);
    const w = u(b.hw * 2);
    const h = u(b.hh * 2);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${u(b.r)}" ry="${u(b.r)}"/>`;
  };
  const tail = `<polygon points="${TAIL.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" role="img" aria-label="Lingvisto">
  <defs>
    <linearGradient id="lg" x1="0" y1="${f(-1)}" x2="0" y2="${f(1)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#4F8F6E"/><stop offset="0.52" stop-color="#2E7550"/><stop offset="1" stop-color="#0E3A23"/>
    </linearGradient>
    <mask id="cut">
      <rect width="${S}" height="${S}" fill="#fff"/>
      <g fill="#000" stroke="#000" stroke-width="${u(GAP * 2)}" stroke-linejoin="round">
        ${rrect(FRONT)}
        ${tail}
      </g>
    </mask>
  </defs>
  ${transparent ? '' : `<rect width="${S}" height="${S}" fill="#FCFAF5"/>`}
  <g mask="url(#cut)" fill="none" stroke="url(#lg)" stroke-width="${u(STROKE * 2)}">
    ${rrect(BACK)}
  </g>
  <g fill="url(#lg)">
    ${rrect(FRONT)}
    ${tail}
  </g>
</svg>
`;
}

/* ---------- write ---------- */
fs.mkdirSync(OUT, { recursive: true });

const jobs = [
  ['icon-180.png', 180, { inset: 0.70 }],                       // apple-touch-icon
  ['icon-192.png', 192, { inset: 0.70 }],
  ['icon-256.png', 256, { inset: 0.70 }],
  ['icon-512.png', 512, { inset: 0.70 }],
  ['icon-1024.png', 1024, { inset: 0.70 }],
  ['icon-maskable-192.png', 192, { inset: 0.52 }],
  ['icon-maskable-512.png', 512, { inset: 0.52 }],
  ['favicon-64.png', 64, { inset: 0.82 }],
  ['favicon-32.png', 32, { inset: 0.86 }],
];

for (const [name, size, opts] of jobs) {
  fs.writeFileSync(path.join(OUT, name), renderIcon(size, opts));
  process.stdout.write(`  ${name}\n`);
}

fs.writeFileSync(path.join(OUT, 'favicon.svg'), svgMark({ transparent: true }));
fs.writeFileSync(path.join(OUT, 'mark.svg'), svgMark({ transparent: true }));
process.stdout.write('  favicon.svg\n  mark.svg\nLingvisto icons written to public/icons\n');
