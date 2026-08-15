//! One-shot, redacted Yellowstone connectivity gate for RFC-001A.
//!
//! This binary reads endpoint and x-token from mode-0600 files, subscribes only
//! to processed slot updates, and exits after three strictly advancing slots.
//! It deliberately has no persistence and never formats transport errors,
//! because those errors can contain endpoint metadata.

use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs::{File, OpenOptions, symlink_metadata},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    process::ExitCode,
    time::Duration,
};

use futures::{SinkExt, StreamExt};
use yellowstone_grpc_client::{ClientTlsConfig, GeyserGrpcClient};
use yellowstone_grpc_proto::geyser::{
    CommitmentLevel, SlotStatus, SubscribeRequest, SubscribeRequestFilterSlots,
    SubscribeRequestPing, subscribe_update::UpdateOneof,
};

const DEFAULT_TIMEOUT_SECONDS: u64 = 45;
const MIN_TIMEOUT_SECONDS: u64 = 5;
const MAX_TIMEOUT_SECONDS: u64 = 300;
const REQUIRED_SLOTS: usize = 3;
const MAX_ENDPOINT_BYTES: u64 = 8 * 1024;
const MAX_TOKEN_BYTES: u64 = 64 * 1024;
const ENDPOINT_FILE: &str = "yellowstone_endpoint";
const TOKEN_FILE: &str = "yellowstone_token";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Reason {
    Usage,
    SecretPathNotAbsolute,
    SecretAncestorInvalid,
    SecretParentInvalid,
    SecretDirectoryInvalid,
    SecretFileInvalid,
    SecretPermissionsInvalid,
    SecretOwnerInvalid,
    SecretSizeInvalid,
    SecretEncodingInvalid,
    SecretLineInvalid,
    SecretPlaceholder,
    EndpointInvalid,
    TokenInvalid,
    ConnectOrAuthFailed,
    SubscribeFailed,
    StreamFailed,
    StreamClosed,
    StreamTimeout,
    NonMonotonicSlot,
    PingFailed,
}

impl Reason {
    const fn code(self) -> &'static str {
        match self {
            Self::Usage => "USAGE_INVALID",
            Self::SecretPathNotAbsolute => "SECRET_PATH_NOT_ABSOLUTE",
            Self::SecretAncestorInvalid => "SECRET_ANCESTOR_INVALID",
            Self::SecretParentInvalid => "SECRET_PARENT_INVALID",
            Self::SecretDirectoryInvalid => "SECRET_DIRECTORY_INVALID",
            Self::SecretFileInvalid => "SECRET_FILE_INVALID",
            Self::SecretPermissionsInvalid => "SECRET_PERMISSIONS_INVALID",
            Self::SecretOwnerInvalid => "SECRET_OWNER_INVALID",
            Self::SecretSizeInvalid => "SECRET_SIZE_INVALID",
            Self::SecretEncodingInvalid => "SECRET_ENCODING_INVALID",
            Self::SecretLineInvalid => "SECRET_LINE_INVALID",
            Self::SecretPlaceholder => "SECRET_PLACEHOLDER",
            Self::EndpointInvalid => "ENDPOINT_INVALID",
            Self::TokenInvalid => "TOKEN_INVALID",
            Self::ConnectOrAuthFailed => "CONNECT_OR_AUTH_FAILED",
            Self::SubscribeFailed => "SUBSCRIBE_FAILED",
            Self::StreamFailed => "STREAM_FAILED",
            Self::StreamClosed => "STREAM_CLOSED",
            Self::StreamTimeout => "STREAM_TIMEOUT",
            Self::NonMonotonicSlot => "NON_MONOTONIC_SLOT",
            Self::PingFailed => "PING_FAILED",
        }
    }
}

type ProbeResult<T> = Result<T, Reason>;

#[derive(Debug, Eq, PartialEq)]
struct Arguments {
    secrets_dir: PathBuf,
    timeout_seconds: u64,
}

#[derive(Debug)]
enum ParseOutcome {
    Run(Arguments),
    Help,
}

fn usage() -> &'static str {
    "usage: ganso-rfc001a-yellowstone-probe --secrets-dir <path> \
        [--timeout-seconds 5..300]"
}

