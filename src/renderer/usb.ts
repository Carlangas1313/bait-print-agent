/**
 * Renderer ESC/POS real: manda los jobs a impresoras termicas fisicas
 * via USB (cola Windows compartida), LAN (TCP raw 9100) o Bluetooth
 * (COM port virtual de Windows).
 *
 * Stack:
 *  - `node-thermal-printer` 4.x para generar el buffer ESC/POS y mandarlo.
 *    Soporta Epson/Star/Tanca/Daruma/Brother. Default EPSON; cubre 90%+
 *    de las termicas del mercado chileno (TM-T20II, T20III, T88V, TSP143).
 *  - Backend `network`: usa el modulo `net` de Node (puro JS, OK en SEA).
 *  - Backend `file`: usa `fs.createWriteStream` (puro JS, OK en SEA).
 *  - Backend `printer:` (cola Windows con driver nativo `printer`): solo
 *    disponible cuando el agente corre desde Node normal (dev). En SEA lo
 *    skipeamos porque el binario nativo `.node` no se empaqueta — ahi el
 *    usuario debe compartir la cola como `\\localhost\<share>` o usar
 *    el path UNC directo en el `target`.
 *
 * Eleccion de `interface` URI:
 *
 *   connection_type | target ejemplo            | URI resultante
 *   ----------------+---------------------------+---------------------------
 *   network         | 192.168.1.50:9100         | tcp://192.168.1.50:9100
 *   network         | 192.168.1.50              | tcp://192.168.1.50:9100
 *   bluetooth       | COM7                      | \\.\COM7
 *   usb             | \\localhost\EPSONTM       | \\localhost\EPSONTM (file)
 *   usb             | \\.\USB001                | \\.\USB001 (file)
 *   usb             | EPSON TM-T20III Receipt   | printer:EPSON TM-T20III Receipt
 *                   |                           |   (requiere modulo `printer`,
 *                   |                           |    fallback a error claro en SEA)
 */

import {
  printer as ThermalPrinter,
  types as PrinterTypes,
  CharacterSet
} from 'node-thermal-printer';
import type { Logger } from '../logger.js';
import type { PrintJobRow } from '../types.js';
import { formatJob } from './console.js';
import type { PrinterRow } from '../printers/registry.js';
import type { DiscoveredPrinter } from '../printers/discover.js';
import { AGENT_VERSION } from '../constants.js';

/**
 * Ancho del papel en chars. Misma constante que console.ts/format.ts.
 * Hoy fijo en 32 (58mm). Si en el futuro hay impresoras 80mm, leerlo del
 * `printer_type` o agregar columna `width` a la tabla `printers`.
 */
const PRINTER_WIDTH = 32;

/**
 * Lineas que destacamos en negrita: cabeceras tipo "COCINA - MESA 4",
 * totales, anulaciones. El match es por keywords case-insensitive.
 */
const BOLD_KEYWORDS = ['MESA', 'COCINA', 'BARRA', 'TOTAL', 'CIERRE', 'ANULACION'];

/**
 * Detecta si una linea debe ir en negrita (titulos, totales, headers).
 *
 * Se hace por keyword porque el contenido de las lineas viene del
 * `formatJob` compartido con console.ts, y no queremos duplicar la logica
 * de layout aca. Si el formatter cambia, este matcher sigue funcionando.
 */
function isBoldLine(rawLine: string): boolean {
  const upper = rawLine.toUpperCase();
  return BOLD_KEYWORDS.some((kw) => upper.includes(kw));
}

/**
 * Construye el `interface` URI que `node-thermal-printer` espera segun
 * el connection_type y el target. Lanza error claro si los datos no
 * cuadran (target vacio, IP malformada, etc.) para que el job falle rapido
 * y vaya al retry path en vez de quedar colgado en el socket.
 *
 * Reglas:
 *   - network: target puede venir como "IP" o "IP:puerto". Si no trae
 *     puerto, asumimos 9100 (raw print, estandar industrial).
 *   - bluetooth: target es el COM port (ej. "COM7" o "\\.\COM7"). Si el
 *     usuario solo puso "COM7", le agregamos el prefijo "\\.\".
 *   - usb: tres casos posibles segun el formato de target:
 *       a) Empieza con "\\" (UNC) o "\\." (device path) -> file backend.
 *       b) Cualquier otro string -> "printer:<nombre>" (requiere driver
 *          nativo `printer`, solo OK en dev/Node, no en SEA).
 */
