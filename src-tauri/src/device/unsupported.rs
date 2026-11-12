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

pub async fn share_text<R: Runtime>(_app: AppHandle<R>, _text: String) -> Result<(), String> {
    Err("此平台不支持系统分享。".into())
}

pub async fn share_file<R: Runtime>(
    _app: AppHandle<R>,
    _name: String,
    _mime_type: String,
    _base64: String,
) -> Result<(), String> {
    Err("此平台不支持系统分享。".into())
}

pub async fn save_file<R: Runtime>(
    _app: AppHandle<R>,
    _name: String,
    _mime_type: String,
    _base64: String,
) -> Result<bool, String> {
    Err("此平台不支持导出文件。".into())
}
pub async fn schedule_todo<R: Runtime>(
    _app: AppHandle<R>,
    _id: String,
    _text: String,
    _remind_at: String,
    _repeat: String,
) -> Result<(), String> {
    Err("此平台不支持待办提醒。".into())
}
pub async fn cancel_todo<R: Runtime>(_app: AppHandle<R>, _id: String) -> Result<(), String> {
    Ok(())
}
