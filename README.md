# bait-print-agent

Agente local que escucha la cola de impresión de **bait-pos** (tabla Supabase `print_jobs`) y procesa los jobs en la PC del local. **V0.1 — modo console** (stdout). USB/ESC-POS llega en Sprint 3.

---

## Cómo funciona

```
┌──────────────┐   Realtime   ┌─────────────────────┐
│ bait-pos web │─INSERT job─►│ Supabase print_jobs │
└──────────────┘              └──────────┬──────────┘
                                         │ canal
                                         ▼
                              ┌─────────────────────┐
                              │ bait-print-agent    │
                              │  - claim CAS        │
                              │  - render console   │
                              │  - mark printed     │
                              └─────────────────────┘
```

- Suscribe a `print_jobs WHERE location_id = $LOCATION` vía Supabase Realtime.
- Al recibir un job `pending`, hace **claim atómico** (`UPDATE ... WHERE status='pending'`); si otro agente del mismo location lo tomó primero, hace skip.
- En modo `console`, formatea el payload y lo imprime en stdout simulando una térmica de 58mm (32 chars de ancho).
- Marca el job como `printed` y registra `printed_at`.
- En errores, reintenta hasta 3 veces con backoff exponencial; después marca `failed` con `last_error`.
- Cada `HEARTBEAT_INTERVAL_SECONDS` actualiza `print_agents.last_seen_at` para que la UI sepa que está vivo.

---

## Setup

### 1. Pre-requisitos

- Node.js **20+** (`node --version`).
- Cuenta Supabase con el proyecto **bait-pos** y las migraciones `039_print_jobs` + `040_print_agents` aplicadas (ya están en producción).

### 2. Clonar y compilar

```bash
git clone https://github.com/Carlangas1313/bait-print-agent.git
cd bait-print-agent
npm install
npm run build
```

### 3. Crear el registro del agente en la DB

Por ahora (Sprint 2) se inserta a mano via SQL en Supabase. Reemplaza los UUIDs:

```sql
INSERT INTO print_agents (restaurant_id, location_id, name, api_token_hash, agent_version)
VALUES (
  '00000000-0000-0000-0000-00000000aaaa', -- restaurant_id
  '00000000-0000-0000-0000-00000000bbbb', -- location_id
  'PC Caja Principal',                     -- name humano
  'dev-token-placeholder',                 -- en Sprint 3: bcrypt del token real
  '0.1.0'
)
RETURNING id;
```

Guarda el `id` que devuelve — ese es tu `BAIT_AGENT_ID`.

### 4. Configurar .env

```bash
cp .env.example .env
```

Edita `.env` con:
- `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API → "service_role" key).
- `BAIT_AGENT_ID` del paso 3.
- `BAIT_RESTAURANT_ID` y `BAIT_LOCATION_ID` matching.

> ⚠️ **El service role key NO se distribuye a clientes**. Es solo para dev local mientras Sprint 3 implementa JWT scoped. Tener un `.env` por PC con esta key implica que cualquiera con acceso a esa PC puede leer/escribir a TODOS los restaurants. Sprint 3 cierra esto.

### 5. Arrancar

```bash
node --env-file=.env dist/index.js --mode console
```

O en modo dev con hot-reload:

```bash
npm run dev
# (carga .env automáticamente vía tsx)
```

Deberías ver:

```
[15:42:01.123] INFO: bait-print-agent v0.1.0 iniciando en modo console para location 00000000-0000-0000-0000-00000000bbbb
[15:42:01.456] INFO: Realtime listener iniciado en location_id=...
[15:42:01.500] INFO: Heartbeat: print_agents actualizado
```

---

## Probar end-to-end

1. Con el agente corriendo, en otra ventana entra a bait-pos web (https://bait-app.cl), abrí una mesa y mandá items a cocina.
2. El agente recibe el evento Realtime y en stdout aparece la comanda formateada:

```
================================
       COCINA - MESA 4
       Mozo: Felipe · 18:42
================================

  2x Lomo a lo pobre
     - Sin huevo
  1x Ensalada chilena
