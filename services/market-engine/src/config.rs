use std::{
    env,
    error::Error,
    ffi::OsString,
    fmt, fs,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration,
};

use serde::{Deserialize, Serialize};

pub const CONFIG_FILE_ENV: &str = "GANSO_CONFIG_FILE";
pub const POSTGRES_PASSWORD_FILE_ENV: &str = "GANSO_POSTGRES_PASSWORD_FILE";
pub const DEFAULT_CONFIG_FILE: &str = "config/runtime.json";

const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_SECRET_BYTES: u64 = 4 * 1024;
const MIN_READINESS_TIMEOUT_MS: u64 = 100;
const MAX_READINESS_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionMode {
    #[default]
    Paper,
}

impl fmt::Display for ExecutionMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("paper")
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    #[default]
    Info,
    Debug,
}

pub struct SecretString(String);

impl SecretString {
    fn new(value: String) -> Self {
        Self(value)
    }

    pub(crate) fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl fmt::Display for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

#[derive(Debug)]
pub struct RuntimeConfig {
    bind_address: SocketAddr,
    execution_mode: ExecutionMode,
    log_level: LogLevel,
    readiness_timeout: Duration,
    pub(crate) postgres: PostgresConfig,
    pub(crate) postgres_password: SecretString,
}

impl RuntimeConfig {
    pub fn load_from_process() -> Result<Self, ConfigError> {
        let config_path = optional_path_from_env(CONFIG_FILE_ENV)?
            .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_FILE));
        let password_path = required_path_from_env(POSTGRES_PASSWORD_FILE_ENV)?;
        Self::load(Some(&config_path), &password_path)
    }

    pub fn load(config_path: Option<&Path>, password_path: &Path) -> Result<Self, ConfigError> {
        let file_config = match config_path {
            Some(path) => read_json_config(path)?,
            None => FileConfig::default(),
        };

        file_config.validate()?;
        let bind_ip = file_config
            .services
            .market_engine
            .bind_address
            .parse::<IpAddr>()
            .map_err(|_| {
                ConfigError::InvalidValue(
                    "services.market_engine.bind_address must be a valid IP address",
                )
            })?;
        let bind_address = SocketAddr::new(bind_ip, file_config.services.market_engine.port);
        let postgres_password = read_secret_file(password_path)?;

        Ok(Self {
            bind_address,
            execution_mode: file_config.execution_mode,
            log_level: file_config.logging.level,
            readiness_timeout: Duration::from_millis(file_config.database.connect_timeout_ms),
            postgres: file_config.database.into(),
            postgres_password,
        })
    }

    pub fn bind_address(&self) -> SocketAddr {
        self.bind_address
    }

    pub fn execution_mode(&self) -> ExecutionMode {
        self.execution_mode
    }

    pub fn readiness_timeout(&self) -> Duration {
        self.readiness_timeout
    }

    pub fn log_level(&self) -> LogLevel {
        self.log_level
    }

    pub fn postgres_host(&self) -> &str {
        &self.postgres.host
    }

    pub fn postgres_port(&self) -> u16 {
        self.postgres.port
    }
}

