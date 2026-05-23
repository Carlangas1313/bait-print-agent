/**
 * Transport unificado para mandar ESC/POS a una impresora termica.
 *
 * Por que un helper aparte:
 * -------------------------
 * Hay 2+ callsites que necesitan mandar ESC/POS a una impresora real:
 *  - `renderJobToPrinter` (flow productivo de comandas)
 *  - `renderTestPage` (boton "Imprimir test" del companion)
 *  - Futuros renderers (notificaciones, anulaciones masivas, etc.)
 *
 * Sin este helper, cada renderer reimplementa la logica de "elegir el
 * transport segun connection_type", lo cual:
 *  - Duplica codigo (DRY violation).
 *  - Hace que un bug del transport (ej. el caso Rongta donde el backend
 *    `printer:` falla en SEA) tenga que arreglarse en N lugares.
 *  - Bloquea agregar transports nuevos (BLE directo, queue de impresion
 *    Linux/macOS) sin tocar todos los renderers.
 *
 * Diseño:
 * -------
 * El renderer arma el contenido (lineas + bold + beep + cut) DENTRO de un
 * callback que recibe el `ThermalPrinter` ya instanciado. El helper decide:
 *
 *  - USB        → buffer-only ThermalPrinter, `getBuffer()` + spooler RAW
 *                 Win32 (sendRawToWindowsPrinter). Esto bypassea cualquier
 *                 driver propietario (Rongta "80Normal", DOT4 de HP, etc.)
 *                 que no traduzca ESC/POS al GDI esperado por el spooler.
 *
 *  - NETWORK    → ThermalPrinter con interface `tcp://ip:9100`. Abre socket,
 *                 isPrinterConnected verifica, execute envia y cierra. La
 *                 termica con Ethernet recibe ESC/POS raw via puerto 9100.
 *
 *  - BLUETOOTH  → ThermalPrinter con interface `\\.\COMn`. Escribe al device
 *                 file del COM virtual; el stack BT de Windows entrega al
 *                 modulo SPP de la impresora.
 *
 * Cualquier otro `connection_type` tira error claro pidiendo configurar
 * la printer correctamente.
 */

import {
  printer as ThermalPrinter,
  types as PrinterTypes,
  CharacterSet
} from 'node-thermal-printer';
import type { Logger } from '../logger.js';
import type { PrinterRow } from './registry.js';
import { sendRawToWindowsPrinter } from './win-raw-print.js';

/**
 * Default del ancho del papel en chars. Se usa como fallback cuando el caller
 * no especifica width (ej. test page sin payload, jobs viejos sin
 * payload.printer en el schema).
 *
 * Mig 060 bait-pos: la columna `printers.width_chars` permite 32/42/48. El
 * caller productivo resuelve el width desde el payload o el PrinterRow y lo
 * pasa explicitamente; este default solo aplica si no se especifica nada.
 */
const PRINTER_WIDTH_DEFAULT = 32;

/**
 * Timeout para socket TCP (network) o file (bluetooth) en ms. Misma logica
 * que el renderer viejo. Para USB no aplica — el spooler de Windows tiene
 * su propio timeout interno mas razonable.
 */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Threshold minimo de bytes en el buffer ESC/POS para considerarlo "util"
 * (no solo bytes de init de codepage). Ver explicacion completa en el check
 * defensivo de sendUsbViaSpooler.
 *
 * Numero racional:
 *  - Tras `tp.clear()` el buffer tiene 3 bytes (cambio de codepage PC858).
 *  - Un ticket REAL minimo (1 linea + LF + cut) son ~30 bytes ESC/POS.
 *  - 16 bytes esta 5x sobre el "solo init" y muy debajo del ticket minimo,
 *    asi que detecta el caso patologico sin falsos positivos.
 */
const MIN_USEFUL_BUFFER_BYTES = 16;

/**
 * Callback que el renderer usa para poblar el ThermalPrinter con el
 * contenido del ticket (lineas, bold, beep, cut). El helper ya hizo
 * `tp.clear()` antes de llamarte, asi que arrancas con buffer limpio.
 *
 * Puede ser sync o async — desde v0.9.0 el callback de bill_preview/proforma
 * descarga el logo via getLogoPath() (I/O cuando hay cache miss). El helper
 * awaitea el retorno antes de mandar el buffer.
 *
 * Tipamos el `tp` como `unknown` y casteamos al consumer para no propagar
 * los typings de node-thermal-printer fuera de transport.ts. En la practica
 * el caller hace `tp as ThermalPrinter` y usa la API completa.
 */
export type PopulatePrinter = (
  tp: InstanceType<typeof ThermalPrinter>
) => void | Promise<void>;

