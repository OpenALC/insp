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
