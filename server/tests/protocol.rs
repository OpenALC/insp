use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use insp_sync_server::{router, Store};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;

const TOKEN_A: &str = "a-private-capability-token-of-43-characters-AA";
const TOKEN_B: &str = "b-private-capability-token-of-43-characters-BB";

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}
fn mutation(operation: &str, id: &str, base: i64) -> Value {
    json!({"operationId":operation,"entityId":id,"entityType":id.split(':').next().unwrap(),"baseRevision":base,"operation":"put","payload":{"version":1,"algorithm":"AES-256-GCM","keyId":"alpha","nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}})
}
async fn create(app: &Router, id: &str, token: &str) {
    assert_eq!(
        request(
            app,
            "PUT",
            &format!("/v1/spaces/{id}"),
            token,
            json!({"header":{"id":id,"version":1}})
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn capability_authentication_isolates_spaces_and_preserves_headers() {
    let app = router(Arc::new(Store::open(":memory:").unwrap()));
    create(&app, "alpha", TOKEN_A).await;
    create(&app, "beta", TOKEN_B).await;
    assert_eq!(
        request(&app, "GET", "/v1/spaces/alpha", TOKEN_B, Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "PUT",
            "/v1/spaces/alpha",
            TOKEN_B,
            json!({"header":{"id":"alpha"}})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, existing) = request(
        &app,
        "PUT",
        "/v1/spaces/alpha",
        TOKEN_A,
        json!({"header":{"id":"alpha","version":99}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(existing["header"]["version"], 1);
    request(
        &app,
        "POST",
        "/v1/spaces/alpha/push",
        TOKEN_A,
        json!({"mutations":[mutation("op-one","note:one",0)]}),
    )
    .await;
    let (_, page) = request(
        &app,
        "GET",
        "/v1/spaces/beta/changes?cursor=0",
        TOKEN_B,
        Value::Null,
    )
    .await;
    assert_eq!(page["changes"], json!([]));
}

#[tokio::test]
async fn idempotence_conflicts_tombstones_and_pagination_are_transactional() {
    let app = router(Arc::new(Store::open(":memory:").unwrap()));
    create(&app, "alpha", TOKEN_A).await;
    let first = mutation("op-one", "note:one", 0);
    let (_, accepted) = request(
        &app,
        "POST",
        "/v1/spaces/alpha/push",
        TOKEN_A,
        json!({"mutations":[first.clone()]}),
    )
    .await;
    let (_, replay) = request(
        &app,
        "POST",
        "/v1/spaces/alpha/push",
        TOKEN_A,
        json!({"mutations":[first.clone()]}),
    )
    .await;
    assert_eq!(accepted, replay);
    let (_, conflict) = request(
        &app,
        "POST",
        "/v1/spaces/alpha/push",
        TOKEN_A,
        json!({"mutations":[mutation("stale","note:one",0)]}),
    )
    .await;
    assert_eq!(conflict["conflicts"][0]["current"]["revision"], 1);
    let mut forged = first.clone();
    forged["payload"]["ciphertext"] = json!("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    let (status, _) = request(
        &app,
        "POST",
        "/v1/spaces/alpha/push",
        TOKEN_A,
        json!({"mutations":[mutation("should-roll-back","note:temporary",0),forged]}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_, page) = request(
        &app,
        "GET",
        "/v1/spaces/alpha/changes?cursor=0",
        TOKEN_A,
        Value::Null,
    )
    .await;
    assert_eq!(page["changes"].as_array().unwrap().len(), 1);
    let delete = json!({"operationId":"delete-one","entityId":"note:one","entityType":"note","baseRevision":1,"operation":"delete","payload":null});
    request(&app,"POST","/v1/spaces/alpha/push",TOKEN_A,json!({"mutations":[delete,mutation("image","attachment:one",0),mutation("group","group:one",0)]})).await;
    let (_, first_page) = request(
        &app,
        "GET",
        "/v1/spaces/alpha/changes?cursor=0&limit=1",
        TOKEN_A,
        Value::Null,
    )
    .await;
    assert_eq!(first_page["changes"][0]["operation"], "delete");
    assert_eq!(first_page["changes"][0]["payload"], Value::Null);
    assert_eq!(first_page["changes"][0]["revision"], 2);
    assert_eq!(first_page["hasMore"], true);
    let cursor = first_page["nextCursor"].as_i64().unwrap();
    let (_, second) = request(
        &app,
        "GET",
        &format!("/v1/spaces/alpha/changes?cursor={cursor}&limit=1"),
        TOKEN_A,
        Value::Null,
    )
    .await;
    assert_eq!(second["changes"][0]["entityId"], "attachment:one");
    let cursor = second["nextCursor"].as_i64().unwrap();
    let (_, last) = request(
        &app,
        "GET",
        &format!("/v1/spaces/alpha/changes?cursor={cursor}&limit=1"),
        TOKEN_A,
        Value::Null,
    )
    .await;
    assert_eq!(last["changes"][0]["entityId"], "group:one");
    assert_eq!(last["hasMore"], false);
    let (_, stale_resurrection) = request(
        &app,
        "POST",
        "/v1/spaces/alpha/push",
        TOKEN_A,
        json!({"mutations":[mutation("offline-old","note:one",1)]}),
    )
    .await;
    assert_eq!(
        stale_resurrection["conflicts"][0]["current"]["operation"],
        "delete"
    );
}