/**
 * Manda un ticket ESC/POS a la impresora segun su `connection_type`.
 *
 * El renderer (caller) NO necesita saber si la impresora es USB queue,
 * TCP raw 9100 o COM virtual — solo arma el contenido en el callback.
 *
 * El `width` (mig 060) es el ancho del papel en chars que se le pasa al
 * constructor de ThermalPrinter. El caller lo resuelve desde:
 *   payload.printer.width_chars ?? printer.width_chars ?? 32
 * Si no se especifica, default 32 (compat con Rongta 58mm que era el
 * comportamiento previo a mig 060).
 *
 * Lanza si falla en cualquier paso (connect, send, write). El caller decide
 * el retry path (productivo: el claimAndRun de realtime.ts; test: el handler
 * de /v1/printers/:id/test).
 */
export async function sendEscPos(
  printer: PrinterRow,
  populate: PopulatePrinter,
  logger: Logger,
  width: number = PRINTER_WIDTH_DEFAULT
): Promise<void> {
  switch (printer.connection_type) {
    case 'usb':
      await sendUsbViaSpooler(printer, populate, logger, width);
      return;

    case 'network':
      await sendViaThermalPrinter(printer, populate, logger, width);
      return;

    case 'bluetooth':
      await sendViaThermalPrinter(printer, populate, logger, width);
      return;

    default:
      throw new Error(
        `connection_type no soportado: "${printer.connection_type}" en printer "${printer.name}". ` +
          `Valores validos: usb | network | bluetooth.`
      );
  }
}

/**
 * Path USB: arma el buffer ESC/POS sin abrir conexion al device, despues
 * lo manda via spooler Win32 (RAW datatype). Funciona para CUALQUIER queue
 * registrada en Windows independiente del driver del fabricante.
 *
 * Usamos un interface dummy (`\\.\__bait_buffer_only__`) que ThermalPrinter
 * NO abre hasta que llamamos `execute()` o `isPrinterConnected()`. Como
 * solo usamos `getBuffer()`, nunca se intenta abrir el handle. Workaround
 * para que la API de node-thermal-printer nos sirva como builder de buffer.
 */
async function sendUsbViaSpooler(
  printer: PrinterRow,
  populate: PopulatePrinter,
  logger: Logger,
  width: number
): Promise<void> {
  const tp = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: '\\\\.\\__bait_buffer_only__',
    characterSet: CharacterSet.PC858_EURO,
    width,
    removeSpecialCharacters: false
  });
  tp.clear();
  await populate(tp);
  const buffer = tp.getBuffer();

  // Defensa anti "ticket fantasma" (v0.9.3):
  //
  // Tras `tp.clear()` el buffer NO queda en 0 bytes — queda con la secuencia
  // de cambio de codepage (PC858_EURO) que son ~3 bytes (0x1B 0x74 0x13). Si
  // por algun bug regresivo el populate no agrega contenido REAL al buffer
  // (ej: un callsite futuro pierde el `await` sobre un populate async, una
  // promesa intermedia tira sin propagar, etc.), `getBuffer()` retornaria
  // SOLO esos bytes de init y `sendRawToWindowsPrinter` los mandaria al
  // spooler sin queja. Resultado en papel: NADA visible. Resultado en DB:
  // status='printed', sin error. El operador ve jobs marcados printed pero
  // la termica nunca se movio.
  //
  // Para detectar ese escenario, exigimos que el buffer tenga al menos
  // `MIN_USEFUL_BUFFER_BYTES` mas alla de los bytes de init. Si no llega,
  // tiramos error claro — el caller (claimAndRun de realtime.ts) lo clasifica
  // como transient y el job NO se marca printed. Asi el bug es VISIBLE en
  // last_error en lugar de quedar silencioso.
  //
  // El threshold de 16 bytes es conservador: el ticket mas corto razonable
  // (1 println con "X" + cut) son >= 30 bytes ESC/POS. 16 bytes es 5x mas
  // grande que los 3 bytes de init, asi que cualquier render real lo pasa.
  if (buffer.length < MIN_USEFUL_BUFFER_BYTES) {
    throw new Error(
      `Buffer ESC/POS vacio o solo init (${buffer.length} bytes) para printer "${printer.name}". ` +
        `El renderer no agrego contenido — probable regresion del populate sync/async ` +
        `o type guard del payload fallando. No mando al spooler para evitar ticket fantasma.`
    );
  }

  // Resolver el QUEUE NAME que Win32 OpenPrinter espera.
  //
  // Historicamente la app guardaba `target` como UNC share (\\localhost\<name>)
  // porque la version vieja del agente usaba el `file` backend. Con el spooler
  // RAW de Win32 (v0.6.4+), `target` debe ser el queue name plano. Como hay
  // configs viejas en produccion con UNC, soportamos ambos:
  //
  //   target='\\localhost\PrintCaja' → extraemos 'PrintCaja'
  //   target='\\OFFICE-PC\HP'        → extraemos 'HP' (UNC remoto, OpenPrinter
  //                                      lo resuelve via spooler de OFFICE-PC)
  //   target='PrintCaja'             → tal cual (caso optimo)
  //   target=NULL o vacio            → fallback a printer.name (alias humano)
  const queueName = resolveWindowsQueueName(printer);
  if (!queueName) {
    throw new Error(
      `No pude resolver el queue name de la impresora "${printer.name}". ` +
        `Configura el campo "Destino" en bait-app.cl -> Impresoras con el ` +
        `nombre exacto de la cola de Windows (ej: "PrintCaja"). ` +
        `Verifica con: Get-Printer | Select Name`
    );
  }

  logger.debug(
    { printerName: printer.name, queueName, rawTarget: printer.target },
    'USB spooler: resolved queue name from printer config'
  );

  await sendRawToWindowsPrinter(queueName, buffer, logger);
  logger.debug(
    { printer: printer.name, queueName, bytes: buffer.length },
    'sendEscPos USB via spooler RAW completado'
  );
}

