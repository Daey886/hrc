// Minimal SVG -> PNG renderer for this specific icon (no deps).
// Renders the exact shapes used in icon.svg at a given size with 4x supersampling.
// Usage: node svg2png.js <outfile.png> <size>
const fs = require('fs');
const zlib = require('zlib');

const size = parseInt(process.argv[3] || '128', 10);
const SS = 4; // supersample factor
const W = size * SS;

// --- simple software rasterizer over the analytic shapes ---
// helpers
function inRoundedRect(x, y, rx, ry, w, h, r) {
  if (x < rx || x >= rx + w || y < ry || y >= ry + h) return false;
  const cx = Math.max(rx + r, Math.min(x, rx + w - r));
  const cy = Math.max(ry + r, Math.min(y, ry + h - r));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= rx + r && x < rx + w - r) || (y >= ry + r && y < ry + h - r);
}
// distance from P to segment AB
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}
function inCircle(x, y, cx, cy, r) { const dx = x - cx, dy = y - cy; return dx * dx + dy * dy <= r * r; }

// cursor polygon (from icon.svg, scaled /1 coords 0..128)
const cursor = [[64,62],[64,98],[73,88],[80,102],[88,98],[81,85],[94,84]];
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function sample(sx, sy) {
  const x = sx * 128 / W, y = sy * 128 / W; // icon-space 0..128

  // outside rounded bg -> transparent
  const inBG = inRoundedRect(x, y, 4, 4, 120, 120, 28);
  if (!inBG) return [0, 0, 0, 0];

  // gradient bg (diagonal #4f46e5 -> #7c3aed)
  const t = Math.max(0, Math.min(1, (x + y) / 256));
  let r = Math.round(79 + (124 - 79) * t);
  let g = Math.round(70 + (58 - 70) * t);
  let b = Math.round(229 + (237 - 229) * t);

  // gloss: top half lighter
  if (y < 64) {
    const gt = 1 - y / 64;
    r = Math.round(r + (255 - r) * 0.25 * gt);
    g = Math.round(g + (255 - g) * 0.25 * gt);
    b = Math.round(b + (255 - b) * 0.25 * gt);
  }

  // signal arcs (stroke 7, white, alpha .55 / .8): arc from (40,52) to (88,52) radius 34 center (64,52)
  // arc1: center (64,52) r=34, upper half
  const dx1 = x - 64, dy1 = y - 52;
  const d1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
  const onArc1 = Math.abs(d1 - 34) <= 3.5 * 1.5 && y <= 52 && x >= 40 && x <= 88; // slight widen for AA
  const onArc2 = (() => { const dx = x - 64, dy = y - 60; const d = Math.sqrt(dx * dx + dy * dy); return Math.abs(d - 20) <= 3.5 * 1.5 && y <= 60 && x >= 50 && x <= 78; })();

  // cursor polygon + dark stroke
  const inCursor = pointInPolygon(x, y, cursor);
  let nearEdge = false;
  for (let i = 0, j = cursor.length - 1; i < cursor.length; j = i++) {
    if (distSeg(x, y, cursor[j][0], cursor[j][1], cursor[i][0], cursor[i][1]) <= 1.8) { nearEdge = true; break; }
  }

  // connection dot
  const inDot = inCircle(x, y, 64, 58, 6);

  if (inCursor || inDot) return [255, 255, 255, 255];
  if (nearEdge) { // dark indigo stroke #312e81
    return [49, 46, 129, 255];
  }
  if (onArc1) return [255, 255, 255, Math.round(255 * 0.55)];
  if (onArc2) return [255, 255, 255, Math.round(255 * 0.8)];

  return [r, g, b, 255];
}

// render with supersampling
const raw = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [pr, pg, pb, pa] = sample(x * SS + sx + 0.5, y * SS + sy + 0.5);
        // premultiplied accumulate
        r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
      }
    }
    const n = SS * SS;
    const o = (y * size + x) * 4;
    if (a > 0) {
      raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a);
      raw[o + 3] = Math.round(a / n);
    }
  }
}

// encode PNG (RGBA8)
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
// add filter byte per scanline
const rawF = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++) {
  rawF[y * (size * 4 + 1)] = 0;
  raw.copy(rawF, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(rawF, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);
fs.writeFileSync(process.argv[2], png);
console.log(`wrote ${process.argv[2]} ${size}x${size} ${png.length} bytes`);
