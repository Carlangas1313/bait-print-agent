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
bait-print-agent --mode <console|usb>   # Modo de operación (default: console)
bait-print-agent --version              # Imprime versión y sale
bait-print-agent --help                 # Muestra ayuda
```

`--mode usb` no está implementado todavía (Sprint 3). Pasarlo loguea un warning y cae a `console`.

---

## Variables de entorno

| Variable | Default | Notas |
|---|---|---|
| `SUPABASE_URL` | — | URL del proyecto Supabase de bait-pos |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Service role key (Sprint 2 dev only) |
| `BAIT_AGENT_ID` | — | UUID de la fila en `print_agents` |
| `BAIT_RESTAURANT_ID` | — | UUID del restaurant que atiende |
| `BAIT_LOCATION_ID` | — | UUID de la location |
| `BAIT_AGENT_MODE` | `console` | `console` o `usb` (USB no implementado) |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` |
| `HEARTBEAT_INTERVAL_SECONDS` | `30` | Cada cuánto actualizar `last_seen_at` |

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

## Distribución (Windows .exe)

El agente se distribuye como un **single binary** `bait-print-agent-win-x64.exe` (~80 MB) generado con [Node.js Single Executable Applications (SEA)](https://nodejs.org/api/single-executable-applications.html). No requiere Node instalado en la PC del cliente.

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

### 5. Actualizar el agente

El agente chequea automáticamente cada hora si hay una versión nueva en GitHub Releases. Si la hay, te avisa en los logs con el link de descarga.

Para chequear manualmente:

```cmd
bait-print-agent-win-x64.exe check-updates
```

Para actualizar:

1. `bait-print-agent-win-x64.exe uninstall-service` (como admin)
2. Descargar el .exe nuevo del link que apareció en los logs.
3. Reemplazar el archivo viejo por el nuevo.
4. `bait-print-agent-win-x64.exe install-service` (como admin)

(El reemplazo automático del .exe llega en versiones posteriores.)

#### Variables de entorno opcionales

| Variable | Default | Notas |
|---|---|---|
| `UPDATE_CHECK_INTERVAL_MINUTES` | `60` | Cada cuántos minutos chequear (mínimo 1) |
| `UPDATE_CHECK_ENABLED` | `true` | Setear a `false` desactiva el checker completo |

> ⚠️ Si el repo `Carlangas1313/bait-print-agent` es privado, la API pública de GitHub responde 404 sin auth y el agente loguea un warning (una sola vez por arranque, no en cada check). En ese caso el aviso de updates no funciona hasta que el repo sea público o agreguemos soporte para tokens.

### 6. Build local del .exe (sólo para desarrolladores)

```powershell
npm install
npm run package:win
# Output: dist/bait-print-agent-win-x64.exe
```

Sólo funciona en Windows (Node SEA inyecta el blob en un `node.exe`, no se puede cross-compilar). Para builds reproducibles, el flujo oficial es CI via GitHub Actions con un tag `v*.*.*`.

---

## Roadmap

**Sprint 3a (en curso):**
- ✅ Empaquetar como `.exe` single-file con Node SEA.
- ✅ Auto-publish a GitHub Releases via GitHub Actions.
- ✅ CLI `bait-print-agent setup --code XXXX-XXXX` para pairing.

**Sprint 3b (próximo):**
- Driver ESC/POS real con `node-thermal-printer`.
- JWT scoped en lugar de service role key → safe para distribuir a clientes.

**Sprint 3c (después):**
- Firma del .exe con certificado EV → desaparece el warning de SmartScreen.
- `bait-print-agent install-service` para auto-instalación como servicio Windows.
- ✅ Aviso automático de updates (polling a GitHub Releases, log con link de descarga). El reemplazo del .exe sigue siendo manual.

**Sprint 4:**
- Integración SimpleAPI/OpenFactura para emisión DTE (boleta SII real).
- Layout completo de `sii_receipt` con folio + timbre PDF417.

**Sprint 5:**
- Auto-update via GitHub Releases.
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
