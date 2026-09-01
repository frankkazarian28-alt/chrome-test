/**
 * Generates the extension icons.
 *
 * The icon is the dial itself: a ring split into wedges, with the last wedge
 * drained to read as "a timer part-way through". Written by hand so the repo
 * needs no image tooling to rebuild them — run `node tools/make-icons.cjs`.
 */
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SIZES = [16, 32, 48, 128];
const WEDGES = [
  { sweep: 0.28, color: [79, 142, 247], drained: false },
  { sweep: 0.22, color: [34, 184, 166], drained: false },
  { sweep: 0.3, color: [242, 166, 59], drained: false },
  { sweep: 0.2, color: [232, 97, 140], drained: true }
];
const GAP = 0.012; // turns of blank between wedges
const SAMPLES = 4; // supersampling factor per axis

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Colour of the icon at one sample point, or null where it is transparent. */
function sample(x, y, size) {
  const center = size / 2;
  const dx = x - center;
  const dy = y - center;
  const radius = Math.hypot(dx, dy);
  const outer = size * 0.46;
  const inner = size * 0.24;
  if (radius > outer || radius < inner) return null;

  // Turns clockwise from 12 o'clock.
  let turn = (Math.atan2(dx, -dy) / (Math.PI * 2) + 1) % 1;

  let start = 0;
  for (const wedge of WEDGES) {
    const end = start + wedge.sweep;
    if (turn >= start && turn < end) {
      const half = GAP / 2;
      if (turn < start + half || turn > end - half) return null;
      const alpha = wedge.drained ? 0.28 : 1;
      return [wedge.color[0], wedge.color[1], wedge.color[2], alpha];
    }
    start = end;
  }
  return null;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / SAMPLES;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const hit = sample(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size);
          if (!hit) continue;
          r += hit[0] * hit[3];
          g += hit[1] * hit[3];
          b += hit[2] * hit[3];
          a += hit[3];
        }
      }
      const total = SAMPLES * SAMPLES;
      const offset = (y * size + x) * 4;
      if (a > 0) {
        rgba[offset] = Math.round(r / a);
        rgba[offset + 1] = Math.round(g / a);
        rgba[offset + 2] = Math.round(b / a);
        rgba[offset + 3] = Math.round((a / total) * 255);
      }
    }
  }
  return encodePng(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)`);
}