/**
 * Extrae el queue name de Windows desde el target de la printer. Maneja UNC
 * paths historicos (\\host\share) tirando el prefijo, y cae a printer.name
 * si target esta vacio.
 *
 * Casos:
 *   '\\localhost\PrintCaja'  → 'PrintCaja'
 *   '\\OFFICE-PC\HP4000'     → 'HP4000'
 *   '\\\\localhost\\PrintCaja' (double escape in JSON) → 'PrintCaja'
 *   'PrintCaja'              → 'PrintCaja' (tal cual)
 *   ''  o  null              → printer.name
 *   '\\'                     → null (mal formado)
 */
function resolveWindowsQueueName(printer: PrinterRow): string | null {
  const target = (printer.target ?? '').trim();
  if (target.length === 0) {
    const name = (printer.name ?? '').trim();
    return name.length > 0 ? name : null;
  }

  // UNC: \\host\share → quedarse con "share" (la parte despues del 2do \).
  if (target.startsWith('\\\\')) {
    // Strip leading '\\', luego buscar el primer '\' que separa host de share.
    const rest = target.slice(2);
    const slash = rest.indexOf('\\');
    if (slash < 0) return null; // mal formado
    const share = rest.slice(slash + 1).trim();
    return share.length > 0 ? share : null;
  }

  // Caso plano: target ya es el queue name.
  return target;
}

/**
 * Path network/bluetooth: usa ThermalPrinter con un interface URI real.
 * node-thermal-printer abre el socket/file, escribe el buffer y cierra.
 *
 * Verifica conectividad antes para fallar rapido si el device no responde
 * (asi el retry-scheduler del realtime puede aplicar backoff sin esperar
 * el timeout de write).
 */
async function sendViaThermalPrinter(
  printer: PrinterRow,
  populate: PopulatePrinter,
  logger: Logger,
  width: number
): Promise<void> {
  const interfaceUri = buildInterfaceUri(printer);

  const tp = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: interfaceUri,
    characterSet: CharacterSet.PC858_EURO,
    width,
    removeSpecialCharacters: false,
    options: { timeout: CONNECT_TIMEOUT_MS }
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
  await populate(tp);

  // Misma defensa anti "ticket fantasma" que sendUsbViaSpooler. Si el buffer
  // de ThermalPrinter quedo solo con bytes de init (populate vacio), no
  // queremos que el execute() socket-TCP/COM-write marque ok sin haber
  // mandado contenido util. Ver comentario detallado arriba en sendUsbViaSpooler.
  const buffer = tp.getBuffer();
  if (buffer.length < MIN_USEFUL_BUFFER_BYTES) {
    throw new Error(
      `Buffer ESC/POS vacio o solo init (${buffer.length} bytes) para printer "${printer.name}" (${printer.connection_type}). ` +
        `El renderer no agrego contenido — probable regresion del populate sync/async. ` +
        `No ejecuto el send para evitar ticket fantasma.`
    );
  }

  try {
    await tp.execute();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Fallo execute() en printer "${printer.name}": ${msg}`
    );
  }

  logger.debug(
    {
      printer: printer.name,
      connection_type: printer.connection_type,
      target: printer.target
    },
    'sendEscPos via ThermalPrinter (network/bluetooth) completado'
  );
}

/**
 * Construye el `interface` URI que node-thermal-printer espera para network
 * y bluetooth. Igual que el viejo `buildInterfaceUri` de usb.ts pero solo
 * cubre los casos no-USB (USB ahora va por el spooler).
 *
 * Para BLUETOOTH:
 *   target = "COM7"          → "\\\\.\\COM7"
 *   target = "\\\\.\\COM7"   → "\\\\.\\COM7" (idempotente)
 *
 * Para NETWORK:
 *   target = "192.168.1.50:9100" → "tcp://192.168.1.50:9100"
 *   target = "192.168.1.50"      → "tcp://192.168.1.50:9100" (default port)
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
      const hasPort = /:\d+$/.test(target);
      return hasPort ? `tcp://${target}` : `tcp://${target}:9100`;
    }
    case 'bluetooth': {
      if (target.startsWith('\\\\')) return target;
      return `\\\\.\\${target}`;
    }
    default:
      // No deberia llegar aca — sendEscPos route USB al spooler, no a este
      // helper. Defensive throw.
      throw new Error(
        `buildInterfaceUri llamado con connection_type "${printer.connection_type}" — solo network/bluetooth aca.`
      );
  }
}
