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
use privatum_relay::{app, mailbox_id, open_state, Config};
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
        let ed = self.sk.verifying_key().to_bytes();
        let body = json!({
            "ed25519": b64(&ed),
            "curve25519": b64(&self.curve),
            "signature": self.sign(&[b"privatum-register-v1", &ed, &self.curve]),
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