function buildInterfaceUri(printer: PrinterRow): string {
  const target = (printer.target ?? '').trim();
  if (target.length === 0) {
    throw new Error(
      `Printer "${printer.name}" no tiene target configurado. Configurala en bait-app.cl -> Configuracion -> Impresoras.`
    );
  }

  switch (printer.connection_type) {
    case 'network': {
      // "192.168.1.50:9100" o "192.168.1.50"
      const hasPort = /:\d+$/.test(target);
      return hasPort ? `tcp://${target}` : `tcp://${target}:9100`;
    }

    case 'bluetooth': {
      // Bluetooth en Windows se expone como COM virtual cuando esta pareada.
      // Aceptamos "COM7" o "\\.\COM7" indistintamente.
      if (target.startsWith('\\\\')) return target;
      return `\\\\.\\${target}`;
    }

    case 'usb': {
      // Caso a: ya es un path file (UNC compartida o device path crudo).
      if (target.startsWith('\\\\')) return target;
      // Caso b: nombre de cola Windows -> printer: con driver nativo.
      // En SEA el driver no se puede cargar; el error se va a tirar al
      // ejecutar isPrinterConnected. Documentado en el README.
      return `printer:${target}`;
    }

    default: {
      // Cualquier otro connection_type que el filtro de registry.ts dejo
      // pasar por error. Defensive: tiramos para no mandar basura al socket.
      throw new Error(
        `connection_type no soportado: "${printer.connection_type}" en printer "${printer.name}"`
      );
    }
  }
}

/**
 * Carga el driver nativo `printer` de manera opcional. Solo necesario
 * cuando el target es `printer:<nombre>` (cola Windows con driver nativo).
 *
 * En SEA el modulo nativo `.node` no se empaqueta y require() tira; en
 * ese caso retornamos null y el caller decide si tirar o sugerir un
 * fallback (compartir la cola como UNC).
 */
function loadOptionalPrinterDriver(): unknown | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('printer');
    return mod;
  } catch {
    return null;
  }
}

/**
 * Imprime un job en una impresora fisica via ESC/POS.
 *
 * Flujo:
 *   1. Construir interface URI segun connection_type/target.
 *   2. Instanciar ThermalPrinter con codepage chileno (PC858 cubre tildes,
 *      ñ y €).
 *   3. Si interface es `printer:`, cargar driver nativo opcional. Si no
 *      esta disponible, tirar error claro.
 *   4. isPrinterConnected() — si la printer no responde, error con contexto.
 *   5. Generar el bloque ASCII via formatJob() (compartido con console/virtual).
 *   6. Iterar lineas y agregar bold cuando matchee keyword (MESA, TOTAL, ...).
 *   7. Beep + cut + execute. Repetir `copies` veces.
 *
 * No captura excepciones internas: deja que se propaguen al claimAndRun
 * del realtime.ts, que las maneja con retry + backoff.
 */
