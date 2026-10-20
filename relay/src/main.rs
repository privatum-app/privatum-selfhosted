use std::{env, time::Duration};

use privatum_relay::{app, open_state, Config};

fn env_or<T: std::str::FromStr>(name: &str, default: T) -> T {
    env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// The onion hostname comes from PRIVATUM_HOST, or from a file written by the
/// tor container (PRIVATUM_HOST_FILE), which may appear a few seconds after boot.
async fn resolve_host() -> String {
    if let Ok(host) = env::var("PRIVATUM_HOST") {
        return host.trim().to_owned();
    }
    let path = env::var("PRIVATUM_HOST_FILE").unwrap_or_else(|_| {
        eprintln!("fatal: set PRIVATUM_HOST or PRIVATUM_HOST_FILE");
        std::process::exit(2);
    });
    for _ in 0..120 {
        if let Ok(host) = std::fs::read_to_string(&path) {
            if !host.trim().is_empty() {
                return host.trim().to_owned();
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    eprintln!("fatal: {path} did not appear within 120s");
    std::process::exit(2);
}

#[tokio::main]
async fn main() {
    let cfg = Config {
        host: resolve_host().await,
        db_path: env::var("PRIVATUM_DB").unwrap_or_else(|_| "/data/relay.sqlite".into()),
        message_ttl_days: env_or("PRIVATUM_MESSAGE_TTL_DAYS", 14),
        max_mailboxes: env_or("PRIVATUM_MAX_MAILBOXES", 10_000),
    };
    let state = open_state(&cfg).unwrap_or_else(|e| {
        eprintln!("fatal: cannot open database: {e}");
        std::process::exit(1);
    });

    let cleaner = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(600));
        loop {
            tick.tick().await;
            cleaner.cleanup();
        }
    });

    let static_dir = env::var("PRIVATUM_STATIC_DIR").ok();
    let router = app(state, static_dir.as_deref());
    let listen = env::var("PRIVATUM_LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&listen).await.unwrap_or_else(|e| {
        eprintln!("fatal: cannot listen on {listen}: {e}");
        std::process::exit(1);
    });
    // No request logging on purpose: the relay keeps no access logs (THREAT-MODEL L3).
    eprintln!("privatum-relay listening on {listen}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            // docker stop sends SIGTERM; Ctrl-C sends SIGINT.
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
        })
        .await
        .unwrap_or_else(|e| eprintln!("server error: {e}"));
}
