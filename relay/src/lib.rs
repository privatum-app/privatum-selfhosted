//! Privatum relay: stores and forwards opaque, end-to-end encrypted envelopes.
//! It never sees passwords, private keys or plaintext. See docs/PROTOCOL.md.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path, State,
    },
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use data_encoding::{BASE32_NOPAD, BASE64_NOPAD};
use ed25519_dalek::{Signature, VerifyingKey};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

const NONCE_TTL: Duration = Duration::from_secs(60);
const TOKEN_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_ENVELOPE: usize = 64 * 1024;
const MAX_PENDING_PER_MAILBOX: i64 = 1000;
const MAX_ONE_TIME_KEYS: i64 = 200;
const MAX_NONCES: usize = 10_000;

const CSP: &str = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; \
connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; \
worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PERMISSIONS: &str = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), \
interest-cohort=(), browsing-topics=()";

pub struct Config {
    /// Onion hostname the auth signature is bound to (never taken from the Host header).
    pub host: String,
    pub db_path: String,
    pub message_ttl_days: i64,
    pub max_mailboxes: i64,
}

pub struct AppState {
    db: Mutex<Connection>,
    host: String,
    message_ttl_secs: i64,
    max_mailboxes: i64,
    nonces: Mutex<HashMap<String, (String, Instant)>>,
    tokens: Mutex<HashMap<[u8; 32], (String, Instant)>>,
    buckets: Mutex<HashMap<String, (f64, Instant)>>,
    notify: broadcast::Sender<String>,
}

pub type Shared = Arc<AppState>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn random32() -> [u8; 32] {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    b
}

fn err(code: StatusCode, msg: &'static str) -> Response {
    (code, Json(serde_json::json!({ "error": msg }))).into_response()
}

fn db_err<E>(_: E) -> Response {
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal")
}

fn b64_fixed<const N: usize>(s: &str) -> Result<[u8; N], Response> {
    BASE64_NOPAD
        .decode(s.as_bytes())
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "bad_encoding"))
}

fn verify(ed25519: &[u8; 32], msg: &[u8], signature: &str) -> Result<(), Response> {
    let key = VerifyingKey::from_bytes(ed25519).map_err(|_| err(StatusCode::BAD_REQUEST, "bad_key"))?;
    let sig = Signature::from_bytes(&b64_fixed::<64>(signature)?);
    key.verify_strict(msg, &sig).map_err(|_| err(StatusCode::UNAUTHORIZED, "bad_signature"))
}

/// mailbox_id = base32(SHA-256("privatum-id-v1" || ed25519 || curve25519)), lowercase.
pub fn mailbox_id(ed25519: &[u8; 32], curve25519: &[u8; 32]) -> String {
    let mut h = Sha256::new();
    h.update(b"privatum-id-v1");
    h.update(ed25519);
    h.update(curve25519);
    BASE32_NOPAD.encode(&h.finalize()).to_ascii_lowercase()
}

