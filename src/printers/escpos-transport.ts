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
import { captureJob } from './escpos-capture.js';

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
 * Delay POST-write entre jobs concurrentes que apuntan al mismo queue Windows
 * (v0.9.4). Override via env var `BAIT_PRINT_INTER_JOB_DELAY_MS`.
 *
 * Por que existe (bug v0.9.3):
 * ----------------------------
 * Cuando bait-pos genera varios kitchen_orders simultaneos que terminan en el
 * mismo queue fisico (ej: setup donde 5 printers DB apuntan a target='PrintCaja'),
 * el agente los renderiza en paralelo y los manda al spooler en burst de <230ms.
 * El driver "Generic / Text Only" + la termica USB no aguanta el ritmo:
 *  - El job N entra cuando el N-1 todavia esta procesandose.
 *  - El spooler los acepta a los 4, marca printed los 4.
 *  - Fisicamente solo sale 1 papel (los demas descartados internamente).
 *
 * El fix es serializar jobs por target queue: un job a la vez por queue, con
 * un delay corto post-write para que la termica termine de procesar el buffer
 * anterior antes que el siguiente se mande.
 *
 * Default 500ms:
 *  - Suficiente para que una termica USB tipica termine de imprimir un ticket
 *    de comanda corta (4-8 lineas + cut, lo mas comun).
 *  - No tan largo como para hacer notable la espera en uso normal (el operador
 *    no nota un retraso de 500ms entre comandas).
 *  - Para tickets largos (cierre de caja con 50+ items) el agente igual hace
 *    la espera completa y se vuelve a serializar, lo cual esta bien porque
 *    cierres no son concurrentes en la practica.
 *
 * Override:
 *  - BAIT_PRINT_INTER_JOB_DELAY_MS=0  → sin delay (debugging local).
 *  - BAIT_PRINT_INTER_JOB_DELAY_MS=1500 → termica MUY lenta o cierre con logo
 *    grande que demora en procesar.
 */
const DEFAULT_INTER_JOB_DELAY_MS = 500;

function resolveInterJobDelayMs(): number {
  const raw = process.env.BAIT_PRINT_INTER_JOB_DELAY_MS;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_INTER_JOB_DELAY_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return DEFAULT_INTER_JOB_DELAY_MS;
  }
  return parsed;
}

/**
 * Lock por target Windows queue (v0.9.4).
 *
 * Key = queue name resuelto (ej: "PrintCaja", "HP4000"). NO printer.id ni
 * printer.name: lo que importa es a que queue FISICA del spooler estamos
 * mandando bytes. Multiples filas `printers` en DB pueden apuntar al mismo
 * queue (caso del bug original), y todas ellas tienen que serializarse contra
 * el mismo lock.
 *
 * Value = promesa que representa el job en vuelo (write + post-write delay).
 * Cuando termina, el siguiente job al mismo target arranca recien ahi.
 *
 * Por que un Map global y no por instancia:
 *  - sendUsbViaSpooler se llama desde N callsites (renderJobToPrinter del flow
 *    productivo, renderTestPage del companion, futuros). Todos comparten el
 *    mismo spooler de Windows — el lock tiene que ser proceso-global, no por
 *    callsite.
 *  - El proceso del agente es single-instance (servicio Windows), asi que
 *    "global del proceso" == "global del agente".
 *
 * Limpieza:
 *  - Cuando termina el job, si el lock todavia apunta a la misma promesa que
 *    teniamos, lo removemos. Si alguien ya seteo una nueva promesa encima
 *    (jobs encolados), la dejamos para no perder esa cadena.
 *  - Si la promesa rechaza, el catch tambien limpia (no queremos que un error
 *    deje el lock vivo para siempre bloqueando el target).
 */
const targetLocks = new Map<string, Promise<void>>();

/**
 * Contador de jobs en vuelo + en cola por target. Solo para logging
 * informativo ("hay 3 jobs esperando este queue"). NO se usa para logica de
 * scheduling — el ordenamiento real lo da la cadena de promesas en
 * targetLocks.
 *
 * Incrementamos antes de empezar la espera, decrementamos cuando entramos
 * al critical section (write + sleep). Asi `queueDepth` en el log refleja
 * "cuantos jobs hay haciendo cola este target", incluido el que se va a
 * loggear.
 */
const targetQueueDepth = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hook para sobrescribir la funcion de envio al spooler RAW. Default es la
 * real (`sendRawToWindowsPrinter` que spawnea PowerShell). Los tests la
 * cambian por un mock que no toca Windows.
 *
 * No es API publica — el `_` prefix marca el contrato. Cualquier uso fuera
 * del archivo de test es un bug.
 */
