//! Local management panel. Compose publishes it on 127.0.0.1 only; the onion service
//! never forwards to it. It reaches tor through tor's control socket (in tor's own
//! volume) and the relay through its internal admin API. It never gets the Docker socket.

use std::{
    collections::HashMap,
    env,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use data_encoding::{BASE32, BASE64URL_NOPAD, BASE64_NOPAD, HEXLOWER};
use ed25519_dalek::{hazmat::ExpandedSecretKey, VerifyingKey};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UnixStream},
    time::timeout,
};
use tower_http::services::{ServeDir, ServeFile};

const SESSION_TTL: Duration = Duration::from_secs(12 * 3600);
const MIN_PASSWORD: usize = 10;
const COOKIE: &str = "privatum_admin";
const IO_TIMEOUT: Duration = Duration::from_secs(5);
// Files tor keeps in HiddenServiceDir for a v3 onion service.
const SECRET_FILE: &str = "hs_ed25519_secret_key";
const PUBLIC_FILE: &str = "hs_ed25519_public_key";
const HOSTNAME_FILE: &str = "hostname";
const SECRET_HEADER: &[u8; 32] = b"== ed25519v1-secret: type0 ==\0\0\0";
const PUBLIC_HEADER: &[u8; 32] = b"== ed25519v1-public: type0 ==\0\0\0";

struct Admin {
    /// Holds the password hash (argon2id, PHC string).
    data_dir: PathBuf,
    /// tor's /var/lib/tor: hs/ keys, control/ socket and cookie.
    tor_dir: PathBuf,
    /// host:port of the relay's internal admin API.
    relay: String,
    token_file: PathBuf,
    sessions: Mutex<HashMap<[u8; 32], Instant>>,
    /// Failed logins in the current minute.
    failures: Mutex<(u32, Instant)>,
}

type Shared = Arc<Admin>;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn err(code: StatusCode, msg: &'static str) -> Response {
    (code, Json(json!({ "error": msg }))).into_response()
}

fn random_token() -> String {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    BASE64URL_NOPAD.encode(&b)
}

/// Writes through a temp file and rename, so readers never see half a file.
fn write_atomic(path: &Path, contents: &[u8], mode: u32) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(&tmp)?;
    f.write_all(contents)?;
    f.sync_all()?;
    std::fs::rename(tmp, path)
}

/// Only requests addressed to this machine by name are served: a page on another site
/// that resolves its own domain to 127.0.0.1 (DNS rebinding) is turned away here.
fn local_host(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else { return false };
    let name = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(""),
    };
    matches!(name, "localhost" | "127.0.0.1" | "::1")
}

async fn guard(req: Request, next: Next) -> Response {
    if !local_host(req.headers()) {
        return err(StatusCode::FORBIDDEN, "forbidden_host");
    }
    // A custom header cannot be sent cross-site without a CORS preflight, which we never
    // answer: together with the SameSite cookie this blocks request forgery.
    let mutating = !matches!(*req.method(), Method::GET | Method::HEAD);
    if mutating && req.headers().get("x-privatum-admin").map(|v| v.as_bytes()) != Some(b"1") {
        return err(StatusCode::FORBIDDEN, "missing_header");
    }
    next.run(req).await
}

impl Admin {
    fn password_file(&self) -> PathBuf {
        self.data_dir.join("password")
    }

    fn configured(&self) -> bool {
        std::fs::metadata(self.password_file()).map(|m| m.len() > 0).unwrap_or(false)
    }

    fn session_of(headers: &HeaderMap) -> Option<[u8; 32]> {
        let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
        let token = cookies.split(';').find_map(|c| c.trim().strip_prefix(&format!("{COOKIE}=")))?;
        Some(Sha256::digest(token.as_bytes()).into())
    }

    fn authed(&self, headers: &HeaderMap) -> Result<(), Response> {
        let now = Instant::now();
        let mut sessions = lock(&self.sessions);
        sessions.retain(|_, exp| *exp > now);
        match Self::session_of(headers) {
            Some(id) if sessions.contains_key(&id) => Ok(()),
            _ => Err(err(StatusCode::UNAUTHORIZED, "unauthorized")),
        }
    }

