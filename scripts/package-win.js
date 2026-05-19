#!/usr/bin/env node
/**
 * package-win.js — Empaqueta bait-print-agent como un .exe single-file para Windows x64
 * usando Node.js Single Executable Applications (SEA).
 *
 * Pipeline:
 *   1. Verificar prerequisitos (Windows, dist/bundle.cjs presente).
 *   2. Generar sea-config.json apuntando al bundle.
 *   3. Correr `node --experimental-sea-config sea-config.json` para producir el blob.
 *   4. Copiar node.exe del runner actual a dist/bait-print-agent-win-x64.exe.
 *   5. Inyectar el blob con postject usando el sentinel fuse oficial.
 *   6. Loguear el tamano final y verificar que el .exe quedo > 30 MB.
 *
 * Por que SEA y no pkg/nexe:
 *   - SEA es built-in de Node 20+, no agrega deps de tercero al runtime.
 *   - Direccion oficial de Node.js, va a mejorar con cada release.
 *   - pkg/nexe son comunidad/forks y vienen desactualizados.
 *
 * Trade-offs conocidos de SEA en 2026:
 *   - Sigue siendo experimental (warning suprimido via disableExperimentalSEAWarning).
 *   - Worker threads no funcionan dentro del SEA → pino-pretty queda fuera del bundle.
 *   - El binary es grande (~80-100 MB) porque incluye todo el runtime de Node.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUNDLE = path.join(DIST, 'bundle.cjs');
const SEA_CONFIG = path.join(ROOT, 'sea-config.json');
const SEA_BLOB = path.join(DIST, 'sea-prep.blob');
const OUTPUT_EXE = path.join(DIST, 'bait-print-agent-win-x64.exe');
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const NSSM_SRC = path.join(ROOT, 'vendor', 'nssm.exe');
const NSSM_DEST = path.join(DIST, 'nssm.exe');

function log(msg) {
  process.stdout.write(`[package-win] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[package-win] ERROR: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Prerequisites
// ---------------------------------------------------------------------------
function checkPrereqs() {
  if (os.platform() !== 'win32') {
    fail(
      'El packaging Windows solo corre en Windows. ' +
        'Usa GitHub Actions (.github/workflows/release.yml) o WSL2 con Node Windows.'
    );
  }

  if (!fs.existsSync(BUNDLE)) {
    log(`bundle.cjs no existe, corriendo npm run bundle...`);
    const result = spawnSync('npm', ['run', 'bundle'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true
    });
    if (result.status !== 0) {
      fail('npm run bundle fallo');
    }
  }

  const bundleSize = fs.statSync(BUNDLE).size;
  log(`Bundle OK: ${BUNDLE} (${(bundleSize / 1024).toFixed(1)} KB)`);

  // Verificamos que estamos en Node 20+, sino postject va a tirar mensajes raros.
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 20) {
    fail(`Necesitas Node 20+ para SEA. Tenes ${process.versions.node}`);
  }
  log(`Node ${process.versions.node} OK`);
}

// ---------------------------------------------------------------------------
// 2. Generar sea-config.json
// ---------------------------------------------------------------------------
function writeSeaConfig() {
  const config = {
    main: 'dist/bundle.cjs',
    output: 'dist/sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true
  };
  fs.writeFileSync(SEA_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf8');
  log(`sea-config.json escrito`);
}

// ---------------------------------------------------------------------------
// 3. Generar el blob
// ---------------------------------------------------------------------------
function generateBlob() {
  log(`Generando SEA blob...`);
  const result = spawnSync(
    process.execPath,
    ['--experimental-sea-config', SEA_CONFIG],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (result.status !== 0) {
    fail('La generacion del blob fallo');
  }
  if (!fs.existsSync(SEA_BLOB)) {
    fail(`El blob no se genero en ${SEA_BLOB}`);
  }
  const blobSize = fs.statSync(SEA_BLOB).size;
  log(`Blob generado: ${SEA_BLOB} (${(blobSize / 1024).toFixed(1)} KB)`);
}

// ---------------------------------------------------------------------------
// 4. Copiar node.exe a output
// ---------------------------------------------------------------------------
function copyNodeBinary() {
  log(`Copiando node.exe del runner (${process.execPath}) a output...`);
  fs.copyFileSync(process.execPath, OUTPUT_EXE);
  const exeSize = fs.statSync(OUTPUT_EXE).size;
  log(`node.exe copiado a ${OUTPUT_EXE} (${(exeSize / 1024 / 1024).toFixed(1)} MB)`);
}

// ---------------------------------------------------------------------------
// 5. Inyectar el blob con postject
// ---------------------------------------------------------------------------
function injectBlob() {
  log(`Inyectando blob con postject...`);
  const result = spawnSync(
    'npx',
    [
      '--yes',
      'postject',
      OUTPUT_EXE,
      'NODE_SEA_BLOB',
      SEA_BLOB,
      '--sentinel-fuse',
      SENTINEL_FUSE
    ],
    { cwd: ROOT, stdio: 'inherit', shell: true }
  );
  if (result.status !== 0) {
    fail('postject fallo al inyectar el blob');
  }
  log(`Blob inyectado correctamente`);
}

// ---------------------------------------------------------------------------
// 6. Copiar nssm.exe al lado del binario empaquetado
// ---------------------------------------------------------------------------
// Por que: el install-service del agente usa NSSM (Non-Sucking Service Manager)
// para wrappear el .exe Node como servicio Windows valido. El install-service
// busca nssm.exe en path.dirname(process.execPath), asi que tiene que viajar
// junto al .exe. Lo dejamos en dist/ para que Inno Setup lo copie en su [Files].
//
// El binario NSSM vive en vendor/nssm.exe; en CI lo descarga el workflow,
// en dev local hay que bajarlo a mano (instrucciones en el README).
function copyNssm() {
  if (!fs.existsSync(NSSM_SRC)) {
    log(
      `[WARN] vendor/nssm.exe NO encontrado. El install-service NO va a funcionar en clientes finales. ` +
        `Descarga nssm-2.24 desde https://nssm.cc/release/nssm-2.24.zip y coloca win64/nssm.exe en vendor/nssm.exe, ` +
        `o agrega el step "Download NSSM" al workflow de CI.`
    );
    return;
  }

  fs.copyFileSync(NSSM_SRC, NSSM_DEST);
  const nssmSize = (fs.statSync(NSSM_DEST).size / 1024).toFixed(1);
  log(`nssm.exe copiado a dist/ (${nssmSize} KB)`);
}

// ---------------------------------------------------------------------------
// 7. Verificar resultado
// ---------------------------------------------------------------------------
function verifyOutput() {
  const finalSize = fs.statSync(OUTPUT_EXE).size;
  const finalMB = (finalSize / 1024 / 1024).toFixed(1);
  log(`============================================`);
  log(`OK Output: ${OUTPUT_EXE}`);
  log(`OK Size:   ${finalMB} MB`);
  log(`============================================`);

  if (finalSize < 30 * 1024 * 1024) {
    fail(`El .exe es sospechosamente chico (${finalMB} MB). Espero >30 MB.`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  log(`Empaquetando bait-print-agent como Windows SEA executable`);
  checkPrereqs();
  writeSeaConfig();
  generateBlob();
  copyNodeBinary();
  injectBlob();
  copyNssm();
  verifyOutput();
}

main();
