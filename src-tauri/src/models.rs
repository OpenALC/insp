use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteGroup {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub group_id: Option<String>,
    pub kind: String,
    pub privacy: String,
    pub sync_policy: String,
    pub preview: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    #[serde(flatten)]
    pub summary: NoteSummary,
    pub schema_version: i64,
    pub content: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyNote {
    #[serde(flatten)]
    pub summary: NoteSummary,
    pub schema_version: i64,
    pub content: Value,
    pub deleted_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteWrite {
    pub id: String,
    pub title: String,
    pub group_id: Option<String>,
    pub content: Value,
    pub plain_text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub groups: Vec<NoteGroup>,
    pub notes: Vec<NoteSummary>,
    pub data_directory: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub mime_type: String,
    pub original_name: String,
    pub byte_length: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyAttachment {
    pub id: String,
    pub mime_type: String,
    pub original_name: String,
    pub byte_length: usize,
    pub data_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyExport {
    pub groups: Vec<NoteGroup>,
    pub notes: Vec<LegacyNote>,
    pub attachments: Vec<LegacyAttachment>,
    pub data_directory: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultRecord {
    pub id: String,
    pub payload: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultPut {
    pub id: String,
    pub payload: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultCommitInput {
    pub header: Option<String>,
    pub puts: Vec<VaultPut>,
    pub deletes: Vec<String>,
    #[serde(default)]
    pub purge_legacy: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHttpInput {
    pub url: String,
    pub method: String,
    pub token: String,
    pub body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHttpResponse {
    pub status: u16,
    pub body: String,
}
