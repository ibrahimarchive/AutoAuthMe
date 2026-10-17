import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

function createCRC32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
}

const crcTable = createCRC32Table();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcBuf = Buffer.alloc(4);
  const toHash = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(toHash), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function generatePNG(size) {
  const width = size;
  const height = size;
  const rawData = Buffer.alloc((width * 4 + 1) * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * 4 + 1);
    rawData[rowOffset] = 0; // Filter byte 0 (None)

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;

      // Normalized coordinates [-1, 1]
      const nx = (x / (width - 1)) * 2 - 1;
      const ny = (y / (height - 1)) * 2 - 1;
      const dist = Math.sqrt(nx * nx + ny * ny);

      // Rounded rectangle shield-like background
      const rx = Math.abs(nx);
      const ry = Math.abs(ny);
      const inBox = (rx < 0.88 && ry < 0.88);

      if (inBox) {
        // Gradient from Deep Violet (#4f46e5) to Cyan/Teal (#06b6d4)
        const t = (nx + ny + 2) / 4;
        let r = Math.round(79 * (1 - t) + 6 * t);
        let g = Math.round(70 * (1 - t) + 182 * t);
        let b = Math.round(229 * (1 - t) + 212 * t);

        // Center keyhole/shield icon silhouette (white lock icon)
        // Shackle: top circle
        const shackleDist = Math.sqrt(nx * nx + (ny + 0.22) * (ny + 0.22));
        const inShackle = shackleDist < 0.32 && shackleDist > 0.16 && ny < -0.05;

        // Lock body: rounded box
        const inBody = (Math.abs(nx) < 0.42 && ny >= -0.05 && ny <= 0.45);

        // Keyhole inside body
        const keyholeCircle = Math.sqrt(nx * nx + (ny - 0.15) * (ny - 0.15)) < 0.09;
        const keyholeSlot = (Math.abs(nx) < 0.04 && ny >= 0.15 && ny <= 0.30);
        const inKeyhole = keyholeCircle || keyholeSlot;

        if (inShackle || (inBody && !inKeyhole)) {
          // Pure bright white lock with subtle glow
          r = 255;
          g = 255;
          b = 255;
        }

        rawData[pxOffset] = r;
        rawData[pxOffset + 1] = g;
        rawData[pxOffset + 2] = b;
        rawData[pxOffset + 3] = 255;
      } else {
        // Transparent border
        rawData[pxOffset] = 0;
        rawData[pxOffset + 1] = 0;
        rawData[pxOffset + 2] = 0;
        rawData[pxOffset + 3] = 0;
      }
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = writeChunk('IHDR', ihdr);

  // IDAT chunk
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = writeChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = writeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

const iconsDir = path.resolve('icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 32, 48, 128].forEach(size => {
  const pngBuf = generatePNG(size);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, pngBuf);
  console.log(`Generated icon${size}.png (${pngBuf.length} bytes)`);
});
