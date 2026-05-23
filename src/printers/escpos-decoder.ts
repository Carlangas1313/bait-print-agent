/**
 * Decoder ESC/POS -> texto plano legible (con anotaciones de formato inline).
 *
 * Sensor de diagnostico (v0.9.6): cuando el agente termina un job USB en el
 * spooler de Windows, ademas de mandar los bytes a la termica, los decodifica
 * a un .txt humano-legible y lo guarda en `~/.bait-print-agent/captures/`. Asi
 * un operador (humano o Claude) puede ver EXACTAMENTE que se imprimio sin
 * tener el papel fisico delante.
 *
 * Diseno general:
 * ---------------
 *  - Texto printable (CP858/CP437 + ASCII 0x20-0x7E) -> tal cual.
 *  - LF (0x0A) -> newline real ('\n').
 *  - CR (0x0D) -> ignorado (la termica lo trata como linefeed sin avance, no
 *    aporta al texto).
 *  - ESC (0x1B) -> mira el byte siguiente y emite tag inline `[CMD]` o
 *    `[CMD param]`. Algunos comandos consumen bytes adicionales (ej. ESC ! n
 *    consume 1 byte de modo).
 *  - GS (0x1D) -> idem. Importante para `[CUT]` (GS V), `[INV]` (GS B), QR
 *    (GS k) y raster bitmap (GS v 0).
 *  - Cualquier byte no-printable y no-conocido -> `[0xXX]`.
 *
 * Comandos soportados:
 * --------------------
 * El listado matchea los que `node-thermal-printer` emite con la character
 * set PC858 que usamos en el transport. Si en el futuro se agregan layouts
 * que usen comandos nuevos, sumarlos aca y caen al fallback `[0xXX]`.
 *
 *  - ESC @            -> [INIT]\n
 *  - ESC ! n          -> [FONT A] / [FONT B] / [XL] / [FONT B XL] (segun bits)
 *  - ESC E n          -> [BOLD] / [/BOLD]
 *  - ESC a n          -> [LEFT] / [CENTER] / [RIGHT]
 *  - ESC t n          -> [CODEPAGE n] (cambio de tabla de caracteres)
 *  - ESC d n          -> [FEED n]
 *  - ESC J n          -> [FEED n/180in]
 *  - ESC - n          -> [UNDERLINE] / [/UNDERLINE]
 *  - GS ! n           -> [SIZE WxH] (bits altos = width, bajos = height)
 *  - GS B n           -> [INV] / [/INV]
 *  - GS V m [n]       -> [CUT] (m=0,1 full / m=65,66 partial — los unificamos)
 *  - GS v 0 m wL wH hL hH ... -> [IMAGE WxH bitmap]   (skip raster bytes)
 *  - GS ( k ...       -> [QR ...] (los GS ( k del workflow QR de node-thermal-printer)
 *  - ESC p m t1 t2    -> [BEEP]  (kick drawer; node-thermal-printer lo usa como
 *                                 trigger del beep tambien)
 *  - LF (0x0A)        -> '\n' real
 *  - CR (0x0D)        -> ignorar
 *
 * Cualquier otro ESC X o GS X consume el comando ESC/GS + el byte que sigue
 * y emite `[ESC 0xXX]` o `[GS 0xXX]`. No es perfecto pero es debug.
 */

/**
 * Tabla de mapeo simple para nombrar comandos comunes en el output decodeado.
 * El switch en `decodeEscPos` es la fuente de verdad — esta tabla es solo
 * para documentacion / referencia.
 */
export const ESCPOS_COMMAND_NAMES: Readonly<Record<string, string>> = {
  '1B 40': 'INIT',
  '1B 21': 'FONT MODE',
  '1B 45': 'BOLD',
  '1B 61': 'ALIGN',
  '1B 74': 'CODEPAGE',
  '1B 64': 'FEED LINES',
  '1B 4A': 'FEED DOTS',
  '1B 2D': 'UNDERLINE',
  '1B 70': 'KICK/BEEP',
  '1D 21': 'TEXT SIZE',
  '1D 42': 'INVERT',
  '1D 56': 'CUT',
  '1D 76 30': 'RASTER BITMAP',
  '1D 28 6B': 'QR'
};