    fn new_session(&self) -> Response {
        let token = random_token();
        let id: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        lock(&self.sessions).insert(id, Instant::now() + SESSION_TTL);
        let cookie = format!("{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}", SESSION_TTL.as_secs());
        let mut res = Json(json!({ "ok": true })).into_response();
        res.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).expect("ascii cookie"));
        res
    }

    /// Creates the token the relay checks, once; the relay reads it on every call.
    fn ensure_relay_token(&self) -> std::io::Result<()> {
        let existing = std::fs::read_to_string(&self.token_file).unwrap_or_default();
        if existing.trim().is_empty() {
            write_atomic(&self.token_file, random_token().as_bytes(), 0o644)?;
        }
        Ok(())
    }

    /// Sends one command to tor's control socket and returns its reply lines.
    async fn tor(&self, command: &str) -> Result<Vec<String>, &'static str> {
        let cookie = tokio::fs::read(self.tor_dir.join("control/cookie")).await.map_err(|_| "tor_unavailable")?;
        let run = async {
            let mut stream = UnixStream::connect(self.tor_dir.join("control/sock")).await.ok()?;
            let script = format!("AUTHENTICATE {}\r\n{command}\r\nQUIT\r\n", HEXLOWER.encode(&cookie));
            stream.write_all(script.as_bytes()).await.ok()?;
            let mut out = String::new();
            stream.read_to_string(&mut out).await.ok()?;
            Some(out)
        };
        let out = timeout(IO_TIMEOUT, run).await.ok().flatten().ok_or("tor_unavailable")?;
        let mut lines = out.lines().map(str::to_owned);
        if lines.next().as_deref() != Some("250 OK") {
            return Err("tor_auth_failed");
        }
        Ok(lines.collect())
    }

    /// Calls the relay's internal API. A JSON body means POST. Relay errors (4xx) come back
    /// as their error code so the panel can show them.
    // shortcut: hand-written HTTP/1.1 for small fixed-length JSON replies; use a real client if the API grows.
    async fn relay_call(&self, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let unavailable = || "relay_unavailable".to_owned();
        let token = std::fs::read_to_string(&self.token_file).map_err(|_| unavailable())?;
        let run = async {
            let mut stream = TcpStream::connect(&self.relay).await.ok()?;
            let (method, payload) = match body {
                Some(b) => ("POST", b.to_string()),
                None => ("GET", String::new()),
            };
            let req = format!(
                "{method} {path} HTTP/1.1\r\nHost: relay\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                token.trim(),
                payload.len()
            );
            stream.write_all(req.as_bytes()).await.ok()?;
            let mut out = Vec::new();
            stream.read_to_end(&mut out).await.ok()?;
            Some(out)
        };
        let out = timeout(IO_TIMEOUT, run).await.ok().flatten().ok_or_else(unavailable)?;
        let split = out.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(unavailable)?;
        let json: Value = serde_json::from_slice(&out[split + 4..]).map_err(|_| unavailable())?;
        if out.starts_with(b"HTTP/1.1 200 ") {
            Ok(json)
        } else if out.starts_with(b"HTTP/1.1 4") {
            Err(json["error"].as_str().map(str::to_owned).unwrap_or_else(unavailable))
        } else {
            Err(unavailable())
        }
    }

    /// Authenticated pass-through to the relay, which validates the request itself.
    async fn relay_for(&self, headers: &HeaderMap, path: &str, body: Option<&Value>) -> Response {
        if let Err(e) = self.authed(headers) {
            return e;
        }
        match self.relay_call(path, body).await {
            Ok(v) => Json(v).into_response(),
            Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
        }
    }

    /// tor exits at once; Docker's restart policy starts it again with the files now in hs/.
    async fn restart_tor(&self) -> Response {
        match self.tor("SIGNAL HALT").await {
            Ok(_) => Json(json!({ "ok": true })).into_response(),
            Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, e),
        }
    }

    fn onion(&self) -> Option<String> {
        let host = std::fs::read_to_string(self.tor_dir.join("hs/hostname")).ok()?;
        let host = host.trim();
        (host.len() == 62 && host.ends_with(".onion")).then(|| host.to_owned())
    }
}

