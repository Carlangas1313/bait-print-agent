/**
 * Manda bytes ESC/POS RAW directo al spooler de Windows usando la Win32 API
 * `WritePrinter` (winspool.drv). Es el approach correcto para imprimir en
 * termicas USB cuando Windows expone la impresora como una "queue" con un
 * driver propietario (Rongta, ESDPRT, DOT4 de HP, etc.) en vez de un device
 * path \\.\USB001 directo.
 *
 * Por que esto y no:
 * ------------------
 *   - `\\.\USB001` (file backend de node-thermal-printer): solo funciona si
 *     Windows expone la impresora con un PortName tipo "USB001" simple. Las
 *     termicas modernas tienden a usar puertos virtuales (RongtaUSB PORT:,
 *     DOT4_001, ESDPRT001, etc) donde abrir el device path directo falla.
 *
 *   - `printer:<name>` (printer backend de node-thermal-printer): requiere
 *     el modulo nativo `printer` de npm, que NO se empaqueta en Node SEA
 *     (el .node binario queda fuera del .exe single-file). En produccion
 *     este path simplemente no esta disponible.
 *
 *   - Driver de Windows (el que se usa al "Click derecho > Imprimir"): el
 *     driver renderiza el documento con GDI (bitmaps), no manda los bytes
 *     ESC/POS tal cual. Si nuestros bytes son ESC/POS, el driver los
 *     interpreta como GDI corrupto y la termica imprime papel en blanco.
 *
 * Como funciona aca:
 * ------------------
 *  1. node-thermal-printer arma el buffer ESC/POS (via `tp.getBuffer()`
 *     despues de tp.println / tp.cut / etc, sin llamar tp.execute()).
 *  2. Lo guardamos en un archivo binario temporal en %TEMP%.
 *  3. Spawneamos PowerShell con un script Add-Type que define las firmas
 *     de OpenPrinter / StartDocPrinter / WritePrinter / EndDocPrinter, lee
 *     el archivo binario y manda los bytes con `pDataType = "RAW"`.
 *  4. El spooler de Windows reconoce datatype RAW y NO los pasa por el
 *     driver — los manda byte por byte al dispositivo subyacente. Asi la
 *     termica recibe ESC/POS valido y lo interpreta correctamente.
 *  5. Borramos el archivo temporal y reportamos.
 *
 * Esta es la tecnica estandar que usan los SDK POS de Microsoft, Epson y
 * la mayoria de las apps de comercios. La documenta Microsoft en
 * https://learn.microsoft.com/en-us/windows/win32/printdocs/sending-data-directly-to-a-printer
 *
 * Requisitos del runtime:
 *  - Windows (cualquier version con PowerShell, todos los soportados hoy).
 *  - El usuario que corre el agente debe tener permiso para imprimir en
 *    esa printer (siempre verdadero si Windows muestra la queue).
 *  - powershell.exe en el PATH (true por default en cualquier Windows).
 *  - El timeout default de 10s cubre incluso impresoras lentas o con cola
 *    llena; los jobs ESC/POS tipicos pesan <10 KB y se mandan en milisegundos.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);

/**
 * Tiempo maximo que esperamos a PowerShell. Si la impresora esta atorada o
 * el spooler colgo, cortamos a los 10s y dejamos que el caller decida el
 * retry. Mas que esto seria innecesario — la impresion ESC/POS es de
 * milisegundos en el caso normal.
 */
const POWERSHELL_TIMEOUT_MS = 10_000;

/**
 * Manda un buffer crudo a la queue de Windows indicada. Lanza si falla
 * en cualquier paso (write archivo temp, OpenPrinter, WritePrinter, etc).
 *
 * El printerName es el `Name` de Get-Printer (el nombre visible en
 * Settings -> Bluetooth & devices -> Printers & scanners). Soporta nombres
 * con espacios — los pasamos via base64 al script PowerShell para evitar
 * cualquier tema de escaping.
 */
