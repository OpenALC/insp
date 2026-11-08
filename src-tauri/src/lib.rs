mod models;
mod storage;

use models::{Attachment, Note, NoteGroup, NoteWrite, WorkspaceSnapshot};
use std::sync::Arc;
use storage::Storage;
use tauri::{Manager, State};

async fn storage_task<T: Send + 'static>(
    storage: State<'_, Arc<Storage>>,
    work: impl FnOnce(&Storage) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let storage = Arc::clone(storage.inner());
    tauri::async_runtime::spawn_blocking(move || work(&storage))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn load_workspace(storage: State<'_, Arc<Storage>>) -> Result<WorkspaceSnapshot, String> {
    storage_task(storage, Storage::load_workspace).await
}

#[tauri::command]
async fn get_note(storage: State<'_, Arc<Storage>>, id: String) -> Result<Note, String> {
    storage_task(storage, move |db| db.get_note(&id)).await
}

#[tauri::command]
async fn create_note(
    storage: State<'_, Arc<Storage>>,
    group_id: Option<String>,
    kind: Option<String>,
) -> Result<Note, String> {
    storage_task(storage, move |db| {
        db.create_note(group_id, kind.as_deref().unwrap_or("richtext"))
    })
    .await
}

#[tauri::command]
async fn save_note(storage: State<'_, Arc<Storage>>, input: NoteWrite) -> Result<Note, String> {
    storage_task(storage, move |db| db.save_note(input)).await
}

#[tauri::command]
async fn delete_note(storage: State<'_, Arc<Storage>>, id: String) -> Result<(), String> {
    storage_task(storage, move |db| db.delete_note(&id)).await
}

#[tauri::command]
async fn create_group(storage: State<'_, Arc<Storage>>, name: String) -> Result<NoteGroup, String> {
    storage_task(storage, move |db| db.create_group(&name)).await
}

#[tauri::command]
async fn rename_group(
    storage: State<'_, Arc<Storage>>,
    id: String,
    name: String,
) -> Result<NoteGroup, String> {
    storage_task(storage, move |db| db.rename_group(&id, &name)).await
}

#[tauri::command]
async fn delete_group(storage: State<'_, Arc<Storage>>, id: String) -> Result<(), String> {
    storage_task(storage, move |db| db.delete_group(&id)).await
}

#[tauri::command]
async fn import_image(
    storage: State<'_, Arc<Storage>>,
    original_name: String,
    bytes: Vec<u8>,
) -> Result<Attachment, String> {
    storage_task(storage, move |db| db.import_image(original_name, bytes)).await
}

#[tauri::command]
async fn import_image_bytes(
    storage: State<'_, Arc<Storage>>,
    request: tauri::ipc::Request<'_>,
) -> Result<Attachment, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("图片传输需要二进制内容。".into());
    };
    let name = request
        .headers()
        .get("x-file-name")
        .ok_or("图片名称缺失。")?
        .to_str()
        .map_err(|error| error.to_string())?;
    let original_name = percent_encoding::percent_decode_str(name)
        .decode_utf8()
        .map_err(|error| error.to_string())?
        .into_owned();
    let bytes = bytes.clone();
    storage_task(storage, move |db| db.import_image(original_name, bytes)).await
}

#[tauri::command]
async fn resolve_image(storage: State<'_, Arc<Storage>>, id: String) -> Result<String, String> {
    storage_task(storage, move |db| db.resolve_image(&id)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    }));
    builder
        .setup(|app| {
            app.manage(Arc::new(Storage::open(app.path().app_data_dir()?)?));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            get_note,
            create_note,
            save_note,
            delete_note,
            create_group,
            rename_group,
            delete_group,
            import_image,
            import_image_bytes,
            resolve_image,
        ])
        .run(tauri::generate_context!())
        .expect("无法启动拾页");
}
