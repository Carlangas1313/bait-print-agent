// bAIt Print Companion — entry point (Tauri 2)
//
// Crea el tray icon, el menú nativo de Windows y maneja el toggle de la
// ventana flotante. El frontend (React + Vite) vive en ../src.
//
// Layout del menu (click derecho):
//   - Estado del servicio
//   - Test de impresión
//   - Reiniciar cola
//   ----------
//   - Abrir bait-app.cl
//   - Ver logs
//   ----------
//   - Salir del companion
//
// Click izquierdo en el icono: toggle show/hide de la window principal.

use std::path::PathBuf;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon.png");

// ---------- Agent home helpers ----------

/// Resuelve la carpeta `~/.bait-print-agent/` (donde vive config.json + logs/).
///
/// Respeta el env var `BAIT_AGENT_HOME`: si esta seteado lo usamos tal cual,
/// sin appendear `.bait-print-agent`. Util para dev local sin tocar la config
/// real del cliente (ej: BAIT_AGENT_HOME=C:\dev\.bait-print-agent-dev).
///
/// En produccion (sin override), construimos `<home>/.bait-print-agent` con
/// `dirs::home_dir()` para portabilidad cross-platform.
fn resolve_agent_home() -> Result<PathBuf, String> {
    if let Ok(override_path) = std::env::var("BAIT_AGENT_HOME") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let home = dirs::home_dir()
        .ok_or_else(|| "No pude resolver el directorio HOME del usuario.".to_string())?;
    Ok(home.join(".bait-print-agent"))
}

// ---------- Tauri commands ----------

/// Abre la carpeta de logs del agente con el explorador del sistema.
///
/// Idem que el item "Ver logs" del tray, pero invocable desde el
/// frontend (Tab "Acciones"). Centralizamos la logica aca para que la
/// resolucion de `BAIT_AGENT_HOME` viva solo en un lugar.
#[tauri::command]
fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    let home = resolve_agent_home()?;
    let logs = home.join("logs");
    // Si la carpeta de logs aun no existe (primera instalacion), abrimos
    // el folder padre para que el user al menos vea donde deberia estar todo.
    let target = if logs.exists() { logs } else { home };
    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("No pude abrir la carpeta de logs: {e}"))
}

/// Lee `<agent_home>/config.json` y devuelve el `local_api_token` que el
/// frontend usa como Bearer auth contra el HTTP server local del agente.
///
/// Errores user-friendly:
///  - Archivo no existe → "Servicio no configurado todavia..."
///  - JSON corrupto → "config.json corrupto..."
///  - Falta el campo `local_api_token` → "Servicio antiguo sin local API..."
///
/// El token es cacheado en JS-side (modulo state) — este comando se invoca
/// una sola vez al primer fetch, o cuando el cache se invalida por 401.
#[tauri::command]
fn read_local_api_token() -> Result<String, String> {
    let home = resolve_agent_home()?;
    let config_path = home.join("config.json");

    if !config_path.exists() {
        return Err(
            "Servicio no configurado todavia. Corre el wizard de setup primero.".to_string(),
        );
    }

    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("No pude leer config.json: {e}"))?;

    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| "config.json corrupto".to_string())?;

    let token = parsed
        .get("local_api_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            "Servicio antiguo sin local API. Actualiza el agente a v0.5.5+".to_string()
        })?;

    if token.trim().is_empty() {
        return Err("Servicio antiguo sin local API. Actualiza el agente a v0.5.5+".to_string());
    }

    Ok(token.to_string())
}