export async function sendRawToWindowsPrinter(
  printerName: string,
  buffer: Buffer,
  logger: Logger
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error(
      `sendRawToWindowsPrinter solo funciona en Windows. Detectado: ${process.platform}`
    );
  }

  if (!printerName || printerName.trim().length === 0) {
    throw new Error('printerName vacio');
  }
  if (!buffer || buffer.length === 0) {
    throw new Error('buffer vacio — no hay nada que imprimir');
  }

  // Archivo temp con bytes binarios. Nombre random para evitar colisiones
  // con multiples jobs en paralelo, en %TEMP% que es donde Node y PowerShell
  // tienen permisos sin elevation.
  const tmpName = `bait-rawprint-${crypto.randomBytes(8).toString('hex')}.bin`;
  const tmpPath = path.join(os.tmpdir(), tmpName);

  try {
    await fs.writeFile(tmpPath, buffer);
    logger.debug(
      { printerName, bytes: buffer.length, tmpPath },
      'Buffer ESC/POS escrito a archivo temp, invocando PowerShell + WritePrinter'
    );

    // Pasamos printerName base64-encoded para evitar problemas con espacios,
    // tildes, caracteres especiales (el formateo del PortName del Rongta:
    // "RongtaUSB PORT:" tiene espacio y dos puntos — todo va a sobrevivir
    // si lo decodificamos del lado PS).
    const nameB64 = Buffer.from(printerName, 'utf8').toString('base64');

    // Escape de apostrofes en tmpPath para que el single-quoted string de PS
    // no se rompa si el path tiene uno (raro pero posible). En PS, el escape
    // de "'" dentro de '...' es "''" (dos apostrofes).
    const tmpPathEsc = tmpPath.replace(/'/g, "''");

    // Script PowerShell. Inyectamos printerNameB64 y tmpPath como literales
    // single-quoted (PS no expande variables ni codigo dentro de single-quoted).
    // Esto evita el problema con `-Command <script> -- arg1 arg2` donde PS
    // interpreta `--` como operador unario y rompe el parse.
    //
    // nameB64 es seguro inyectar como literal: charset base64 = [A-Za-z0-9+/=],
    // sin apostrofes ni caracteres especiales.
    const script = `
$ErrorActionPreference = 'Stop'
$printerNameB64 = '${nameB64}'
$tmpPath = '${tmpPathEsc}'

$printerName = [System.Text.Encoding]::UTF8.GetString(
  [System.Convert]::FromBase64String($printerNameB64)
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class BaitRawSpooler {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public struct DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }

  [DllImport("winspool.drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

  [DllImport("winspool.drv", EntryPoint="ClosePrinter", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern int StartDocPrinter(IntPtr hPrinter, int Level, [In] ref DOCINFOA pDocInfo);

  [DllImport("winspool.drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", EntryPoint="EndPagePrinter", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
}
'@

$bytes = [System.IO.File]::ReadAllBytes($tmpPath)
$handle = [IntPtr]::Zero

if (-not [BaitRawSpooler]::OpenPrinter($printerName, [ref]$handle, [IntPtr]::Zero)) {
  $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "OpenPrinter fallo (printer='$printerName'): Win32 error $code"
}

try {
  $doc = New-Object BaitRawSpooler+DOCINFOA
  $doc.pDocName = 'bAIt Print Job'
  $doc.pDataType = 'RAW'

  $docId = [BaitRawSpooler]::StartDocPrinter($handle, 1, [ref]$doc)
  if ($docId -eq 0) {
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "StartDocPrinter fallo: Win32 error $code"
  }

  try {
    if (-not [BaitRawSpooler]::StartPagePrinter($handle)) {
      $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "StartPagePrinter fallo: Win32 error $code"
    }

    [int]$written = 0
    if (-not [BaitRawSpooler]::WritePrinter($handle, $bytes, $bytes.Length, [ref]$written)) {
      $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "WritePrinter fallo: Win32 error $code"
    }
    if ($written -ne $bytes.Length) {
      throw "WritePrinter incompleto: esperaba $($bytes.Length) bytes, escribi $written"
    }

    [void][BaitRawSpooler]::EndPagePrinter($handle)
  } finally {
    [void][BaitRawSpooler]::EndDocPrinter($handle)
  }
} finally {
  [void][BaitRawSpooler]::ClosePrinter($handle)
}

Write-Output "OK"
`;

    // Encodeamos el script entero en base64 UTF-16LE (formato que PS espera
    // para -EncodedCommand). Esto evita TODOS los problemas de escaping en
    // la CLI: comillas, saltos de linea, dollar signs, todo se preserva
    // byte-perfect. Recomendado por Microsoft para scripts complejos.
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');

    const psArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodedScript
    ];

    const { stdout, stderr } = await execFileAsync('powershell.exe', psArgs, {
      timeout: POWERSHELL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });

    if (stderr && stderr.trim().length > 0) {
      // Algunos warnings de PS van a stderr pero exit code 0 — los logueamos
      // solo en debug. El error real ya hubiera matado el proceso con !=0.
      logger.debug(
        { stderr: stderr.trim().slice(0, 500), printerName },
        'PowerShell stderr non-empty (job termino OK igual)'
      );
    }

    if (!stdout.includes('OK')) {
      throw new Error(
        `PowerShell no reporto OK al final del WritePrinter (printer='${printerName}'). ` +
          `stdout: ${stdout.trim().slice(0, 200)}`
      );
    }

    logger.info(
      { printerName, bytes: buffer.length },
      `Spooler RAW: ${buffer.length} bytes enviados a "${printerName}"`
    );
  } catch (err) {
    // execFile lanza ChildProcessError con stderr + exit code en el message
    // cuando el script PS tira (throw -> exit code 1 + stderr con el msg).
    // Extraemos el detail user-friendly y lo propagamos.
    const e = err as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
      code?: string | number;
    };
    const detail =
      (e.stderr && e.stderr.toString().trim()) ||
      (e.stdout && e.stdout.toString().trim()) ||
      e.message;
    throw new Error(
      `No pude imprimir RAW en "${printerName}": ${detail.slice(0, 400)}`
    );
  } finally {
    // Best-effort cleanup. Si fallo el delete (raro: archivo lockeado por
    // antivirus, etc) lo dejamos y Windows va a limpiarlo en algun reinicio.
    fs.unlink(tmpPath).catch(() => {});
  }
}
