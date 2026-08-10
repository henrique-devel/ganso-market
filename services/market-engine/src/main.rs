use std::process::ExitCode;

use ganso_market_engine::{RuntimeConfig, init_json_logging, run};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[tokio::main]
async fn main() -> ExitCode {
    let config = match RuntimeConfig::load_from_process() {
        Ok(config) => config,
        Err(error) => {
            let event = serde_json::json!({
                "timestamp": OffsetDateTime::now_utc()
                    .format(&Rfc3339)
                    .expect("current UTC timestamp must be representable as RFC3339"),
                "level": "ERROR",
                "service": "market-engine",
                "reason_code": "CONFIG_INVALID",
                "message": error.to_string(),
            });
            eprintln!("{event}");
            return ExitCode::FAILURE;
        }
    };

    init_json_logging(config.log_level());
    match run(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(
                service = "market-engine",
                reason_code = error.reason_code(),
                error = %error,
                "market-engine terminated"
            );
            ExitCode::FAILURE
        }
    }
}
