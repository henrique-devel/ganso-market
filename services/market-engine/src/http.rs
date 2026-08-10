use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Extension, Request, State},
    http::{HeaderName, HeaderValue, StatusCode, header::CONTENT_TYPE},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::time::timeout;
use tracing::Instrument as _;
use uuid::Uuid;

use crate::config::ExecutionMode;

pub const CORRELATION_ID_HEADER: &str = "x-correlation-id";

pub type ProbeFuture<'a> = Pin<Box<dyn Future<Output = Result<(), ProbeError>> + Send + 'a>>;

pub trait ReadinessProbe: Send + Sync + 'static {
    fn check(&self) -> ProbeFuture<'_>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProbeError {
    DependencyUnavailable,
    UnexpectedResponse,
}

#[derive(Clone)]
struct AppState {
    probe: Arc<dyn ReadinessProbe>,
    readiness_timeout: Duration,
    execution_mode: ExecutionMode,
    metrics: Arc<Metrics>,
}

#[derive(Default)]
struct Metrics {
    live_requests: AtomicU64,
    ready_requests: AtomicU64,
    ready_failures: AtomicU64,
    metrics_requests: AtomicU64,
    replaced_correlation_ids: AtomicU64,
}

#[derive(Clone, Debug)]
struct CorrelationId(String);

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ServiceStatus {
    Live,
    Ready,
    NotReady,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum CheckStatus {
    Ready,
    NotReady,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReasonCode {
    PostgresUnavailable,
    PostgresUnexpectedResponse,
    ReadinessTimeout,
}

impl ReasonCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::PostgresUnavailable => "POSTGRES_UNAVAILABLE",
            Self::PostgresUnexpectedResponse => "POSTGRES_UNEXPECTED_RESPONSE",
            Self::ReadinessTimeout => "READINESS_TIMEOUT",
        }
    }
}

#[derive(Debug, Serialize)]
struct ServiceHealth {
    service: &'static str,
    status: ServiceStatus,
    checked_at: String,
    execution_mode: ExecutionMode,
    correlation_id: String,
    reason_codes: Vec<ReasonCode>,
    checks: Vec<ServiceCheck>,
}

#[derive(Debug, Serialize)]
struct ServiceCheck {
    name: &'static str,
    status: CheckStatus,
    reason_codes: Vec<ReasonCode>,
}

pub fn router(
    probe: Arc<dyn ReadinessProbe>,
    readiness_timeout: Duration,
    execution_mode: ExecutionMode,
) -> Router {
    let metrics = Arc::new(Metrics::default());
    let state = AppState {
        probe,
        readiness_timeout,
        execution_mode,
        metrics: Arc::clone(&metrics),
    };

    Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/metrics", get(prometheus_metrics))
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            metrics,
            correlation_id_middleware,
        ))
}

async fn live(
    State(state): State<AppState>,
    Extension(correlation_id): Extension<CorrelationId>,
) -> impl IntoResponse {
    state.metrics.live_requests.fetch_add(1, Ordering::Relaxed);
    health_response(
        StatusCode::OK,
        ServiceStatus::Live,
        state.execution_mode,
        correlation_id,
        Vec::new(),
        Vec::new(),
    )
}

