// Glossa — PWA icon generator. The logo is the letter G drawn as pure geometry:
// an annulus with a wedge cut out of its right side, plus a horizontal bar that
// fills the wedge and runs out to the outer edge. No font, no image file, no
// dependencies — so every size renders exactly rather than being resampled.
//   node tools/gen-icons.mjs      (run from the glossa/ directory)
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

/* ---------- palette ----------
   The gradient runs top-to-bottom exactly as in the reference: a soft sea
   green resolving into deep pine. Stops are the same three the stylesheet
   uses, so the icon and the in-app mark are the same object.                 */
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

/* ---------- G geometry ----------
   Everything is a fraction of the glyph's outer radius, centred on the glyph
   square, y pointing down.

   The bowl is not a constant-width ring. A letter drawn with a broad nib held
   at a steady angle comes out thick where the pen moves across its width and
   thin where it moves along it, which for an upright face means heavy at the
   left and right shoulders and light over the top and under the bottom. That
   modulation is the whole difference between a book letterform and a traced
   circle, so it is built in rather than faked later.

   The wedge is cut from the upper-right quadrant only: below the bar the bowl
   carries straight on, which is what stops the mark reading as a C with a
   stick through it.                                                          */
const R_OUT = 1.000;
const W_MAX = 0.300;             // stroke at the shoulders (3 and 9 o'clock)
const W_MIN = 0.112;             // stroke over the top and under the bottom
const GAP_FROM = -34 * Math.PI / 180; // upper-right, where the wedge starts
const GAP_TO = 0;                     // 3 o'clock, where the bar sits
const BAR_HALF = 0.079;          // the bar is a thin stroke, as a light face
const BAR_X0 = 0.255;            // inner terminal of the bar
const BAR_X1 = R_OUT;            // flush with the outer edge

// Stroke width of the bowl on the ray at angle `th`. Squaring the cosine keeps
// the thin sections thin for longer, which reads as more contrast than a plain
// cosine at the same extremes.
const strokeAt = (th) => W_MIN + (W_MAX - W_MIN) * Math.cos(th) ** 2;

// Is (x, y) — in glyph space, origin at centre, y down — inside the G?
function insideG(x, y) {
  const r = Math.hypot(x, y);
  const th = Math.atan2(y, x);
  if (r <= R_OUT && r >= R_OUT - strokeAt(th)) {
    if (!(th > GAP_FROM && th < GAP_TO)) return true;
  }
  if (y >= -BAR_HALF && y <= BAR_HALF && x >= BAR_X0 && x <= BAR_X1) return true;
  return false;
}

/* ---------- raster ---------- */
const SS = 4; // supersampling factor per axis

// `inset` is the fraction of the canvas the glyph's diameter occupies.
function renderIcon(size, { inset = 0.62, background = CREAM, transparent = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const radiusPx = (size * inset) / 2;
  const cx = size / 2;
  const cy = size / 2;

  // Vertical gradient spans the glyph's own bounding box, not the canvas, so
  // the mark keeps the same colour ramp at every size.
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
          if (insideG((x - cx) / radiusPx, (y - cy) / radiusPx)) {
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
   Driven by the same constants and the same strokeAt(), so the favicon, the
   in-app mark and the PNGs cannot drift apart. A modulated stroke has no
   constant-width equivalent, so the bowl is emitted as a filled outline:
   forward along the outer edge, back along the inner one.                    */
function svgMark({ transparent = true } = {}) {
  const S = 100;
  const R = 42;          // outer radius in SVG units
  const c = S / 2;
  const STEPS = 180;

  const fx = (n) => n.toFixed(2);
  const at = (rad, ang) => `${fx(c + rad * Math.cos(ang))} ${fx(c + rad * Math.sin(ang))}`;

  // The bowl runs clockwise from the bar (3 o'clock) all the way round to the
  // top of the wedge, so the wedge itself is simply never drawn.
  const span = Math.PI * 2 - (GAP_TO - GAP_FROM);
  const outer = [];
  const inner = [];
  for (let i = 0; i <= STEPS; i++) {
    const th = GAP_TO + (span * i) / STEPS;
    outer.push(at(R, th));
    inner.push(at(R * (R_OUT - strokeAt(th)), th));
  }
  const bowl = `M ${outer.join(' L ')} L ${inner.reverse().join(' L ')} Z`;

  const y0 = fx(c - R * BAR_HALF);
  const y1 = fx(c + R * BAR_HALF);
  const x0 = fx(c + R * BAR_X0);
  const x1 = fx(c + R * BAR_X1);
  const bar = `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" role="img" aria-label="Glossa">
  <defs>
    <linearGradient id="gg" x1="0" y1="${fx(c - R)}" x2="0" y2="${fx(c + R)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#4F8F6E"/>
      <stop offset="0.52" stop-color="#2E7550"/>
      <stop offset="1" stop-color="#0E3A23"/>
    </linearGradient>
  </defs>
  ${transparent ? '' : `<rect width="${S}" height="${S}" fill="#FCFAF5"/>`}
  <path d="${bowl}" fill="url(#gg)"/>
  <path d="${bar}" fill="url(#gg)"/>
</svg>
`;
}

/* ---------- write ---------- */
fs.mkdirSync(OUT, { recursive: true });

const jobs = [
  ['icon-180.png', 180, { inset: 0.62 }],                       // apple-touch-icon
  ['icon-192.png', 192, { inset: 0.62 }],
  ['icon-256.png', 256, { inset: 0.62 }],
  ['icon-512.png', 512, { inset: 0.62 }],
  ['icon-1024.png', 1024, { inset: 0.62 }],
  // Maskable icons get cropped to a circle on some launchers, so the glyph
  // sits inside the 80% safe zone and the cream runs to the edge.
  ['icon-maskable-192.png', 192, { inset: 0.46 }],
  ['icon-maskable-512.png', 512, { inset: 0.46 }],
  ['favicon-64.png', 64, { inset: 0.72 }],
  ['favicon-32.png', 32, { inset: 0.74 }],
];

for (const [name, size, opts] of jobs) {
  fs.writeFileSync(path.join(OUT, name), renderIcon(size, opts));
  process.stdout.write(`  ${name}\n`);
}

fs.writeFileSync(path.join(OUT, 'favicon.svg'), svgMark({ transparent: true }));
fs.writeFileSync(path.join(OUT, 'mark.svg'), svgMark({ transparent: true }));
process.stdout.write('  favicon.svg\n  mark.svg\nGlossa icons written to public/icons\n');