fn parse_arguments<I>(arguments: I) -> ProbeResult<ParseOutcome>
where
    I: IntoIterator<Item = OsString>,
{
    let mut arguments = arguments.into_iter();
    let _program = arguments.next();
    let mut secrets_dir = None;
    let mut timeout_seconds = DEFAULT_TIMEOUT_SECONDS;

    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--help" | "-h") => return Ok(ParseOutcome::Help),
            Some("--secrets-dir") if secrets_dir.is_none() => {
                let value = arguments.next().ok_or(Reason::Usage)?;
                if value.is_empty() {
                    return Err(Reason::Usage);
                }
                secrets_dir = Some(PathBuf::from(value));
            }
            Some("--timeout-seconds") => {
                let value = arguments.next().ok_or(Reason::Usage)?;
                timeout_seconds = value
                    .to_str()
                    .ok_or(Reason::Usage)?
                    .parse()
                    .map_err(|_| Reason::Usage)?;
                if !(MIN_TIMEOUT_SECONDS..=MAX_TIMEOUT_SECONDS).contains(&timeout_seconds) {
                    return Err(Reason::Usage);
                }
            }
            _ => return Err(Reason::Usage),
        }
    }

    Ok(ParseOutcome::Run(Arguments {
        secrets_dir: secrets_dir.ok_or(Reason::Usage)?,
        timeout_seconds,
    }))
}

fn current_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and does not dereference memory.
    unsafe { libc::geteuid() }
}

fn validate_no_symlink_ancestors(path: &Path) -> ProbeResult<()> {
    if !path.is_absolute() {
        return Err(Reason::SecretPathNotAbsolute);
    }

    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir => current.push(Path::new("/")),
            Component::Normal(part) => {
                current.push(part);
                let metadata =
                    symlink_metadata(&current).map_err(|_| Reason::SecretAncestorInvalid)?;
                if metadata.file_type().is_symlink() {
                    return Err(Reason::SecretAncestorInvalid);
                }
            }
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => {
                return Err(Reason::SecretAncestorInvalid);
            }
        }
    }
    Ok(())
}

fn open_nofollow(path: &Path, directory: bool) -> ProbeResult<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    let mut flags = libc::O_NOFOLLOW | libc::O_CLOEXEC;
    if directory {
        flags |= libc::O_DIRECTORY;
    }
    options.custom_flags(flags).open(path).map_err(|_| {
        if directory {
            Reason::SecretDirectoryInvalid
        } else {
            Reason::SecretFileInvalid
        }
    })
}

fn validate_directory(path: &Path, parent: bool) -> ProbeResult<()> {
    let file = open_nofollow(path, true).map_err(|reason| {
        if parent {
            Reason::SecretParentInvalid
        } else {
            reason
        }
    })?;
    let metadata = file.metadata().map_err(|_| {
        if parent {
            Reason::SecretParentInvalid
        } else {
            Reason::SecretDirectoryInvalid
        }
    })?;
    if metadata.permissions().mode() & 0o777 != 0o700 {
        return Err(Reason::SecretPermissionsInvalid);
    }
    if metadata.uid() != current_uid() {
        return Err(Reason::SecretOwnerInvalid);
    }
    Ok(())
}

fn read_secret(path: &Path, maximum_bytes: u64) -> ProbeResult<String> {
    let file = open_nofollow(path, false)?;
    let metadata = file.metadata().map_err(|_| Reason::SecretFileInvalid)?;
    if !metadata.is_file() {
        return Err(Reason::SecretFileInvalid);
    }
    if metadata.permissions().mode() & 0o777 != 0o600 {
        return Err(Reason::SecretPermissionsInvalid);
    }
    if metadata.uid() != current_uid() {
        return Err(Reason::SecretOwnerInvalid);
    }
    if metadata.len() == 0 || metadata.len() > maximum_bytes {
        return Err(Reason::SecretSizeInvalid);
    }

    let mut bytes = Vec::new();
    file.take(maximum_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Reason::SecretFileInvalid)?;
    if bytes.is_empty() || bytes.len() as u64 > maximum_bytes {
        return Err(Reason::SecretSizeInvalid);
    }
    if bytes.contains(&0) || bytes.contains(&b'\r') {
        return Err(Reason::SecretLineInvalid);
    }
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.is_empty() || bytes.contains(&b'\n') {
        return Err(Reason::SecretLineInvalid);
    }

    String::from_utf8(bytes).map_err(|_| Reason::SecretEncodingInvalid)
}

fn looks_like_placeholder(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase().replace(['-', ' '], "_");
    value.contains('<')
        || value.contains('>')
        || normalized.contains("placeholder")
        || normalized.contains("change_me")
        || normalized.contains("replace_me")
        || normalized.contains("your_")
        || normalized == "example"
}

fn validate_endpoint(endpoint: &str) -> ProbeResult<()> {
    if endpoint.trim() != endpoint || looks_like_placeholder(endpoint) {
        return Err(Reason::SecretPlaceholder);
    }
    let authority_and_path = endpoint
        .strip_prefix("https://")
        .ok_or(Reason::EndpointInvalid)?;
    let authority = authority_and_path.split('/').next().unwrap_or_default();
    if authority.is_empty()
        || authority.contains('@')
        || endpoint.contains('?')
        || endpoint.contains('#')
    {
        return Err(Reason::EndpointInvalid);
    }
    Ok(())
}

