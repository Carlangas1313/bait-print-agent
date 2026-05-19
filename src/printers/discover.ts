import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);

/**
 * Snapshot de una impresora descubierta en el sistema operativo del agente.
 *
 * Lo publicamos al heartbeat para que la UI de bait-pos pueda armar el
 * dropdown "Elegi la impresora a configurar" sin que el cliente tenga que
 * pegar UNC paths ni IPs a mano.
 *
 * Campos:
 * - name: nombre tal cual aparece en Windows (eg "EPSON TM-T20III Receipt").
 *   La UI lo usa como label visible y como default del campo `name` del form.
 * - kind: inferido del PortName de Windows. La UI lo usa para pre-seleccionar
 *   el `connection_type` del form de impresora.
 * - device_id: el target sugerido. Para USB es PortName crudo (eg "USB001"),
 *   para network ya viene normalizado "ip:puerto", para serial es "COMn".
 * - default: si Windows tiene esta impresora marcada como default (solo
 *   informativo, no la elegimos automaticamente).
 */
export type DiscoveredPrinter = {
  name: string;
  kind: 'usb' | 'network' | 'bluetooth' | 'unknown';
  device_id: string;
  default: boolean;
};

/**
 * Fila cruda que devuelve `Get-Printer | Select-Object Name,PortName,Default`
 * tras pasarla por `ConvertTo-Json`. PowerShell omite el field si esta vacio
 * y a veces nos manda Default como bool, otras como string "True"/"False" —
 * normalizamos todo dentro del parser.
 */
type RawWindowsPrinter = {
  Name?: unknown;
  PortName?: unknown;
  Default?: unknown;
};

/**
 * Lista negra: nombres que matchean estos patrones son drivers de Microsoft/
 * Adobe que nunca son una impresora real, asi que los filtramos antes de
 * mandar al server. Si el match es por nombre tipico ("Microsoft Print to
 * PDF", "Fax", "Adobe PDF", "OneNote") los descartamos.
 */
const EXCLUDED_NAME_PATTERN = /microsoft|onenote|xps|fax|adobe pdf/i;

/**
 * Regex para PortName de Windows. El orden importa:
 * 1. USB primero (USB001, USB002, etc.)
 * 2. IP pura o IP:puerto (typical thermal LAN setup en :9100)
 * 3. WSD-* (web services for devices, generalmente impresoras de red)
 * 4. COM* (serial / bluetooth virtual COM port)
 */
const RE_USB = /^USB\d+$/i;
const RE_IP =
  /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)(?::\d{1,5})?$/;
const RE_WSD = /^WSD-/i;
const RE_COM = /^COM\d+$/i;

/**
 * Limite duro para el array de printers. Algun cliente puede tener decenas
 * de drivers viejos instalados — no queremos guardar 100 entries en jsonb.
 */
const MAX_DISCOVERED = 32;

/**
 * Timeout del proceso PowerShell. Si Get-Printer cuelga 5s no esperamos
 * mas — el heartbeat debe ser rapido.
 */
const POWERSHELL_TIMEOUT_MS = 5_000;

/**
 * Descubre las impresoras del sistema operativo. Solo soporta Windows
 * (PowerShell). En otros OS retorna [] con un debug log.
 *
 * Output: array con `kind` y `device_id` ya inferidos. Filtra drivers de
 * Microsoft/Adobe (PDF, OneNote, XPS, Fax) y limita a MAX_DISCOVERED entries.
 */