/**
 * Decodifica un buffer ESC/POS a string legible.
 *
 * No valida — si encuentra bytes inesperados los marca `[0xXX]` y sigue.
 * El objetivo es DIAGNOSTICO, no ser un parser estricto. Un buffer corrupto
 * decodea a algo "casi correcto" + algunos tags raros que indican el problema.
 *
 * No lanza nunca. Garantia: para cualquier Buffer, retorna un string.
 */
export function decodeEscPos(buffer: Buffer): string {
  const out: string[] = [];
  let i = 0;
  const len = buffer.length;

  // Buffer para acumular texto printable contiguo. Se flushea cuando aparece
  // un comando (LF, ESC, GS, etc) para que el output mantenga el orden
  // [TAG]texto[TAG]texto sin pegar todo en una sola linea.
  let textRun: number[] = [];
  const flushText = () => {
    if (textRun.length > 0) {
      out.push(decodeTextRun(textRun));
      textRun = [];
    }
  };

  while (i < len) {
    const b = buffer[i] as number;

    // LF: terminamos la linea actual y emitimos newline real.
    if (b === 0x0a) {
      flushText();
      out.push('\n');
      i += 1;
      continue;
    }

    // CR: lo descartamos. La termica lo trata como retorno al margen sin
    // avance, lo que no agrega caracter al output decodeado.
    if (b === 0x0d) {
      i += 1;
      continue;
    }

    // ESC (0x1B)
    if (b === 0x1b) {
      flushText();
      const consumed = decodeEscSequence(buffer, i, out);
      i += consumed;
      continue;
    }

    // GS (0x1D)
    if (b === 0x1d) {
      flushText();
      const consumed = decodeGsSequence(buffer, i, out);
      i += consumed;
      continue;
    }

    // FS (0x1C) — algunos comandos de set internacional. No los emitimos
    // como texto. Consumimos 2 bytes (FS + arg) y emitimos tag generico.
    if (b === 0x1c) {
      flushText();
      const next = i + 1 < len ? buffer[i + 1] : undefined;
      out.push(`[FS${next !== undefined ? ` 0x${next.toString(16).toUpperCase().padStart(2, '0')}` : ''}]`);
      i += next !== undefined ? 2 : 1;
      continue;
    }

    // Printable (ASCII y caracteres extendidos CP858/CP437). Acumulamos en
    // textRun para flushear de a chunks; asi varios bytes seguidos se decodean
    // como un solo string en lugar de emitirse byte a byte.
    if (b >= 0x20 && b <= 0xff) {
      textRun.push(b);
      i += 1;
      continue;
    }

    // Bytes de control no conocidos (0x00-0x1F sin LF/CR/ESC/GS/FS). Los
    // marcamos en hex para no perder informacion.
    flushText();
    out.push(`[0x${b.toString(16).toUpperCase().padStart(2, '0')}]`);
    i += 1;
  }

  flushText();
  return out.join('');
}

/**
 * Decodea un run de bytes printable a string. Para CP858/CP437 (los 128+
 * extendidos), hacemos una aproximacion: los caracteres CP858 que tienen
 * equivalente en Latin-1 los mapeamos. El resto se emite como `?` para no
 * romper el txt humano-legible.
 *
 * Nota: el decoder NO necesita ser perfectamente preciso en el charset, su
 * objetivo es legibilidad para diagnostico. Si el operador necesita el byte
 * exacto, mira el log + el .bin que el spooler ya descarto.
 */
function decodeTextRun(bytes: number[]): string {
  // Buffer + Buffer.toString('latin1') es la forma mas directa de convertir
  // bytes 0x20-0xFF a un string preservable. PC858 difiere de Latin-1 en
  // algunos slots (Euro 0xD5 vs O-acute) pero para diagnostico es suficiente.
  return Buffer.from(bytes).toString('latin1');
}

/**
 * Decodea una secuencia ESC X [args]. Avanza el output con el tag apropiado
 * y retorna cuantos bytes consumio (incluyendo el 0x1B inicial).
 *
 * Si el ESC esta al final del buffer (sin byte siguiente), consume 1 byte y
 * emite `[ESC]`.
 */
