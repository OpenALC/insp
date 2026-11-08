use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::Path as FilePath,
    sync::{Arc, Mutex},
    time::Duration,
};
use subtle::ConstantTimeEq;

pub struct Store(Mutex<Connection>);
#[derive(Debug)]
pub struct ApiError(StatusCode, &'static str);
type Result<T> = std::result::Result<T, ApiError>;
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
fn database_error(_: rusqlite::Error) -> ApiError {
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Database operation failed",
    )
}
fn bad_request(message: &'static str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    version: u8,
    algorithm: String,
    key_id: String,
    nonce: String,
    ciphertext: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mutation {
    operation_id: String,
    entity_id: String,
    entity_type: String,
    base_revision: i64,
    operation: String,
    payload: Option<Envelope>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    #[serde(flatten)]
    mutation: Mutation,
    revision: i64,
    sequence: i64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Accepted {
    operation_id: String,
    revision: i64,
    sequence: i64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    operation_id: String,
    current: Change,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct PushResult {
    accepted: Vec<Accepted>,
    conflicts: Vec<Conflict>,
}
#[derive(Deserialize)]
struct HeaderInput {
    header: Value,
}
#[derive(Deserialize)]
struct PushInput {
    mutations: Vec<Mutation>,
}
#[derive(Deserialize)]
struct Cursor {
    #[serde(default)]
    cursor: i64,
    #[serde(default = "page_size")]
    limit: usize,
}
fn page_size() -> usize {
    100
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    changes: Vec<Change>,
    next_cursor: i64,
    has_more: bool,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b':')
}
fn validate_mutation(space: &str, mutation: &Mutation) -> Result<()> {
    if !valid_id(&mutation.operation_id)
        || !valid_id(&mutation.entity_id)
        || mutation.base_revision < 0
    {
        return Err(bad_request("Invalid mutation identifier or revision"));
    }
    if !["note", "group", "attachment"].contains(&mutation.entity_type.as_str())
        || !mutation
            .entity_id
            .starts_with(&format!("{}:", mutation.entity_type))
    {
        return Err(bad_request("Invalid entity type"));
    }
    match (&*mutation.operation, &mutation.payload) {
        ("delete", None) => Ok(()),
        ("put", Some(payload))
            if payload.version == 1
                && payload.algorithm == "AES-256-GCM"
                && payload.key_id == space
                && payload.nonce.len() == 16
                && payload.ciphertext.len() >= 24
                && payload.ciphertext.len() <= 50 * 1024 * 1024
                && payload
                    .nonce
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
                && payload
                    .ciphertext
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=') =>
        {
            Ok(())
        }
        _ => Err(bad_request(
            "Expected an authenticated ciphertext envelope or a deletion",
        )),
    }
}
fn token(headers: &HeaderMap) -> Result<String> {
    let value = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "Bearer token required"))?;
    if value.len() < 32
        || value.len() > 512
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "Invalid token"));
    }
    Ok(value.to_string())
}
fn authenticate(connection: &Connection, id: &str, token: &str) -> Result<()> {
    let stored: Option<Vec<u8>> = connection
        .query_row("SELECT token_hash FROM spaces WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(database_error)?;
    let hash = Sha256::digest(token.as_bytes());
    match stored {
        Some(stored) if stored.as_slice().ct_eq(hash.as_slice()).unwrap_u8() == 1 => Ok(()),
        _ => Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "Invalid space credentials",
        )),
    }
}