pub fn open_state(cfg: &Config) -> rusqlite::Result<Shared> {
    let db = Connection::open(&cfg.db_path)?;
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS mailboxes (
             id TEXT PRIMARY KEY,
             ed25519 TEXT NOT NULL,
             curve25519 TEXT NOT NULL,
             created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS one_time_keys (
             mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
             key_id TEXT NOT NULL,
             key TEXT NOT NULL,
             signature TEXT NOT NULL,
             PRIMARY KEY (mailbox_id, key_id));
         CREATE TABLE IF NOT EXISTS fallback_keys (
             mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
             key_id TEXT NOT NULL,
             key TEXT NOT NULL,
             signature TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS messages (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             to_mailbox TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
             from_mailbox TEXT NOT NULL,
             envelope TEXT NOT NULL,
             created_at INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS messages_to ON messages (to_mailbox, id);",
    )?;
    Ok(Arc::new(AppState {
        db: Mutex::new(db),
        host: cfg.host.clone(),
        message_ttl_secs: cfg.message_ttl_days * 86_400,
        max_mailboxes: cfg.max_mailboxes,
        nonces: Mutex::new(HashMap::new()),
        tokens: Mutex::new(HashMap::new()),
        buckets: Mutex::new(HashMap::new()),
        notify: broadcast::channel(1024).0,
    }))
}

impl AppState {
    /// Token bucket: `per_min` requests per minute, burst of the same size.
    fn allow(&self, key: &str, per_min: f64) -> bool {
        let now = Instant::now();
        let mut buckets = lock(&self.buckets);
        let b = buckets.entry(key.to_owned()).or_insert((per_min, now));
        b.0 = (b.0 + now.duration_since(b.1).as_secs_f64() * per_min / 60.0).min(per_min);
        b.1 = now;
        if b.0 >= 1.0 {
            b.0 -= 1.0;
            true
        } else {
            false
        }
    }

    fn lookup_token(&self, token: &str) -> Option<(String, Instant)> {
        let raw = b64_fixed::<32>(token).ok()?;
        let hash: [u8; 32] = Sha256::digest(raw).into();
        let tokens = lock(&self.tokens);
        let (mailbox, expires) = tokens.get(&hash)?;
        (Instant::now() < *expires).then(|| (mailbox.clone(), *expires))
    }

    fn authed(&self, headers: &HeaderMap) -> Result<String, Response> {
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .and_then(|t| self.lookup_token(t))
            .map(|(mailbox, _)| mailbox)
            .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "unauthorized"))
    }

    fn rate(&self, key: &str, per_min: f64) -> Result<(), Response> {
        if self.allow(key, per_min) {
            Ok(())
        } else {
            Err(err(StatusCode::TOO_MANY_REQUESTS, "rate_limited"))
        }
    }

    fn ed25519_of(&self, mailbox: &str) -> Result<Option<[u8; 32]>, Response> {
        let key: Option<String> = lock(&self.db)
            .query_row("SELECT ed25519 FROM mailboxes WHERE id = ?1", [mailbox], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        key.map(|k| b64_fixed::<32>(&k)).transpose()
    }

    /// Drops expired messages, nonces, tokens and idle rate-limit buckets.
    pub fn cleanup(&self) {
        let cutoff = now_unix() - self.message_ttl_secs;
        let _ = lock(&self.db).execute("DELETE FROM messages WHERE created_at < ?1", [cutoff]);
        let now = Instant::now();
        lock(&self.nonces).retain(|_, (_, exp)| *exp > now);
        lock(&self.tokens).retain(|_, (_, exp)| *exp > now);
        lock(&self.buckets).retain(|_, (_, last)| now.duration_since(*last) < Duration::from_secs(600));
    }
}

pub fn app(state: Shared, static_dir: Option<&str>) -> Router {
    let mut router = Router::new()
        .route("/v1/register", post(register))
        .route("/v1/auth/challenge", post(challenge))
        .route("/v1/auth/verify", post(verify_auth))
        .route("/v1/keys", put(put_keys))
        .route("/v1/keys/{mailbox_id}", get(get_keys))
        .route("/v1/messages", post(post_message))
        .route("/v1/messages/{id}", delete(delete_message))
        .route("/v1/inbox", get(inbox));
    if let Some(dir) = static_dir {
        router = router.fallback_service(ServeDir::new(dir));
    }
    let headers: [(HeaderName, &'static str); 8] = [
        (header::CONTENT_SECURITY_POLICY, CSP),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::CACHE_CONTROL, "no-store"),
        (HeaderName::from_static("permissions-policy"), PERMISSIONS),
        (HeaderName::from_static("cross-origin-opener-policy"), "same-origin"),
        (HeaderName::from_static("cross-origin-resource-policy"), "same-origin"),
    ];
    let mut router = router.layer(DefaultBodyLimit::max(128 * 1024)).with_state(state);
    for (name, value) in headers {
        router = router.layer(SetResponseHeaderLayer::overriding(name, HeaderValue::from_static(value)));
    }
    router
}

#[derive(Deserialize)]
struct RegisterReq {
    ed25519: String,
    curve25519: String,
    signature: String,
}

async fn register(State(s): State<Shared>, Json(req): Json<RegisterReq>) -> Result<Response, Response> {
    s.rate("global:register", 30.0)?;
    let ed = b64_fixed::<32>(&req.ed25519)?;
    let curve = b64_fixed::<32>(&req.curve25519)?;
    let mut msg = b"privatum-register-v1".to_vec();
    msg.extend_from_slice(&ed);
    msg.extend_from_slice(&curve);
    verify(&ed, &msg, &req.signature)?;

    let id = mailbox_id(&ed, &curve);
    let db = lock(&s.db);
    let exists: bool = db
        .query_row("SELECT EXISTS(SELECT 1 FROM mailboxes WHERE id = ?1)", [&id], |r| r.get(0))
        .map_err(db_err)?;
    if !exists {
        let count: i64 = db.query_row("SELECT COUNT(*) FROM mailboxes", [], |r| r.get(0)).map_err(db_err)?;
        if count >= s.max_mailboxes {
            return Err(err(StatusCode::SERVICE_UNAVAILABLE, "instance_full"));
        }
        db.execute(
            "INSERT INTO mailboxes (id, ed25519, curve25519, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, req.ed25519, req.curve25519, now_unix()],
        )
        .map_err(db_err)?;
    }
    Ok(Json(serde_json::json!({ "mailbox_id": id })).into_response())
}

#[derive(Deserialize)]
struct ChallengeReq {
    mailbox_id: String,
}

async fn challenge(State(s): State<Shared>, Json(req): Json<ChallengeReq>) -> Result<Response, Response> {
    s.rate("global:challenge", 120.0)?;
    let nonce = BASE64_NOPAD.encode(&random32());
    let mut nonces = lock(&s.nonces);
    if nonces.len() >= MAX_NONCES {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, "busy"));
    }
    nonces.insert(nonce.clone(), (req.mailbox_id, Instant::now() + NONCE_TTL));
    Ok(Json(serde_json::json!({ "nonce": nonce })).into_response())
}

