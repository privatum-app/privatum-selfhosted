use std::future::IntoFuture;

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use data_encoding::BASE64_NOPAD;
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use privatum_relay::{admin_app, app, mailbox_id, open_state, Config};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use tower::ServiceExt;

const HOST: &str = "exampleonionaddressexampleonionaddressexampleonionaddr.onion";

fn router() -> Router {
    let cfg = Config { host: HOST.into(), db_path: ":memory:".into(), message_ttl_days: 14, max_mailboxes: 100 };
    app(open_state(&cfg).unwrap(), None)
}

fn b64(b: &[u8]) -> String {
    BASE64_NOPAD.encode(b)
}

async fn call(r: &Router, method: &str, uri: &str, token: Option<&str>, body: Value) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri).header("content-type", "application/json");
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let res = r.clone().oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

struct User {
    sk: SigningKey,
    curve: [u8; 32],
    id: String,
}

impl User {
    fn new() -> Self {
        let mut seed = [0u8; 32];
        let mut curve = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        OsRng.fill_bytes(&mut curve);
        let sk = SigningKey::from_bytes(&seed);
        let id = mailbox_id(&sk.verifying_key().to_bytes(), &curve);
        User { sk, curve, id }
    }

    fn sign(&self, parts: &[&[u8]]) -> String {
        b64(&self.sk.sign(&parts.concat()).to_bytes())
    }

    async fn register(&self, r: &Router) -> (StatusCode, Value) {
        self.register_with(r, None).await
    }

    async fn register_with(&self, r: &Router, invite: Option<&str>) -> (StatusCode, Value) {
        let ed = self.sk.verifying_key().to_bytes();
        let body = json!({
            "ed25519": b64(&ed),
            "curve25519": b64(&self.curve),
            "signature": self.sign(&[b"privatum-register-v1", &ed, &self.curve]),
            "invite": invite,
        });
        call(r, "POST", "/v1/register", None, body).await
    }

    async fn login(&self, r: &Router) -> String {
        let (_, c) = call(r, "POST", "/v1/auth/challenge", None, json!({ "mailbox_id": self.id })).await;
        let nonce = c["nonce"].as_str().unwrap();
        let raw = BASE64_NOPAD.decode(nonce.as_bytes()).unwrap();
        let body = json!({
            "mailbox_id": self.id,
            "nonce": nonce,
            "signature": self.sign(&[b"privatum-auth-v1", HOST.as_bytes(), &raw]),
        });
        let (status, v) = call(r, "POST", "/v1/auth/verify", None, body).await;
        assert_eq!(status, StatusCode::OK, "{v}");
        v["token"].as_str().unwrap().to_owned()
    }

    fn signed_key(&self, key_id: &str) -> Value {
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        json!({ "key_id": key_id, "key": b64(&key), "signature": self.sign(&[b"privatum-otk-v1", &key]) })
    }
}

#[tokio::test]
async fn register_returns_self_certifying_id_and_is_idempotent() {
    let r = router();
    let u = User::new();
    let (s1, v1) = u.register(&r).await;
    let (s2, v2) = u.register(&r).await;
    assert_eq!((s1, s2), (StatusCode::OK, StatusCode::OK));
    assert_eq!(v1["mailbox_id"], u.id);
    assert_eq!(v2["mailbox_id"], u.id);
    assert_eq!(u.id.len(), 52);
}

