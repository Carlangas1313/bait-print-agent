/**
 * Tests para src/printers/escpos-decoder.ts
 *
 * Foco: garantizar que el decoder produce output legible y semanticamente
 * correcto para los comandos ESC/POS que node-thermal-printer emite. Los
 * tests usan buffers construidos a mano con las secuencias documentadas;
 * NO ejecutan ThermalPrinter real para mantener los tests rapidos y sin
 * dependencias.
 *
 * Si en el futuro se agregan layouts que usan comandos nuevos, sumar un
 * test aca que cubra el byte sequence y el tag esperado.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEscPos } from './escpos-decoder.js';

describe('decodeEscPos — texto plano', () => {
  it('decodea ASCII printable tal cual', () => {
    const buf = Buffer.from('Hola mundo', 'ascii');
    assert.equal(decodeEscPos(buf), 'Hola mundo');
  });

  it('LF se convierte en newline real', () => {
    const buf = Buffer.from([0x41, 0x0a, 0x42]); // "A\nB"
    assert.equal(decodeEscPos(buf), 'A\nB');
  });

  it('CR se descarta sin emitir nada', () => {
    const buf = Buffer.from([0x41, 0x0d, 0x42]); // "A\rB"
    assert.equal(decodeEscPos(buf), 'AB');
  });

  it('CR + LF en orden se condensa a un solo \\n', () => {
    const buf = Buffer.from([0x41, 0x0d, 0x0a, 0x42]);
    assert.equal(decodeEscPos(buf), 'A\nB');
  });

  it('bytes de control desconocidos se marcan en hex', () => {
    const buf = Buffer.from([0x41, 0x07, 0x42]); // 0x07 = BEL
    assert.equal(decodeEscPos(buf), 'A[0x07]B');
  });
});

describe('decodeEscPos — comandos ESC', () => {
  it('ESC @ → [INIT]\\n', () => {
    const buf = Buffer.from([0x1b, 0x40, 0x41]); // ESC @, "A"
    assert.equal(decodeEscPos(buf), '[INIT]\nA');
  });

  it('ESC ! 0x00 → [FONT A]', () => {
    const buf = Buffer.from([0x1b, 0x21, 0x00]);
    assert.equal(decodeEscPos(buf), '[FONT A]');
  });

  it('ESC ! 0x01 → [FONT B]', () => {
    const buf = Buffer.from([0x1b, 0x21, 0x01]);
    assert.equal(decodeEscPos(buf), '[FONT B]');
  });

  it('ESC ! 0x30 → [XL] (double H + W)', () => {
    const buf = Buffer.from([0x1b, 0x21, 0x30]);
    assert.equal(decodeEscPos(buf), '[XL]');
  });

  it('ESC E 1 → [BOLD], ESC E 0 → [/BOLD]', () => {
    const buf = Buffer.from([0x1b, 0x45, 0x01, 0x41, 0x1b, 0x45, 0x00]);
    assert.equal(decodeEscPos(buf), '[BOLD]A[/BOLD]');
  });

  it('ESC a 1 → [CENTER], ESC a 0 → [LEFT]', () => {
    const buf = Buffer.from([
      0x1b, 0x61, 0x01,
      0x54, 0x49, 0x54, // "TIT"
      0x1b, 0x61, 0x00
    ]);
    assert.equal(decodeEscPos(buf), '[CENTER]TIT[LEFT]');
  });
});

describe('decodeEscPos — comandos GS', () => {
  it('GS ! 0x11 → [SIZE 2x2]', () => {
    const buf = Buffer.from([0x1d, 0x21, 0x11]);
    assert.equal(decodeEscPos(buf), '[SIZE 2x2]');
  });

  it('GS ! 0x00 → [SIZE 1x1]', () => {
    const buf = Buffer.from([0x1d, 0x21, 0x00]);
    assert.equal(decodeEscPos(buf), '[SIZE 1x1]');
  });

  it('GS B 1 → [INV], GS B 0 → [/INV]', () => {
    const buf = Buffer.from([0x1d, 0x42, 0x01, 0x58, 0x1d, 0x42, 0x00]);
    assert.equal(decodeEscPos(buf), '[INV]X[/INV]');
  });

  it('GS V 0 → [CUT]', () => {
    const buf = Buffer.from([0x1d, 0x56, 0x00]);
    assert.equal(decodeEscPos(buf), '[CUT]');
  });

  it('GS V 65 n → [CUT] (cut with feed, consume 4 bytes)', () => {
    const buf = Buffer.from([0x1d, 0x56, 0x41, 0x05, 0x41]); // ESC V A 5, despues "A"
    // Espera "[CUT]A" — el "A" tras los 4 bytes del cut.
    assert.equal(decodeEscPos(buf), '[CUT]A');
  });
});

describe('decodeEscPos — raster bitmap (GS v 0)', () => {
  it('emite [IMAGE WxH bitmap] y skipea los bytes binarios', () => {
    // GS v 0 m wL wH hL hH d1 ...
    // 1 byte ancho (8 px) x 2 lineas alto = 2 bytes de data.
    const buf = Buffer.from([
      0x1d, 0x76, 0x30, 0x00, // GS v 0 m=0
      0x01, 0x00,             // wL=1, wH=0 → 1 byte = 8 px
      0x02, 0x00,             // hL=2, hH=0 → 2 lineas
      0xff, 0xff,             // 2 bytes raster (placeholder)
      0x41                    // "A" despues del bitmap
    ]);
    const out = decodeEscPos(buf);
    assert.match(out, /\[IMAGE 8x2 bitmap, 2 bytes\]A/);
  });
});

describe('decodeEscPos — QR (GS ( k)', () => {
  it('extrae la URL del store-data (fn=0x50)', () => {
    // GS ( k pL pH cn fn m d1 d2 ...
    // cn=49 (0x31), fn=80 (0x50), data="hola"
    // paramLen = 2 (cn+fn) + 1 (m) + 4 (data) = 7  → pL=7, pH=0
    // Actually paramLen counts bytes from cn onwards INCLUSIVE of cn+fn.
    // In our decoder: paramLen = pL + pH<<8, and the total consumed is
    // 5 (GS + ( + k + pL + pH) + paramLen. So paramLen must include cn+fn+m+data.
    // cn(1) + fn(1) + m(1) + 'hola'(4) = 7
    const data = Buffer.from('hola', 'ascii');
    const buf = Buffer.concat([
      Buffer.from([0x1d, 0x28, 0x6b, 0x07, 0x00, 0x31, 0x50, 0x30]),
      data
    ]);
    const out = decodeEscPos(buf);
    assert.match(out, /\[QR data: "hola"\]/);
  });
});

describe('decodeEscPos — ticket sintetico realista', () => {
  it('decodea un ticket mini: init + center + bold + texto + LF + cut', () => {
    const buf = Buffer.concat([
      Buffer.from([0x1b, 0x40]),            // ESC @
      Buffer.from([0x1b, 0x61, 0x01]),      // ESC a 1 (center)
      Buffer.from([0x1b, 0x45, 0x01]),      // ESC E 1 (bold)
      Buffer.from('La Cocina', 'ascii'),
      Buffer.from([0x0a]),                  // LF
      Buffer.from([0x1b, 0x45, 0x00]),      // ESC E 0 (/bold)
      Buffer.from([0x1b, 0x61, 0x00]),      // ESC a 0 (left)
      Buffer.from('TOTAL $5.000', 'ascii'),
      Buffer.from([0x0a]),                  // LF
      Buffer.from([0x1d, 0x56, 0x00])       // GS V 0 (cut)
    ]);
    const out = decodeEscPos(buf);
    // Verificamos los tags esperados, no el output exacto byte a byte:
    assert.match(out, /\[INIT\]/);
    assert.match(out, /\[CENTER\]/);
    assert.match(out, /\[BOLD\]La Cocina/);
    assert.match(out, /\[\/BOLD\]/);
    assert.match(out, /\[LEFT\]/);
    assert.match(out, /TOTAL \$5\.000/);
    assert.match(out, /\[CUT\]/);
  });
});

describe('decodeEscPos — robustez ante bytes truncos', () => {
  it('ESC al final del buffer no rompe — emite [ESC] y sigue', () => {
    const buf = Buffer.from([0x41, 0x1b]);
    assert.equal(decodeEscPos(buf), 'A[ESC]');
  });

  it('GS al final del buffer no rompe — emite [GS]', () => {
    const buf = Buffer.from([0x41, 0x1d]);
    assert.equal(decodeEscPos(buf), 'A[GS]');
  });

  it('ESC X desconocido emite [ESC 0xXX] y consume 2 bytes', () => {
    const buf = Buffer.from([0x1b, 0x99, 0x41]);
    assert.equal(decodeEscPos(buf), '[ESC 0x99]A');
  });

  it('buffer vacio devuelve string vacio', () => {
    assert.equal(decodeEscPos(Buffer.alloc(0)), '');
  });
});
