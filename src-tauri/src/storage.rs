use std::{fs, path::PathBuf, sync::Mutex, time::Duration};

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, Row};
use uuid::Uuid;

use crate::models::{Attachment, Note, NoteGroup, NoteSummary, NoteWrite, WorkspaceSnapshot};

pub struct Storage {
    connection: Mutex<Connection>,
    directory: PathBuf,
}

const NOTE_COLUMNS: &str =
    "id, title, group_id, kind, privacy, sync_policy, preview, created_at, updated_at, revision";

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn summary(row: &Row<'_>) -> rusqlite::Result<NoteSummary> {
    Ok(NoteSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        group_id: row.get(2)?,
        kind: row.get(3)?,
        privacy: row.get(4)?,
        sync_policy: row.get(5)?,
        preview: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        revision: row.get(9)?,
    })
}

fn group(row: &Row<'_>) -> rusqlite::Result<NoteGroup> {
    Ok(NoteGroup {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn read_note(connection: &Connection, id: &str) -> Result<Note, String> {
    let (summary, schema_version, content): (NoteSummary, i64, String) = connection
        .query_row(
            &format!("SELECT {NOTE_COLUMNS}, schema_version, content FROM notes WHERE id = ?1 AND deleted_at IS NULL"),
            [id],
            |row| Ok((summary(row)?, row.get(10)?, row.get(11)?)),
        )
        .map_err(|error| error.to_string())?;
    Ok(Note {
        summary,
        schema_version,
        content: serde_json::from_str(&content).map_err(|error| error.to_string())?,
    })
}

fn read_group(connection: &Connection, id: &str) -> Result<NoteGroup, String> {
    connection
        .query_row(
            "SELECT id, name, parent_id, created_at, updated_at FROM groups WHERE id = ?1",
            [id],
            group,
        )
        .map_err(|error| error.to_string())
}

impl Storage {
    pub fn open(directory: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        fs::create_dir_all(directory.join("attachments"))?;
        let mut connection = Connection::open(directory.join("notes.sqlite3"))?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
        )?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        match version {
            0 => {
                let transaction = connection.transaction()?;
                transaction.execute_batch(include_str!("../migrations/001_initial.sql"))?;
                transaction.commit()?;
            }
            1 => {}
            _ => {
                return Err(
                    format!("数据库版本 {version} 高于此版本应用支持的版本，请升级应用。").into(),
                )
            }
        }
        Ok(Self {
            connection: Mutex::new(connection),
            directory,
        })
    }

    pub fn load_workspace(&self) -> Result<WorkspaceSnapshot, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection
            .prepare("SELECT id, name, parent_id, created_at, updated_at FROM groups ORDER BY created_at, id")
            .map_err(|error| error.to_string())?;
        let groups = statement
            .query_map([], group)
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(&format!("SELECT {NOTE_COLUMNS} FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC, id"))
            .map_err(|error| error.to_string())?;
        let notes = statement
            .query_map([], summary)
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        Ok(WorkspaceSnapshot {
            groups,
            notes,
            data_directory: self.directory.to_string_lossy().into_owned(),
        })
    }

    pub fn get_note(&self, id: &str) -> Result<Note, String> {
        read_note(&self.connection.lock().unwrap(), id)
    }

    pub fn create_note(&self, group_id: Option<String>, kind: &str) -> Result<Note, String> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let id = Uuid::new_v4().to_string();
        let timestamp = now();
        let (title, content, preview) = match kind {
            "richtext" => (
                "未命名笔记",
                serde_json::json!({"type":"doc","content":[{"type":"paragraph"}]}),
                "",
            ),
            "mindmap" => (
                "未命名导图",
                serde_json::json!({"type":"mindmap","root":{"id":Uuid::new_v4().to_string(),"text":"中心主题","children":[]}}),
                "中心主题",
            ),
            _ => return Err("不支持的笔记类型。".into()),
        };
        transaction.execute(
            "INSERT INTO notes (id, title, group_id, kind, content, preview, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, title, group_id, kind, content.to_string(), preview, timestamp],
        ).map_err(|error| error.to_string())?;
        let note = read_note(&transaction, &id)?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(note)
    }

    pub fn save_note(&self, input: NoteWrite) -> Result<Note, String> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let title = input.title.trim();
        let title = if title.is_empty() {
            "未命名笔记"
        } else {
            title
        };
        let preview = input
            .plain_text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(180)
            .collect::<String>();
        let changed = transaction.execute(
            "UPDATE notes SET title = ?1, group_id = ?2, content = ?3, plain_text = ?4, preview = ?5, updated_at = ?6, revision = revision + 1 WHERE id = ?7 AND deleted_at IS NULL",
            params![title, input.group_id, input.content.to_string(), input.plain_text, preview, now(), input.id],
        ).map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("这篇笔记已被删除，未覆盖本地内容。".into());
        }
        let note = read_note(&transaction, &input.id)?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(note)
    }

    pub fn delete_note(&self, id: &str) -> Result<(), String> {
        let connection = self.connection.lock().unwrap();
        connection.execute(
            "UPDATE notes SET deleted_at = ?1, updated_at = ?1, revision = revision + 1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now(), id],
        ).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn create_group(&self, name: &str) -> Result<NoteGroup, String> {
        let connection = self.connection.lock().unwrap();
        let id = Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO groups (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                params![id, name.trim(), now()],
            )
            .map_err(|error| error.to_string())?;
        read_group(&connection, &id)
    }

    pub fn rename_group(&self, id: &str, name: &str) -> Result<NoteGroup, String> {
        let connection = self.connection.lock().unwrap();
        connection
            .execute(
                "UPDATE groups SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![name.trim(), now(), id],
            )
            .map_err(|error| error.to_string())?;
        read_group(&connection, id)
    }

    pub fn delete_group(&self, id: &str) -> Result<(), String> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction.execute(
            "UPDATE notes SET group_id = NULL, updated_at = ?1, revision = revision + 1 WHERE group_id = ?2",
            params![now(), id],
        ).map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM groups WHERE id = ?1", [id])
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn import_image(
        &self,
        original_name: String,
        bytes: Vec<u8>,
    ) -> Result<Attachment, String> {
        // File bytes cross the WebView boundary; bound resource use and reject active formats such as SVG.
        if bytes.len() > 20 * 1024 * 1024 {
            return Err("图片不能超过 20 MB。".into());
        }
        let kind = infer::get(&bytes).ok_or("无法识别图片格式。")?;
        let extension = match kind.mime_type() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => return Err("请选择 PNG、JPEG、GIF 或 WebP 图片。".into()),
        };
        let attachment = Attachment {
            id: Uuid::new_v4().to_string(),
            mime_type: kind.mime_type().into(),
            original_name,
            byte_length: bytes.len(),
        };
        let file_name = format!("{}.{}", attachment.id, extension);
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO attachments (id, file_name, mime_type, original_name, byte_length, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![attachment.id, file_name, attachment.mime_type, attachment.original_name, attachment.byte_length as i64, now()],
        ).map_err(|error| error.to_string())?;
        fs::write(self.directory.join("attachments").join(file_name), bytes)
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(attachment)
    }

    pub fn resolve_image(&self, id: &str) -> Result<String, String> {
        let connection = self.connection.lock().unwrap();
        let file_name: String = connection
            .query_row(
                "SELECT file_name FROM attachments WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        Ok(self
            .directory
            .join("attachments")
            .join(file_name)
            .to_string_lossy()
            .into_owned())
    }
}