async fn ready(
    State(state): State<AppState>,
    Extension(correlation_id): Extension<CorrelationId>,
) -> impl IntoResponse {
    state.metrics.ready_requests.fetch_add(1, Ordering::Relaxed);

    let (status_code, status, reason_code) =
        match timeout(state.readiness_timeout, state.probe.check()).await {
            Ok(Ok(())) => (StatusCode::OK, ServiceStatus::Ready, None),
            Ok(Err(ProbeError::DependencyUnavailable)) => (
                StatusCode::SERVICE_UNAVAILABLE,
                ServiceStatus::NotReady,
                Some(ReasonCode::PostgresUnavailable),
            ),
            Ok(Err(ProbeError::UnexpectedResponse)) => (
                StatusCode::SERVICE_UNAVAILABLE,
                ServiceStatus::NotReady,
                Some(ReasonCode::PostgresUnexpectedResponse),
            ),
            Err(_) => (
                StatusCode::SERVICE_UNAVAILABLE,
                ServiceStatus::NotReady,
                Some(ReasonCode::ReadinessTimeout),
            ),
        };

    if let Some(reason_code) = reason_code {
        state.metrics.ready_failures.fetch_add(1, Ordering::Relaxed);
        tracing::warn!(
            correlation_id = %correlation_id.0,
            reason_code = reason_code.as_str(),
            "readiness probe rejected"
        );
    }

    let reason_codes = reason_code.into_iter().collect::<Vec<_>>();
    health_response(
        status_code,
        status,
        state.execution_mode,
        correlation_id,
        reason_codes.clone(),
        vec![ServiceCheck {
            name: "postgres",
            status: if status_code == StatusCode::OK {
                CheckStatus::Ready
            } else {
                CheckStatus::NotReady
            },
            reason_codes,
        }],
    )
}

async fn prometheus_metrics(
    State(state): State<AppState>,
    Extension(_correlation_id): Extension<CorrelationId>,
) -> Response {
    state
        .metrics
        .metrics_requests
        .fetch_add(1, Ordering::Relaxed);

    let body = format!(
        concat!(
            "# HELP ganso_market_engine_health_live_requests_total Liveness requests.\n",
            "# TYPE ganso_market_engine_health_live_requests_total counter\n",
            "ganso_market_engine_health_live_requests_total {}\n",
            "# HELP ganso_market_engine_health_ready_requests_total Readiness requests.\n",
            "# TYPE ganso_market_engine_health_ready_requests_total counter\n",
            "ganso_market_engine_health_ready_requests_total {}\n",
            "# HELP ganso_market_engine_health_ready_failures_total Failed readiness requests.\n",
            "# TYPE ganso_market_engine_health_ready_failures_total counter\n",
            "ganso_market_engine_health_ready_failures_total {}\n",
            "# HELP ganso_market_engine_metrics_requests_total Metrics requests.\n",
            "# TYPE ganso_market_engine_metrics_requests_total counter\n",
            "ganso_market_engine_metrics_requests_total {}\n",
            "# HELP ganso_market_engine_replaced_correlation_ids_total Invalid correlation IDs replaced with generated IDs.\n",
            "# TYPE ganso_market_engine_replaced_correlation_ids_total counter\n",
            "ganso_market_engine_replaced_correlation_ids_total {}\n"
        ),
        state.metrics.live_requests.load(Ordering::Relaxed),
        state.metrics.ready_requests.load(Ordering::Relaxed),
        state.metrics.ready_failures.load(Ordering::Relaxed),
        state.metrics.metrics_requests.load(Ordering::Relaxed),
        state
            .metrics
            .replaced_correlation_ids
            .load(Ordering::Relaxed),
    );

    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
    );
    response
}

async fn correlation_id_middleware(
    State(metrics): State<Arc<Metrics>>,
    mut request: Request,
    next: Next,
) -> Response {
    let header_name = HeaderName::from_static(CORRELATION_ID_HEADER);
    let provided = request.headers().get(&header_name);
    let correlation_id = match provided.and_then(validated_correlation_id) {
        Some(value) => value,
        None if provided.is_some() => {
            metrics
                .replaced_correlation_ids
                .fetch_add(1, Ordering::Relaxed);
            let generated = generated_correlation_id();
            tracing::warn!(
                service = "market-engine",
                correlation_id = %generated.0,
                reason_code = "CORRELATION_ID_REPLACED",
                "invalid correlation ID replaced"
            );
            generated
        }
        None => generated_correlation_id(),
    };

    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    request.extensions_mut().insert(correlation_id.clone());
    let span = tracing::info_span!(
        "http_request",
        service = "market-engine",
        correlation_id = %correlation_id.0,
        method = %method,
        path = %path
    );
    let mut response = next.run(request).instrument(span.clone()).await;
    insert_correlation_header(&mut response, &correlation_id);
    tracing::info!(parent: &span, status = response.status().as_u16(), "request completed");
    response
}

