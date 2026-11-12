use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, plugin::PluginHandle, AppHandle, Manager, Runtime};

use super::Insets;

struct Device<R: Runtime>(PluginHandle<R>);

pub fn setup<R: Runtime>(
    app: &AppHandle<R>,
    api: PluginApi<R, ()>,
) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(Device(
        api.register_android_plugin("com.insp.notes", "DevicePlugin")?,
    ));
    Ok(())
}

async fn call<R: Runtime, T: DeserializeOwned>(
    app: AppHandle<R>,
    command: &str,
    args: serde_json::Value,
) -> Result<T, String> {
    app.state::<Device<R>>()
        .0
        .run_mobile_plugin_async(command, args)
        .await
        .map_err(|error| error.to_string())
}

pub async fn secret_get<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Option<String>, String> {
    call(app, "secretGet", serde_json::json!({ "id": id })).await
}

pub async fn secret_set<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    value: String,
) -> Result<(), String> {
    call(
        app,
        "secretSet",
        serde_json::json!({ "id": id, "value": value }),
    )
    .await
}

pub async fn auth_status<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    call(app, "authStatus", serde_json::json!({})).await
}

pub async fn authenticate<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    call(app, "authenticate", serde_json::json!({})).await
}

pub async fn insets<R: Runtime>(app: AppHandle<R>) -> Result<Insets, String> {
    call(app, "insets", serde_json::json!({})).await
}

pub async fn set_appearance<R: Runtime>(app: AppHandle<R>, dark: bool) -> Result<(), String> {
    call(app, "setAppearance", serde_json::json!({ "dark": dark })).await
}

pub async fn share_text<R: Runtime>(app: AppHandle<R>, text: String) -> Result<(), String> {
    call(app, "shareText", serde_json::json!({ "text": text })).await
}

pub async fn share_file<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    mime_type: String,
    base64: String,
) -> Result<(), String> {
    call(
        app,
        "shareFile",
        serde_json::json!({ "name": name, "mimeType": mime_type, "base64": base64 }),
    )
    .await
}

pub async fn save_file<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    mime_type: String,
    base64: String,
) -> Result<bool, String> {
    call(
        app,
        "saveFile",
        serde_json::json!({ "name": name, "mimeType": mime_type, "base64": base64 }),
    )
    .await
}

pub async fn schedule_todo<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    text: String,
    remind_at: String,
    repeat: String,
) -> Result<(), String> {
    call(
        app,
        "scheduleTodo",
        serde_json::json!({ "id": id, "text": text, "remindAt": remind_at, "repeat": repeat }),
    )
    .await
}

pub async fn cancel_todo<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    call(app, "cancelTodo", serde_json::json!({ "id": id })).await
}