#[derive(Debug)]
pub enum ConfigError {
    EnvironmentNotUnicode(&'static str),
    MissingEnvironment(&'static str),
    EmptyEnvironment(&'static str),
    FileMetadata {
        kind: std::io::ErrorKind,
    },
    FileTooLarge {
        kind: FileKind,
        maximum_bytes: u64,
    },
    FileRead {
        kind: std::io::ErrorKind,
    },
    InvalidJson {
        line: usize,
        column: usize,
        category: serde_json::error::Category,
    },
    InvalidSecret(&'static str),
    InvalidValue(&'static str),
}

#[derive(Clone, Copy, Debug)]
pub enum FileKind {
    Configuration,
    Secret,
}

impl fmt::Display for FileKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration => formatter.write_str("configuration"),
            Self::Secret => formatter.write_str("secret"),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EnvironmentNotUnicode(name) => {
                write!(formatter, "environment locator {name} is not valid Unicode")
            }
            Self::MissingEnvironment(name) => {
                write!(formatter, "required environment locator {name} is missing")
            }
            Self::EmptyEnvironment(name) => {
                write!(formatter, "environment locator {name} is empty")
            }
            Self::FileMetadata { kind } => {
                write!(formatter, "cannot inspect configuration input ({kind})")
            }
            Self::FileTooLarge {
                kind,
                maximum_bytes,
            } => write!(
                formatter,
                "{kind} input exceeds the {maximum_bytes}-byte limit"
            ),
            Self::FileRead { kind } => {
                write!(formatter, "cannot read configuration input ({kind})")
            }
            Self::InvalidJson {
                line,
                column,
                category,
            } => write!(
                formatter,
                "configuration JSON is invalid at line {line}, column {column} ({category:?})"
            ),
            Self::InvalidSecret(reason) => write!(formatter, "secret file is invalid: {reason}"),
            Self::InvalidValue(reason) => write!(formatter, "configuration is invalid: {reason}"),
        }
    }
}

impl Error for ConfigError {}

#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct FileConfig {
    schema_version: u32,
    execution_mode: ExecutionMode,
    database: DatabaseFileConfig,
    services: ServicesFileConfig,
    logging: LoggingFileConfig,
}

impl Default for FileConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            execution_mode: ExecutionMode::Paper,
            database: DatabaseFileConfig::default(),
            services: ServicesFileConfig::default(),
            logging: LoggingFileConfig::default(),
        }
    }
}

impl FileConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        if self.schema_version != 1 {
            return Err(ConfigError::InvalidValue(
                "schema_version must be exactly 1",
            ));
        }
        if !(MIN_READINESS_TIMEOUT_MS..=MAX_READINESS_TIMEOUT_MS)
            .contains(&self.database.connect_timeout_ms)
        {
            return Err(ConfigError::InvalidValue(
                "database.connect_timeout_ms must be between 100 and 30000",
            ));
        }

        validate_text("database.host", &self.database.host)?;
        validate_text("database.user", &self.database.user)?;
        validate_text("database.name", &self.database.name)?;
        if self.database.port == 0 {
            return Err(ConfigError::InvalidValue(
                "database.port must be greater than zero",
            ));
        }
        validate_service("services.api", &self.services.api)?;
        validate_service("services.market_engine", &self.services.market_engine)?;
        validate_service("services.model_worker", &self.services.model_worker)?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct DatabaseFileConfig {
    host: String,
    port: u16,
    user: String,
    name: String,
    connect_timeout_ms: u64,
}