#[tokio::test]
async fn register_rejects_signature_from_other_key() {
    let r = router();
    let (u, other) = (User::new(), User::new());
    let ed = u.sk.verifying_key().to_bytes();
    let body = json!({
        "ed25519": b64(&ed),
        "curve25519": b64(&u.curve),
        "signature": other.sign(&[b"privatum-register-v1", &ed, &u.curve]),
    });
    let (status, _) = call(&r, "POST", "/v1/register", None, body).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_rejects_wrong_host_and_nonce_is_single_use() {
    let r = router();
    let u = User::new();
    u.register(&r).await;
    let (_, c) = call(&r, "POST", "/v1/auth/challenge", None, json!({ "mailbox_id": u.id })).await;
    let nonce = c["nonce"].as_str().unwrap().to_owned();
    let raw = BASE64_NOPAD.decode(nonce.as_bytes()).unwrap();

    // Signed for another relay: must fail, and burns the nonce.
    let bad = json!({ "mailbox_id": u.id, "nonce": nonce, "signature": u.sign(&[b"privatum-auth-v1", b"evil.onion", &raw]) });
    assert_eq!(call(&r, "POST", "/v1/auth/verify", None, bad).await.0, StatusCode::UNAUTHORIZED);

    let good = json!({ "mailbox_id": u.id, "nonce": nonce, "signature": u.sign(&[b"privatum-auth-v1", HOST.as_bytes(), &raw]) });
    assert_eq!(call(&r, "POST", "/v1/auth/verify", None, good).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn endpoints_require_token() {
    let r = router();
    assert_eq!(call(&r, "PUT", "/v1/keys", None, json!({})).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(call(&r, "POST", "/v1/messages", Some("AAAA"), json!({ "to": "x", "envelope": "y" })).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn one_time_keys_are_consumed_then_fallback_remains() {
    let r = router();
    let (alice, bob) = (User::new(), User::new());
    alice.register(&r).await;
    bob.register(&r).await;
    let ta = alice.login(&r).await;
    let tb = bob.login(&r).await;

    let keys = json!({ "one_time_keys": [alice.signed_key("k1")], "fallback_key": alice.signed_key("f1") });
    assert_eq!(call(&r, "PUT", "/v1/keys", Some(&ta), keys).await.0, StatusCode::NO_CONTENT);

    let uri = format!("/v1/keys/{}", alice.id);
    let (_, first) = call(&r, "GET", &uri, Some(&tb), Value::Null).await;
    assert_eq!(first["one_time_key"]["key_id"], "k1");
    assert_eq!(first["fallback_key"]["key_id"], "f1");
    assert_eq!(first["ed25519"], b64(&alice.sk.verifying_key().to_bytes()));

    let (_, second) = call(&r, "GET", &uri, Some(&tb), Value::Null).await;
    assert!(second["one_time_key"].is_null());
    assert_eq!(second["fallback_key"]["key_id"], "f1");
}

#[tokio::test]
async fn new_one_time_key_batch_replaces_the_old_one() {
    let r = router();
    let (alice, bob) = (User::new(), User::new());
    alice.register(&r).await;
    bob.register(&r).await;
    let ta = alice.login(&r).await;
    let tb = bob.login(&r).await;

    let old = json!({ "one_time_keys": [alice.signed_key("old1"), alice.signed_key("old2")] });
    call(&r, "PUT", "/v1/keys", Some(&ta), old).await;
    let new = json!({ "one_time_keys": [alice.signed_key("new1")] });
    assert_eq!(call(&r, "PUT", "/v1/keys", Some(&ta), new).await.0, StatusCode::NO_CONTENT);

    let uri = format!("/v1/keys/{}", alice.id);
    let (_, first) = call(&r, "GET", &uri, Some(&tb), Value::Null).await;
    assert_eq!(first["one_time_key"]["key_id"], "new1");
    let (_, second) = call(&r, "GET", &uri, Some(&tb), Value::Null).await;
    assert!(second["one_time_key"].is_null(), "old keys must be gone");

    // A fallback-only update must not wipe the one-time keys.
    call(&r, "PUT", "/v1/keys", Some(&ta), json!({ "one_time_keys": [alice.signed_key("n2")] })).await;
    call(&r, "PUT", "/v1/keys", Some(&ta), json!({ "fallback_key": alice.signed_key("f") })).await;
    let (_, third) = call(&r, "GET", &uri, Some(&tb), Value::Null).await;
    assert_eq!(third["one_time_key"]["key_id"], "n2");
}

#[tokio::test]
async fn put_keys_rejects_key_signed_by_someone_else() {
    let r = router();
    let (alice, mallory) = (User::new(), User::new());
    alice.register(&r).await;
    let ta = alice.login(&r).await;
    let keys = json!({ "one_time_keys": [mallory.signed_key("k1")] });
    assert_eq!(call(&r, "PUT", "/v1/keys", Some(&ta), keys).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn messages_are_only_deletable_by_recipient() {
    let r = router();
    let (alice, bob) = (User::new(), User::new());
    alice.register(&r).await;
    bob.register(&r).await;
    let ta = alice.login(&r).await;
    let tb = bob.login(&r).await;

    let (status, v) = call(&r, "POST", "/v1/messages", Some(&ta), json!({ "to": bob.id, "envelope": "opaque" })).await;
    assert_eq!(status, StatusCode::CREATED);
    let uri = format!("/v1/messages/{}", v["id"]);
    assert_eq!(call(&r, "DELETE", &uri, Some(&ta), Value::Null).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call(&r, "DELETE", &uri, Some(&tb), Value::Null).await.0, StatusCode::NO_CONTENT);

    let unknown = json!({ "to": "nobody", "envelope": "opaque" });
    assert_eq!(call(&r, "POST", "/v1/messages", Some(&ta), unknown).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn security_headers_are_sent() {
    let res = router()
        .oneshot(Request::builder().uri("/v1/keys/x").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let h = res.headers();
    assert!(h["content-security-policy"].to_str().unwrap().contains("frame-ancestors 'none'"));
    assert_eq!(h["x-frame-options"], "DENY");
    assert_eq!(h["cross-origin-opener-policy"], "same-origin");
    assert_eq!(h["referrer-policy"], "no-referrer");
}

#[tokio::test]
async fn inbox_delivers_pending_and_live_messages() {
    let r = router();
    let (alice, bob) = (User::new(), User::new());
    alice.register(&r).await;
    bob.register(&r).await;
    let ta = alice.login(&r).await;
    let tb = bob.login(&r).await;
    call(&r, "POST", "/v1/messages", Some(&ta), json!({ "to": bob.id, "envelope": "before" })).await;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(axum::serve(listener, r.clone()).into_future());

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/inbox")).await.unwrap();
    ws.send(Message::Text(json!({ "token": tb }).to_string().into())).await.unwrap();

    let next = |m: Option<Result<Message, _>>| -> Value {
        serde_json::from_str(m.unwrap().unwrap().to_text().unwrap()).unwrap()
    };
    let first = next(ws.next().await);
    assert_eq!(first["envelope"], "before");
    assert_eq!(first["from"], alice.id);

    call(&r, "POST", "/v1/messages", Some(&ta), json!({ "to": bob.id, "envelope": "after" })).await;
    let second = next(ws.next().await);
    assert_eq!(second["envelope"], "after");
}

#[tokio::test]
async fn inbox_closes_without_valid_token() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(axum::serve(listener, router()).into_future());
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/inbox")).await.unwrap();
    ws.send(Message::Text(json!({ "token": "bogus" }).to_string().into())).await.unwrap();
    assert!(matches!(ws.next().await, Some(Ok(Message::Close(_))) | None));
}

#[tokio::test]
async fn static_assets_are_cached_and_served_gzipped_but_the_page_is_not() {
    let dir = std::env::temp_dir().join(format!("privatum-static-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html>").unwrap();
    std::fs::write(dir.join("assets/app.js"), "console.log(1)").unwrap();
    std::fs::write(dir.join("assets/app.js.gz"), [0x1f, 0x8b, 0x08, 0x00]).unwrap();
    let cfg = Config { host: HOST.into(), db_path: ":memory:".into(), message_ttl_days: 14, max_mailboxes: 100 };
    let r = app(open_state(&cfg).unwrap(), Some(dir.to_str().unwrap()));
    let get = |uri: &str| {
        Request::builder().uri(uri).header("accept-encoding", "gzip").body(Body::empty()).unwrap()
    };

    let asset = r.clone().oneshot(get("/assets/app.js")).await.unwrap();
    assert_eq!(asset.status(), StatusCode::OK);
    assert_eq!(asset.headers()["content-encoding"], "gzip");
    assert!(asset.headers()["cache-control"].to_str().unwrap().contains("immutable"));
    assert_eq!(asset.headers()["x-frame-options"], "DENY");

    let page = r.clone().oneshot(get("/")).await.unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(page.headers()["cache-control"], "no-store");

    let api = r.oneshot(get("/v1/keys/x")).await.unwrap();
    assert_eq!(api.headers()["cache-control"], "no-store");
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn admin_api_needs_the_token_and_reports_only_counts() {
    let cfg = Config { host: HOST.into(), db_path: ":memory:".into(), message_ttl_days: 14, max_mailboxes: 100 };
    let state = open_state(&cfg).unwrap();
    let r = app(state.clone(), None);
    let dir = std::env::temp_dir().join(format!("privatum-admin-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let token_file = dir.join("token");
    let admin = admin_app(state, token_file.to_string_lossy().into_owned());

    // No token file yet: nothing gets in, not even an empty bearer.
    assert_eq!(call(&admin, "GET", "/admin/stats", Some(""), json!({})).await.0, StatusCode::UNAUTHORIZED);
    std::fs::write(&token_file, "s3cret-token\n").unwrap();
    assert_eq!(call(&admin, "GET", "/admin/stats", None, json!({})).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(call(&admin, "GET", "/admin/stats", Some("wrong"), json!({})).await.0, StatusCode::UNAUTHORIZED);

    User::new().register(&r).await;
    let (status, v) = call(&admin, "GET", "/admin/stats", Some("s3cret-token"), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["mailboxes"], 1);
    assert_eq!(v["messages"], 0);
    assert_eq!(v["message_ttl_days"], 14);
    // The admin API is not part of the public app.
    assert_eq!(call(&r, "GET", "/admin/stats", Some("s3cret-token"), json!({})).await.0, StatusCode::NOT_FOUND);
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn new_onion_hostname_drops_tokens_and_binds_new_signatures() {
    let cfg = Config { host: HOST.into(), db_path: ":memory:".into(), message_ttl_days: 14, max_mailboxes: 100 };
    let state = open_state(&cfg).unwrap();
    let r = app(state.clone(), None);
    let u = User::new();
    u.register(&r).await;
    let token = u.login(&r).await;
    assert!(!state.set_host(HOST), "same name is not a change");
    let new_host = "anotheronionaddressanotheronionaddressanotheronionaddr.onion";
    assert!(state.set_host(new_host));
    assert_eq!(call(&r, "PUT", "/v1/keys", Some(&token), json!({})).await.0, StatusCode::UNAUTHORIZED);

    let (_, c) = call(&r, "POST", "/v1/auth/challenge", None, json!({ "mailbox_id": u.id })).await;
    let nonce = c["nonce"].as_str().unwrap().to_owned();
    let raw = BASE64_NOPAD.decode(nonce.as_bytes()).unwrap();
    let good = json!({ "mailbox_id": u.id, "nonce": nonce, "signature": u.sign(&[b"privatum-auth-v1", new_host.as_bytes(), &raw]) });
    assert_eq!(call(&r, "POST", "/v1/auth/verify", None, good).await.0, StatusCode::OK);
}

/// App and admin API over one in-memory relay; the admin token is "t".
fn app_and_admin() -> (Router, Router, std::path::PathBuf) {
    let cfg = Config { host: HOST.into(), db_path: ":memory:".into(), message_ttl_days: 14, max_mailboxes: 100 };
    let state = open_state(&cfg).unwrap();
    let mut raw = [0u8; 8];
    OsRng.fill_bytes(&mut raw);
    let dir = std::env::temp_dir().join(format!("privatum-access-{}", b64(&raw).replace('/', "_")));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("token"), "t").unwrap();
    let admin = admin_app(state.clone(), dir.join("token").to_string_lossy().into_owned());
    (app(state, None), admin, dir)
}

#[tokio::test]
async fn invite_mode_needs_a_valid_unused_code_but_never_locks_out_members() {
    let (r, admin, dir) = app_and_admin();
    let member = User::new();
    assert_eq!(member.register(&r).await.0, StatusCode::OK, "open by default");
    assert_eq!(call(&r, "GET", "/v1/instance", None, json!({})).await.1["registration"], "open");
    let token = member.login(&r).await;
    assert_eq!(call(&r, "POST", "/v1/invites", Some(&token), json!({})).await.1["error"], "not_invite_mode");

    assert_eq!(call(&admin, "POST", "/admin/registration", Some("t"), json!({ "mode": "nope" })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(call(&admin, "POST", "/admin/registration", Some("t"), json!({ "mode": "invite" })).await.0, StatusCode::OK);
    assert_eq!(call(&r, "GET", "/v1/instance", None, json!({})).await.1["registration"], "invite");

    let newcomer = User::new();
    assert_eq!(newcomer.register(&r).await.1["error"], "invite_required");
    assert_eq!(newcomer.register_with(&r, Some("aaaaaaaaaaaaaaaaaaaaaaaaaa")).await.1["error"], "invalid_invite");
    assert_eq!(member.register(&r).await.0, StatusCode::OK, "existing mailboxes need no code");

    // A member's code works once.
    assert_eq!(call(&r, "POST", "/v1/invites", None, json!({})).await.0, StatusCode::UNAUTHORIZED);
    let (status, v) = call(&r, "POST", "/v1/invites", Some(&token), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let code = v["code"].as_str().unwrap().to_owned();
    assert_eq!(code.len(), 26);
    assert_eq!(newcomer.register_with(&r, Some(&code)).await.0, StatusCode::OK);
    assert_eq!(User::new().register_with(&r, Some(&code)).await.1["error"], "invalid_invite");

    // An admin code with two uses; revoking it stops the rest.
    let (_, v) = call(&admin, "POST", "/admin/invites", Some("t"), json!({ "uses": 2, "days": 1 })).await;
    let admin_code = v["code"].as_str().unwrap().to_owned();
    assert_eq!(User::new().register_with(&r, Some(&admin_code)).await.0, StatusCode::OK);
    let (_, access) = call(&admin, "GET", "/admin/access", Some("t"), json!({})).await;
    let live = access["invites"].as_array().unwrap();
    assert_eq!(live.len(), 1, "used-up member code is gone");
    assert_eq!(live[0]["uses_left"], 1);
    assert_eq!(live[0]["by_admin"], true);
    assert!(!access.to_string().contains(&admin_code), "the panel never sees codes again, only hash prefixes");
    let id = live[0]["id"].as_str().unwrap();
    assert_eq!(call(&admin, "POST", "/admin/invites/revoke", Some("t"), json!({ "id": id })).await.0, StatusCode::OK);
    assert_eq!(User::new().register_with(&r, Some(&admin_code)).await.1["error"], "invalid_invite");
    assert_eq!(call(&admin, "POST", "/admin/invites", Some("t"), json!({ "uses": 0, "days": 1 })).await.0, StatusCode::BAD_REQUEST);

    // Closed: nobody new, members still fine.
    call(&admin, "POST", "/admin/registration", Some("t"), json!({ "mode": "closed" })).await;
    let (_, v) = call(&admin, "POST", "/admin/invites", Some("t"), json!({ "uses": 1, "days": 1 })).await;
    assert_eq!(User::new().register_with(&r, v["code"].as_str()).await.1["error"], "registration_closed");
    assert_eq!(member.register(&r).await.0, StatusCode::OK);
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn removing_a_mailbox_drops_its_keys_queue_and_sessions() {
    let (r, admin, dir) = app_and_admin();
    let (alice, bob) = (User::new(), User::new());
    alice.register(&r).await;
    bob.register(&r).await;
    let (ta, tb) = (alice.login(&r).await, bob.login(&r).await);
    call(&r, "POST", "/v1/messages", Some(&ta), json!({ "to": bob.id, "envelope": "x" })).await;
    let (_, access) = call(&admin, "GET", "/admin/access", Some("t"), json!({})).await;
    let row = access["mailboxes"].as_array().unwrap().iter().find(|m| m["id"] == bob.id.as_str()).unwrap().clone();
    assert_eq!(row["pending"], 1);

    assert_eq!(call(&admin, "POST", "/admin/mailboxes/remove", Some("t"), json!({ "id": bob.id })).await.0, StatusCode::OK);
    assert_eq!(call(&r, "PUT", "/v1/keys", Some(&tb), json!({})).await.0, StatusCode::UNAUTHORIZED, "session gone");
    assert_eq!(call(&r, "GET", &format!("/v1/keys/{}", bob.id), Some(&ta), json!({})).await.0, StatusCode::NOT_FOUND);
    let (_, stats) = call(&admin, "GET", "/admin/stats", Some("t"), json!({})).await;
    assert_eq!((stats["mailboxes"].clone(), stats["messages"].clone()), (json!(1), json!(0)));
    std::fs::remove_dir_all(dir).ok();
}