export async function discoverPrinters(
  logger: Logger
): Promise<DiscoveredPrinter[]> {
  if (process.platform !== 'win32') {
    logger.debug(
      { platform: process.platform },
      'Discovery saltado — solo Windows lo soporta'
    );
    return [];
  }

  // PowerShell -NoProfile evita cargar el perfil del user (mas rapido +
  // determinista). -Command vs -EncodedCommand: usamos Command porque el
  // script es corto y bien escapado.
  //
  // ConvertTo-Json -Compress reduce el size del payload. Sin `-Depth N`
  // alcanza para 3 fields planos como los que pedimos.
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-Printer | Select-Object Name,PortName,Default | ConvertTo-Json -Compress'
  ];

  let stdout: string;
  try {
    const result = await execFileAsync('powershell.exe', args, {
      timeout: POWERSHELL_TIMEOUT_MS,
      // El default es 'utf8' pero Windows PS 5.1 usa UTF-16 LE para piped
      // output sin BOM. Le pedimos a Node que decode con 'utf8' igual y
      // si vemos null bytes adelante, hacemos el fallback abajo.
      maxBuffer: 1024 * 1024 // 1MB, holgado para decenas de printers
    });
    stdout = stripBom(result.stdout);
  } catch (err) {
    // Fallar el discovery no es critico — el agente sigue imprimiendo
    // normal, solo perdemos el auto-discovery en la UI hasta el proximo
    // ciclo. Logueamos warn y retornamos vacio.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Get-Printer fallo, no pude descubrir impresoras (no es critico)'
    );
    return [];
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    logger.debug('Get-Printer no devolvio nada — sin impresoras instaladas?');
    return [];
  }

  // Get-Printer devuelve objeto (no array) cuando solo hay una printer.
  // Normalizamos siempre a array antes de iterar.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        sample: trimmed.slice(0, 200)
      },
      'No pude parsear el JSON de Get-Printer (formato inesperado)'
    );
    return [];
  }

  const raw: RawWindowsPrinter[] = Array.isArray(parsed)
    ? (parsed as RawWindowsPrinter[])
    : [parsed as RawWindowsPrinter];

  const discovered: DiscoveredPrinter[] = [];
  for (const item of raw) {
    const name = typeof item.Name === 'string' ? item.Name.trim() : '';
    const port = typeof item.PortName === 'string' ? item.PortName.trim() : '';

    if (!name) continue;

    // Filtrar drivers de Microsoft/Adobe — no son impresoras reales.
    if (EXCLUDED_NAME_PATTERN.test(name)) continue;

    const { kind, device_id } = inferKindAndDeviceId(port);
    const isDefault = coerceBool(item.Default);

    discovered.push({ name, kind, device_id, default: isDefault });

    if (discovered.length >= MAX_DISCOVERED) {
      logger.warn(
        { limit: MAX_DISCOVERED },
        `Maximo de printers alcanzado (${MAX_DISCOVERED}), descarto el resto`
      );
      break;
    }
  }

  if (discovered.length === 0) {
    logger.info('Discovery: no encontre impresoras imprimibles');
    return [];
  }

  // Log resumen con nombres para que sea facil debuggear desde el log.
  logger.info(
    {
      count: discovered.length,
      printers: discovered.map((p) => ({
        name: p.name,
        kind: p.kind,
        default: p.default
      }))
    },
    `Descubri ${discovered.length} printer(s) Windows`
  );

  return discovered;
}

/**
 * Infiere kind + device_id a partir del PortName de Windows.
 *
 * Casos:
 * - USB001..USBn          -> kind=usb, device_id=PortName.
 *   Nota: para que node-thermal-printer pueda escribir necesita el share
 *   UNC ("\\localhost\<share>"), no el USBnnn crudo. La UI muestra un
 *   warning + link al instructivo para compartir la impresora cuando el
 *   usuario elige una USB.
 * - "192.168.x.y"         -> kind=network, device_id="ip:9100" (default port).
 * - "192.168.x.y:port"    -> kind=network, device_id="ip:port".
 * - "WSD-..."             -> kind=network, device_id=PortName (raw).
 *   Es un puerto WSD descubierto, sin IP visible — el usuario tendra que
 *   pegar la IP manual.
 * - "COMn"                -> kind=bluetooth, device_id=PortName.
 *   En contexto POS asumimos BT serial; podria ser RS-232 puro pero es raro.
 * - otro / vacio          -> kind=unknown, device_id=PortName (o "").
 */
function inferKindAndDeviceId(port: string): {
  kind: DiscoveredPrinter['kind'];
  device_id: string;
} {
  if (!port) return { kind: 'unknown', device_id: '' };

  if (RE_USB.test(port)) {
    return { kind: 'usb', device_id: port };
  }

  if (RE_IP.test(port)) {
    // Default port 9100 (raw socket de impresoras termicas) si no especifica.
    const device_id = port.includes(':') ? port : `${port}:9100`;
    return { kind: 'network', device_id };
  }

  if (RE_WSD.test(port)) {
    return { kind: 'network', device_id: port };
  }

  if (RE_COM.test(port)) {
    return { kind: 'bluetooth', device_id: port };
  }

  return { kind: 'unknown', device_id: port };
}

/**
 * Normaliza el Default de PowerShell a bool. PS lo entrega como bool real
 * casi siempre, pero defensivamente aceptamos string "True"/"False" tambien.
 */
function coerceBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }
  return false;
}

/**
 * Algunas combinaciones de PowerShell + pipe en Windows incluyen el BOM
 * UTF-8 al inicio (EF BB BF). Si esta, lo sacamos para que JSON.parse no
 * falle.
 */
function stripBom(s: string): string {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}