#[derive(Deserialize)]
struct VerifyReq {
    mailbox_id: String,
    nonce: String,
    signature: String,
}

async fn verify_auth(State(s): State<Shared>, Json(req): Json<VerifyReq>) -> Result<Response, Response> {
    let unauthorized = || err(StatusCode::UNAUTHORIZED, "unauthorized");
    // Single use: removed before checking, so a failed attempt burns the nonce.
    let (mailbox, expires) = lock(&s.nonces).remove(&req.nonce).ok_or_else(unauthorized)?;
    if mailbox != req.mailbox_id || Instant::now() > expires {
        return Err(unauthorized());
    }
    let ed = s.ed25519_of(&mailbox)?.ok_or_else(unauthorized)?;
    let mut msg = b"privatum-auth-v1".to_vec();
    msg.extend_from_slice(s.host.as_bytes());
    msg.extend_from_slice(&b64_fixed::<32>(&req.nonce)?);
    verify(&ed, &msg, &req.signature)?;

    let token = random32();
    let hash: [u8; 32] = Sha256::digest(token).into();
    lock(&s.tokens).insert(hash, (mailbox, Instant::now() + TOKEN_TTL));
    Ok(Json(serde_json::json!({
        "token": BASE64_NOPAD.encode(&token),
        "expires_in": TOKEN_TTL.as_secs(),
    }))
    .into_response())
}

#[derive(Deserialize, Serialize)]
struct SignedKey {
    key_id: String,
    key: String,
    signature: String,
}

#[derive(Deserialize)]
struct PutKeysReq {
    #[serde(default)]
    one_time_keys: Vec<SignedKey>,
    fallback_key: Option<SignedKey>,
}

