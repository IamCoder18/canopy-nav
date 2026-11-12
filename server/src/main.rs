use canopy_packserver::{
    Result,
    admin::{self, Admin},
    api,
    config::Config,
    jobs::State,
};
use clap::{Parser, Subcommand};
#[derive(Parser)]
#[command(name = "packserver", version)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}
#[derive(Subcommand)]
enum Command {
    Serve,
    #[command(subcommand)]
    Admin(Admin),
}
#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("{}: {} {}", e.code, e.message, e.detail);
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let cli = Cli::parse();
    let config = Config::from_env()?;
    if let Some(Command::Admin(cmd)) = cli.command {
        return admin::run(config, cmd);
    }
    let _lock = admin::server_lock(&config)?;
    let port = config.port;
    let state = State::new(config);
    state.sweep()?;
    let s = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            let s = s.clone();
            let _ = tokio::task::spawn_blocking(move || s.sweep()).await;
        }
    });
    // Caddy terminates public IPv6 TLS; container listens dual-stack internally.
    let listener = tokio::net::TcpListener::bind((std::net::Ipv6Addr::UNSPECIFIED, port)).await?;
    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
