use tauri::{plugin::PluginApi, AppHandle, Runtime};

use super::Insets;

pub fn setup<R: Runtime>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, ()>,
) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

pub async fn secret_get<R: Runtime>(
    _app: AppHandle<R>,
    _id: String,
) -> Result<Option<String>, String> {
    Err("此平台尚未实现安全设备密钥存储。".into())
}

pub async fn secret_set<R: Runtime>(
    _app: AppHandle<R>,
    _id: String,
    _value: String,
) -> Result<(), String> {
    Err("此平台尚未实现安全设备密钥存储。".into())
}

pub async fn auth_status<R: Runtime>(_app: AppHandle<R>) -> Result<bool, String> {
    Ok(false)
}

pub async fn authenticate<R: Runtime>(_app: AppHandle<R>) -> Result<bool, String> {
    Ok(false)
}

pub async fn insets<R: Runtime>(_app: AppHandle<R>) -> Result<Insets, String> {
    Ok(Insets::default())
}

pub async fn set_appearance<R: Runtime>(_app: AppHandle<R>, _dark: bool) -> Result<(), String> {
    Ok(())
}