/// Refuses a key set tor would not accept, or whose parts do not belong together, before
/// anything is written: the secret key must yield the public key, and the hostname must
/// carry that same public key (version 3).
fn check_onion_key(secret: &[u8], public: &[u8], hostname: &str) -> Result<(), &'static str> {
    if secret.len() != 96 || !secret.starts_with(SECRET_HEADER) || public.len() != 64 || !public.starts_with(PUBLIC_HEADER) {
        return Err("bad_key_files");
    }
    let expanded: [u8; 64] = secret[32..].try_into().map_err(|_| "bad_key_files")?;
    let derived = VerifyingKey::from(&ExpandedSecretKey::from_bytes(&expanded));
    if derived.as_bytes() != &public[32..] {
        return Err("key_mismatch");
    }
    let label = hostname.strip_suffix(".onion").filter(|l| l.len() == 56).ok_or("bad_hostname")?;
    let raw = BASE32.decode(label.to_ascii_uppercase().as_bytes()).map_err(|_| "bad_hostname")?;
    if raw.len() != 35 || raw[..32] != public[32..] || raw[34] != 3 {
        return Err("key_mismatch");
    }
    Ok(())
}

/// From `status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY="Done"`.
fn parse_bootstrap(lines: &[String]) -> Option<(u8, String)> {
    let line = lines.iter().find(|l| l.contains("status/bootstrap-phase="))?;
    let progress = line.split("PROGRESS=").nth(1)?.split(' ').next()?.parse().ok()?;
    let summary = line.split("SUMMARY=\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or("").to_owned();
    Some((progress, summary))
}

async fn session(State(a): State<Shared>, headers: HeaderMap) -> Json<Value> {
    Json(json!({ "configured": a.configured(), "logged_in": a.authed(&headers).is_ok() }))
}

#[derive(Deserialize)]
struct PasswordReq {
    password: String,
}

async fn setup(State(a): State<Shared>, Json(req): Json<PasswordReq>) -> Response {
    if a.configured() {
        return err(StatusCode::CONFLICT, "already_configured");
    }
    if req.password.chars().count() < MIN_PASSWORD {
        return err(StatusCode::BAD_REQUEST, "short_password");
    }
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let Ok(salt) = SaltString::encode_b64(&salt) else { return err(StatusCode::INTERNAL_SERVER_ERROR, "internal") };
    let Ok(hash) = Argon2::default().hash_password(req.password.as_bytes(), &salt) else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "internal");
    };
    if write_atomic(&a.password_file(), hash.to_string().as_bytes(), 0o600).is_err() {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "cannot_save");
    }
    a.new_session()
}

async fn login(State(a): State<Shared>, Json(req): Json<PasswordReq>) -> Response {
    {
        let mut f = lock(&a.failures);
        if f.1.elapsed() > Duration::from_secs(60) {
            *f = (0, Instant::now());
        }
        if f.0 >= 10 {
            return err(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
        }
    }
    let stored = std::fs::read_to_string(a.password_file()).unwrap_or_default();
    let ok = PasswordHash::new(stored.trim())
        .map(|h| Argon2::default().verify_password(req.password.as_bytes(), &h).is_ok())
        .unwrap_or(false);
    if !ok {
        lock(&a.failures).0 += 1;
        return err(StatusCode::UNAUTHORIZED, "wrong_password");
    }
    a.new_session()
}

async fn logout(State(a): State<Shared>, headers: HeaderMap) -> Response {
    if let Some(id) = Admin::session_of(&headers) {
        lock(&a.sessions).remove(&id);
    }
    let mut res = Json(json!({ "ok": true })).into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("privatum_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"),
    );
    res
}

async fn status(State(a): State<Shared>, headers: HeaderMap) -> Result<Json<Value>, Response> {
    a.authed(&headers)?;
    let tor = match a.tor("GETINFO status/bootstrap-phase").await {
        Ok(lines) => match parse_bootstrap(&lines) {
            Some((progress, summary)) => json!({ "ok": true, "progress": progress, "summary": summary }),
            None => json!({ "ok": false, "error": "tor_unexpected_reply" }),
        },
        Err(e) => json!({ "ok": false, "error": e }),
    };
    let relay = match a.relay_call("/admin/stats", None).await {
        Ok(mut v) => {
            v["ok"] = json!(true);
            v
        }
        Err(e) => json!({ "ok": false, "error": e }),
    };
    Ok(Json(json!({ "onion": a.onion(), "tor": tor, "relay": relay, "version": env!("CARGO_PKG_VERSION") })))
}

/// Returns the onion key files for the browser to encrypt into a backup.
async fn onion_export(State(a): State<Shared>, headers: HeaderMap) -> Result<Json<Value>, Response> {
    a.authed(&headers)?;
    let read = |name: &str| std::fs::read(a.tor_dir.join("hs").join(name));
    let (Ok(secret), Ok(public), Some(hostname)) = (read(SECRET_FILE), read(PUBLIC_FILE), a.onion()) else {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, "no_key_yet"));
    };
    Ok(Json(json!({
        "hostname": hostname,
        "secret_key": BASE64_NOPAD.encode(&secret),
        "public_key": BASE64_NOPAD.encode(&public),
    })))
}

