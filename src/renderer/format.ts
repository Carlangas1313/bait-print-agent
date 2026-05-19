/**
 * Helpers de formato puros para el renderer de impresoras termicas.
 *
 * Asumimos ancho default = 32 chars (papel 58mm). Si en el futuro
 * soportamos 80mm, el caller pasa width = 48.
 *
 * Sin side effects: cada funcion devuelve un string nuevo.
 */

/**
 * Linea horizontal de '=' del ancho dado. Util para bordes principales
 * (cabecera, separadores fuertes).
 */
export function line(width = 32): string {
  return '='.repeat(width);
}

/**
 * Linea horizontal de '-' del ancho dado. Util para separadores secundarios
 * (subtotal vs total, separar items de footer, etc.).
 */
export function divider(width = 32): string {
  return '-'.repeat(width);
}

/**
 * Centra un texto en `width` chars agregando espacios a izquierda y derecha.
 * Si el texto es mas largo que el width, se devuelve tal cual (no se trunca,
 * mejor que la impresora corte a perder data).
 */
export function padCenter(text: string, width = 32): string {
  if (text.length >= width) return text;
  const totalPadding = width - text.length;
  const left = Math.floor(totalPadding / 2);
  const right = totalPadding - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

/**
 * Alinea texto a la derecha agregando padding a la izquierda hasta
 * completar `width` chars. Si el texto excede el width, devuelve tal cual.
 *
 * Util para columnas de monto: `padLeft('24.500', 8)` -> '  24.500'.
 */
export function padLeft(text: string, width: number): string {
  if (text.length >= width) return text;
  return ' '.repeat(width - text.length) + text;
}

/**
 * Formato chileno de moneda: "$ 24.500" sin decimales, separador de miles
 * con punto. Asume que `amount` viene en pesos enteros (no centavos).
 *
 * Si llega negativo: "$ -1.500". El espacio entre $ y numero es a proposito
 * (estilo chileno comun en boletas).
 */
export function formatCLP(amount: number): string {
  const formatter = new Intl.NumberFormat('es-CL', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
  const rounded = Math.round(amount);
  return `$ ${formatter.format(rounded)}`;
}

/**
 * Devuelve "HH:MM" en zona Santiago Chile (`America/Santiago`).
 *
 * Si el ISO viene en UTC (con Z) lo convierte; si viene con offset, idem.
 * No tira: si el ISO es invalido, devuelve "--:--" para que no rompa la
 * impresion.
 */
export function formatTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '--:--';

  const formatter = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  return formatter.format(date);
}

/**
 * Devuelve "DD-MM HH:MM" en zona Santiago. Util para cierres de caja
 * y headers con fecha + hora.
 *
 * Si el ISO es invalido, devuelve "--/-- --:--".
 */
export function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '--/-- --:--';

  // Intl no tiene un patron compacto "DD-MM HH:MM" listo,
  // entonces sacamos las partes y armamos manualmente.
  const formatter = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '--';

  return `${get('day')}-${get('month')} ${get('hour')}:${get('minute')}`;
}

/**
 * Wrap text en lineas de maximo `maxWidth` chars sin partir palabras.
 * Si una palabra individual excede el maxWidth, la deja en su propia linea
 * (no se trunca; preferimos overflow visible a perder informacion).
 *
 * Util para notas largas que no caben en una sola linea de la termica.
 */
export function wrap(text: string, maxWidth: number): string[] {
  if (!text || maxWidth <= 0) return [];

  const words = text.split(/\s+/).filter(w => w.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    // Si agregar la palabra (con espacio) entra, la sumamos.
    if (current.length + 1 + word.length <= maxWidth) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);

  return lines;
}
