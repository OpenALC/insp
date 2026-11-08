use std::{fs, path::PathBuf, sync::Mutex, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::models::{
    Attachment, LegacyAttachment, LegacyExport, LegacyNote, Note, NoteGroup, NoteSummary,
    NoteWrite, VaultCommitInput, VaultRecord, WorkspaceSnapshot,
};

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

fn legacy_note(row: &Row<'_>) -> rusqlite::Result<LegacyNote> {
    let content: String = row.get(11)?;
    Ok(LegacyNote {
        summary: summary(row)?,
        schema_version: row.get(10)?,
        content: serde_json::from_str(&content).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                11,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        deleted_at: row.get(12)?,
    })
}

fn ensure_legacy_writes_allowed(connection: &Connection) -> Result<(), String> {
    let header_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM vault_header WHERE id = 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if header_exists {
        Err("加密保险库已启用，拒绝写入旧明文存储。".into())
    } else {
        Ok(())
    }
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
            1 | 2 => {}
            _ => {
                return Err(format!("数据库版本 {version} 不受此版本应用支持，请升级应用。").into())
            }
        }
        if version < 2 {
            let transaction = connection.transaction()?;
            transaction.execute_batch(include_str!("../migrations/002_secure_vault.sql"))?;
            transaction.commit()?;
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

    pub fn vault_header(&self) -> Result<Option<String>, String> {
        self.connection
            .lock()
            .unwrap()
            .query_row("SELECT payload FROM vault_header WHERE id = 1", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn vault_list(&self) -> Result<Vec<VaultRecord>, String> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection
            .prepare(
                "SELECT id, CASE WHEN substr(id, 1, 11) = 'attachment:' THEN NULL ELSE payload END \
                 FROM secure_records ORDER BY id",
            )
            .map_err(|error| error.to_string())?;
        let records = statement
            .query_map([], |row| {
                Ok(VaultRecord {
                    id: row.get(0)?,
                    payload: row.get(1)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        Ok(records)
    }

    pub fn vault_get(&self, id: &str) -> Result<Option<String>, String> {
        self.connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT payload FROM secure_records WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn vault_commit(&self, input: VaultCommitInput) -> Result<(), String> {
        let mut connection = self.connection.lock().unwrap();
        if input.purge_legacy {
            connection
                .pragma_update(None, "secure_delete", true)
                .map_err(|error| error.to_string())?;
        }
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        if let Some(header) = input.header {
            transaction
                .execute(
                    "INSERT INTO vault_header (id, payload) VALUES (1, ?1) \
                     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
                    [header],
                )
                .map_err(|error| error.to_string())?;
        }
        for put in input.puts {
            transaction
                .execute(
                    "INSERT INTO secure_records (id, payload) VALUES (?1, ?2) \
                     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
                    params![put.id, put.payload],
                )
                .map_err(|error| error.to_string())?;
        }
        for id in input.deletes {
            transaction
                .execute("DELETE FROM secure_records WHERE id = ?1", [id])
                .map_err(|error| error.to_string())?;
        }

        if input.purge_legacy {
            let header_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM vault_header WHERE id = 1)",
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if !header_exists {
                return Err("清除旧数据前必须先持久化加密保险库头部。".into());
            }
            transaction
                .execute_batch("DELETE FROM notes; DELETE FROM groups; DELETE FROM attachments;")
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;

        if input.purge_legacy {
            let attachment_directory = self.directory.join("attachments");
            for entry in fs::read_dir(&attachment_directory).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                if entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_file()
                {
                    fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
                }
            }
            connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn vault_legacy_export(&self) -> Result<LegacyExport, String> {
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
            .prepare(&format!(
                "SELECT {NOTE_COLUMNS}, schema_version, content, deleted_at FROM notes ORDER BY updated_at DESC, id"
            ))
            .map_err(|error| error.to_string())?;
        let notes = statement
            .query_map([], legacy_note)
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;

        let mut statement = connection
            .prepare(
                "SELECT id, file_name, mime_type, original_name, byte_length FROM attachments ORDER BY id",
            )
            .map_err(|error| error.to_string())?;
        let stored_attachments = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;

        let attachments = stored_attachments
            .into_iter()
            .map(|(id, file_name, mime_type, original_name, byte_length)| {
                let bytes = fs::read(self.directory.join("attachments").join(file_name))
                    .map_err(|error| error.to_string())?;
                Ok(LegacyAttachment {
                    id,
                    mime_type,
                    original_name,
                    byte_length: usize::try_from(byte_length).map_err(|error| error.to_string())?,
                    data_base64: STANDARD.encode(bytes),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;

        Ok(LegacyExport {
            groups,
            notes,
            attachments,
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
        ensure_legacy_writes_allowed(&transaction)?;
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
        ensure_legacy_writes_allowed(&transaction)?;
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
        ensure_legacy_writes_allowed(&connection)?;
        connection.execute(
            "UPDATE notes SET deleted_at = ?1, updated_at = ?1, revision = revision + 1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now(), id],
        ).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn create_group(&self, name: &str) -> Result<NoteGroup, String> {
        let connection = self.connection.lock().unwrap();
        ensure_legacy_writes_allowed(&connection)?;
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
        ensure_legacy_writes_allowed(&connection)?;
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
        ensure_legacy_writes_allowed(&transaction)?;
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
        ensure_legacy_writes_allowed(&self.connection.lock().unwrap())?;
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
        ensure_legacy_writes_allowed(&transaction)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{NoteWrite, VaultPut};
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn legacy_storage() -> (TempDir, Storage) {
        let directory = tempfile::tempdir().unwrap();
        let connection = Connection::open(directory.path().join("notes.sqlite3")).unwrap();
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        connection
            .execute(
                "INSERT INTO groups (id, name, created_at, updated_at) VALUES ('group-1', '旧分组', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO notes (id, title, group_id, content, plain_text, created_at, updated_at) \
                 VALUES ('note-active', '活动笔记', 'group-1', '{\"type\":\"doc\"}', '内容', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO notes (id, title, group_id, content, plain_text, created_at, updated_at, deleted_at) \
                 VALUES ('note-deleted', '已删除笔记', 'group-1', '{\"type\":\"doc\"}', '已删除内容', '2024-01-02T00:00:00Z', '2024-01-03T00:00:00Z', '2024-01-03T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO attachments (id, file_name, mime_type, original_name, byte_length, created_at) \
                 VALUES ('image-1', 'image-1.png', 'image/png', '旧图片.png', 4, '2024-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        fs::create_dir_all(directory.path().join("attachments")).unwrap();
        fs::write(
            directory.path().join("attachments/image-1.png"),
            [0, 1, 2, 255],
        )
        .unwrap();
        drop(connection);
        let storage = Storage::open(directory.path().to_path_buf()).unwrap();
        (directory, storage)
    }

    #[test]
    fn legacy_export_and_encrypted_purge_preserve_migration_contract() {
        let (_directory, storage) = legacy_storage();
        let export = storage.vault_legacy_export().unwrap();
        assert_eq!(export.groups.len(), 1);
        assert_eq!(export.notes.len(), 2);
        assert_eq!(
            export
                .notes
                .iter()
                .find(|note| note.summary.id == "note-deleted")
                .unwrap()
                .deleted_at
                .as_deref(),
            Some("2024-01-03T00:00:00Z")
        );
        assert_eq!(export.attachments.len(), 1);
        assert_eq!(
            STANDARD.decode(&export.attachments[0].data_base64).unwrap(),
            [0, 1, 2, 255]
        );

        storage
            .vault_commit(VaultCommitInput {
                header: Some("opaque-header".into()),
                puts: vec![
                    VaultPut {
                        id: "note:note-active".into(),
                        payload: "opaque-note".into(),
                    },
                    VaultPut {
                        id: "attachment:image-1".into(),
                        payload: "opaque-image".into(),
                    },
                ],
                deletes: vec![],
                purge_legacy: true,
            })
            .unwrap();

        assert_eq!(
            storage.vault_header().unwrap().as_deref(),
            Some("opaque-header")
        );
        let records = storage.vault_list().unwrap();
        let image = records
            .iter()
            .find(|record| record.id == "attachment:image-1")
            .unwrap();
        assert_eq!(image.payload, None);
        assert_eq!(
            storage.vault_get("attachment:image-1").unwrap().as_deref(),
            Some("opaque-image")
        );
        assert_eq!(
            storage.vault_get("note:note-active").unwrap().as_deref(),
            Some("opaque-note")
        );
        let after_purge = storage.vault_legacy_export().unwrap();
        assert!(after_purge.groups.is_empty());
        assert!(after_purge.notes.is_empty());
        assert!(after_purge.attachments.is_empty());
        assert!(!storage.directory.join("attachments/image-1.png").exists());

        assert!(storage.create_note(None, "richtext").is_err());
        assert!(storage
            .save_note(NoteWrite {
                id: "note-active".into(),
                title: "title".into(),
                group_id: None,
                content: serde_json::json!({}),
                plain_text: "body".into(),
            })
            .is_err());
        assert!(storage.delete_note("note-active").is_err());
        assert!(storage.create_group("group").is_err());
        assert!(storage.rename_group("group-1", "new name").is_err());
        assert!(storage.delete_group("group-1").is_err());
        assert!(storage.import_image("blocked.png".into(), vec![]).is_err());
    }

    #[test]
    fn failed_vault_write_keeps_legacy_rows_and_attachment_files() {
        let (_directory, storage) = legacy_storage();
        storage
            .connection
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_secure_record BEFORE INSERT ON secure_records \
                 BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END;",
            )
            .unwrap();

        let result = storage.vault_commit(VaultCommitInput {
            header: Some("opaque-header".into()),
            puts: vec![VaultPut {
                id: "note:note-active".into(),
                payload: "opaque-note".into(),
            }],
            deletes: vec![],
            purge_legacy: true,
        });
        assert!(result.is_err());
        assert_eq!(storage.vault_header().unwrap(), None);
        let export = storage.vault_legacy_export().unwrap();
        assert_eq!(export.groups.len(), 1);
        assert_eq!(export.notes.len(), 2);
        assert_eq!(export.attachments.len(), 1);
        assert!(storage.directory.join("attachments/image-1.png").exists());
    }
}