--------------------------------
================================
```

3. Refrescá `/pos/print-queue` en bait-pos — el job aparece como **printed** (verde).

---

## Comandos CLI

```
bait-print-agent --mode <console|virtual|usb>   # Modo de operación (default: console)
bait-print-agent --version                      # Imprime versión y sale
bait-print-agent --help                         # Muestra ayuda
```

Modos:

- `console`: vuelca cada ticket a stdout (32 chars de ancho, ASCII). Útil para dev y CI.
- `virtual`: escribe los tickets a `~/bait-print-out/<fecha>/<hora>-<tipo>-<id>.txt`. Útil para QA visual sin hardware.
- `usb`: imprime en impresoras térmicas físicas configuradas en bait-app.cl vía driver ESC/POS (`node-thermal-printer`). Soporta USB (cola Windows compartida), LAN (TCP 9100) y Bluetooth (COM port virtual). Ver sección **Modo USB / LAN** más abajo.

---

## Variables de entorno

| Variable | Default | Notas |
|---|---|---|
| `SUPABASE_URL` | — | URL del proyecto Supabase de bait-pos |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Service role key (Sprint 2 dev only) |
| `BAIT_AGENT_ID` | — | UUID de la fila en `print_agents` |
| `BAIT_RESTAURANT_ID` | — | UUID del restaurant que atiende |
| `BAIT_LOCATION_ID` | — | UUID de la location |
| `BAIT_AGENT_MODE` | `console` | `console`, `virtual` o `usb` |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` |
| `HEARTBEAT_INTERVAL_SECONDS` | `30` | Cada cuánto actualizar `last_seen_at` |
| `PRINTERS_REFRESH_INTERVAL_MINUTES` | `5` | Cada cuántos minutos refrescar la lista de impresoras desde Supabase (solo modo `usb`) |

---

## Layouts soportados (Sprint 2)

| `job_type` | Status |
|---|---|
| `kitchen_order` | ✅ Implementado |
| `bar_order` | ✅ Implementado (mismo layout que kitchen) |
| `kitchen_cancel` | ✅ Implementado (header "ANULACION", items con prefijo `[X]`) |
| `bill_proforma` | ✅ Implementado |
| `cash_close` | ✅ Implementado |
| `sii_receipt` | ⏳ Stub: log warn + dump JSON. Sprint 4 lo termina cuando integremos OpenFactura/SimpleAPI. |

---

## Modo USB / LAN (driver ESC/POS real)

El agente puede mandar las comandas directo a impresoras térmicas físicas
conectadas a la PC (USB, LAN o Bluetooth), no solo escribirlas a archivo.

### Pre-requisitos

1. **Configurá las impresoras en bait-app.cl** → Configuración → Impresoras → sección "Impresoras físicas":
   - Nombre (ej. "Térmica Cocina")
   - Tipo de conexión: **USB / LAN / Bluetooth**
   - Target (depende del tipo de conexión, ver tabla más abajo)
   - Print area asociada (Cocina, Caja, Barra)
   - Auto-cortar papel, beep, copias

2. **Arrancá el agente con `--mode usb`:**

   ```cmd
   bait-print-agent.exe --mode usb
   ```

   O si lo instalaste como servicio, exportá la env var `BAIT_AGENT_MODE=usb`
   antes de arrancar el servicio. (Próximo Sprint: flag persistente en
   `%USERPROFILE%\.bait-print-agent\config.json`).

### Cómo configurar el `target` según el tipo de conexión

| Tipo | Ejemplo de `target` | Cómo lo arma el agente | Notas |
|---|---|---|---|
| `network` | `192.168.1.50:9100` | `tcp://192.168.1.50:9100` | Puerto raw 9100. Si omitís `:9100`, se asume. |
| `network` | `192.168.1.50` | `tcp://192.168.1.50:9100` | |
| `bluetooth` | `COM7` | `\\.\COM7` | El COM virtual que crea Windows al parear la impresora BT. |
| `usb` | `\\localhost\EPSONTM` | `\\localhost\EPSONTM` (file backend) | **Recomendado en el `.exe`.** Compartí la cola Windows con ese nombre y el agente escribe ahí en RAW. |
| `usb` | `\\.\USB001` | `\\.\USB001` (file backend) | Device path crudo si la impresora expone su puerto. |
| `usb` | `EPSON TM-T20III Receipt` | `printer:EPSON TM-T20III Receipt` | Solo funciona en `npm run dev` (Node normal con módulo nativo `printer` instalado). **No funciona en el `.exe` empaquetado** — usá la opción de cola compartida `\\localhost\<share>`. |