/// Descarga el setup.exe a `%TEMP%` y lo ejecuta con UAC elevation.
///
/// Estrategia: spawneamos un script PowerShell que hace:
///   1. Invoke-WebRequest del download_url al temp.
///   2. Start-Process -Verb RunAs del .exe descargado.
///
/// `-Verb RunAs` dispara el popup de UAC de Windows en la sesion del
/// usuario. Si el user aprueba, el setup.exe arranca como admin y el
/// wizard se ve normal. Si rechaza, el spawn termina con error 1223
/// (operacion cancelada por el user) y se lo devolvemos al frontend.
///
/// IMPORTANTE: este comando NO espera a que el setup termine. Una vez
/// que el setup arranque, su anti-zombie (Pascal CurStepChanged) va a
/// hacer taskkill del companion. Asi que el companion va a morir poco
/// despues que esta llamada retorne. El frontend muestra un toast
/// "Lanzando instalador..." antes para que el user entienda lo que pasa.
#[tauri::command]
async fn install_update(download_url: String) -> Result<String, String> {
    use std::process::Command;

    if !download_url.starts_with("https://github.com/") {
        return Err(format!(
            "URL de descarga rechazada por seguridad (no es github.com): {download_url}"
        ));
    }

    // Path del archivo descargado. Nombre fijo para que el script PS no
    // necesite interpolar variables del Rust side. El instalador anterior
    // (si existe) se sobrescribe sin problema.
    let temp_dir = std::env::temp_dir();
    let installer_path = temp_dir.join("bait-print-agent-setup-update.exe");
    let installer_path_str = installer_path.to_string_lossy().to_string();

    // Script PowerShell: descarga + lanza con RunAs y el flag /COMPANIONUPDATE.
    // Ese flag le dice al wizard del .iss "este es un upgrade via companion,
    // saltea las paginas que el companion ya sabe" (Welcome, SelectDir,
    // SkipPairingCheck, PairingPage). Si el user en cambio descarga el setup
    // manual de GitHub y lo corre, no hay flag y el wizard se muestra
    // completo — permite re-pairing, cambiar dir, etc.
    //
    // `$ErrorActionPreference='Stop'` hace que cualquier fallo (red caida, 404,
    // etc.) tire excepcion y deje stderr legible.
    let ps_script = format!(
        "$ErrorActionPreference='Stop'; \
         $ProgressPreference='SilentlyContinue'; \
         Invoke-WebRequest -Uri '{}' -OutFile '{}' -UseBasicParsing; \
         Start-Process -Verb RunAs -FilePath '{}' -ArgumentList '/COMPANIONUPDATE'",
        download_url, installer_path_str, installer_path_str
    );

    log::info!("[updater] Descargando + lanzando instalador desde {download_url}");

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps_script,
        ])
        .output()
        .map_err(|e| format!("No pude lanzar PowerShell: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        log::error!("[updater] PowerShell exit {:?}: {}", output.status.code(), stderr);

        // Exit code 1223 (0x4C7) = ERROR_CANCELLED = el user clickeo "No"
        // en el popup de UAC. Le damos un mensaje user-friendly.
        if stderr.contains("1223") || stdout.contains("1223") {
            return Err("Cancelaste el popup de Windows. Volve a clickear si querias actualizar.".to_string());
        }
        return Err(format!(
            "Fallo al descargar o lanzar el instalador: {}",
            if stderr.trim().is_empty() { &stdout } else { &stderr }
                .trim()
                .chars()
                .take(300)
                .collect::<String>()
        ));
    }

    log::info!("[updater] Instalador lanzado OK desde {installer_path_str}");
    Ok(installer_path_str)
}

// ---------- Window helpers ----------

/// Reposiciona la ventana cerca del tray (bottom-right del monitor con
/// margen 12px). Calcula sobre el monitor donde está el cursor (típicamente
/// el primario en Windows con tray en la bottom-right).
fn position_window_near_tray(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    // Monitor donde está el cursor — fallback a primary
    let monitor = window
        .current_monitor()?
        .or(window.primary_monitor()?)
        .ok_or_else(|| tauri::Error::AssetNotFound("no monitor".into()))?;

    let monitor_size = monitor.size();
    let scale = monitor.scale_factor();
    let monitor_pos = monitor.position();

    // Tamaño de la window en pixeles físicos
    let win_size = window.outer_size()?;

    // Margen 12px (lógico → físico)
    let margin_px = (12.0_f64 * scale).round() as i32;

    let x_physical = monitor_pos.x + monitor_size.width as i32
        - win_size.width as i32
        - margin_px;
    let y_physical = monitor_pos.y + monitor_size.height as i32
        - win_size.height as i32
        - margin_px;

    window.set_position(tauri::PhysicalPosition::new(x_physical, y_physical))?;
    Ok(())
}

/// Muestra la ventana (posicionándola si estaba oculta) o la oculta si ya
/// estaba visible. Llamado por el click izquierdo en el tray icon.
fn toggle_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("[tray] main window no encontrada en toggle");
        return;
    };

    match window.is_visible() {
        Ok(true) => {
            if let Err(e) = window.hide() {
                log::error!("[tray] hide error: {e}");
            }
        }
        Ok(false) => {
            if let Err(e) = position_window_near_tray(app) {
                log::warn!("[tray] position warn: {e}");
            }
            if let Err(e) = window.show() {
                log::error!("[tray] show error: {e}");
            }
            if let Err(e) = window.set_focus() {
                log::warn!("[tray] focus warn: {e}");
            }
        }
        Err(e) => log::error!("[tray] is_visible error: {e}"),
    }
}