impl Store {
    pub fn open(
        path: impl AsRef<FilePath>,
    ) -> std::result::Result<Self, Box<dyn std::error::Error>> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, token_hash BLOB NOT NULL, header TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS entities (space_id TEXT NOT NULL REFERENCES spaces(id), id TEXT NOT NULL, entity_type TEXT NOT NULL, revision INTEGER NOT NULL, sequence INTEGER NOT NULL, operation_id TEXT NOT NULL, base_revision INTEGER NOT NULL, operation TEXT NOT NULL, payload TEXT, PRIMARY KEY(space_id,id));
            CREATE INDEX IF NOT EXISTS entity_sequence ON entities(space_id,sequence);
            CREATE TABLE IF NOT EXISTS receipts (space_id TEXT NOT NULL REFERENCES spaces(id), operation_id TEXT NOT NULL, fingerprint BLOB NOT NULL, revision INTEGER NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(space_id,operation_id));")?;
        Ok(Self(Mutex::new(connection)))
    }

    fn create_space(&self, id: &str, token: &str, header: Value) -> Result<Value> {
        if !valid_id(id)
            || !header.is_object()
            || header.get("id").and_then(Value::as_str) != Some(id)
            || header.to_string().len() > 16 * 1024
        {
            return Err(bad_request("Invalid vault header"));
        }
        let mut connection = self.0.lock().unwrap();
        let transaction = connection.transaction().map_err(database_error)?;
        let existing: Option<String> = transaction
            .query_row("SELECT header FROM spaces WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(database_error)?;
        if let Some(existing) = existing {
            authenticate(&transaction, id, token)?;
            return serde_json::from_str(&existing).map_err(|_| {
                ApiError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Stored header is corrupt",
                )
            });
        }
        transaction
            .execute(
                "INSERT INTO spaces(id,token_hash,header) VALUES (?1,?2,?3)",
                params![
                    id,
                    Sha256::digest(token.as_bytes()).as_slice(),
                    header.to_string()
                ],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok(header)
    }

    fn header(&self, id: &str, token: &str) -> Result<Value> {
        let connection = self.0.lock().unwrap();
        authenticate(&connection, id, token)?;
        let serialized: String = connection
            .query_row("SELECT header FROM spaces WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .map_err(database_error)?;
        serde_json::from_str(&serialized).map_err(|_| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Stored header is corrupt",
            )
        })
    }

    fn push(&self, id: &str, token: &str, mutations: Vec<Mutation>) -> Result<PushResult> {
        if mutations.len() > 100 {
            return Err(bad_request("At most 100 mutations are allowed"));
        }
        for mutation in &mutations {
            validate_mutation(id, mutation)?;
        }
        let mut connection = self.0.lock().unwrap();
        let transaction = connection.transaction().map_err(database_error)?;
        authenticate(&transaction, id, token)?;
        let mut result = PushResult {
            accepted: vec![],
            conflicts: vec![],
        };
        for mutation in mutations {
            let fingerprint = Sha256::digest(
                serde_json::to_vec(&mutation).map_err(|_| bad_request("Invalid mutation"))?,
            );
            let receipt: Option<(Vec<u8>, i64, i64)> = transaction.query_row("SELECT fingerprint,revision,sequence FROM receipts WHERE space_id=?1 AND operation_id=?2", params![id,mutation.operation_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(database_error)?;
            if let Some((stored, revision, sequence)) = receipt {
                if stored.as_slice() != fingerprint.as_slice() {
                    return Err(ApiError(
                        StatusCode::CONFLICT,
                        "Operation identifier was reused with different content",
                    ));
                }
                result.accepted.push(Accepted {
                    operation_id: mutation.operation_id,
                    revision,
                    sequence,
                });
                continue;
            }
            let current = read_change(&transaction, id, &mutation.entity_id)?;
            let revision = current.as_ref().map_or(0, |change| change.revision);
            if mutation.base_revision != revision {
                if let Some(current) = current {
                    result.conflicts.push(Conflict {
                        operation_id: mutation.operation_id,
                        current,
                    });
                    continue;
                }
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "Unknown entity has a nonzero base revision",
                ));
            }
            let revision = revision + 1;
            transaction
                .execute("UPDATE spaces SET sequence=sequence+1 WHERE id=?1", [id])
                .map_err(database_error)?;
            let sequence: i64 = transaction
                .query_row("SELECT sequence FROM spaces WHERE id=?1", [id], |row| {
                    row.get(0)
                })
                .map_err(database_error)?;
            let payload = mutation
                .payload
                .as_ref()
                .map(|value| serde_json::to_string(value).unwrap());
            transaction.execute("INSERT INTO entities(space_id,id,entity_type,revision,sequence,operation_id,base_revision,operation,payload) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(space_id,id) DO UPDATE SET entity_type=excluded.entity_type,revision=excluded.revision,sequence=excluded.sequence,operation_id=excluded.operation_id,base_revision=excluded.base_revision,operation=excluded.operation,payload=excluded.payload", params![id,mutation.entity_id,mutation.entity_type,revision,sequence,mutation.operation_id,mutation.base_revision,mutation.operation,payload]).map_err(database_error)?;
            transaction.execute("INSERT INTO receipts(space_id,operation_id,fingerprint,revision,sequence) VALUES(?1,?2,?3,?4,?5)", params![id,mutation.operation_id,fingerprint.as_slice(),revision,sequence]).map_err(database_error)?;
            result.accepted.push(Accepted {
                operation_id: mutation.operation_id,
                revision,
                sequence,
            });
        }
        transaction.commit().map_err(database_error)?;
        Ok(result)
    }

    fn changes(&self, id: &str, token: &str, cursor: i64, limit: usize) -> Result<Page> {
        if cursor < 0 || !(1..=100).contains(&limit) {
            return Err(bad_request("Invalid pagination arguments"));
        }
        let connection = self.0.lock().unwrap();
        authenticate(&connection, id, token)?;
        let mut statement = connection.prepare("SELECT id FROM entities WHERE space_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3").map_err(database_error)?;
        let ids = statement
            .query_map(params![id, cursor, (limit + 1) as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(database_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(database_error)?;
        let has_more = ids.len() > limit;
        let mut changes = vec![];
        let mut size = 0;
        let mut truncated = false;
        for entity in ids.into_iter().take(limit) {
            let change = read_change(&connection, id, &entity)?.unwrap();
            let bytes = change
                .mutation
                .payload
                .as_ref()
                .map_or(0, |p| p.ciphertext.len());
            if !changes.is_empty() && size + bytes > 50 * 1024 * 1024 {
                truncated = true;
                break;
            }
            size += bytes;
            changes.push(change);
        }
        let next_cursor = changes.last().map_or(cursor, |change| change.sequence);
        Ok(Page {
            changes,
            next_cursor,
            has_more: has_more || truncated,
        })
    }
}

fn read_change(connection: &Connection, space: &str, id: &str) -> Result<Option<Change>> {
    let row: Option<(String, i64, i64, String, i64, String, Option<String>)> = connection.query_row("SELECT entity_type,revision,sequence,operation_id,base_revision,operation,payload FROM entities WHERE space_id=?1 AND id=?2", params![space,id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).optional().map_err(database_error)?;
    row.map(
        |(entity_type, revision, sequence, operation_id, base_revision, operation, payload)| {
            let payload = payload
                .map(|value| serde_json::from_str(&value))
                .transpose()
                .map_err(|_| {
                    ApiError(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Stored envelope is corrupt",
                    )
                })?;
            Ok(Change {
                mutation: Mutation {
                    entity_id: id.to_string(),
                    entity_type,
                    operation_id,
                    base_revision,
                    operation,
                    payload,
                },
                revision,
                sequence,
            })
        },
    )
    .transpose()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Worker failed"))?
}
async fn create(
    State(store): State<Arc<Store>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<HeaderInput>,
) -> Result<Json<Value>> {
    let token = token(&headers)?;
    blocking(move || store.create_space(&id, &token, input.header))
        .await
        .map(|header| Json(json!({"header":header})))
}
async fn header(
    State(store): State<Arc<Store>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let token = token(&headers)?;
    blocking(move || store.header(&id, &token))
        .await
        .map(|header| Json(json!({"header":header})))
}
async fn push(
    State(store): State<Arc<Store>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<PushInput>,
) -> Result<Json<PushResult>> {
    let token = token(&headers)?;
    blocking(move || store.push(&id, &token, input.mutations))
        .await
        .map(Json)
}
async fn changes(
    State(store): State<Arc<Store>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(cursor): Query<Cursor>,
) -> Result<Json<Page>> {
    let token = token(&headers)?;
    blocking(move || store.changes(&id, &token, cursor.cursor, cursor.limit))
        .await
        .map(Json)
}
pub fn router(store: Arc<Store>) -> Router {
    Router::new()
        .route("/v1/spaces/{id}", put(create).get(header))
        .route("/v1/spaces/{id}/push", post(push))
        .route("/v1/spaces/{id}/changes", get(changes))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(store)
}