type RawSendFn = (
  printerName: string,
  buffer: Buffer,
  logger: Logger
) => Promise<void>;

let rawSendImpl: RawSendFn = sendRawToWindowsPrinter;

export function _setRawSendImplForTests(fn: RawSendFn | null): void {
  rawSendImpl = fn ?? sendRawToWindowsPrinter;
}

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
 * Contexto del job para etiquetar la captura ESC/POS (v0.9.6).
 *
 * Threaded down desde el dispatcher (renderJobToPrinter pasa job.id +
 * job.job_type + style del print_options del payload). Para callsites que
 * no son jobs reales (renderTestPage del companion), el caller pasa un
 * objeto sintetico — el captor no diferencia.
 *
 * Es opcional en `sendEscPos` para no romper callsites legacy / tests
 * unitarios que aun llaman con la signature vieja (3 args). En esos casos
 * no se genera captura y no pasa nada.
 */
export type CaptureContext = {
  jobId: string;
  jobType: string;
  /** Estilo de print_options (classic/minimal/brand/thermal_pro) o null. */
  style: string | null;
};

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
 * `captureContext` (v0.9.6): si se especifica, el flow USB exitoso captura
 * el buffer ESC/POS a un .txt humano-legible en `~/.bait-print-agent/captures/`.
 * Sensor de diagnostico para que Claude pueda inspeccionar que se imprimio
 * sin tener el papel fisico. Optional para callsites legacy.
 *
 * Lanza si falla en cualquier paso (connect, send, write). El caller decide
 * el retry path (productivo: el claimAndRun de realtime.ts; test: el handler
 * de /v1/printers/:id/test).
 */
