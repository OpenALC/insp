use serde::{Deserialize, Serialize};
use tauri::{plugin::TauriPlugin, AppHandle, Runtime};

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
use android as platform;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;
#[cfg(not(any(windows, target_os = "android")))]
mod unsupported;
#[cfg(not(any(windows, target_os = "android")))]
use unsupported as platform;

#[derive(Default, Deserialize, Serialize)]
pub struct Insets {
    top: f64,
    bottom: f64,
    left: f64,
    right: f64,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("insp-device")
        .setup(|app, api| {
            platform::setup(app, api)?;
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn device_secret_get<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Option<String>, String> {
    platform::secret_get(app, id).await
}

#[tauri::command]
pub async fn device_secret_set<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    value: String,
) -> Result<(), String> {
    platform::secret_set(app, id, value).await
}

#[tauri::command]
pub async fn device_auth_status<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    platform::auth_status(app).await
}

#[tauri::command]
pub async fn device_authenticate<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    platform::authenticate(app).await
}

#[tauri::command]
pub async fn device_insets<R: Runtime>(app: AppHandle<R>) -> Result<Insets, String> {
    platform::insets(app).await
}

#[tauri::command]
pub async fn device_set_appearance<R: Runtime>(
    app: AppHandle<R>,
    dark: bool,
) -> Result<(), String> {
    platform::set_appearance(app, dark).await
}

#[tauri::command]
pub async fn device_share_text<R: Runtime>(app: AppHandle<R>, text: String) -> Result<(), String> {
    platform::share_text(app, text).await
}

#[tauri::command]
pub async fn device_share_file<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    mime_type: String,
    base64: String,
) -> Result<(), String> {
    platform::share_file(app, name, mime_type, base64).await
}

#[tauri::command]
pub async fn device_save_file<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    mime_type: String,
    base64: String,
) -> Result<bool, String> {
    platform::save_file(app, name, mime_type, base64).await
}
