/**
 * Tests para src/printers/escpos-transport.ts
 *
 * Foco principal: el lock por target queue (v0.9.4). Verificamos que dos+
 * llamadas concurrentes a `sendEscPos` con el mismo target Windows queue se
 * serialicen (segundo empieza despues del primero, tercero despues del
 * segundo), evitando el bug v0.9.3 donde el burst al spooler hacia que el
 * driver "Generic / Text Only" descartara jobs internamente.
 *
 * Framework: node:test (builtin Node 22) + `tsx` loader, como el resto del
 * proyecto. Ver `logo-cache.test.ts` para el patron base.
 *
 * Mock strategy:
 *  - Inyectamos un fake `rawSendImpl` via `_setRawSendImplForTests` para no
 *    spawnear PowerShell ni tocar Windows.
 *  - El fake registra (timestamp, queue) cada vez que es llamado y tarda un
 *    poco simulando el spooler (ej. 30ms). Asi podemos verificar que el
 *    segundo call no arranca hasta que el primero (+ post-write delay)
 *    termino.
 *  - Para evitar tests largos seteamos `BAIT_PRINT_INTER_JOB_DELAY_MS=20`,
 *    lo suficiente para verificar la serializacion pero rapido.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendEscPos,
  _setRawSendImplForTests,
  _targetLocksForTests,
  _targetQueueDepthForTests
} from './escpos-transport.js';
import type { PrinterRow } from './registry.js';
import type { Logger } from '../logger.js';

// ============================================================
// Helpers
// ============================================================

/**
 * Logger no-op para que los tests no spammeen stdout. Cumple la forma minima
 * que el codigo bajo test usa (`info`, `debug`, `warn`, `error`).
 */
function silentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    trace: noop,
    fatal: noop,
    child: () => silentLogger()
  } as unknown as Logger;
}

/**
 * Arma una PrinterRow USB minima con el target dado. Lo importante para los
 * tests del lock es solo `connection_type='usb'` + `target` (lo que termina
 * siendo la key del lock).
 */
function makeUsbPrinter(targetQueue: string, name: string = targetQueue): PrinterRow {
  return {
    id: `printer-${name}`,
    name,
    printer_type: 'thermal_kitchen',
    connection_type: 'usb',
    target: targetQueue,
    print_area_id: null,
    is_primary: false,
    copies: 1,
    cut_paper: false,
    beep: false,
    width_chars: 32
  };
}

/**
 * Populate dummy: agrega lineas suficientes para superar el threshold
 * `MIN_USEFUL_BUFFER_BYTES` (16 bytes) del check anti-ticket-fantasma.
 * 5 lineas de println son ~50 bytes ESC/POS, bien sobre el umbral.
 */
function populateDummy(tp: {
  println: (s: string) => void;
  cut: () => void;
}): void {
  tp.println('Linea 1 de test');
  tp.println('Linea 2');
  tp.println('Linea 3 mas larga para garantizar bytes');
  tp.println('Linea 4');
  tp.cut();
}

type CallRecord = {
  queue: string;
  startedAt: number;
  endedAt: number;
};

function makeRecordingRawSend(
  fakeWriteDurationMs: number,
  records: CallRecord[]
) {
  return async (queue: string, _buffer: Buffer): Promise<void> => {
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, fakeWriteDurationMs));
    const endedAt = Date.now();
    records.push({ queue, startedAt, endedAt });
  };
}

// ============================================================
// Tests
// ============================================================

