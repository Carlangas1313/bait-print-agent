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