impl Default for DatabaseFileConfig {
    fn default() -> Self {
        Self {
            host: "postgres".to_owned(),
            port: 5_432,
            user: "ganso_market".to_owned(),
            name: "ganso_market".to_owned(),
            connect_timeout_ms: 1_500,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ServicesFileConfig {
    api: ServiceFileConfig,
    market_engine: ServiceFileConfig,
    model_worker: ServiceFileConfig,
}

impl Default for ServicesFileConfig {
    fn default() -> Self {
        Self {
            api: ServiceFileConfig::new("127.0.0.1", 3_000),
            market_engine: ServiceFileConfig::new("127.0.0.1", 8_081),
            model_worker: ServiceFileConfig::new("127.0.0.1", 8_090),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ServiceFileConfig {
    bind_address: String,
    port: u16,
}

impl ServiceFileConfig {
    fn new(bind_address: &str, port: u16) -> Self {
        Self {
            bind_address: bind_address.to_owned(),
            port,
        }
    }
}

impl Default for ServiceFileConfig {
    fn default() -> Self {
        Self::new("127.0.0.1", 1)
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct LoggingFileConfig {
    level: LogLevel,
}

#[derive(Debug)]
pub(crate) struct PostgresConfig {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) user: String,
    pub(crate) database: String,
}

impl From<DatabaseFileConfig> for PostgresConfig {
    fn from(value: DatabaseFileConfig) -> Self {
        Self {
            host: value.host,
            port: value.port,
            user: value.user,
            database: value.name,
        }
    }
}

fn optional_path_from_env(name: &'static str) -> Result<Option<PathBuf>, ConfigError> {
    match env::var_os(name) {
        Some(value) => path_from_env_value(name, value).map(Some),
        None => Ok(None),
    }
}

fn required_path_from_env(name: &'static str) -> Result<PathBuf, ConfigError> {
    let value = env::var_os(name).ok_or(ConfigError::MissingEnvironment(name))?;
    path_from_env_value(name, value)
}

fn path_from_env_value(name: &'static str, value: OsString) -> Result<PathBuf, ConfigError> {
    let value = value
        .into_string()
        .map_err(|_| ConfigError::EnvironmentNotUnicode(name))?;
    if value.is_empty() {
        return Err(ConfigError::EmptyEnvironment(name));
    }
    Ok(PathBuf::from(value))
}

fn read_json_config(path: &Path) -> Result<FileConfig, ConfigError> {
    ensure_file_size(path, FileKind::Configuration, MAX_CONFIG_BYTES)?;
    let bytes = fs::read(path).map_err(|error| ConfigError::FileRead { kind: error.kind() })?;
    serde_json::from_slice(&bytes).map_err(|error| ConfigError::InvalidJson {
        line: error.line(),
        column: error.column(),
        category: error.classify(),
    })
}

fn read_secret_file(path: &Path) -> Result<SecretString, ConfigError> {
    ensure_file_size(path, FileKind::Secret, MAX_SECRET_BYTES)?;
    let bytes = fs::read(path).map_err(|error| ConfigError::FileRead { kind: error.kind() })?;
    let mut secret = String::from_utf8(bytes)
        .map_err(|_| ConfigError::InvalidSecret("content must be valid UTF-8"))?;

    if secret.ends_with("\r\n") {
        secret.truncate(secret.len() - 2);
    } else if secret.ends_with('\n') {
        secret.truncate(secret.len() - 1);
    }

    if secret.is_empty() {
        return Err(ConfigError::InvalidSecret("content must not be empty"));
    }
    if secret.contains(['\r', '\n', '\0']) {
        return Err(ConfigError::InvalidSecret(
            "content must be a single line without NUL bytes",
        ));
    }

    Ok(SecretString::new(secret))
}

fn ensure_file_size(path: &Path, kind: FileKind, maximum: u64) -> Result<(), ConfigError> {
    let metadata =
        fs::metadata(path).map_err(|error| ConfigError::FileMetadata { kind: error.kind() })?;
    if !metadata.is_file() {
        return Err(ConfigError::InvalidValue(
            "configuration input is not a file",
        ));
    }
    if metadata.len() > maximum {
        return Err(ConfigError::FileTooLarge {
            kind,
            maximum_bytes: maximum,
        });
    }
    Ok(())
}

fn validate_text(field: &'static str, value: &str) -> Result<(), ConfigError> {
    if value.is_empty()
        || value.trim() != value
        || value.chars().any(char::is_control)
        || value.len() > 255
    {
        return Err(ConfigError::InvalidValue(match field {
            "database.host" => "database.host must be 1-255 safe characters",
            "database.user" => "database.user must be 1-255 safe characters",
            "database.name" => "database.name must be 1-255 safe characters",
            _ => "text field is invalid",
        }));
    }
    Ok(())
}

fn validate_service(field: &'static str, service: &ServiceFileConfig) -> Result<(), ConfigError> {
    service.bind_address.parse::<IpAddr>().map_err(|_| {
        ConfigError::InvalidValue("service bind_address must be a valid IP address")
    })?;
    if service.port == 0 {
        return Err(ConfigError::InvalidValue(match field {
            "services.api" => "services.api.port must be greater than zero",
            "services.market_engine" => "services.market_engine.port must be greater than zero",
            "services.model_worker" => "services.model_worker.port must be greater than zero",
            _ => "service port must be greater than zero",
        }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fmt::Write as _, path::PathBuf};

    use uuid::Uuid;

    use super::*;

    struct TestFile {
        path: PathBuf,
    }

    impl TestFile {
        fn new(label: &str, contents: &str) -> Self {
            let mut filename = String::new();
            write!(
                &mut filename,
                "ganso-market-engine-{label}-{}",
                Uuid::new_v4()
            )
            .expect("writing to String cannot fail");
            let path = env::temp_dir().join(filename);
            fs::write(&path, contents).expect("test fixture should be writable");
            Self { path }
        }
    }

    impl Drop for TestFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    #[test]
    fn json_overrides_defaults_and_secret_file_supplies_password() {
        let config = TestFile::new(
            "config",
            r#"{
                "database": { "port": 5544, "connect_timeout_ms": 2500 },
                "services": {
                    "market_engine": { "bind_address": "127.0.0.1", "port": 9091 }
                },
                "logging": { "level": "debug" }
            }"#,
        );
        let password = TestFile::new("password", "unit-test-placeholder\n");

        let loaded = RuntimeConfig::load(Some(&config.path), &password.path)
            .expect("valid layered configuration should load");

        assert_eq!(loaded.execution_mode(), ExecutionMode::Paper);
        assert_eq!(loaded.bind_address().port(), 9_091);
        assert_eq!(loaded.readiness_timeout(), Duration::from_millis(2_500));
        assert_eq!(loaded.postgres_host(), "postgres");
        assert_eq!(loaded.postgres_port(), 5_544);
        assert_eq!(loaded.log_level(), LogLevel::Debug);
        assert!(!format!("{loaded:?}").contains("unit-test-placeholder"));
    }

    #[test]
    fn combined_runtime_schema_is_accepted() {
        let config = TestFile::new(
            "config",
            r#"{
                "schema_version": 1,
                "execution_mode": "paper",
                "database": {
                    "host": "postgres",
                    "port": 5432,
                    "name": "ganso_market",
                    "user": "ganso_market",
                    "connect_timeout_ms": 1000
                },
                "services": {
                    "api": { "bind_address": "0.0.0.0", "port": 3000 },
                    "market_engine": { "bind_address": "0.0.0.0", "port": 8081 },
                    "model_worker": { "bind_address": "0.0.0.0", "port": 8090 }
                },
                "logging": { "level": "info" }
            }"#,
        );
        let password = TestFile::new("password", "unit-test-placeholder");

        let loaded = RuntimeConfig::load(Some(&config.path), &password.path)
            .expect("the shared runtime schema should load");

        assert_eq!(loaded.bind_address().to_string(), "0.0.0.0:8081");
        assert_eq!(loaded.readiness_timeout(), Duration::from_millis(1_000));
    }

    #[test]
    fn unsupported_schema_version_fails_closed() {
        let config = TestFile::new("config", r#"{"schema_version":2}"#);
        let password = TestFile::new("password", "unit-test-placeholder");

        assert!(matches!(
            RuntimeConfig::load(Some(&config.path), &password.path),
            Err(ConfigError::InvalidValue(
                "schema_version must be exactly 1"
            ))
        ));
    }

    #[test]
    fn live_execution_mode_is_rejected() {
        let config = TestFile::new("config", r#"{"execution_mode":"live"}"#);
        let password = TestFile::new("password", "unit-test-placeholder");

        let error = RuntimeConfig::load(Some(&config.path), &password.path)
            .expect_err("live mode must fail closed");

        assert!(matches!(error, ConfigError::InvalidJson { .. }));
    }

    #[test]
    fn unknown_fields_are_rejected_at_every_level() {
        let password = TestFile::new("password", "unit-test-placeholder");
        let top_level = TestFile::new("config", r#"{"unexpected":true}"#);
        let nested = TestFile::new(
            "config",
            r#"{"database":{"password":"must-not-be-configured-here"}}"#,
        );

        assert!(matches!(
            RuntimeConfig::load(Some(&top_level.path), &password.path),
            Err(ConfigError::InvalidJson { .. })
        ));
        assert!(matches!(
            RuntimeConfig::load(Some(&nested.path), &password.path),
            Err(ConfigError::InvalidJson { .. })
        ));
    }

    #[test]
    fn invalid_timeout_fails_boot_validation() {
        let config = TestFile::new("config", r#"{"database":{"connect_timeout_ms":0}}"#);
        let password = TestFile::new("password", "unit-test-placeholder");

        assert!(matches!(
            RuntimeConfig::load(Some(&config.path), &password.path),
            Err(ConfigError::InvalidValue(_))
        ));
    }

    #[test]
    fn secret_debug_and_display_are_redacted() {
        let secret = SecretString::new("unit-test-placeholder".to_owned());

        assert_eq!(format!("{secret}"), "[REDACTED]");
        assert_eq!(format!("{secret:?}"), "[REDACTED]");
    }
}
