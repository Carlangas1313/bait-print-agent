# bAIt Print Companion

Tray + ventana flotante para el agente `bait-print-agent`. Vive en la
sesión del usuario (no en Session 0 de Windows como el servicio) y le da
al cajero una UI premium para ver el estado del agente, los jobs recientes
y ejecutar acciones (test de impresión, reiniciar cola, etc.).

> **Estado:** wireup HTTP completo. El companion lee
> `~/.bait-print-agent/config.json` para el Bearer token y polea
> `http://127.0.0.1:17891` cada 5s (status) / 10s (recent jobs).
> Si el agente no está corriendo el header muestra "DESCONECTADO"
> en rojo y las acciones quedan deshabilitadas. Apenas el servicio
> vuelve, el polling reconecta solo.

## Stack

- **Tauri 2** (no Tauri 1)
- **Vite 6 + React 18 + TypeScript estricto**
- **Tailwind 3** + **shadcn/ui** (variant slate base, CSS vars)
- **framer-motion** para animaciones y `lucide-react` para iconos
- Fuentes Google: **Inter** (body) + **Space Grotesk** (display/títulos)

## Estructura

```
companion/
├── index.html                  ← carga Google Fonts (Inter + Space Grotesk)
├── package.json                ← scripts: dev, build, tauri:dev, tauri:build
├── tailwind.config.js          ← paleta bait (navy / cyan / cream / orange)
├── tsconfig.json
├── vite.config.ts              ← port 1420 strict, alias @/
├── components.json             ← config shadcn (baseColor slate)
├── postcss.config.js
├── scripts/
│   └── generate-icons.mjs      ← genera placeholder PNGs (zero-dep)
├── src/
│   ├── main.tsx
│   ├── App.tsx                 ← compone header + tabs + footer + toaster
│   ├── index.css               ← Tailwind directives + glass-shell + scrollbar
│   ├── components/
│   │   ├── AppHeader.tsx       ← logo bAIt + status dot + window controls
│   │   ├── AppFooter.tsx       ← versión + link soporte
│   │   ├── StatusTab.tsx       ← métricas + conexiones + impresoras
│   │   ├── RecentJobsTab.tsx   ← 20 jobs colapsables con badge + items
│   │   ├── ActionsTab.tsx      ← test print + restart + pairing + quick links
│   │   ├── StatusDot.tsx       ← dot con pulse infinito (framer-motion)
│   │   └── ui/                 ← shadcn primitives (button, card, badge, tabs,
│   │                             scroll-area, separator, tooltip, toast, toaster)
│   ├── hooks/
│   │   └── use-toast.ts        ← toast store (shadcn adaptado)
│   └── lib/
│       ├── utils.ts            ← cn(), formatRelative, formatTime
│       ├── mock-data.ts        ← AgentState + 2 printers + 10 jobs mock
│       └── api.ts              ← stub fetch(127.0.0.1:17891), flag USE_MOCKS
└── src-tauri/
    ├── Cargo.toml              ← tauri 2, plugin-opener, plugin-process, env_logger
    ├── tauri.conf.json         ← window 380×540, transparent, alwaysOnTop, no decorations
    ├── build.rs
    ├── capabilities/
    │   └── default.json        ← permissions: window, tray, menu, opener, process
    ├── icons/                  ← PNG placeholders generados (navy + b cyan)
    └── src/
        ├── main.rs             ← entry, env_logger init
        └── lib.rs              ← tray + menu nativo + window toggle/position
```

## Cómo correr

### Frontend solo (Vite, sin tray)

Útil para iterar sobre la UI sin esperar el ciclo de compilación de Rust.
La app detecta que `@tauri-apps/api` no está disponible y los handlers de
window (hide/exit) hacen un `console.warn` en vez de romper.

```bash
cd companion
npm install
npm run dev
# abre http://localhost:1420
```

> En modo Vite puro el comando Tauri `read_local_api_token` no existe,
> así que cualquier `fetch` al HTTP server del agente va a fallar con un
> error. El frontend pinta "DESCONECTADO" en el header — es el
> comportamiento esperado mientras no haya runtime Tauri.

### Variables de entorno para dev

| Var | Default | Para qué sirve |
|-----|---------|----------------|
| `BAIT_AGENT_HOME` | `%USERPROFILE%\.bait-print-agent` | Override del directorio donde vive `config.json` + `logs/`. Útil para tener una config de dev separada de la productiva (ej. `C:\dev\.bait-agent-dev`). Lo respeta tanto el comando Rust `read_local_api_token` como el botón "Ver logs". |