export async function renderJobToPrinter(
  job: PrintJobRow,
  printer: PrinterRow,
  logger: Logger
): Promise<void> {
  logger.info(
    {
      jobId: job.id,
      jobType: job.job_type,
      printerName: printer.name,
      connectionType: printer.connection_type,
      target: printer.target
    },
    `Renderizando job ${job.id} en impresora "${printer.name}" (${printer.connection_type})`
  );

  const interfaceUri = buildInterfaceUri(printer);

  // node-thermal-printer requiere el driver explicito para el backend
  // `printer:`. Para network/file el campo `driver` se ignora.
  const driver =
    interfaceUri.startsWith('printer:')
      ? (loadOptionalPrinterDriver() as object | null)
      : undefined;

  if (interfaceUri.startsWith('printer:') && !driver) {
    throw new Error(
      `No se pudo cargar el driver nativo 'printer' para imprimir en cola Windows "${printer.target}". ` +
        `Opciones:\n` +
        `  1) Compartir la cola en Windows y configurar el target como \\\\localhost\\<nombre_share>\n` +
        `  2) Usar conexion LAN (puerto raw 9100) en vez de USB\n` +
        `  3) (Avanzado) Instalar el modulo 'printer' manualmente; no funciona en el .exe empaquetado.`
    );
  }

  const tp = new ThermalPrinter({
    type: PrinterTypes.EPSON, // Epson-compat cubre 90%+ del mercado CL.
    interface: interfaceUri,
    characterSet: CharacterSet.PC858_EURO, // Tildes + ñ + € en chileno.
    width: PRINTER_WIDTH,
    removeSpecialCharacters: false,
    options: { timeout: 5000 },
    // Cast a `any` porque el typing oficial pide `Object` pero acepta undefined
    // tambien para los backends que no lo usan (network/file).
    ...(driver ? { driver: driver as object } : {})
  });

  // Verificar conexion antes de armar el buffer. Para LAN abre socket
  // a host:port y cierra. Para file/printer chequea existencia/disponibilidad.
  let connected = false;
  try {
    connected = await tp.isPrinterConnected();
  } catch (err) {
    // El backend `printer:` tira false en vez de retornar false. Lo
    // tratamos como no-conectada con detalle del error.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Printer "${printer.name}" no responde (${printer.connection_type}://${printer.target}): ${msg}`
    );
  }
  if (!connected) {
    throw new Error(
      `Printer "${printer.name}" no responde (${printer.connection_type}://${printer.target})`
    );
  }

  // Construir el bloque ASCII reutilizando el formatter compartido.
  // No re-implementamos layouts aca: console/virtual/usb deben mostrar
  // el mismo ticket.
  const content = formatJob(job, logger);
  const lines = content.split('\n');

  const copies = Math.max(1, printer.copies ?? 1);

  for (let copy = 1; copy <= copies; copy++) {
    tp.clear();

    for (const rawLine of lines) {
      // Lineas vacias = newLine() simple, sin pasar por println() que mete
      // un \n extra en algunos firmwares medio rotos.
      if (rawLine.length === 0) {
        tp.newLine();
        continue;
      }

      const bold = isBoldLine(rawLine);
      if (bold) tp.bold(true);
      tp.println(rawLine);
      if (bold) tp.bold(false);
    }

    if (printer.beep) {
      // 1 beep corto. Algunas Epson aceptan 2 args (numero, longitud),
      // otras solo el primero. Pasamos los defaults.
      tp.beep();
    }
    if (printer.cut_paper) {
      tp.cut();
    }

    try {
      await tp.execute();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Fallo execute() en printer "${printer.name}" (copia ${copy}/${copies}): ${msg}`
      );
    }
  }

  logger.info(
    {
      jobId: job.id,
      printerName: printer.name,
      connectionType: printer.connection_type,
      target: printer.target,
      copies
    },
    `Job impreso en ${printer.name} (${printer.connection_type}:${printer.target ?? ''})`
  );
}

/**
 * Construye una `PrinterRow` sintetica a partir de una impresora descubierta
 * del OS. Sirve para imprimir un test page directo (sin pasar por la cola
 * print_jobs) eligiendo cualquier impresora del dropdown del companion, sin
 * que tenga que estar configurada todavia en bait-app.cl.
 *
 * Reglas de mapeo:
 *  - usb         → target = "\\.\<PortName>" (device path crudo, evita el
 *                  modulo `printer` que no funciona en SEA).
 *  - network     → target = "<device_id>" (ya viene como "ip:puerto").
 *  - bluetooth   → target = "\\.\<device_id>" (COM port virtual).
 *  - unknown     → tiramos error claro (no podemos imprimir si no sabemos
 *                  por que puerto sale).
 *
 * Para el test page no necesitamos copies/beep/cut_paper de la config — usamos
 * defaults (1 copia, beep off, cut on).
 */
function discoveredToSyntheticPrinter(
  discovered: DiscoveredPrinter
): PrinterRow {
  let target: string;
  switch (discovered.kind) {
    case 'usb':
      // PortName tipico: "USB001". El prefijo \\.\ lo convierte en device
      // path que el backend `file` de node-thermal-printer abre como stream.
      target = discovered.device_id.startsWith('\\\\')
        ? discovered.device_id
        : `\\\\.\\${discovered.device_id}`;
      break;
    case 'network':
      // Ya viene como "ip:puerto" desde discover.ts.
      target = discovered.device_id;
      break;
    case 'bluetooth':
      // COM virtual en Windows: "COM7" → "\\.\COM7".
      target = discovered.device_id.startsWith('\\\\')
        ? discovered.device_id
        : `\\\\.\\${discovered.device_id}`;
      break;
    default:
      throw new Error(
        `No puedo imprimir test page en una impresora de tipo "${discovered.kind}". ` +
          `Configurala manualmente en bait-app.cl -> Settings -> Impresoras.`
      );
  }

  return {
    id: `test-${discovered.device_id}`,
    name: discovered.name,
    printer_type: 'thermal_test',
    connection_type: discovered.kind,
    target,
    print_area_id: null,
    is_primary: false,
    copies: 1,
    cut_paper: true,
    beep: false
  };
}

/**
 * Construye las lineas de la pagina de prueba. ASCII fijo, no usa formatJob
 * porque no queremos depender de un job_type real para el test (sumar 'test'
 * al schema de la DB seria overkill para esto).
 */
function buildTestPageLines(
  discovered: DiscoveredPrinter,
  agentName: string,
  locationName: string | null
): string[] {
  const width = PRINTER_WIDTH;
  const sep = '='.repeat(width);
  const dash = '-'.repeat(width);
  const now = new Date();
  const fecha =
    `${now.getDate().toString().padStart(2, '0')}/` +
    `${(now.getMonth() + 1).toString().padStart(2, '0')}/` +
    `${now.getFullYear()} ` +
    `${now.getHours().toString().padStart(2, '0')}:` +
    `${now.getMinutes().toString().padStart(2, '0')}:` +
    `${now.getSeconds().toString().padStart(2, '0')}`;

  const lines: string[] = [
    sep,
    centerLine('bAIt PRINT AGENT', width),
    centerLine('Test de impresion', width),
    sep,
    '',
    `Fecha:   ${fecha}`,
    `Agente:  ${agentName}`
  ];
  if (locationName) {
    lines.push(`Local:   ${locationName}`);
  }
  lines.push(`Version: ${AGENT_VERSION}`);
  lines.push('');
  lines.push(dash);
  lines.push('Impresora:');
  lines.push(`  ${discovered.name}`);
  lines.push(`  Conexion: ${discovered.kind.toUpperCase()}`);
  lines.push(`  Device:   ${discovered.device_id}`);
  lines.push(dash);
  lines.push('');
  lines.push('Si lees este ticket, la');
  lines.push('impresora esta funcionando');
  lines.push('correctamente.');
  lines.push('');
  lines.push(sep);
  return lines;
}

function centerLine(text: string, width: number): string {
  if (text.length >= width) return text.substring(0, width);
  const pad = Math.floor((width - text.length) / 2);
  return ' '.repeat(pad) + text;
}

/**
 * Imprime un test page en la impresora indicada. Usado por el endpoint
 * `POST /v1/printers/:id/test` del companion.
 *
 * Diseño: NO pasa por la cola print_jobs. El handler recibe el id del OS
 * (USB001 / ip:puerto / COM7), construye una `PrinterRow` sintetica con esa
 * conexion y delega al mismo path de node-thermal-printer que usa la
 * impresion productiva. Asi el test:
 *   - No requiere que la impresora este configurada en bait-app.cl.
 *   - Verifica la conectividad real al mismo socket / device que usaria
 *     un job productivo.
 *   - No genera ruido en la tabla print_jobs (no aparece como "Test" en
 *     el historial del dashboard).
 *
 * Errores:
 *   - Si la printer no responde → throw "Printer no responde...".
 *   - Si el backend `printer:` (queue Windows con driver) se intenta usar
 *     en SEA → throw con sugerencia de UNC share.
 *   - Si kind === 'unknown' → throw con sugerencia de configuracion manual.
 */
export async function renderTestPage(
  discovered: DiscoveredPrinter,
  agentName: string,
  locationName: string | null,
  logger: Logger
): Promise<void> {
  const printer = discoveredToSyntheticPrinter(discovered);
  const interfaceUri = buildInterfaceUri(printer);

  logger.info(
    {
      printerName: printer.name,
      connectionType: printer.connection_type,
      interfaceUri
    },
    `Imprimiendo test page en "${printer.name}"`
  );

  // Mismo bloque que renderJobToPrinter — driver nativo opcional para queues
  // Windows con printer: prefix. En SEA falla con mensaje claro.
  const driver =
    interfaceUri.startsWith('printer:')
      ? (loadOptionalPrinterDriver() as object | null)
      : undefined;

  if (interfaceUri.startsWith('printer:') && !driver) {
    throw new Error(
      `No puedo imprimir en la cola Windows "${printer.target}" desde el agente empaquetado. ` +
        `Compartila como red local (\\\\localhost\\<nombre>) o usa conexion LAN raw 9100.`
    );
  }

  const tp = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: interfaceUri,
    characterSet: CharacterSet.PC858_EURO,
    width: PRINTER_WIDTH,
    removeSpecialCharacters: false,
    options: { timeout: 5000 },
    ...(driver ? { driver: driver as object } : {})
  });

  let connected = false;
  try {
    connected = await tp.isPrinterConnected();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Printer "${printer.name}" no responde (${printer.connection_type}://${printer.target}): ${msg}`
    );
  }
  if (!connected) {
    throw new Error(
      `Printer "${printer.name}" no responde (${printer.connection_type}://${printer.target})`
    );
  }

  tp.clear();
  const lines = buildTestPageLines(discovered, agentName, locationName);
  for (const raw of lines) {
    if (raw.length === 0) {
      tp.newLine();
      continue;
    }
    const bold = isBoldLine(raw);
    if (bold) tp.bold(true);
    tp.println(raw);
    if (bold) tp.bold(false);
  }
  if (printer.cut_paper) {
    tp.cut();
  }

  try {
    await tp.execute();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Fallo execute() en test page de "${printer.name}": ${msg}`
    );
  }

  logger.info(
    {
      printerName: printer.name,
      connectionType: printer.connection_type,
      target: printer.target
    },
    `Test page impreso en "${printer.name}"`
  );
}
