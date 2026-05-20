#!/usr/bin/env node
/**
 * Genera los PNGs placeholder para tray y bundle del companion.
 * Output:
 *   src-tauri/icons/tray-icon.png  (32x32)
 *   src-tauri/icons/32x32.png      (32x32)
 *   src-tauri/icons/128x128.png    (128x128)
 *   src-tauri/icons/128x128@2x.png (256x256)
 *   src-tauri/icons/icon.png       (512x512 — para bundle)
 *
 * Diseño: navy (#0a1929) con la "b" en cyan (#00bcd4), borde sutil cyan.
 * Implementado con primitives de zlib + crc para evitar dependencias.
 *
 * Tipografía: glifo dibujado por nosotros (no podemos cargar fuentes sin libs).
 * Es un placeholder — Carlos lo refina con un PNG real de Figma.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../src-tauri/icons");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// ---- Paleta ----
const NAVY = [0x0a, 0x19, 0x29];
const CYAN = [0x00, 0xbc, 0xd4];
const CYAN_DARK = [0x00, 0x83, 0x9f];
const TRANSPARENT = [0, 0, 0, 0];

// ---- PNG primitives ----
function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  const crcInput = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function pngFromRGBA(width, height, pixels /* Uint8Array length=w*h*4 */) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = chunk("IHDR", ihdr);

  // Filter byte 0 (None) per row
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < stride; x++) {
      raw[y * (stride + 1) + 1 + x] = pixels[y * stride + x];
    }
  }
  const idatChunk = chunk("IDAT", deflateSync(raw, { level: 9 }));
  const iendChunk = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

// ---- Drawing helpers ----
function makeCanvas(size) {
  const px = new Uint8Array(size * size * 4); // start transparent
  return px;
}

function setPx(px, size, x, y, [r, g, b, a = 255]) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
}

function fillRoundedRect(px, size, x0, y0, x1, y1, radius, color) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // round corners
      const inCornerTL = x < x0 + radius && y < y0 + radius;
      const inCornerTR = x > x1 - radius && y < y0 + radius;
      const inCornerBL = x < x0 + radius && y > y1 - radius;
      const inCornerBR = x > x1 - radius && y > y1 - radius;
      if (inCornerTL) {
        const dx = x - (x0 + radius);
        const dy = y - (y0 + radius);
        if (dx * dx + dy * dy > radius * radius) continue;
      } else if (inCornerTR) {
        const dx = x - (x1 - radius);
        const dy = y - (y0 + radius);
        if (dx * dx + dy * dy > radius * radius) continue;
      } else if (inCornerBL) {
        const dx = x - (x0 + radius);
        const dy = y - (y1 - radius);
        if (dx * dx + dy * dy > radius * radius) continue;
      } else if (inCornerBR) {
        const dx = x - (x1 - radius);
        const dy = y - (y1 - radius);
        if (dx * dx + dy * dy > radius * radius) continue;
      }
      setPx(px, size, x, y, color);
    }
  }
}

function strokeRoundedRect(px, size, x0, y0, x1, y1, radius, color) {
  // simple — draw a thin band by drawing outer filled then erasing inner.
  // Since we want a 1-px stroke, draw the perimeter pixels of the rounded box.
  const inside = makeCanvas(size);
  fillRoundedRect(inside, size, x0 + 1, y0 + 1, x1 - 1, y1 - 1, Math.max(0, radius - 1), [1, 1, 1, 1]);
  const outline = makeCanvas(size);
  fillRoundedRect(outline, size, x0, y0, x1, y1, radius, [1, 1, 1, 1]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (outline[i + 3] && !inside[i + 3]) {
        setPx(px, size, x, y, color);
      }
    }
  }
}

/**
 * Dibuja un glifo "b" en (cx, cy) con altura ~h y color dado.
 * Compuesto por: una barra vertical + un círculo en la parte baja.
 */
function drawB(px, size, cx, cy, h, color) {
  const stroke = Math.max(1, Math.round(h * 0.18));
  const barTop = cy - h / 2;
  const barBot = cy + h / 2;
  const barX = cx - h * 0.32;

  // barra vertical
  for (let y = Math.round(barTop); y <= Math.round(barBot); y++) {
    for (let dx = 0; dx < stroke; dx++) {
      setPx(px, size, Math.round(barX) + dx, y, color);
    }
  }

  // bowl: anillo en la mitad inferior, centrado un poco a la derecha de la barra
  const bowlRadius = h * 0.30;
  const bowlCx = Math.round(barX) + stroke + bowlRadius * 0.85;
  const bowlCy = cy + h * 0.18;
  const innerR = bowlRadius - stroke;
  for (let y = -bowlRadius - 1; y <= bowlRadius + 1; y++) {
    for (let x = -bowlRadius - 1; x <= bowlRadius + 1; x++) {
      const d2 = x * x + y * y;
      if (d2 <= bowlRadius * bowlRadius && d2 >= innerR * innerR) {
        setPx(px, size, Math.round(bowlCx + x), Math.round(bowlCy + y), color);
      }
    }
  }
}

// ---- Generate one icon ----
function generate(size) {
  const px = makeCanvas(size);

  // Fondo navy con esquinas redondeadas
  const radius = Math.max(2, Math.round(size * 0.22));
  fillRoundedRect(px, size, 0, 0, size - 1, size - 1, radius, [...NAVY, 255]);

  // Borde cyan sutil
  strokeRoundedRect(px, size, 0, 0, size - 1, size - 1, radius, [...CYAN, 130]);

  // "b" cyan centrada (un poco a la izquierda visualmente para compensar el bowl)
  const glyphH = Math.round(size * 0.55);
  const cx = Math.round(size * 0.50);
  const cy = Math.round(size * 0.52);
  drawB(px, size, cx, cy, glyphH, [...CYAN, 255]);

  return pngFromRGBA(size, size, px);
}

// ---- Write outputs ----
const TARGETS = [
  ["tray-icon.png", 32],
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
];

for (const [name, size] of TARGETS) {
  const buf = generate(size);
  const outPath = resolve(OUT_DIR, name);
  writeFileSync(outPath, buf);
  console.log(`✔ ${name} (${size}x${size}) — ${buf.length} bytes`);
}

console.log("");
console.log(`Output: ${OUT_DIR}`);
console.log("Nota: icon.ico e icon.icns no se generan acá — Tauri los puede");
console.log("crear con `npx tauri icon ./src-tauri/icons/icon.png` cuando");
console.log("Rust + Tauri CLI estén disponibles.");