async fn put_keys(State(s): State<Shared>, headers: HeaderMap, Json(req): Json<PutKeysReq>) -> Result<Response, Response> {
    let me = s.authed(&headers)?;
    s.rate(&format!("keys:{me}"), 30.0)?;
    let ed = s.ed25519_of(&me)?.ok_or_else(|| err(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    for k in req.one_time_keys.iter().chain(req.fallback_key.iter()) {
        if k.key_id.is_empty() || k.key_id.len() > 64 {
            return Err(err(StatusCode::BAD_REQUEST, "bad_key_id"));
        }
        let mut msg = b"privatum-otk-v1".to_vec();
        msg.extend_from_slice(&b64_fixed::<32>(&k.key)?);
        verify(&ed, &msg, &k.signature)?;
    }

    let db = lock(&s.db);
    let stored: i64 = db
        .query_row("SELECT COUNT(*) FROM one_time_keys WHERE mailbox_id = ?1", [&me], |r| r.get(0))
        .map_err(db_err)?;
    if stored + req.one_time_keys.len() as i64 > MAX_ONE_TIME_KEYS {
        return Err(err(StatusCode::BAD_REQUEST, "too_many_keys"));
    }
    for k in &req.one_time_keys {
        db.execute(
            "INSERT OR IGNORE INTO one_time_keys (mailbox_id, key_id, key, signature) VALUES (?1, ?2, ?3, ?4)",
            params![me, k.key_id, k.key, k.signature],
        )
        .map_err(db_err)?;
    }
    if let Some(k) = &req.fallback_key {
        db.execute(
            "INSERT OR REPLACE INTO fallback_keys (mailbox_id, key_id, key, signature) VALUES (?1, ?2, ?3, ?4)",
            params![me, k.key_id, k.key, k.signature],
        )
        .map_err(db_err)?;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn get_keys(State(s): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Result<Response, Response> {
    let me = s.authed(&headers)?;
    s.rate(&format!("fetch:{me}"), 60.0)?;
    let db = lock(&s.db);
    let identity: Option<(String, String)> = db
        .query_row("SELECT ed25519, curve25519 FROM mailboxes WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(db_err)?;
    let (ed25519, curve25519) = identity.ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    let row = |r: &rusqlite::Row| Ok(SignedKey { key_id: r.get(0)?, key: r.get(1)?, signature: r.get(2)? });
    let one_time_key = db
        .query_row(
            "DELETE FROM one_time_keys WHERE rowid = (
                 SELECT rowid FROM one_time_keys WHERE mailbox_id = ?1 ORDER BY rowid LIMIT 1)
             RETURNING key_id, key, signature",
            [&id],
            row,
        )
        .optional()
        .map_err(db_err)?;
    let fallback_key = db
        .query_row("SELECT key_id, key, signature FROM fallback_keys WHERE mailbox_id = ?1", [&id], row)
        .optional()
        .map_err(db_err)?;
    Ok(Json(serde_json::json!({
        "mailbox_id": id,
        "ed25519": ed25519,
        "curve25519": curve25519,
        "one_time_key": one_time_key,
        "fallback_key": fallback_key,
    }))
    .into_response())
}

#[derive(Deserialize)]
struct PostMessageReq {
    to: String,
    envelope: String,
}

async fn post_message(State(s): State<Shared>, headers: HeaderMap, Json(req): Json<PostMessageReq>) -> Result<Response, Response> {
    let me = s.authed(&headers)?;
    s.rate(&format!("send:{me}"), 120.0)?;
    if req.envelope.is_empty() || req.envelope.len() > MAX_ENVELOPE {
        return Err(err(StatusCode::BAD_REQUEST, "bad_envelope"));
    }
    let id = {
        let db = lock(&s.db);
        let exists: bool = db
            .query_row("SELECT EXISTS(SELECT 1 FROM mailboxes WHERE id = ?1)", [&req.to], |r| r.get(0))
            .map_err(db_err)?;
        if !exists {
            return Err(err(StatusCode::NOT_FOUND, "not_found"));
        }
        let pending: i64 = db
            .query_row("SELECT COUNT(*) FROM messages WHERE to_mailbox = ?1", [&req.to], |r| r.get(0))
            .map_err(db_err)?;
        if pending >= MAX_PENDING_PER_MAILBOX {
            return Err(err(StatusCode::TOO_MANY_REQUESTS, "mailbox_full"));
        }
        db.execute(
            "INSERT INTO messages (to_mailbox, from_mailbox, envelope, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![req.to, me, req.envelope, now_unix()],
        )
        .map_err(db_err)?;
        db.last_insert_rowid()
    };
    let _ = s.notify.send(req.to);
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response())
}

async fn delete_message(State(s): State<Shared>, headers: HeaderMap, Path(id): Path<i64>) -> Result<Response, Response> {
    let me = s.authed(&headers)?;
    let deleted = lock(&s.db)
        .execute("DELETE FROM messages WHERE id = ?1 AND to_mailbox = ?2", params![id, me])
        .map_err(db_err)?;
    if deleted == 0 {
        return Err(err(StatusCode::NOT_FOUND, "not_found"));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize)]
struct WsAuth {
    token: String,
}

#[derive(Serialize)]
struct Delivered {
    id: i64,
    from: String,
    envelope: String,
    created_at: i64,
}

// Browsers cannot set headers on a WebSocket, so the token is the first frame
// (not a query parameter, which would end up in URLs and logs).
async fn inbox(State(s): State<Shared>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(4096).on_upgrade(move |sock| inbox_loop(s, sock))
}

async fn inbox_loop(s: Shared, mut sock: WebSocket) {
    let first = tokio::time::timeout(Duration::from_secs(10), sock.recv()).await;
    let auth = match first {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<WsAuth>(&t).ok(),
        _ => None,
    };
    let Some((mailbox, expires)) = auth.and_then(|a| s.lookup_token(&a.token)) else {
        let _ = sock.send(Message::Close(None)).await;
        return;
    };
    // Subscribe before the first read so nothing sent in between is missed.
    let mut rx = s.notify.subscribe();
    let mut last_id = 0;
    if !send_pending(&s, &mut sock, &mailbox, &mut last_id).await {
        return;
    }
    let deadline = tokio::time::sleep_until(tokio::time::Instant::from_std(expires));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            note = rx.recv() => match note {
                Ok(to) if to != mailbox => {}
                Err(broadcast::error::RecvError::Closed) => break,
                // Our mailbox, or lagged (may have missed ours): re-read from the DB.
                _ => if !send_pending(&s, &mut sock, &mailbox, &mut last_id).await { break },
            },
            frame = sock.recv() => match frame {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
        }
    }
    let _ = sock.send(Message::Close(None)).await;
}

async fn send_pending(s: &AppState, sock: &mut WebSocket, mailbox: &str, last_id: &mut i64) -> bool {
    let rows: Vec<Delivered> = {
        let db = lock(&s.db);
        let Ok(mut stmt) = db.prepare(
            "SELECT id, from_mailbox, envelope, created_at FROM messages
             WHERE to_mailbox = ?1 AND id > ?2 ORDER BY id",
        ) else {
            return false;
        };
        let Ok(rows) = stmt.query_map(params![mailbox, *last_id], |r| {
            Ok(Delivered { id: r.get(0)?, from: r.get(1)?, envelope: r.get(2)?, created_at: r.get(3)? })
        }) else {
            return false;
        };
        rows.filter_map(Result::ok).collect()
    };
    for m in rows {
        *last_id = m.id;
        let Ok(text) = serde_json::to_string(&m) else { return false };
        if sock.send(Message::Text(text.into())).await.is_err() {
            return false;
        }
    }
    true
}
