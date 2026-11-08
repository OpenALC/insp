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