/// Muestra y enfoca la ventana — sin toggle, para items de menú que abren
/// la ventana directamente.
fn show_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = position_window_near_tray(app);
    let _ = window.show();
    let _ = window.set_focus();
}

// ---------- Menu actions ----------

fn handle_menu_event(app: &AppHandle, event_id: &str) {
    log::info!("[menu] click → {event_id}");
    match event_id {
        "service-status" => {
            show_window(app);
            // TODO: deep-link al tab "Estado" cuando wireup HTTP server
        }
        "test-print" => {
            show_window(app);
            // TODO: deep-link al tab "Acciones" cuando wireup HTTP server
        }
        "restart-queue" => {
            show_window(app);
            // TODO: dispatch a la acción "restartQueue" cuando wireup HTTP server
        }
        "open-bait-app" => {
            if let Err(e) = app.opener().open_url("https://bait-app.cl", None::<&str>) {
                log::error!("[menu] open bait-app.cl error: {e}");
            }
        }
        "view-logs" => {
            if let Err(e) = open_logs_folder(app.clone()) {
                log::error!("[menu] view-logs fallo: {e}");
            }
        }
        "exit" => {
            log::info!("[menu] exit → cerrando companion");
            app.exit(0);
        }
        other => log::warn!("[menu] event id desconocido: {other}"),
    }
}

// ---------- Setup ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance: si el usuario lanza un 2do bait-print-companion.exe
        // (doble click en el shortcut, autostart + manual, etc), el callback de
        // abajo se ejecuta en la instancia que YA estaba viva. Le mostramos la
        // window al primero y dejamos que el 2do muera solo. Sin esto terminamos
        // con N icons en el tray.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log::info!("[single-instance] 2da instancia detectada, mostrando window de la 1ra");
            show_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            read_local_api_token,
            open_logs_folder,
            install_update
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // ---------- Menu nativo (context menu del tray) ----------
            let item_status =
                MenuItem::with_id(app, "service-status", "Estado del servicio", true, None::<&str>)?;
            let item_test =
                MenuItem::with_id(app, "test-print", "Test de impresión", true, None::<&str>)?;
            let item_restart =
                MenuItem::with_id(app, "restart-queue", "Reiniciar cola", true, None::<&str>)?;

            let sep1 = PredefinedMenuItem::separator(app)?;

            let item_open =
                MenuItem::with_id(app, "open-bait-app", "Abrir bait-app.cl", true, None::<&str>)?;
            let item_logs = MenuItem::with_id(app, "view-logs", "Ver logs", true, None::<&str>)?;

            let sep2 = PredefinedMenuItem::separator(app)?;

            let item_exit =
                MenuItem::with_id(app, "exit", "Salir del companion", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &item_status,
                    &item_test,
                    &item_restart,
                    &sep1,
                    &item_open,
                    &item_logs,
                    &sep2,
                    &item_exit,
                ],
            )?;

            // ---------- Tray icon ----------
            let icon = Image::from_bytes(TRAY_ICON_BYTES)?;
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .tooltip("bAIt Print Companion")
                .menu(&menu)
                .show_menu_on_left_click(false) // click izq → toggle window, no menú
                .on_menu_event(move |app, event| {
                    handle_menu_event(app, event.id.as_ref());
                })
                .on_tray_icon_event(move |tray, event| {
                    // Toggle window en click izquierdo (release/Up) y tambien
                    // en double-click. Algunas configs de Windows + Tauri 2
                    // entregan los eventos en orden raro (Down sin Up, o solo
                    // DoubleClick), asi que cubrimos ambos para que el icono
                    // siempre responda.
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            log::info!("[tray] click izquierdo (Up) → toggle window");
                            toggle_window(tray.app_handle());
                        }
                        TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        } => {
                            log::info!("[tray] double-click izquierdo → show window");
                            show_window(tray.app_handle());
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Posicionamos la ventana en bottom-right desde el primer arranque
            // (queda oculta hasta que clickeen el tray).
            let _ = position_window_near_tray(&handle);

            log::info!("[companion] setup completo — tray + window listos");
            Ok(())
        })
        .on_window_event(|window, event| {
            // En vez de cerrar la app cuando el user clickea la X, ocultamos
            // la window (el companion vive en el tray). Logueamos cada vez
            // que dispara para poder confirmar en el log que el handler corrio
            // (si el log NO aparece y la window se cerro, el bug es de Tauri).
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    log::info!("[window] CloseRequested en 'main' → hide() + prevent_close()");
                    if let Err(e) = window.hide() {
                        log::error!("[window] hide() fallo: {e}");
                    }
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error mientras corría bait-print-companion");
}