function decodeEscSequence(buffer: Buffer, start: number, out: string[]): number {
  const len = buffer.length;
  if (start + 1 >= len) {
    out.push('[ESC]');
    return 1;
  }

  const cmd = buffer[start + 1] as number;

  switch (cmd) {
    // ESC @ — inicializar impresora. Sin args.
    case 0x40:
      out.push('[INIT]\n');
      return 2;

    // ESC ! n — modo de print (bits: bold, double-h, double-w, underline,
    //                          font A/B). Lo decodeamos a tags humanos.
    case 0x21: {
      if (start + 2 >= len) {
        out.push('[ESC ! ?]');
        return 2;
      }
      const mode = buffer[start + 2] as number;
      out.push(formatPrintMode(mode));
      return 3;
    }

    // ESC E n — bold on/off.
    case 0x45: {
      if (start + 2 >= len) return 2;
      const on = (buffer[start + 2] as number) !== 0;
      out.push(on ? '[BOLD]' : '[/BOLD]');
      return 3;
    }

    // ESC a n — align: 0=left, 1=center, 2=right.
    case 0x61: {
      if (start + 2 >= len) return 2;
      const v = buffer[start + 2] as number;
      const align = v === 1 ? '[CENTER]' : v === 2 ? '[RIGHT]' : '[LEFT]';
      out.push(align);
      return 3;
    }

    // ESC t n — seleccionar codepage. Solo informativo.
    case 0x74: {
      if (start + 2 >= len) return 2;
      const cp = buffer[start + 2] as number;
      out.push(`[CODEPAGE ${cp}]`);
      return 3;
    }

    // ESC d n — feed n lines.
    case 0x64: {
      if (start + 2 >= len) return 2;
      const n = buffer[start + 2] as number;
      out.push(`[FEED ${n}]`);
      return 3;
    }

    // ESC J n — feed n/180 inch (motion units finos). Lo emitimos minimal.
    case 0x4a: {
      if (start + 2 >= len) return 2;
      const n = buffer[start + 2] as number;
      out.push(`[FEED-DOTS ${n}]`);
      return 3;
    }

    // ESC - n — underline: 0=off, 1=on, 2=double.
    case 0x2d: {
      if (start + 2 >= len) return 2;
      const v = buffer[start + 2] as number;
      out.push(v === 0 ? '[/UNDERLINE]' : '[UNDERLINE]');
      return 3;
    }

    // ESC p m t1 t2 — kick cash drawer (algunos firmwares lo usan tambien
    // como beep). 4 bytes total.
    case 0x70: {
      if (start + 4 >= len) {
        out.push('[KICK?]');
        return 2;
      }
      out.push('[BEEP/KICK]');
      return 5;
    }

    // ESC R n — international character set.
    case 0x52: {
      if (start + 2 >= len) return 2;
      const n = buffer[start + 2] as number;
      out.push(`[INTL-CHARSET ${n}]`);
      return 3;
    }

    // ESC 3 n / ESC 2 — line spacing. Consumimos pero no etiquetamos en
    // detalle.
    case 0x33: {
      if (start + 2 >= len) return 2;
      const n = buffer[start + 2] as number;
      out.push(`[LINE-SPACING ${n}/180]`);
      return 3;
    }
    case 0x32:
      out.push('[LINE-SPACING DEFAULT]');
      return 2;

    // Desconocido: emitimos tag con el byte hex y consumimos 2 bytes
    // (asumiendo que casi todos los ESC X comandos llevan 1 byte de arg).
    // Si en realidad lleva mas, los siguientes se van a leer como texto
    // o como otra secuencia, pero al menos el ESC no se "come" todo el
    // resto del buffer.
    default: {
      const hex = cmd.toString(16).toUpperCase().padStart(2, '0');
      out.push(`[ESC 0x${hex}]`);
      return 2;
    }
  }
}

/**
 * Formatea el byte n de `ESC ! n` a tags humanos. El byte es un bitfield:
 *   bit 0 (0x01) -> font B
 *   bit 3 (0x08) -> bold
 *   bit 4 (0x10) -> double-height
 *   bit 5 (0x20) -> double-width
 *   bit 7 (0x80) -> underline
 *
 * Combinaciones comunes que emitimos como tag unificado:
 *  - 0x00 -> [FONT A]
 *  - 0x01 -> [FONT B]
 *  - 0x10 -> [FONT A 2H]
 *  - 0x20 -> [FONT A 2W]
 *  - 0x30 -> [XL]   (double-height + double-width)
 *
 * Para combinaciones raras emitimos `[FONT bits=0xXX]`.
 */
