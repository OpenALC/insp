use insp_sync_server::{router, Store};
use std::{env, fs, path::PathBuf, sync::Arc};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = PathBuf::from(env::var("INSP_DATA_DIR").unwrap_or_else(|_| "./data".into()));
    fs::create_dir_all(&directory)?;
    let store = Arc::new(Store::open(directory.join("sync.sqlite3"))?);
    let address = env::var("INSP_LISTEN").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("Insp sync listening on {}", listener.local_addr()?);
    axum::serve(listener, router(store))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