fn validate_token(token: &str) -> ProbeResult<()> {
    if token.trim() != token || looks_like_placeholder(token) {
        return Err(Reason::SecretPlaceholder);
    }
    if token.is_empty() || !token.is_ascii() {
        return Err(Reason::TokenInvalid);
    }
    Ok(())
}

fn subscription_request() -> SubscribeRequest {
    let mut slots = HashMap::new();
    slots.insert(
        "rfc001a_probe".to_owned(),
        SubscribeRequestFilterSlots {
            filter_by_commitment: Some(true),
            interslot_updates: Some(false),
        },
    );
    SubscribeRequest {
        slots,
        commitment: Some(CommitmentLevel::Processed as i32),
        ..SubscribeRequest::default()
    }
}

#[derive(Debug, Default, Eq, PartialEq)]
struct SlotProgress {
    first: Option<u64>,
    last: Option<u64>,
    count: usize,
}

impl SlotProgress {
    fn observe(&mut self, slot: u64) -> ProbeResult<bool> {
        if let Some(previous) = self.last {
            if slot < previous {
                return Err(Reason::NonMonotonicSlot);
            }
            if slot == previous {
                return Ok(false);
            }
        }
        self.first.get_or_insert(slot);
        self.last = Some(slot);
        self.count += 1;
        Ok(self.count >= REQUIRED_SLOTS)
    }
}

async fn probe(arguments: &Arguments) -> ProbeResult<SlotProgress> {
    validate_no_symlink_ancestors(&arguments.secrets_dir)?;
    let parent = arguments
        .secrets_dir
        .parent()
        .ok_or(Reason::SecretParentInvalid)?;
    validate_directory(parent, true)?;
    validate_directory(&arguments.secrets_dir, false)?;

    let endpoint = read_secret(
        &arguments.secrets_dir.join(ENDPOINT_FILE),
        MAX_ENDPOINT_BYTES,
    )?;
    let token = read_secret(&arguments.secrets_dir.join(TOKEN_FILE), MAX_TOKEN_BYTES)?;
    validate_endpoint(&endpoint)?;
    validate_token(&token)?;

    let connect_timeout = Duration::from_secs(arguments.timeout_seconds.min(15));
    let builder = GeyserGrpcClient::build_from_shared(endpoint)
        .map_err(|_| Reason::EndpointInvalid)?
        .x_token(Some(token))
        .map_err(|_| Reason::TokenInvalid)?
        .tls_config(ClientTlsConfig::new().with_native_roots())
        .map_err(|_| Reason::EndpointInvalid)?
        .connect_timeout(connect_timeout)
        .http2_keep_alive_interval(Duration::from_secs(15))
        .keep_alive_timeout(Duration::from_secs(10))
        .keep_alive_while_idle(true);

    let operation = async move {
        let mut client = builder
            .connect()
            .await
            .map_err(|_| Reason::ConnectOrAuthFailed)?;
        let request = subscription_request();
        let (mut sink, mut stream) = client
            .subscribe_with_request(Some(request.clone()))
            .await
            .map_err(|_| Reason::SubscribeFailed)?;
        let mut progress = SlotProgress::default();

        loop {
            let update = stream
                .next()
                .await
                .ok_or(Reason::StreamClosed)?
                .map_err(|_| Reason::StreamFailed)?;
            match update.update_oneof {
                Some(UpdateOneof::Slot(slot)) if slot.status() == SlotStatus::SlotProcessed => {
                    if progress.observe(slot.slot)? {
                        return Ok(progress);
                    }
                }
                Some(UpdateOneof::Ping(_)) => {
                    let pong = SubscribeRequest {
                        ping: Some(SubscribeRequestPing { id: 1 }),
                        ..request.clone()
                    };
                    sink.send(pong).await.map_err(|_| Reason::PingFailed)?;
                }
                _ => {}
            }
        }
    };

    tokio::time::timeout(Duration::from_secs(arguments.timeout_seconds), operation)
        .await
        .map_err(|_| Reason::StreamTimeout)?
}