function formatPrintMode(n: number): string {
  if (n === 0x00) return '[FONT A]';
  if (n === 0x01) return '[FONT B]';
  if (n === 0x10) return '[FONT A 2H]';
  if (n === 0x20) return '[FONT A 2W]';
  if (n === 0x30) return '[XL]';
  if (n === 0x11) return '[FONT B 2H]';
  if (n === 0x21) return '[FONT B 2W]';
  if (n === 0x31) return '[FONT B XL]';

  // Decoded bitfield para casos raros (incluye bold/underline si vienen).
  const parts: string[] = [];
  parts.push((n & 0x01) !== 0 ? 'FONT B' : 'FONT A');
  if ((n & 0x08) !== 0) parts.push('BOLD');
  if ((n & 0x10) !== 0) parts.push('2H');
  if ((n & 0x20) !== 0) parts.push('2W');
  if ((n & 0x80) !== 0) parts.push('UNDERLINE');
  return `[${parts.join(' ')}]`;
}

/**
 * Decodea una secuencia GS X [args]. Igual semantica que decodeEscSequence:
 * avanza el output y retorna bytes consumidos (incluido el 0x1D inicial).
 */
function decodeGsSequence(buffer: Buffer, start: number, out: string[]): number {
  const len = buffer.length;
  if (start + 1 >= len) {
    out.push('[GS]');
    return 1;
  }

  const cmd = buffer[start + 1] as number;

  switch (cmd) {
    // GS ! n — select character size. Bits altos (4-7) = ancho-1, bits bajos
    // (0-3) = alto-1. Asi 0x00 = 1x1, 0x11 = 2x2, 0x33 = 4x4.
    case 0x21: {
      if (start + 2 >= len) {
        out.push('[GS !]');
        return 2;
      }
      const v = buffer[start + 2] as number;
      const width = ((v >> 4) & 0x0f) + 1;
      const height = (v & 0x0f) + 1;
      out.push(`[SIZE ${width}x${height}]`);
      return 3;
    }

    // GS B n — invert (reverse white/black). 0=off, !=0 on.
    case 0x42: {
      if (start + 2 >= len) return 2;
      const on = (buffer[start + 2] as number) !== 0;
      out.push(on ? '[INV]' : '[/INV]');
      return 3;
    }

    // GS V m [n] — cut paper.
    //   m=0: full cut
    //   m=1: partial cut
    //   m=65 (0x41), m=66 (0x42): cut with feed (4 bytes: GS V m n)
    // Unificamos todo a [CUT] para diagnostico — el modo exacto no aporta
    // al objetivo del sensor.
    case 0x56: {
      if (start + 2 >= len) {
        out.push('[CUT]');
        return 2;
      }
      const m = buffer[start + 2] as number;
      out.push('[CUT]');
      // m=65/66 + n (feed lines antes del corte) = 4 bytes
      if (m === 0x41 || m === 0x42) {
        return 4;
      }
      return 3;
    }

    // GS v 0 m wL wH hL hH d1 ... — raster bitmap. Los bytes de imagen los
    // skippamos del decode (son binarios opacos) y emitimos `[IMAGE WxH bitmap]`
    // con las dimensiones para diagnostico.
    case 0x76: {
      // Esperamos GS v 0 m wL wH hL hH ...
      if (start + 7 >= len) {
        out.push('[IMAGE ?]');
        return len - start;
      }
      // buffer[start+2] debe ser 0x30 ('0') — modo raster.
      const mode = buffer[start + 2] as number;
      if (mode !== 0x30) {
        // Otra variante de GS v no documentada aca. Consumimos solo el header.
        const hex = mode.toString(16).toUpperCase().padStart(2, '0');
        out.push(`[GS v 0x${hex}]`);
        return 3;
      }
      // buffer[start+3] = m (densidad)
      const wL = buffer[start + 4] as number;
      const wH = buffer[start + 5] as number;
      const hL = buffer[start + 6] as number;
      const hH = buffer[start + 7] as number;
      const widthBytes = wL + (wH << 8);
      const height = hL + (hH << 8);
      const dataLen = widthBytes * height;
      const totalConsumed = 8 + dataLen;
      out.push(`[IMAGE ${widthBytes * 8}x${height} bitmap, ${dataLen} bytes]`);
      // Si el bitmap declarado se pasa del buffer, consumimos hasta el final
      // para no quedar leyendo basura.
      if (start + totalConsumed > len) {
        return len - start;
      }
      return totalConsumed;
    }

    // GS ( k pL pH cn fn ... — comandos QR (set model, set size, set EC level,
    // store data, print). El protocolo es modal: varias secuencias `GS ( k`
    // arman el QR; la que tiene `fn=0x51` (81) es el "print symbol data".
    //
    // En vez de implementar el state machine completo, emitimos un solo tag
    // `[QR cmd=fn paramLen=L]` por cada GS ( k que aparezca, y para fn=0x50
    // (store data) intentamos extraer la URL. Asi el sensor reporta:
    //
    //   [QR cmd=83 ...]   -> set size
    //   [QR data: "https://..."]  -> el contenido
    //   [QR cmd=81 ...]   -> print
    //
    // El operador ve la URL y los pasos, suficiente para diagnostico.
    case 0x28: {
      if (start + 3 >= len) {
        out.push('[GS (]');
        return 2;
      }
      const sub = buffer[start + 2] as number;
      if (sub !== 0x6b) {
        // GS ( X — comando no QR. Lo emitimos como tag opaco.
        const subHex = sub.toString(16).toUpperCase().padStart(2, '0');
        out.push(`[GS ( 0x${subHex}]`);
        return 3;
      }
      // GS ( k: pL, pH, cn, fn, [m, ...data...]
      // length = pL + pH*256 (bytes desde cn en adelante)
      if (start + 6 >= len) {
        out.push('[QR ?]');
        return len - start;
      }
      const pL = buffer[start + 3] as number;
      const pH = buffer[start + 4] as number;
      const cn = buffer[start + 5] as number;
      const fn = buffer[start + 6] as number;
      const paramLen = pL + (pH << 8);
      // Total bytes consumidos: 5 header (GS + '(' + 'k' + pL + pH) + paramLen (cn fn ...)
      const totalConsumed = 5 + paramLen;

      // Caso especial: fn=0x50 (80, store data) tiene los bytes:
      //   GS ( k pL pH cn fn m d1 d2 ... dN
      // donde m (1 byte, 0x30='0' segun spec) es el selector del submode de
      // store-data, y dN son los caracteres del payload del QR. paramLen
      // cuenta cn+fn+m+data, asi que data arranca en start+8 (skip m) y
      // termina en start+5+paramLen.
      if (cn === 0x31 && fn === 0x50) {
        const dataStart = start + 8;
        const dataEnd = Math.min(start + 5 + paramLen, len);
        if (dataEnd > dataStart) {
          const dataBytes = buffer.subarray(dataStart, dataEnd);
          // latin1 mantiene los bytes 0x20-0xFF tal cual (URLs, ids ASCII, que
          // es lo tipico del QR). Si en el futuro alguien mete UTF-8 en el
          // payload, latin1 lo emite con escapes raros pero el .txt sigue
          // siendo legible para diagnostico.
          const dataStr = dataBytes.toString('latin1');
          out.push(`[QR data: "${dataStr}"]`);
        } else {
          out.push('[QR data: ""]');
        }
      } else {
        out.push(`[QR cmd cn=${cn} fn=${fn} len=${paramLen}]`);
      }

      if (start + totalConsumed > len) {
        return len - start;
      }
      return totalConsumed;
    }

    // GS L nL nH — left margin. Lo consumimos silenciosamente (es config
    // de layout, no aporta al output legible).
    case 0x4c: {
      if (start + 3 >= len) return 2;
      const nL = buffer[start + 2] as number;
      const nH = buffer[start + 3] as number;
      const margin = nL + (nH << 8);
      out.push(`[LMARGIN ${margin}]`);
      return 4;
    }

    // GS W nL nH — printing area width. Idem L.
    case 0x57: {
      if (start + 3 >= len) return 2;
      const nL = buffer[start + 2] as number;
      const nH = buffer[start + 3] as number;
      const width = nL + (nH << 8);
      out.push(`[AREA-WIDTH ${width}]`);
      return 4;
    }

    // Default: GS X desconocido. Marcamos y consumimos 2 bytes (mismo
    // approach que ESC).
    default: {
      const hex = cmd.toString(16).toUpperCase().padStart(2, '0');
      out.push(`[GS 0x${hex}]`);
      return 2;
    }
  }
}