#[derive(Deserialize)]
struct RestoreReq {
    hostname: String,
    secret_key: String,
    public_key: String,
}

/// Replaces the onion key and restarts tor, which then serves the restored address.
async fn onion_restore(State(a): State<Shared>, headers: HeaderMap, Json(req): Json<RestoreReq>) -> Response {
    if let Err(e) = a.authed(&headers) {
        return e;
    }
    let decode = |s: &str| BASE64_NOPAD.decode(s.as_bytes()).map_err(|_| "bad_key_files");
    let checked = (|| {
        let (secret, public) = (decode(&req.secret_key)?, decode(&req.public_key)?);
        check_onion_key(&secret, &public, req.hostname.trim())?;
        Ok::<_, &'static str>((secret, public))
    })();
    let (secret, public) = match checked {
        Ok(k) => k,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let hs = a.tor_dir.join("hs");
    let written = write_atomic(&hs.join(SECRET_FILE), &secret, 0o600)
        .and_then(|_| write_atomic(&hs.join(PUBLIC_FILE), &public, 0o600))
        .and_then(|_| write_atomic(&hs.join(HOSTNAME_FILE), format!("{}\n", req.hostname.trim()).as_bytes(), 0o600));
    if written.is_err() {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "cannot_save");
    }
    a.restart_tor().await
}

#[derive(Deserialize)]
struct RotateReq {
    confirm: String,
}

/// Deletes the onion key and restarts tor, which then creates a new address. Irreversible
/// without a backup, hence the typed confirmation.
async fn onion_rotate(State(a): State<Shared>, headers: HeaderMap, Json(req): Json<RotateReq>) -> Response {
    if let Err(e) = a.authed(&headers) {
        return e;
    }
    if req.confirm != "TROCAR" {
        return err(StatusCode::BAD_REQUEST, "not_confirmed");
    }
    let hs = a.tor_dir.join("hs");
    for name in [SECRET_FILE, PUBLIC_FILE, HOSTNAME_FILE] {
        match std::fs::remove_file(hs.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "cannot_delete"),
        }
    }
    a.restart_tor().await
}

async fn access(State(a): State<Shared>, headers: HeaderMap) -> Response {
    a.relay_for(&headers, "/admin/access", None).await
}

async fn set_registration(State(a): State<Shared>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    a.relay_for(&headers, "/admin/registration", Some(&body)).await
}

async fn revoke_invite(State(a): State<Shared>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    a.relay_for(&headers, "/admin/invites/revoke", Some(&body)).await
}

async fn remove_mailbox(State(a): State<Shared>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    a.relay_for(&headers, "/admin/mailboxes/remove", Some(&body)).await
}