export async function sendEscPos(
  printer: PrinterRow,
  populate: PopulatePrinter,
  logger: Logger,
  width: number = PRINTER_WIDTH_DEFAULT,
  captureContext?: CaptureContext
): Promise<void> {
  switch (printer.connection_type) {
    case 'usb':
      await sendUsbViaSpooler(printer, populate, logger, width, captureContext);
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
 *
 * Serializacion por target (v0.9.4):
 * ----------------------------------
 * Las llamadas concurrentes al MISMO queue Windows se serializan via
 * `targetLocks`. El rendering del buffer corre en paralelo (cheap, en RAM),
 * pero la escritura al spooler + el delay post-write se hacen una a la vez.
 * Ver comentario sobre el bug original arriba en `DEFAULT_INTER_JOB_DELAY_MS`.
 */
async function sendUsbViaSpooler(
  printer: PrinterRow,
  populate: PopulatePrinter,
  logger: Logger,
  width: number,
  captureContext?: CaptureContext
): Promise<void> {
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
  //
  // Lo resolvemos PRIMERO (antes del rendering) porque es el key del lock por
  // target. Si falla, fallamos rapido sin gastar CPU rindiendo un buffer que
  // no podemos mandar a ningun lado.
  const queueName = resolveWindowsQueueName(printer);
  if (!queueName) {
    throw new Error(
      `No pude resolver el queue name de la impresora "${printer.name}". ` +
        `Configura el campo "Destino" en bait-app.cl -> Impresoras con el ` +
        `nombre exacto de la cola de Windows (ej: "PrintCaja"). ` +
        `Verifica con: Get-Printer | Select Name`
    );
  }

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

  logger.debug(
    { printerName: printer.name, queueName, rawTarget: printer.target },
    'USB spooler: resolved queue name from printer config'
  );

  // Serializacion por target queue (v0.9.4): si hay un job en vuelo o
  // encolado para este queue, esperamos a que termine antes de empezar el
  // nuestro. La cadena de promesas en targetLocks garantiza orden FIFO entre
  // los jobs que llegaron a este punto del codigo.
  //
  // OJO: la espera incluye el delay post-write del job anterior. Asi le damos
  // tiempo a la termica fisica de procesar el buffer ya enviado antes de que
  // el spooler reciba el siguiente. Ese delay es lo que evita que el driver
  // "Generic / Text Only" descarte jobs en burst.
  await acquireTargetLockAndSend(
    queueName,
    printer,
    buffer,
    logger
  );

  logger.debug(
    { printer: printer.name, queueName, bytes: buffer.length },
    'sendEscPos USB via spooler RAW completado'
  );

  // Captura ESC/POS (v0.9.6): sensor de diagnostico. Si tenemos contexto del
  // job, decodea el buffer a .txt y lo guarda en ~/.bait-print-agent/captures/.
  // Es no-throwing por contrato — si falla, el job sigue marcado printed y
  // solo queda un warn en el log. Ver `escpos-capture.ts`.
  if (captureContext) {
    await captureJob(
      captureContext.jobId,
      captureContext.jobType,
      captureContext.style,
      buffer,
      logger
    );
  }
}

/**
 * Toma el lock del target queue, ejecuta el write RAW + sleep post-write,
 * y libera el lock al final. Si hay un job previo en vuelo, espera a que
 * termine (incluido su delay) antes de arrancar.
 *
 * Diseño de la cadena:
 *  1. Leemos el lock actual del target (puede ser undefined).
 *  2. Construimos NUESTRA promesa `p` que espera al previo y despues hace
 *     write + sleep. La encadenamos en una sola promesa async.
 *  3. La seteamos en el Map ANTES de await (sincronicamente). Asi el
 *     proximo caller que entre ve nuestra `p` como lock y se encadena
 *     atras nuestro, no atras del previo.
 *  4. Awaiteamos nuestra propia `p` y, al final, limpiamos solo si seguimos
 *     siendo el lock (no romper la cadena de los que se encolaron).
 *
 * Errores:
 *  - Si el write falla, lo propagamos pero igual liberamos el lock para no
 *    bloquear futuros jobs en este target.
 *  - El sleep post-write SOLO corre si el write tuvo exito. Si el write fallo
 *    no tiene sentido esperar.
 */
async function acquireTargetLockAndSend(
  queueName: string,
  printer: PrinterRow,
  buffer: Buffer,
  logger: Logger
): Promise<void> {
  const previousLock = targetLocks.get(queueName);
  const interJobDelayMs = resolveInterJobDelayMs();

  // Snapshot del depth ANTES de incrementar, para que el log refleje cuantos
  // habia antes del nuestro. El que va a empezar inmediato (sin previousLock)
  // ve queueDepth=0; el primero en esperar ve 1; el segundo en esperar ve 2.
  const depthBefore = targetQueueDepth.get(queueName) ?? 0;
  targetQueueDepth.set(queueName, depthBefore + 1);

  if (previousLock) {
    logger.info(
      {
        target: queueName,
        printerName: printer.name,
        queueDepth: depthBefore + 1
      },
      `Esperando lock del target "${queueName}" (otro job en proceso)`
    );
  }

  const ownPromise: Promise<void> = (async () => {
    // Esperar al previo. Si tira, lo capturamos para no propagar el error
    // del job anterior al nuestro: ese error ya lo recibio su propio caller.
    if (previousLock) {
      try {
        await previousLock;
      } catch {
        // Ignorado a proposito: el error del job previo es del job previo.
        // Nosotros seguimos para no bloquear el target a perpetuidad si uno
        // falla.
      }
    }

    try {
      await rawSendImpl(queueName, buffer, logger);

      // Delay post-write SOLO si el write fue exitoso. Le damos tiempo a la
      // termica fisica de procesar el buffer antes que el siguiente job en
      // la cadena le mande mas bytes. Sin este sleep, el driver descarta
      // jobs en burst (root cause del bug v0.9.3).
      if (interJobDelayMs > 0) {
        logger.debug(
          { target: queueName, delayMs: interJobDelayMs },
          'Delay post-write para que la termica procese el buffer'
        );
        await sleep(interJobDelayMs);
      }
    } finally {
      // Decrementar depth siempre (exito o fallo). El cleanup del Map de
      // locks se hace despues, basado en si seguimos siendo el lock activo.
      const current = targetQueueDepth.get(queueName) ?? 1;
      if (current <= 1) {
        targetQueueDepth.delete(queueName);
      } else {
        targetQueueDepth.set(queueName, current - 1);
      }
    }
  })();

  // Setear el lock SINCRONO antes del await, para que cualquier caller que
  // llegue mientras nosotros esperamos se encadene atras nuestro.
  targetLocks.set(queueName, ownPromise);

  try {
    await ownPromise;
  } finally {
    // Solo limpiamos si seguimos siendo el lock. Si alguien ya seteo una
    // promesa nueva encima (jobs encolados detras nuestro), no la tocamos.
    if (targetLocks.get(queueName) === ownPromise) {
      targetLocks.delete(queueName);
    }
  }
}

/**
 * Helper interno expuesto SOLO para tests. NO usar en codigo productivo —
 * el flow normal pasa por sendEscPos que llama internamente al lock.
 *
 * Se exporta el Map y el contador asi un test puede:
 *  - Resetear estado entre casos.
 *  - Inspeccionar queueDepth durante una corrida concurrente.
 *
 * El _ prefix marca el contrato "no public, no semver guarantee".
 */
export const _targetLocksForTests = targetLocks;
export const _targetQueueDepthForTests = targetQueueDepth;

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