> Si configurás un target inválido o la impresora no responde, el job
> falla con mensaje claro (`Printer "X" no responde: ...`) y el realtime
> lo manda al retry path (3 intentos con backoff lineal de 5s · intento).

### Refresh de la lista de impresoras

El agente recarga la lista cada 5 min desde Supabase, así que si agregás o
modificás impresoras en bait-app.cl mientras el agente está corriendo, los
cambios se ven a más tardar en 5 min sin reiniciar.

Override del intervalo con la env var `PRINTERS_REFRESH_INTERVAL_MINUTES`
(mínimo 1, default 5).

### Hardware soportado

- **Epson**: TM-T20II, TM-T20III, TM-T88V, TM-m30 y cualquier modelo con ESC/POS estándar.
- **Star**: TSP143III, TSP100, TSP650 — funcional (detectado como tipo EPSON; ESC/POS compat).
- **Bixolon**: SRP-330, SRP-350 — funcional.
- **Genéricas chinas ESC/POS** (Cashino, Xprinter, etc.) — funcional con codepage PC858.

### Codepage

El agente envía codepage `PC858_EURO` que soporta tildes (á, é, í, ó, ú),
ñ y €. Si tu impresora muestra caracteres raros, ajustá el codepage
hardcodeado en `src/renderer/usb.ts` (Sprint posterior agrega UI para esto
en bait-app.cl).

### Si no tenés impresora física pero querés probar

1. **LAN simulada con `netcat`/`socat`**: levantá un listener en puerto 9100 (`nc -lk 9100 > /tmp/ticket.bin`) y configurá una printer con `connection_type=network` y `target=127.0.0.1:9100`. Cada job queda en `/tmp/ticket.bin` como buffer ESC/POS crudo (ASCII + códigos de control).
2. **Modo `virtual`**: si no necesitás validar el camino ESC/POS específicamente, `--mode virtual` te da el mismo ticket ASCII en `~/bait-print-out/`.

---

## Distribución (Windows .exe)

El agente se distribuye en dos formatos:

