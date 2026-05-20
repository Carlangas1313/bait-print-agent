# bAIt Print Companion

Tray + ventana flotante para el agente `bait-print-agent`. Vive en la
sesión del usuario (no en Session 0 de Windows como el servicio) y le da
al cajero una UI premium para ver el estado del agente, los jobs recientes
y ejecutar acciones (test de impresión, reiniciar cola, etc.).

> **Estado:** scaffold V0 — todo el frontend renderiza con datos mock.
> El wireup al HTTP server local del agente (127.0.0.1:17891) está
> pendiente en `src/lib/api.ts` detrás del flag `USE_MOCKS`.

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

> Los handlers que dependen del HTTP server del agente (test print real,
> restart queue, ver logs) están dejados como `TODO` en `handle_menu_event`.
> Cuando el otro sub-agent termine el endpoint, se wireup-ean con un
> comando Tauri `#[tauri::command]` que hace el fetch a 127.0.0.1:17891.

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

## Mock data

Todo el JSON mock está en `src/lib/mock-data.ts`:

- `mockAgentState` — status online, 142 impresos hoy, 2 pendientes, 1 fallido
- `mockPrinters` — Cocina Principal (HP_OfficeJet, online, primary) +
  Barra (EPSON_TM-T20III, offline)
- `mockRecentJobs` — 10 jobs con mix de status: `printed` (5), `failed` (1),
  `printing` (1), `waiting_printer` (1), `pending` (1), `kitchen_cancel` (1)

El polling cada 4 seg en `App.tsx` simula refresh real. El último heartbeat
se actualiza a `now` en cada fetch para que el "hace X seg" sea siempre fresco.

## TODOs pendientes (wireup HTTP server)

Cuando el sub-agent del servicio termine el HTTP server local en
`127.0.0.1:17891`:

1. **`src/lib/api.ts`** — `USE_MOCKS = false` y verificar que los endpoints
   matcheen con la shape esperada (ver comentario en cabecera del archivo).
   Endpoints esperados:
   - `GET  /v1/state` → `AgentState`
   - `GET  /v1/printers` → `PrinterInfo[]`
   - `GET  /v1/jobs/recent?limit=20` → `PrintJob[]`
   - `POST /v1/test-print` `{ printer_id }` → `{ ok, job_id }`
   - `POST /v1/queue/restart` → `{ ok }`
   - `POST /v1/pairing/reset` → `{ ok }`
2. **CORS** — el HTTP server necesita aceptar requests desde
   `http://localhost:1420` (dev Vite) y desde `tauri://localhost` (release
   webview de Windows). Probablemente con un `Access-Control-Allow-Origin: *`
   alcanza ya que el server solo escucha en loopback.
3. **`src-tauri/src/lib.rs`** — los handlers de menú (`test-print`,
   `restart-queue`, `view-logs`) deberían no solo abrir la window sino
   también dispatchar un evento custom al frontend (vía `app.emit("menu-action", id)`)
   para que el frontend reaccione (ej: cambiar al tab "Acciones" y abrir
   el dropdown de la impresora).
4. **Heartbeat watchdog** — si `getState()` falla 3 veces seguidas, mostrar
   un toast destructive "Servicio caído" y cambiar el StatusDot a rojo.
5. **Auth** — el HTTP server local probablemente quiere un token de pairing
   leído de `%USERPROFILE%\.bait-print-agent\config.json`. Agregar un
   header `X-Companion-Token` en `lib/api.ts` con valor leído al boot vía
   un comando Tauri `#[tauri::command] read_pairing_token()`.
6. **Auto-start del companion** — agregar a `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
   un acceso al `.exe` instalado en `Program Files\bAIt Print Companion\`.
   Probablemente como una flag en el wizard del instalador del agente.
7. **Refinar el icono del tray** — el placeholder geométrico se ve bien
   en 128px pero a 16-32px del tray pierde definición. Reemplazar con
   un PNG hecho en Figma con anti-aliasing pixel-perfect.
8. **Empaquetado conjunto** — decidir si el companion se distribuye junto
   al agente (`bait-print-agent-setup.exe` instala ambos) o como un
   `.exe` separado. Lo más limpio es que el instalador del agente
   pregunte "¿instalar companion?" como opcional.

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
