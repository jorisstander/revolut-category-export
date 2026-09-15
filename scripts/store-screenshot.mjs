#!/usr/bin/env node
// Build the Chrome Web Store listing image from the README screenshot.
//
// The Store takes 1280×800 or 640×400. `docs/screenshot.png` is the popup at
// its own portrait aspect, right above a README and wrong for a listing. This
// centres it on a canvas of the accepted size.
//
// It does the compositing here rather than through a browser because a capture
// step is a step somebody has to remember, get the zoom right for, and redo
// whenever the popup changes. This is one command, and it produces the same
// image every time from the same input.
//
// There is a PNG codec below, in the sense that a bicycle contains an engine:
// it reads 8-bit non-interlaced images, with or without an alpha channel, and
// writes them back without one. Both turn up in practice -- a screenshot saved
// from a viewer tends to be truecolour, and one produced by a canvas is always
// RGBA. Anything else is refused rather than guessed at. `node:zlib` does the
// actual compression, so this stays dependency-free like everything else here.
//
// Usage: node scripts/store-screenshot.mjs
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const SOURCE = 'docs/screenshot.png';
const TARGET = 'docs/store-assets/store-1280x800.png';

const CANVAS_W = 1280;
const CANVAS_H = 800;
const SHOT_H = 700;                       // leaves a 50px margin above and below
const BACKGROUND = [0xf4, 0xf4, 0xf2];    // the popup's own paper tone, a shade cooler
const BORDER = [0xd8, 0xd6, 0xd0];        // a hairline, so the popup does not float

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An 8-bit PNG as {width, height, rgb} with three bytes per pixel.
 *
 *  Colour type 6 (RGBA) is accepted and flattened onto `BACKGROUND`, which is
 *  the colour it is about to be placed on anyway. Where the image is fully
 *  opaque, as a popup screenshot is, that is a no-op that just drops the
 *  channel.
 */
function decodePng(file) {
  if (file.readUInt32BE(0) !== 0x89504e47) throw new Error(`${SOURCE} is not a PNG`);

  const width = file.readUInt32BE(16);
  const height = file.readUInt32BE(20);
  const [depth, colour, , , interlace] = [file[24], file[25], file[26], file[27], file[28]];
  if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) {
    throw new Error(
      `${SOURCE} is bit depth ${depth}, colour type ${colour}, interlace ${interlace}; ` +
      `this reads 8-bit truecolour or RGBA, non-interlaced. Re-save it as one, or widen this.`
    );
  }
  const channels = colour === 6 ? 4 : 3;

  const parts = [];
  for (let offset = 8; offset < file.length;) {
    const length = file.readUInt32BE(offset);
    const type = file.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'IDAT') parts.push(file.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const flat = Buffer.alloc(height * stride);

  // Undo the per-scanline filters. Each row is prefixed with the filter it used,
  // and every filter but None refers to the row above, so this cannot be done
  // out of order.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      // Filters refer to the pixel to the left, which is `channels` bytes back,
      // not three -- getting that wrong on an RGBA image shears the colours.
      const left = x >= channels ? flat[y * stride + x - channels] : 0;
      const up = y > 0 ? flat[(y - 1) * stride + x] : 0;
      const upLeft = (x >= channels && y > 0) ? flat[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        // Paeth: whichever of the three neighbours the gradient points nearest.
        const p = left + up - upLeft;
        const dl = Math.abs(p - left), du = Math.abs(p - up), dul = Math.abs(p - upLeft);
        value += (dl <= du && dl <= dul) ? left : (du <= dul ? up : upLeft);
      } else if (filter !== 0) {
        throw new Error(`unknown PNG row filter ${filter} on line ${y}`);
      }
      flat[y * stride + x] = value & 0xff;
    }
  }

  if (channels === 3) return { width, height, rgb: flat };

  // Flatten onto the background it is about to sit on.
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const a = flat[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) {
      rgb[i * 3 + c] = Math.round(flat[i * 4 + c] * a + BACKGROUND[c] * (1 - a));
    }
  }
  return { width, height, rgb };
}

/** Area-averaged resize. A downscale that samples one pixel per target aliases
 *  text badly, and this image is almost entirely text. */
function resize(image, width, height) {
  const out = Buffer.alloc(width * height * 3);
  const xRatio = image.width / width;
  const yRatio = image.height / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * xRatio)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * image.width + sx) * 3;
          r += image.rgb[at]; g += image.rgb[at + 1]; b += image.rgb[at + 2];
          n++;
        }
      }
      const at = (y * width + x) * 3;
      out[at] = Math.round(r / n);
      out[at + 1] = Math.round(g / n);
      out[at + 2] = Math.round(b / n);
    }
  }
  return { width, height, rgb: out };
}

function encodePng({ width, height, rgb }) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;            // filter None: the image is mostly flat
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;                          // bit depth
  header[9] = 2;                          // colour type: truecolour
  header[10] = 0; header[11] = 0; header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const source = decodePng(readFileSync(SOURCE));
const shotW = Math.round(source.width * (SHOT_H / source.height));
const shot = resize(source, shotW, SHOT_H);

const canvas = Buffer.alloc(CANVAS_W * CANVAS_H * 3);
for (let i = 0; i < CANVAS_W * CANVAS_H; i++) {
  canvas[i * 3] = BACKGROUND[0];
  canvas[i * 3 + 1] = BACKGROUND[1];
  canvas[i * 3 + 2] = BACKGROUND[2];
}

const left = Math.round((CANVAS_W - shotW) / 2);
const top = Math.round((CANVAS_H - SHOT_H) / 2);
for (let y = 0; y < SHOT_H; y++) {
  shot.rgb.copy(canvas, ((top + y) * CANVAS_W + left) * 3, y * shotW * 3, (y + 1) * shotW * 3);
}

// A hairline around it, so a light popup on a light ground still has an edge.
for (let x = left - 1; x <= left + shotW; x++) {
  for (const y of [top - 1, top + SHOT_H]) {
    const at = (y * CANVAS_W + x) * 3;
    canvas[at] = BORDER[0]; canvas[at + 1] = BORDER[1]; canvas[at + 2] = BORDER[2];
  }
}
for (let y = top - 1; y <= top + SHOT_H; y++) {
  for (const x of [left - 1, left + shotW]) {
    const at = (y * CANVAS_W + x) * 3;
    canvas[at] = BORDER[0]; canvas[at + 1] = BORDER[1]; canvas[at + 2] = BORDER[2];
  }
}

mkdirSync('docs/store-assets', { recursive: true });
const png = encodePng({ width: CANVAS_W, height: CANVAS_H, rgb: canvas });
writeFileSync(TARGET, png);
console.log(`${TARGET}  ${CANVAS_W}×${CANVAS_H}, popup at ${shotW}×${SHOT_H}, ${(png.length / 1024).toFixed(1)} KB`);