/// New admin code, returned once as a ready link (the relay keeps only its hash).
async fn new_invite(State(a): State<Shared>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if let Err(e) = a.authed(&headers) {
        return e;
    }
    let Some(onion) = a.onion() else { return err(StatusCode::SERVICE_UNAVAILABLE, "no_key_yet") };
    match a.relay_call("/admin/invites", Some(&body)).await {
        Ok(v) => {
            let code = v["code"].as_str().unwrap_or_default();
            Json(json!({ "code": code, "link": format!("http://{onion}/#r={code}") })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
    }
}

fn app(state: Shared, static_dir: &str) -> Router {
    let api = Router::new()
        .route("/api/session", get(session))
        .route("/api/setup", post(setup))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/status", get(status))
        .route("/api/onion/export", post(onion_export))
        .route("/api/onion/restore", post(onion_restore))
        .route("/api/onion/rotate", post(onion_rotate))
        .route("/api/access", get(access))
        .route("/api/access/registration", post(set_registration))
        .route("/api/access/invites", post(new_invite))
        .route("/api/access/invites/revoke", post(revoke_invite))
        .route("/api/access/mailboxes/remove", post(remove_mailbox))
        .with_state(state);
    // Vite keeps the entry's name (admin.html); every non-asset path shows the panel.
    let page = ServeDir::new(static_dir)
        .append_index_html_on_directories(false)
        .fallback(ServeFile::new(format!("{static_dir}/admin.html")));
    privatum_relay::harden(api.fallback_service(page).layer(middleware::from_fn(guard)))
}

#[tokio::main]
async fn main() {
    let var = |name: &str, default: &str| env::var(name).unwrap_or_else(|_| default.into());
    let admin = Arc::new(Admin {
        data_dir: var("PRIVATUM_ADMIN_DATA", "/admin").into(),
        tor_dir: var("PRIVATUM_TOR_DIR", "/tor").into(),
        relay: var("PRIVATUM_RELAY_ADMIN", "172.30.0.10:8081"),
        token_file: var("PRIVATUM_ADMIN_TOKEN_FILE", "/run/admin-token/token").into(),
        sessions: Mutex::new(HashMap::new()),
        failures: Mutex::new((0, Instant::now())),
    });
    if let Err(e) = admin.ensure_relay_token() {
        eprintln!("fatal: cannot write {}: {e}", admin.token_file.display());
        std::process::exit(1);
    }
    let listen = var("PRIVATUM_ADMIN_LISTEN", "0.0.0.0:8080");
    let listener = tokio::net::TcpListener::bind(&listen).await.unwrap_or_else(|e| {
        eprintln!("fatal: cannot listen on {listen}: {e}");
        std::process::exit(1);
    });
    let port = env::var("PRIVATUM_INFO_PORT").unwrap_or_else(|_| "8099".into());
    eprintln!("painel do Privatum: http://127.0.0.1:{port} (só neste computador)");
    if let Err(e) = axum::serve(listener, app(admin, &var("PRIVATUM_ADMIN_STATIC", "/srv/admin"))).await {
        eprintln!("server error: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(v: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_str(v).unwrap());
        h
    }

    #[test]
    fn only_local_names_are_accepted() {
        for ok in ["localhost:8099", "127.0.0.1:8099", "[::1]:8099", "localhost"] {
            assert!(local_host(&host(ok)), "{ok}");
        }
        for bad in ["evil.example:8099", "127.0.0.1.evil.example", "localhost.evil.example", "192.168.0.5:8099"] {
            assert!(!local_host(&host(bad)), "{bad}");
        }
        assert!(!local_host(&HeaderMap::new()));
    }

    /// A key set laid out exactly as tor writes it.
    fn tor_files(seed: u8) -> (Vec<u8>, Vec<u8>, String) {
        // tor stores SHA-512(seed) with the lower half clamped but not reduced.
        let mut h: [u8; 64] = sha2::Sha512::digest([seed; 32]).into();
        h[0] &= 248;
        h[31] &= 127;
        h[31] |= 64;
        let public = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]).verifying_key();
        let secret = [&SECRET_HEADER[..], &h[..]].concat();
        let public_file = [&PUBLIC_HEADER[..], public.as_bytes()].concat();
        // Checksum bytes are not checked here (tor recomputes them); version must be 3.
        let raw = [&public.as_bytes()[..], &[0, 0, 3]].concat();
        let hostname = format!("{}.onion", BASE32.encode(&raw).to_ascii_lowercase());
        (secret, public_file, hostname)
    }

    #[test]
    fn onion_key_parts_must_belong_together() {
        let (secret, public, hostname) = tor_files(7);
        assert_eq!(check_onion_key(&secret, &public, &hostname), Ok(()));
        let (other_secret, other_public, other_hostname) = tor_files(8);
        assert_eq!(check_onion_key(&other_secret, &public, &hostname), Err("key_mismatch"));
        assert_eq!(check_onion_key(&secret, &public, &other_hostname), Err("key_mismatch"));
        assert_eq!(check_onion_key(&secret, &other_public, &hostname), Err("key_mismatch"));
        assert_eq!(check_onion_key(&secret[..95], &public, &hostname), Err("bad_key_files"));
        let mut no_header = secret.clone();
        no_header[3] = b'X';
        assert_eq!(check_onion_key(&no_header, &public, &hostname), Err("bad_key_files"));
        assert_eq!(check_onion_key(&secret, &public, "short.onion"), Err("bad_hostname"));
    }

    #[test]
    fn reads_tor_bootstrap_reply() {
        let lines = vec![
            "250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY=\"Done\"".to_owned(),
            "250 OK".to_owned(),
        ];
        assert_eq!(parse_bootstrap(&lines), Some((100, "Done".to_owned())));
        assert_eq!(parse_bootstrap(&["250 OK".to_owned()]), None);
    }
}
