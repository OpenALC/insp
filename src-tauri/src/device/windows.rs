use std::{path::PathBuf, ptr, sync::Arc, sync::Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{plugin::PluginApi, AppHandle, Manager, Runtime};
use windows::{
    core::{factory, HSTRING},
    Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    },
    Win32::System::WinRT::IUserConsentVerifierInterop,
};
use windows_future::IAsyncOperation;
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
};

use super::Insets;

struct Secrets(Mutex<Connection>);

impl Secrets {
    fn open(directory: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(&directory)?;
        let connection = Connection::open(directory.join("device-secrets.sqlite3"))?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS device_secrets (
                id TEXT PRIMARY KEY NOT NULL,
                ciphertext BLOB NOT NULL
            );",
        )?;
        Ok(Self(Mutex::new(connection)))
    }

    fn get(&self, id: &str) -> Result<Option<String>, String> {
        let ciphertext: Option<Vec<u8>> = self
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .query_row(
                "SELECT ciphertext FROM device_secrets WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        ciphertext
            .map(|bytes| {
                String::from_utf8(crypt(&bytes, id, false)?)
                    .map_err(|_| "设备密钥不是有效 UTF-8。".to_string())
            })
            .transpose()
    }

    fn set(&self, id: &str, value: &str) -> Result<(), String> {
        let ciphertext = crypt(value.as_bytes(), id, true)?;
        self.0
            .lock()
            .map_err(|error| error.to_string())?
            .execute(
                "INSERT INTO device_secrets (id, ciphertext) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext",
                params![id, ciphertext],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

// DPAPI entropy binds each encrypted value to its app namespace and id.
fn crypt(input: &[u8], id: &str, encrypt: bool) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: input.len().try_into().map_err(|_| "设备密钥过长。")?,
        pbData: input.as_ptr().cast_mut(),
    };
    let entropy_bytes = format!("com.insp.notes/device-secret/v1/{id}");
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy_bytes
            .len()
            .try_into()
            .map_err(|_| "设备密钥标识过长。")?,
        pbData: entropy_bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    // Input/entropy live through the call. DPAPI owns output until LocalFree below.
    let success = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err(format!(
            "DPAPI 操作失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    let bytes = if output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec()
    };
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(bytes)
}

pub fn setup<R: Runtime>(
    app: &AppHandle<R>,
    _api: PluginApi<R, ()>,
) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(Arc::new(Secrets::open(app.path().app_local_data_dir()?)?));
    Ok(())
}

pub async fn secret_get<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Option<String>, String> {
    let secrets = app.state::<Arc<Secrets>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || secrets.get(&id))
        .await
        .map_err(|error| error.to_string())?
}

pub async fn secret_set<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    value: String,
) -> Result<(), String> {
    let secrets = app.state::<Arc<Secrets>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || secrets.set(&id, &value))
        .await
        .map_err(|error| error.to_string())?
}

pub async fn auth_status<R: Runtime>(_app: AppHandle<R>) -> Result<bool, String> {
    let availability = UserConsentVerifier::CheckAvailabilityAsync()
        .map_err(|error| error.to_string())?
        .await
        .map_err(|error| error.to_string())?;
    Ok(availability == UserConsentVerifierAvailability::Available)
}

pub async fn authenticate<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let hwnd = app
        .get_webview_window("main")
        .ok_or("找不到主窗口。")?
        .hwnd()
        .map_err(|error| error.to_string())?;
    let request: IAsyncOperation<UserConsentVerificationResult> = {
        let verifier = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
            .map_err(|error| error.to_string())?;
        unsafe {
            verifier
                .RequestVerificationForWindowAsync(hwnd, &HSTRING::from("验证身份以查看隐私笔记"))
        }
        .map_err(|error| error.to_string())?
    };
    Ok(
        request.await.map_err(|error| error.to_string())?
            == UserConsentVerificationResult::Verified,
    )
}

pub async fn insets<R: Runtime>(_app: AppHandle<R>) -> Result<Insets, String> {
    Ok(Insets::default())
}

pub async fn set_appearance<R: Runtime>(_app: AppHandle<R>, _dark: bool) -> Result<(), String> {
    Ok(())
}

pub async fn share_text<R: Runtime>(_app: AppHandle<R>, _text: String) -> Result<(), String> {
    Err("Windows 使用网页系统分享接口。".into())
}

pub async fn share_file<R: Runtime>(
    _app: AppHandle<R>,
    _name: String,
    _mime_type: String,
    _base64: String,
) -> Result<(), String> {
    Err("Windows 使用网页系统分享接口。".into())
}

pub async fn save_file<R: Runtime>(
    _app: AppHandle<R>,
    _name: String,
    _mime_type: String,
    _base64: String,
) -> Result<bool, String> {
    Err("Windows 使用系统文件选择器。".into())
}
pub async fn schedule_todo<R: Runtime>(
    _app: AppHandle<R>,
    _id: String,
    _text: String,
    _remind_at: String,
    _repeat: String,
) -> Result<(), String> {
    Ok(())
}
pub async fn cancel_todo<R: Runtime>(_app: AppHandle<R>, _id: String) -> Result<(), String> {
    Ok(())
}
