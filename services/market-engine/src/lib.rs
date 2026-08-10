pub mod config;
pub mod http;

use std::{error::Error, fmt, future::Future, io, sync::Arc};

use http::{ProbeError, ProbeFuture, ReadinessProbe};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_postgres::NoTls;
use tracing::level_filters::LevelFilter;

pub use config::{
    CONFIG_FILE_ENV, ConfigError, DEFAULT_CONFIG_FILE, ExecutionMode, LogLevel,
    POSTGRES_PASSWORD_FILE_ENV, RuntimeConfig, SecretString,
};
pub use http::{CORRELATION_ID_HEADER, ReasonCode};

const POSTGRES_PROBE_QUERY: &str = "SELECT 1";

struct PostgresProbe {
    connection: tokio_postgres::Config,
}

impl PostgresProbe {
    fn from_runtime_config(config: &RuntimeConfig) -> Self {
        let mut connection = tokio_postgres::Config::new();
        connection
            .host(&config.postgres.host)
            .port(config.postgres.port)
            .user(&config.postgres.user)
            .password(config.postgres_password.expose_secret())
            .dbname(&config.postgres.database)
            .application_name("ganso-market-engine")
            .connect_timeout(config.readiness_timeout());
        Self { connection }
    }
}

impl ReadinessProbe for PostgresProbe {
    fn check(&self) -> ProbeFuture<'_> {
        Box::pin(async move {
            let (client, connection) = self
                .connection
                .connect(NoTls)
                .await
                .map_err(|_| ProbeError::DependencyUnavailable)?;
            let connection_task = AbortOnDrop::new(tokio::spawn(async move {
                let _ = connection.await;
            }));

            let row = client
                .query_one(POSTGRES_PROBE_QUERY, &[])
                .await
                .map_err(|_| ProbeError::DependencyUnavailable)?;
            let value = row
                .try_get::<usize, i32>(0)
                .map_err(|_| ProbeError::UnexpectedResponse)?;
            drop(client);
            drop(connection_task);

            if value == 1 {
                Ok(())
            } else {
                Err(ProbeError::UnexpectedResponse)
            }
        })
    }
}

struct AbortOnDrop {
    handle: JoinHandle<()>,
}

impl AbortOnDrop {
    fn new(handle: JoinHandle<()>) -> Self {
        Self { handle }
    }
}

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

#[derive(Debug)]
pub enum RunError {
    Bind(io::ErrorKind),
    SignalRegistration(io::ErrorKind),
    Serve(io::ErrorKind),
}

impl RunError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Bind(_) => "HTTP_BIND_FAILED",
            Self::SignalRegistration(_) => "SIGNAL_REGISTRATION_FAILED",
            Self::Serve(_) => "HTTP_SERVE_FAILED",
        }
    }
}

impl fmt::Display for RunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bind(kind) => write!(formatter, "cannot bind HTTP listener ({kind})"),
            Self::SignalRegistration(kind) => {
                write!(formatter, "cannot register shutdown signals ({kind})")
            }
            Self::Serve(kind) => write!(formatter, "HTTP server failed ({kind})"),
        }
    }
}

impl Error for RunError {}

pub fn init_json_logging(level: LogLevel) {
    let level = match level {
        LogLevel::Error => LevelFilter::ERROR,
        LogLevel::Warn => LevelFilter::WARN,
        LogLevel::Info => LevelFilter::INFO,
        LogLevel::Debug => LevelFilter::DEBUG,
    };

    tracing_subscriber::fmt()
        .json()
        .with_max_level(level)
        .with_target(false)
        .with_current_span(true)
        .with_span_list(true)
        .init();
}

pub async fn run(config: RuntimeConfig) -> Result<(), RunError> {
    let bind_address = config.bind_address();
    let readiness_timeout = config.readiness_timeout();
    let execution_mode = config.execution_mode();
    let probe: Arc<dyn ReadinessProbe> = Arc::new(PostgresProbe::from_runtime_config(&config));
    let listener = TcpListener::bind(bind_address)
        .await
        .map_err(|error| RunError::Bind(error.kind()))?;
    let shutdown = shutdown_signal().map_err(|error| RunError::SignalRegistration(error.kind()))?;

    tracing::info!(
        service = "market-engine",
        bind_address = %bind_address,
        execution_mode = %config.execution_mode(),
        "market-engine started"
    );

    axum::serve(
        listener,
        http::router(probe, readiness_timeout, execution_mode),
    )
    .with_graceful_shutdown(shutdown)
    .await
    .map_err(|error| RunError::Serve(error.kind()))?;

    tracing::info!(service = "market-engine", "market-engine stopped");
    Ok(())
}

#[cfg(unix)]
fn shutdown_signal() -> io::Result<impl Future<Output = ()>> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    Ok(async move {
        tokio::select! {
            _ = interrupt.recv() => {
                tracing::info!(service = "market-engine", reason_code = "SIGINT_RECEIVED", "graceful shutdown requested");
            }
            _ = terminate.recv() => {
                tracing::info!(service = "market-engine", reason_code = "SIGTERM_RECEIVED", "graceful shutdown requested");
            }
        }
    })
}

#[cfg(not(unix))]
fn shutdown_signal() -> io::Result<impl Future<Output = ()>> {
    Ok(async move {
        match tokio::signal::ctrl_c().await {
            Ok(()) => {
                tracing::info!(
                    service = "market-engine",
                    reason_code = "SIGINT_RECEIVED",
                    "graceful shutdown requested"
                );
            }
            Err(error) => {
                tracing::error!(
                    service = "market-engine",
                    reason_code = "SIGNAL_RECEIVE_FAILED",
                    error_kind = %error.kind(),
                    "shutdown signal listener failed"
                );
            }
        }
    })
}