describe('escpos-transport — lock por target queue (v0.9.4)', () => {
  before(() => {
    // Delay corto para que la suite no tarde demasiado pero suficientemente
    // medible (>5x el tiempo de scheduling del event loop).
    process.env.BAIT_PRINT_INTER_JOB_DELAY_MS = '20';
  });

  after(() => {
    delete process.env.BAIT_PRINT_INTER_JOB_DELAY_MS;
    _setRawSendImplForTests(null);
  });

  beforeEach(() => {
    // Reset de estado global entre tests. Si un test anterior dejo locks
    // colgados (ej: rejected promise sin handler), arrancamos limpios.
    _targetLocksForTests.clear();
    _targetQueueDepthForTests.clear();
  });

  it('un solo job pasa derecho sin esperar lock', async () => {
    const records: CallRecord[] = [];
    _setRawSendImplForTests(makeRecordingRawSend(15, records));

    const printer = makeUsbPrinter('PrintCaja');
    const logger = silentLogger();

    const t0 = Date.now();
    await sendEscPos(printer, populateDummy, logger);
    const elapsed = Date.now() - t0;

    assert.equal(records.length, 1);
    assert.equal(records[0]?.queue, 'PrintCaja');
    // Total: ~15ms write + ~20ms post-write delay. Damos slack hacia arriba
    // por el scheduler de Node (suele ser <100ms). Hacia abajo, no menos de
    // los 35ms minimos.
    assert.ok(elapsed >= 30, `elapsed=${elapsed}ms (esperado >=30ms)`);
  });

  it('3 calls concurrentes al MISMO target se serializan', async () => {
    const records: CallRecord[] = [];
    const fakeWriteMs = 30;
    _setRawSendImplForTests(makeRecordingRawSend(fakeWriteMs, records));

    const printer = makeUsbPrinter('PrintCaja');
    const logger = silentLogger();

    // Lanzar los 3 jobs en paralelo (sin await secuencial entre ellos).
    const [r1, r2, r3] = await Promise.all([
      sendEscPos(printer, populateDummy, logger),
      sendEscPos(printer, populateDummy, logger),
      sendEscPos(printer, populateDummy, logger)
    ]);

    // Los 3 resolvieron OK.
    assert.equal(r1, undefined);
    assert.equal(r2, undefined);
    assert.equal(r3, undefined);

    // Llegaron 3 calls al raw send, todos al mismo queue.
    assert.equal(records.length, 3);
    assert.ok(
      records.every((r) => r.queue === 'PrintCaja'),
      'todos al mismo queue'
    );

    // Orden estricto: el segundo empieza DESPUES de que el primero termino
    // + delay. El tercero despues del segundo + delay. Permitimos 5ms de
    // jitter del scheduler (el setTimeout no es exacto al ms).
    const [c1, c2, c3] = records as [CallRecord, CallRecord, CallRecord];

    // c2.startedAt debe ser >= c1.endedAt + interJobDelayMs(20) - jitter(5).
    const gap12 = c2.startedAt - c1.endedAt;
    assert.ok(
      gap12 >= 15,
      `Gap c1.end -> c2.start = ${gap12}ms (esperado >=15ms por post-write delay)`
    );

    const gap23 = c3.startedAt - c2.endedAt;
    assert.ok(
      gap23 >= 15,
      `Gap c2.end -> c3.start = ${gap23}ms (esperado >=15ms por post-write delay)`
    );

    // Y mas importante: ningun par se solapo. c2 NO arranca antes de c1.end.
    assert.ok(
      c2.startedAt >= c1.endedAt,
      `c2 arranco antes que c1 terminara — NO serializado`
    );
    assert.ok(
      c3.startedAt >= c2.endedAt,
      `c3 arranco antes que c2 terminara — NO serializado`
    );
  });

  it('2 calls a DISTINTOS targets corren en paralelo (no se bloquean entre si)', async () => {
    const records: CallRecord[] = [];
    const fakeWriteMs = 40;
    _setRawSendImplForTests(makeRecordingRawSend(fakeWriteMs, records));

    const printerA = makeUsbPrinter('PrintCaja', 'PrinterA');
    const printerB = makeUsbPrinter('PrintCocina', 'PrinterB');
    const logger = silentLogger();

    const t0 = Date.now();
    await Promise.all([
      sendEscPos(printerA, populateDummy, logger),
      sendEscPos(printerB, populateDummy, logger)
    ]);
    const elapsed = Date.now() - t0;

    assert.equal(records.length, 2);

    // Si NO hubiera paralelismo, el total seria ~2*(40 + 20) = 120ms.
    // Con paralelismo: ~max(40, 40) + 20 delay = ~60ms.
    // Margen: < 100ms (claramente paralelo).
    assert.ok(
      elapsed < 100,
      `Dos targets distintos deberian correr en paralelo. elapsed=${elapsed}ms`
    );

    // Confirmacion estructural: ambos empezaron casi al mismo tiempo.
    const startsApart = Math.abs(
      (records[0]?.startedAt ?? 0) - (records[1]?.startedAt ?? 0)
    );
    assert.ok(
      startsApart < 15,
      `Ambos targets deberian arrancar casi simultaneo. diff=${startsApart}ms`
    );
  });

  it('si un job al target falla, el siguiente igual procede (no queda lock zombie)', async () => {
    let callCount = 0;
    const records: CallRecord[] = [];

    _setRawSendImplForTests(async (queue: string, _buffer: Buffer) => {
      callCount += 1;
      if (callCount === 1) {
        // Primer call: fallar.
        throw new Error('Fake spooler error en el primero');
      }
      // Segundo call: ok.
      const startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 10));
      records.push({ queue, startedAt, endedAt: Date.now() });
    });

    const printer = makeUsbPrinter('PrintCaja');
    const logger = silentLogger();

    // Job 1: arrancarlo, esperar que falle.
    const p1 = sendEscPos(printer, populateDummy, logger);
    // Job 2: en paralelo, debe esperar al lock del 1 y despues correr.
    const p2 = sendEscPos(printer, populateDummy, logger);

    await assert.rejects(p1, /Fake spooler error/);
    await p2; // No debe rechazar — el error del 1 no contagia.

    // El 2do call al raw send realmente ocurrio.
    assert.equal(records.length, 1, 'el 2do job tiene que haber llegado al raw send');

    // Y el lock se limpio (Map vacio una vez termino todo).
    assert.equal(
      _targetLocksForTests.has('PrintCaja'),
      false,
      'lock del target debe estar limpio despues que la cadena termino'
    );
    assert.equal(
      _targetQueueDepthForTests.get('PrintCaja') ?? 0,
      0,
      'queueDepth tiene que volver a 0 al final'
    );
  });
});
