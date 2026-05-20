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

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, LogicalPosition, LogicalSize, Manager, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon.png");

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
            // TODO: cuando wireup HTTP server, abrir %USERPROFILE%\.bait-print-agent\logs\
            log::info!("[menu] view-logs — pendiente wireup");
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
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
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle());
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
            // la window (el companion vive en el tray).
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error mientras corría bait-print-companion");
}