- **Instalador con UI** (`bait-print-agent-setup.exe`) — recomendado para clientes finales. Wizard en español, copia el binario a `Program Files`, lo registra como servicio Windows y lo arranca. Pide el código de pairing en una página del wizard, no en la consola. **Desde v0.6.0 también empaqueta y arranca el companion** (ver sección siguiente).
- **Binario pelado** (`bait-print-agent-win-x64.exe`, ~83 MB) — recomendado para integradores que quieran instalar el agente desde un script. Single binary generado con [Node.js Single Executable Applications (SEA)](https://nodejs.org/api/single-executable-applications.html). No requiere Node instalado.
- **Companion pelado** (`bait-print-companion-win-x64.exe`, ~10-15 MB) — el .exe del companion solo, por si el cajero lo cierra accidentalmente o quiere reinstalarlo sin re-correr todo el wizard del agente.

---

## Companion (tray icon)

Desde **v0.6.0** el instalador incluye un companion que vive en el tray de Windows y le da al cajero una UI premium para ver el estado del agente, los jobs recientes y ejecutar acciones (test de impresión, reiniciar cola, etc.).

### Por qué un companion separado

El servicio Windows (`bAItPrintAgent`) corre en **Session 0**, una sesión aislada de Windows que NO tiene desktop ni puede mostrar tray icons. Es la decisión correcta para un servicio en background (arranca antes del login, sobrevive logoffs), pero significa que la UI tiene que ser un proceso aparte corriendo en la sesión del usuario.

El companion (`bait-print-companion.exe`) es una app Tauri 2 (~10-15 MB, sin Electron) que vive ahí, se comunica con el servicio por HTTP local en `127.0.0.1:17891`, y le pone cara al sistema.

### Cómo se instala

El **instalador del agente (`bait-print-agent-setup.exe`) empaqueta los dos .exe en uno solo**. Cuando el cliente corre el wizard:

1. Se copia `bait-print-companion.exe` a `C:\Program Files\bAIt Print Agent\` junto al servicio.
2. Se registra el companion en `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` para que arranque automáticamente cuando el usuario hace login.
3. Al terminar el wizard, el companion se lanza por primera vez (checkbox marcado por default — el user puede destildarlo).
4. Se crea un shortcut en el Start Menu (`bAIt > bAIt Print Companion`) por si el user lo cierra y quiere volver a abrirlo.

### Cómo se controla

- **Click izquierdo en el tray** → abre/oculta la ventana flotante (380×540, transparent, alwaysOnTop, sin decorations).
- **Click derecho en el tray** → menú con: Estado del servicio, Test de impresión, Reiniciar cola, Abrir bait-app.cl, Ver logs, Salir del companion.
- **Click en la X del header de la ventana** → la oculta (NO cierra la app — sigue en el tray). Para cerrar el companion del todo: click derecho tray → "Salir del companion".

### Cómo se desinstala

Se va junto con el agente. El uninstaller corre `taskkill /F /IM bait-print-companion.exe` antes de borrar archivos para evitar el clásico "file in use" de Windows. La entry de autostart en HKCU se borra automáticamente por el flag `uninsdeletevalue` del Inno Setup.

---

## Instalación (cliente final)

### Opción A: Instalador con UI (recomendado)

1. Desde **bait-app.cl → Configuración → Impresoras → "+ Conectar nueva impresora"**, copia el código de 8 caracteres.
2. Descarga `bait-print-agent-setup.exe` desde el modal (botón "Descargar instalador").
3. Doble click → wizard en español:
   - Elegí carpeta de instalación (por defecto `C:\Program Files\bAIt Print Agent\`).
   - Marca "Configurar ahora".
   - Pega el código `XXXX-XXXX`.
   - Click "Instalar".
4. El instalador configura el agente, lo registra como servicio Windows y lo arranca. Volvé a bait-app.cl y refrescá — el agente aparece con badge verde "online".

> El instalador no está firmado todavía (Sprint 3c). SmartScreen te va a mostrar "Windows protegió tu PC" la primera vez — click en **Más información → Ejecutar de todos modos**.

### Opción B: Binario pelado (avanzado / scripted)

Para instalaciones via script o cuando preferís manejar el servicio a mano:

### 1. Descargar

Cada release en GitHub publica el .exe firmado por SHA256. Andá a:

[https://github.com/Carlangas1313/bait-print-agent/releases/latest](https://github.com/Carlangas1313/bait-print-agent/releases/latest)

Descargá `bait-print-agent-win-x64.exe` y, si querés validar la integridad, también `bait-print-agent-win-x64.exe.sha256`:

```powershell
certutil -hashfile bait-print-agent-win-x64.exe SHA256
# Comparar con el contenido del .sha256
```

### 2. Ejecutar

Como todavía **no firmamos el .exe** (eso queda para Sprint 3c con un cert EV), Windows SmartScreen va a quejarse la primera vez:

- **Doble click:** vas a ver "Windows protegió tu PC" → click en **"Más información"** → **"Ejecutar de todos modos"**.
- **Alternativa (recomendada):** click derecho → **Propiedades** → marcar **"Desbloquear"** → Aceptar.

Después, desde una terminal en la carpeta donde lo guardaste:

```powershell
.\bait-print-agent-win-x64.exe --version
# 0.1.0
```

### 3. Configurar (primer uso)

```powershell
.\bait-print-agent-win-x64.exe setup --code XXXX-XXXX
```

El `--code` lo entrega bait-pos web (Dashboard → Configuración → Impresoras → "Vincular nueva PC"). El RPC `claim_pairing_code` devuelve credenciales y las guarda en `%USERPROFILE%\.bait-print-agent\config.json`.

Después podés correr el agente sin argumentos:

```powershell
.\bait-print-agent-win-x64.exe
```

Más detalles en la sección [Setup](#setup) de arriba.

### 4. Instalar como servicio Windows

El agente puede correr como servicio Windows que arranca automáticamente al prender la PC. Esto es lo recomendado para producción — el cliente no tiene que abrir nada manualmente.

> El instalador usa **NSSM (Non-Sucking Service Manager)** por debajo para
> wrappear el .exe Node.js como servicio Windows válido. Sin NSSM, Windows
> mata al servicio con error 1053 al arrancar porque Node.js no implementa
> el protocolo nativo del Service Control Manager. NSSM también captura los
> logs del agente a `%USERPROFILE%\.bait-print-agent\logs\` con rotación
> automática cada 1 MB, así si algo falla podés ver el error sin tener que
> correr el agente en foreground.

#### Setup automático (recomendado)

1. Abrí CMD o PowerShell **como Administrador** (click derecho → "Ejecutar como administrador").
2. Navega a la carpeta donde está el .exe (ej. `cd C:\Users\TU_USUARIO\Downloads`).
3. Ejecutá:
   ```cmd
   bait-print-agent-win-x64.exe install-service
   ```
4. Listo. El agente arranca solo desde ahora.

#### Verificar estado

```cmd
bait-print-agent-win-x64.exe service-status
```

#### Desinstalar

```cmd
bait-print-agent-win-x64.exe uninstall-service
```

(necesita CMD/PowerShell como Administrador)

#### Ver los logs del servicio

Los logs se guardan en `%USERPROFILE%\.bait-print-agent\logs\`:

- `stdout.log` — logs normales (info, debug).
- `stderr.log` — errores.

Cada archivo rota cuando llega a 1 MB. Las versiones rotadas se quedan como `stdout.log.1`, `stdout.log.2`, etc.

Para ver los logs en vivo (tail):

```cmd
powershell -Command "Get-Content '%USERPROFILE%\.bait-print-agent\logs\stdout.log' -Wait -Tail 20"
```

### 5. Actualizar el agente

El agente chequea automáticamente cada hora si hay una versión nueva en GitHub Releases. Tenés 3 formas de actualizar:

#### Opción 1: Update automático (recomendado para producción)

Como env var del servicio (o del proceso), seteá:

```
UPDATE_APPLY_ENABLED=true
```

Con ese flag prendido, cuando el checker detecta una versión nueva descarga el `.exe`, lo reemplaza solo (técnica "renombrar viejo + colocar nuevo", soportada por Windows incluso con el `.exe` en uso) y reinicia el servicio Windows con el binario nuevo. Útil para clientes que querés mantener al día sin tocar nada.

#### Opción 2: Update manual con comando

```cmd
bait-print-agent-win-x64.exe update
```

Descarga el último release de GitHub, reemplaza el `.exe` actual, reinicia el servicio. Necesita admin si el agente corre como servicio Windows. Flags útiles:

- `--force` — aplicar update aunque la versión actual ya sea la más nueva (útil para reinstalar el mismo binario).
- `--service-name <name>` — nombre del servicio si lo instalaste con uno custom (default: `bAItPrintAgent`).

Para chequear sin aplicar:

```cmd
bait-print-agent-win-x64.exe check-updates
```

#### Opción 3: Update manual completo (legacy)

1. `bait-print-agent-win-x64.exe uninstall-service` (como admin)
2. Bajás el `.exe` nuevo de [`releases/latest`](https://github.com/Carlangas13/bait-print-agent/releases/latest).
3. Reemplazás el archivo viejo por el nuevo.
4. `bait-print-agent-win-x64.exe install-service` (como admin)

#### Variables de entorno opcionales

| Variable | Default | Notas |
|---|---|---|
| `UPDATE_CHECK_INTERVAL_MINUTES` | `60` | Cada cuántos minutos chequear (mínimo 1) |
| `UPDATE_CHECK_ENABLED` | `true` | Setear a `false` desactiva el checker completo |
| `UPDATE_APPLY_ENABLED` | `false` | Setear a `true` activa el reemplazo automático cuando hay versión nueva (opt-in) |

> ⚠️ Si el repo `Carlangas1313/bait-print-agent` es privado, la API pública de GitHub responde 404 sin auth y el agente loguea un warning (una sola vez por arranque, no en cada check). En ese caso el aviso de updates no funciona hasta que el repo sea público o agreguemos soporte para tokens.

#### Persistencia del config entre updates

El config del agente vive en `%USERPROFILE%\.bait-print-agent\config.json`, **fuera** de `Program Files`. Eso significa que un update del `.exe` no toca el config — el agente nuevo lee el mismo archivo y sigue autenticado sin necesidad de re-pairing.

Tradeoff: si en una versión futura cambiamos el schema de `config.json`, el agente nuevo va a tirar un error de validación al arranque. En ese caso, `bait-print-agent reset` + `bait-print-agent setup --code XXXX-XXXX` te deja al día.

### 6. Build local del .exe (sólo para desarrolladores)

#### Binario pelado

```powershell
npm install
npm run package:win
# Output: dist/bait-print-agent-win-x64.exe
```

Sólo funciona en Windows (Node SEA inyecta el blob en un `node.exe`, no se puede cross-compilar).

#### Instalador con UI

Pre-requisito: [Inno Setup 6.4+](https://jrsoftware.org/isdl.php) instalado.

```powershell
npm run package:win
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /Q /DVersion=0.3.0 scripts\bait-print-agent.iss
# Output: dist\Output\bait-print-agent-setup-0.3.0.exe
```

El script `.iss` está en `scripts/bait-print-agent.iss`. Para builds reproducibles, el flujo oficial es CI vía GitHub Actions con un tag `v*.*.*` — el workflow corre ambos pasos y sube los dos artefactos al release.

---

## Roadmap

**Sprint 3a (en curso):**
- ✅ Empaquetar como `.exe` single-file con Node SEA.
- ✅ Auto-publish a GitHub Releases via GitHub Actions.
- ✅ CLI `bait-print-agent setup --code XXXX-XXXX` para pairing.

**Sprint 3b (v0.4.0 — completo):**
- ✅ Driver ESC/POS real con `node-thermal-printer` (USB cola Windows, LAN raw 9100, Bluetooth COM).
- ✅ Tabla `printers` cargada por location con refresh cada 5 min.
- ✅ Matching job→printer por `print_area_id` con fallback a `is_primary`.
- JWT scoped en lugar de service role key → safe para distribuir a clientes (pendiente).

**Sprint 3c (después):**
- Firma del .exe con certificado EV → desaparece el warning de SmartScreen.
- `bait-print-agent install-service` para auto-instalación como servicio Windows.
- ✅ Aviso automático de updates (polling a GitHub Releases, log con link de descarga). El reemplazo del .exe sigue siendo manual.

**Sprint 4:**
- Integración SimpleAPI/OpenFactura para emisión DTE (boleta SII real).
- Layout completo de `sii_receipt` con folio + timbre PDF417.

**Sprint 5:**
- ✅ Auto-update via GitHub Releases (`bait-print-agent update` + `UPDATE_APPLY_ENABLED=true`).
- Multi-printer por agente (Cocina caliente, Cocina fría, Barra, Caja).
- Heartbeat con métricas (jobs procesados, tiempo medio).

---

## Troubleshooting

**`Configuración inválida. Revisar .env contra .env.example`**
Te falta alguna variable de entorno o tiene formato inválido. El error te dice cuál.

**`Realtime listener no recibe eventos`**
Verificá que la tabla `print_jobs` esté agregada a la publication `supabase_realtime` (la migration 039 lo hace, pero confirmá en Supabase Dashboard → Database → Replication).

**`UPDATE print_agents falló`**
El `BAIT_AGENT_ID` no existe en la DB o la service role key es incorrecta.

**El agente arranca pero los jobs quedan pending**
Confirmá que tu `BAIT_LOCATION_ID` matches el `location_id` de los jobs que inserta bait-pos web. Si tenés varias sucursales y el bait-pos está en modo "Todas", el agente correcto es el de la sucursal donde se cobró.

---

## Licencia

UNLICENSED · Property of Carlos Olivares · bAIt