fn validated_correlation_id(value: &HeaderValue) -> Option<CorrelationId> {
    let raw = value.to_str().ok()?;
    let mut bytes = raw.bytes();
    let first = bytes.next()?;
    (raw.len() <= 64
        && first.is_ascii_alphanumeric()
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')))
    .then(|| CorrelationId(raw.to_owned()))
}

fn generated_correlation_id() -> CorrelationId {
    CorrelationId(Uuid::new_v4().hyphenated().to_string())
}

fn insert_correlation_header(response: &mut Response, correlation_id: &CorrelationId) {
    let value = HeaderValue::from_str(&correlation_id.0)
        .expect("a validated correlation ID is always a valid HTTP header value");
    response
        .headers_mut()
        .insert(HeaderName::from_static(CORRELATION_ID_HEADER), value);
}

fn health_response(
    status_code: StatusCode,
    status: ServiceStatus,
    execution_mode: ExecutionMode,
    correlation_id: CorrelationId,
    reason_codes: Vec<ReasonCode>,
    checks: Vec<ServiceCheck>,
) -> (StatusCode, Json<ServiceHealth>) {
    (
        status_code,
        Json(ServiceHealth {
            service: "market-engine",
            status,
            checked_at: OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .expect("current UTC timestamp must be representable as RFC3339"),
            execution_mode,
            correlation_id: correlation_id.0,
            reason_codes,
            checks,
        }),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;

    use axum::{
        body::to_bytes,
        http::{Request, StatusCode},
    };
    use serde_json::Value;
    use tower::ServiceExt as _;

    use super::*;

    #[derive(Clone, Copy)]
    enum FakeOutcome {
        Ready,
        Unavailable,
        Delayed,
    }

    struct FakeProbe {
        outcome: FakeOutcome,
        calls: Arc<AtomicU64>,
    }

    impl FakeProbe {
        fn new(outcome: FakeOutcome) -> (Arc<Self>, Arc<AtomicU64>) {
            let calls = Arc::new(AtomicU64::new(0));
            (
                Arc::new(Self {
                    outcome,
                    calls: Arc::clone(&calls),
                }),
                calls,
            )
        }
    }

    impl ReadinessProbe for FakeProbe {
        fn check(&self) -> ProbeFuture<'_> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Box::pin(async move {
                match self.outcome {
                    FakeOutcome::Ready => Ok(()),
                    FakeOutcome::Unavailable => Err(ProbeError::DependencyUnavailable),
                    FakeOutcome::Delayed => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        Ok(())
                    }
                }
            })
        }
    }

    #[tokio::test]
    async fn liveness_does_not_call_the_dependency_probe() {
        let (probe, calls) = FakeProbe::new(FakeOutcome::Unavailable);
        let response = router(probe, Duration::from_millis(10), ExecutionMode::Paper)
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        let body = response_json(response).await;
        assert_service_health_shape(&body);
        assert_eq!(body["status"], "live");
        assert_eq!(body["execution_mode"], "paper");
        assert_eq!(body["reason_codes"], serde_json::json!([]));
        assert_eq!(body["checks"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn readiness_returns_503_and_reason_code_when_probe_fails() {
        let (probe, calls) = FakeProbe::new(FakeOutcome::Unavailable);
        let response = router(probe, Duration::from_millis(10), ExecutionMode::Paper)
            .oneshot(
                Request::builder()
                    .uri("/health/ready")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        let body = response_json(response).await;
        assert_service_health_shape(&body);
        assert_eq!(body["status"], "not_ready");
        assert_eq!(
            body["reason_codes"],
            serde_json::json!(["POSTGRES_UNAVAILABLE"])
        );
        assert_eq!(body["checks"][0]["status"], "not_ready");
        assert_eq!(
            body["checks"][0]["reason_codes"],
            serde_json::json!(["POSTGRES_UNAVAILABLE"])
        );
    }

    #[tokio::test]
    async fn readiness_timeout_is_explicit() {
        let (probe, _calls) = FakeProbe::new(FakeOutcome::Delayed);
        let response = router(probe, Duration::from_millis(1), ExecutionMode::Paper)
            .oneshot(
                Request::builder()
                    .uri("/health/ready")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = response_json(response).await;
        assert_eq!(body["status"], "not_ready");
        assert_eq!(
            body["reason_codes"],
            serde_json::json!(["READINESS_TIMEOUT"])
        );
    }

    #[tokio::test]
    async fn valid_correlation_id_is_propagated() {
        let (probe, _calls) = FakeProbe::new(FakeOutcome::Ready);
        let correlation_id = "request-123.test";
        let response = router(probe, Duration::from_millis(10), ExecutionMode::Paper)
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .header(CORRELATION_ID_HEADER, correlation_id)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(
            response
                .headers()
                .get(CORRELATION_ID_HEADER)
                .expect("response should contain correlation ID"),
            correlation_id
        );
        let body = response_json(response).await;
        assert_eq!(body["correlation_id"], correlation_id);
    }

    #[tokio::test]
    async fn missing_correlation_id_is_generated() {
        let (probe, _calls) = FakeProbe::new(FakeOutcome::Ready);
        let response = router(probe, Duration::from_millis(10), ExecutionMode::Paper)
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        let value = response
            .headers()
            .get(CORRELATION_ID_HEADER)
            .expect("response should contain correlation ID")
            .to_str()
            .expect("generated UUID should be ASCII");

        assert_eq!(
            Uuid::parse_str(value).expect("valid UUID").to_string(),
            value
        );
    }

    #[tokio::test]
    async fn invalid_correlation_id_is_replaced_and_handler_continues() {
        let (probe, calls) = FakeProbe::new(FakeOutcome::Ready);
        let response = router(probe, Duration::from_millis(10), ExecutionMode::Paper)
            .oneshot(
                Request::builder()
                    .uri("/health/ready")
                    .header(CORRELATION_ID_HEADER, ".invalid-correlation-id")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        let generated = response
            .headers()
            .get(CORRELATION_ID_HEADER)
            .expect("replacement correlation ID should be returned")
            .to_str()
            .expect("replacement should be ASCII")
            .to_owned();
        assert_ne!(generated, ".invalid-correlation-id");
        Uuid::parse_str(&generated).expect("replacement should be a UUID");
        let body = response_json(response).await;
        assert_eq!(body["correlation_id"], generated);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["reason_codes"], serde_json::json!([]));
        assert_eq!(body["checks"][0]["status"], "ready");
        assert_eq!(body["checks"][0]["reason_codes"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn metrics_are_prometheus_text_and_use_integer_counters() {
        let (probe, _calls) = FakeProbe::new(FakeOutcome::Ready);
        let response = router(probe, Duration::from_millis(10), ExecutionMode::Paper)
            .oneshot(
                Request::builder()
                    .uri("/metrics")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(CONTENT_TYPE)
                .expect("metrics content type should be set"),
            "text/plain; version=0.0.4; charset=utf-8"
        );
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("metrics body should be readable");
        let body = std::str::from_utf8(&body).expect("metrics should be UTF-8");
        assert!(body.contains("ganso_market_engine_metrics_requests_total 1\n"));
    }

    async fn response_json(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), 16 * 1024)
            .await
            .expect("response body should be readable");
        serde_json::from_slice(&bytes).expect("response should contain valid JSON")
    }

    fn assert_service_health_shape(body: &Value) {
        let object = body
            .as_object()
            .expect("service health response should be an object");
        let mut fields = object.keys().map(String::as_str).collect::<Vec<_>>();
        fields.sort_unstable();
        assert_eq!(
            fields,
            vec![
                "checked_at",
                "checks",
                "correlation_id",
                "execution_mode",
                "reason_codes",
                "service",
                "status",
            ]
        );
        assert_eq!(body["service"], "market-engine");
        assert!(
            body["checked_at"]
                .as_str()
                .expect("checked_at should be a string")
                .ends_with('Z')
        );
    }
}