Para usarlo en dev:

```powershell
# PowerShell, sesión del companion (Vite o tauri:dev)
$env:BAIT_AGENT_HOME = "C:\dev\.bait-agent-dev"
npm run tauri:dev
```

```bash
# bash WSL/Git Bash
BAIT_AGENT_HOME=/c/dev/.bait-agent-dev npm run tauri:dev
```

### Tauri completo (con tray + window flotante)

**Requiere Rust instalado** (https://rustup.rs/). En Windows también
necesitás Visual Studio Build Tools 2019+ con la C++ workload — Carlos
ya los tiene, pero si querés validarlo:

```bash
npx tauri info
```

Una vez con Rust:

```bash
npm run tauri:dev
```

La primera compilación tarda 5-10 min (compila tauri + wry + tao desde
cero). Las siguientes son <30s.

### Build de producción

```bash
npm run tauri:build
# Output en src-tauri/target/release/bundle/
#   - msi (Windows installer)
#   - nsis (alternativa NSIS si está configurada)
```

## Diseño visual — decisiones tomadas

- **Ventana 380×540 sin decorations, `transparent: true`, `alwaysOnTop: true`,
  `skipTaskbar: true`, `visible: false` al arranque** — vive en el tray,
  aparece cuando el user clickea el icono.
- **Glass shell custom** (clase `.glass-shell` en `src/index.css`):
  fondo gradient navy con `backdrop-filter: blur(24px) saturate(160%)`,
  borde sutil cyan al 8% y aura cyan en el top via `::before`. Es lo que
  da el efecto premium sin librerías extra.
- **Header con drag region custom** (`data-tauri-drag-region` en
  AppHeader.tsx) porque la window no tiene barra nativa. El user arrastra
  desde el header como una window normal.
- **Tabs en grid de 3 col** con accent cyan al estado activo (subtle inset
  shadow) — más liviano que el default underline.
- **StatusDot** con pulse infinito de framer-motion (scale 1→1.8→1).
  Para `offline`/`inactive` no pulsa, sólo se muestra.
- **Toast** custom variant `warning` con borde naranja para "funcionalidad
  pendiente" — explícito sobre lo que falta wireup.
- **Tipografía:** Inter en body con `ss01` activado para los números
  tabulares; Space Grotesk en `h1-h4` y `.font-display`.
- **Paleta** en `tailwind.config.js`:
  - `bait-navy` (50-950, default 800 = #0a1929)
  - `bait-cyan` (50-900, default 500 = #00bcd4)
  - `bait-cream` (50-500, default 200 = #f5f0e8)
  - `bait-orange` (50-900, default 500 = #ff6b35)

## Tray (Rust)

El tray icon vive en `src-tauri/src/lib.rs`. Implementa:

- **Click izquierdo** → `toggle_window()`: si la window está visible la
  oculta, si no, la reposiciona en bottom-right del monitor (margen 12px)
  y la muestra con foco.
- **Click derecho** → menú nativo de Windows con los items del spec:
  - Estado del servicio
  - Test de impresión
  - Reiniciar cola
  - —
  - Abrir bait-app.cl (vía `tauri-plugin-opener`)
  - Ver logs (TODO: wireup a la carpeta de logs del agente)
  - —
  - Salir del companion (`app.exit(0)`)
- **CloseRequested handler**: cuando el user clickea la X del header,
  ocultamos la window en vez de cerrar la app — el companion vive en el
  tray.

> "Ver logs" abre la carpeta `~/.bait-print-agent/logs/` vía
> `tauri-plugin-opener` (respeta `BAIT_AGENT_HOME` para dev local).
> Los otros items del menú (Estado / Test / Reiniciar cola) por ahora
> solo abren la ventana — falta wirear el deep-link al tab correcto
> (`app.emit("menu-action", id)` + listener en `App.tsx`).

## Icono placeholder

`scripts/generate-icons.mjs` genera 5 PNGs sin dependencias (zlib + crypto
built-in de Node) con un diseño placeholder: cuadrado navy con esquinas
redondeadas, borde sutil cyan al 50%, y la letra "b" en cyan dibujada
geométricamente. Salidas:

- `tray-icon.png` (32×32)
- `32x32.png` (32×32, bundle)
- `128x128.png` (128×128, bundle)
- `128x128@2x.png` (256×256, bundle retina)
- `icon.png` (512×512, source para tauri icon)

Cuando Carlos tenga el icono final, basta con reemplazar `icon.png` y
correr `npx tauri icon ./src-tauri/icons/icon.png` para regenerar todos
los tamaños incluyendo `.ico` (Windows) y `.icns` (macOS).

> Nota: en `tauri.conf.json` solo referenciamos los `.png` que existen.
> Cuando se generen `.ico` y `.icns` con `tauri icon`, agregarlos al
> array `bundle.icon`.

## Datos en vivo

Los hooks `useAgentStatus` y `useRecentJobs` (en `src/hooks/use-agent-status.ts`)
polean el HTTP server local del agente:

| Hook | Endpoint | Intervalo |
|------|----------|-----------|
| `useAgentStatus` | `GET /v1/status` | 5s |
| `useRecentJobs(20)` | `GET /v1/jobs/recent?limit=20` | 10s |

Ambos pausan automáticamente cuando la ventana está hidden (Page
Visibility API). Cuando vuelve visible, hacen un fetch inmediato sin
esperar al próximo tick.

La shape cruda del HTTP server NO es 1:1 con lo que muestra la UI — los
mappers de `src/lib/mappers.ts` traducen entre `AgentStatus`/`PrintJob`
del API y los view-models `AgentState`/`PrinterInfo`/`PrintJob` de la UI.

`src/lib/mock-data.ts` ya NO contiene datos hardcodeados: solo los tipos
que la UI consume. El archivo se mantiene para no romper imports y para
documentar la frontera entre API y view-model.

## TODOs pendientes

1. **`POST /v1/printers/:id/test`** — el server local hoy devuelve 501 con
   un `error: 'not_implemented'`. El companion lo detecta y muestra
   "Funcionalidad en desarrollo" en un toast warning. Para activarlo hay
   que agregar `job_type='test'` al enum de Supabase y un mecanismo de
   `forced_printer_id` (ver TODO en `src/local-api/handlers.ts` del repo padre).
2. **Counters históricos** — `/v1/status` hoy no devuelve `printed_today` /
   `failed_today`. La UI los muestra como "—". Habría que agregar un
   endpoint nuevo (`GET /v1/stats/today`) o calcularlos client-side a
   partir de `/v1/jobs/recent`.
3. **Nombre de `print_area` en jobs** — `/v1/jobs/recent` devuelve
   `print_area_id` pero no el nombre de la print_area. Lo dejamos como
   `printer_name: null` en el view-model. El server podría hacer un join
   con la tabla `print_areas` antes de devolver.
4. **Menu del tray → deep-link al tab** — los items "Estado", "Test", "Reiniciar
   cola" abren la ventana pero no enrutan al tab correcto. Falta wirear
   un evento Tauri (`app.emit("menu-action", id)`) y un listener en
   `App.tsx` que cambie el `defaultValue` del `<Tabs>`.
5. **Auto-start del companion** — agregar al `HKCU\...\Run` del instalador del
   agente.
6. **Refinar el icono del tray** — placeholder geométrico, pixel-fuera de
   foco a 16-32px.
7. **Empaquetado conjunto** — `bait-print-agent-setup.exe` debería instalar
   el companion como opcional.

## Verificado en este scaffold

- TypeCheck pasa (`npx tsc --noEmit`).
- Vite build pasa (1996 modules, gzip 127kb).
- App monta y renderiza los 3 tabs sin errores en consola.
- Toasts funcionan (test print, restart queue gatillan toast warning).
- Cambio de tab funciona.
- Job items se expanden mostrando items + nota + meta.
- Backdrop-filter glass aplica (verificado con preview_inspect).

## NO verificado (requiere Rust)

- `npm run tauri:dev` — Rust no está instalado en la máquina al momento
  del scaffold. Verificado con `npx tauri info`:
  - WebView2 OK, MSVC Build Tools 2019 OK.
  - rustc/cargo/rustup → no instalados.
  - **Acción para Carlos**: instalar Rust desde https://rustup.rs/
    (default toolchain `stable-x86_64-pc-windows-msvc`), luego desde la
    carpeta `companion/` correr `npm run tauri:dev`.

## Licencia

UNLICENSED · Property of Carlos Olivares · bAIt