#[tokio::main]
async fn main() -> ExitCode {
    let arguments = match parse_arguments(env::args_os()) {
        Ok(ParseOutcome::Help) => {
            println!("{}", usage());
            return ExitCode::SUCCESS;
        }
        Ok(ParseOutcome::Run(arguments)) => arguments,
        Err(reason) => {
            eprintln!("FAIL-YELLOWSTONE reason={}", reason.code());
            eprintln!("{}", usage());
            return ExitCode::from(2);
        }
    };

    match probe(&arguments).await {
        Ok(progress) => {
            println!(
                "PASS-YELLOWSTONE slots={} first_slot={} last_slot={} commitment=processed timeout_seconds={}",
                progress.count,
                progress.first.unwrap_or_default(),
                progress.last.unwrap_or_default(),
                arguments.timeout_seconds
            );
            ExitCode::SUCCESS
        }
        Err(reason) => {
            eprintln!("FAIL-YELLOWSTONE reason={}", reason.code());
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock must be after epoch")
                .as_nanos();
            let sequence = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let root = env::temp_dir().join(format!(
                "ganso-rfc001a-yellowstone-test-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&root).expect("create test root");
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("chmod test root");
            Self(fs::canonicalize(root).expect("canonicalize test root"))
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_secret(path: &Path, value: &str, mode: u32) {
        fs::write(path, value).expect("write synthetic secret");
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("chmod secret");
    }

    #[test]
    fn arguments_require_explicit_secret_directory() {
        let result = parse_arguments([OsString::from("probe")]);
        assert_eq!(result.unwrap_err(), Reason::Usage);
    }

    #[test]
    fn secret_directory_path_must_be_absolute_without_symlinked_ancestors() {
        assert_eq!(
            validate_no_symlink_ancestors(Path::new("relative/secrets")).unwrap_err(),
            Reason::SecretPathNotAbsolute
        );

        let directory = TestDirectory::new();
        let real_parent = directory.path().join("real-parent");
        let alias_parent = directory.path().join("alias-parent");
        let secrets = real_parent.join("secrets");
        fs::create_dir(&real_parent).expect("create real parent");
        fs::create_dir(&secrets).expect("create secrets directory");
        symlink(&real_parent, &alias_parent).expect("create ancestor symlink");

        assert_eq!(
            validate_no_symlink_ancestors(&alias_parent.join("secrets")).unwrap_err(),
            Reason::SecretAncestorInvalid
        );
    }

    #[test]
    fn placeholders_are_rejected_without_echoing_them() {
        let sentinel = "YOUR_SYNTHETIC_TOKEN";
        let error = validate_token(sentinel).unwrap_err();
        assert_eq!(error, Reason::SecretPlaceholder);
        assert!(!error.code().contains(sentinel));
    }

    #[test]
    fn endpoint_must_use_https_and_x_token_cannot_be_in_query() {
        assert_eq!(
            validate_endpoint("http://synthetic.invalid:10000").unwrap_err(),
            Reason::EndpointInvalid
        );
        assert_eq!(
            validate_endpoint("https://synthetic.invalid?token=redacted").unwrap_err(),
            Reason::EndpointInvalid
        );
    }

    #[test]
    fn secure_read_requires_exact_mode_and_single_line() {
        let directory = TestDirectory::new();
        let file = directory.path().join("token");
        write_secret(&file, "synthetic-token\n", 0o600);
        assert_eq!(read_secret(&file, 1024).unwrap(), "synthetic-token");

        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).expect("chmod secret");
        assert_eq!(
            read_secret(&file, 1024).unwrap_err(),
            Reason::SecretPermissionsInvalid
        );

        write_secret(&file, "line-one\nline-two\n", 0o600);
        assert_eq!(
            read_secret(&file, 1024).unwrap_err(),
            Reason::SecretLineInvalid
        );
    }

    #[test]
    fn secure_read_rejects_symlink() {
        let directory = TestDirectory::new();
        let target = directory.path().join("target");
        let link = directory.path().join("link");
        write_secret(&target, "synthetic-token", 0o600);
        symlink(&target, &link).expect("create symlink");
        assert_eq!(
            read_secret(&link, 1024).unwrap_err(),
            Reason::SecretFileInvalid
        );
    }

    #[test]
    fn slot_progress_requires_strict_advances() {
        let mut progress = SlotProgress::default();
        assert!(!progress.observe(100).unwrap());
        assert!(!progress.observe(100).unwrap());
        assert!(!progress.observe(101).unwrap());
        assert!(progress.observe(102).unwrap());
        assert_eq!(progress.count, REQUIRED_SLOTS);
        assert_eq!(progress.first, Some(100));
        assert_eq!(progress.last, Some(102));
        assert_eq!(progress.observe(99).unwrap_err(), Reason::NonMonotonicSlot);
    }

    #[test]
    fn request_subscribes_only_to_processed_slots() {
        let request = subscription_request();
        assert_eq!(request.slots.len(), 1);
        assert!(request.accounts.is_empty());
        assert!(request.transactions.is_empty());
        assert!(request.blocks.is_empty());
        assert_eq!(request.commitment, Some(CommitmentLevel::Processed as i32));
        let filter = request.slots.get("rfc001a_probe").expect("slot filter");
        assert_eq!(filter.filter_by_commitment, Some(true));
        assert_eq!(filter.interslot_updates, Some(false));
    }
}
