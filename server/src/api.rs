use crate::{
    Error, Result, auth,
    jobs::{self, State as AppState},
    pipeline::Options,
};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, FromRequestParts, Multipart, Path, Request, State},
    http::{HeaderMap, StatusCode, header, request::Parts},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::{sync::Arc, time::Instant};
use tokio::io::AsyncWriteExt;

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = match self.code {
            "unauthorized" => StatusCode::UNAUTHORIZED,
            "rate_limited" => StatusCode::TOO_MANY_REQUESTS,
            "too_large" => StatusCode::PAYLOAD_TOO_LARGE,
            "not_found" => StatusCode::NOT_FOUND,
            "input_not_pbf" | "input_unsorted" => StatusCode::UNPROCESSABLE_ENTITY,
            "not_ready" => StatusCode::CONFLICT,
            "invalid_request" => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let mut r = (
            status,
            Json(json!({"error":{"code":self.code,"message":self.message,"detail":self.detail}})),
        )
            .into_response();
        // In HTTP/1, refuse rather than drain an unauthorised/oversize body.
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::PAYLOAD_TOO_LARGE {
            r.headers_mut()
                .insert(header::CONNECTION, "close".parse().unwrap());
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            r.headers_mut()
                .insert(header::RETRY_AFTER, "3600".parse().unwrap());
        }
        r
    }
}
#[derive(Clone)]
pub struct Auth(pub String);
impl FromRequestParts<Arc<AppState>> for Auth {
    type Rejection = Error;
    async fn from_request_parts(parts: &mut Parts, state: &Arc<AppState>) -> Result<Self> {
        let key = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .or_else(|| parts.headers.get("x-api-key").and_then(|v| v.to_str().ok()))
            .unwrap_or("")
            .to_owned();
        let dir = state.config.data_dir.clone();
        tokio::task::spawn_blocking(move || auth::verify(&dir, &key))
            .await
            .map_err(|e| Error::new("internal", e.to_string()))?
            .map(Auth)
    }
}
/// Runs before Multipart construction and *before any body poll*, including
/// Hyper's automatic 100 Continue. Rejected requests never receive a Continue.
async fn guard(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let (mut parts, body) = request.into_parts();
    let auth = match Auth::from_request_parts(&mut parts, &state).await {
        Ok(a) => a,
        Err(e) => return e.into_response(),
    };
    let upload = parts.method == axum::http::Method::POST && parts.uri.path() == "/v1/builds";
    if upload {
        if parts
            .headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .is_some_and(|n| n > state.config.max_upload_bytes as u64)
        {
            return Error::new("too_large", "Upload exceeds configured body cap").into_response();
        }
        let permit = match state.upload(&auth.0) {
            Ok(p) => p,
            Err(e) => return e.into_response(),
        };
        parts.extensions.insert(auth);
        // Limited covers framing and text fields too, not just uploaded files.
        let limited = http_body_util::Limited::new(body, state.config.max_upload_bytes);
        let r = next
            .run(Request::from_parts(parts, Body::new(limited)))
            .await;
        drop(permit);
        r
    } else {
        parts.extensions.insert(auth);
        next.run(Request::from_parts(parts, body)).await
    }
}
pub fn router(state: Arc<AppState>) -> Router {
    let protected = Router::new()
        .route("/v1/auth-check", get(auth_check))
        .route("/v1/builds", post(submit))
        .route("/v1/builds/{id}", get(status))
        .route("/v1/builds/{id}/artifacts", get(manifest))
        .route("/v1/builds/{id}/artifacts/{name}", get(artifact))
        .route("/v1/builds/{id}/bundle", get(bundle))
        .layer(middleware::from_fn_with_state(state.clone(), guard));
    Router::new()
        .route("/healthz", get(|| async { Json(json!({"ok":true})) }))
        .merge(protected)
        .fallback(|| async { Error::new("not_found", "Not found") })
        .method_not_allowed_fallback(|| async {
            Error::new("invalid_request", "Method not allowed")
        })
        .layer(DefaultBodyLimit::disable())
        // Axum path/extractor rejections must obey the same JSON contract as
        // application errors. This wrapper never polls a rejected body.
        .layer(middleware::from_fn(json_errors))
        // API keys, not cookies. Allow Capacitor origins and browser installs;
        // no credentialed CORS. TLS and auth are mandatory at the public edge.
        .layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_headers([
                    header::AUTHORIZATION,
                    header::CONTENT_TYPE,
                    header::HeaderName::from_static("x-api-key"),
                ])
                .allow_methods([axum::http::Method::GET, axum::http::Method::POST]),
        )
        .with_state(state)
}
/// Caddy's bodyless forward-auth preflight. No key metadata or administrative
/// action is exposed. POST still reauthenticates and enforces all limits itself.
async fn auth_check(State(s): State<Arc<AppState>>, headers: HeaderMap) -> Result<StatusCode> {
    if let Some(value) = headers
        .get("x-packserver-upload-length")
        .filter(|v| !v.is_empty())
    {
        let length = value
            .to_str()
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or_else(|| Error::new("invalid_request", "Invalid upload length"))?;
        if length > s.config.max_upload_bytes as u64 {
            return Err(Error::new(
                "too_large",
                "Upload exceeds configured body cap",
            ));
        }
    }
    Ok(StatusCode::NO_CONTENT)
}
async fn json_errors(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    let status = response.status();
    let json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    if (status.is_client_error() || status.is_server_error()) && !json {
        let mut error = Error::new(
            "invalid_request",
            status.canonical_reason().unwrap_or("Request rejected"),
        )
        .into_response();
        *error.status_mut() = status;
        error
    } else {
        response
    }
}
fn multipart_error(e: axum::extract::multipart::MultipartError) -> Error {
    Error::new(
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            "too_large"
        } else {
            "input_not_pbf"
        },
        e.body_text(),
    )
}
async fn submit(
    State(s): State<Arc<AppState>>,
    axum::Extension(Auth(owner)): axum::Extension<Auth>,
    multipart: std::result::Result<Multipart, axum::extract::multipart::MultipartRejection>,
) -> Result<Response> {
    let mut multipart = multipart.map_err(|e| Error::new("input_not_pbf", e.to_string()))?;
    let id = auth::random_id("bld_");
    let dir = s.dir(&id);
    let lease = s.lease(&id)?;
    tokio::fs::create_dir_all(dir.join("inputs")).await?;
    let mut paths = vec![];
    let mut options = Options {
        region: id.clone(),
        minzoom: s.config.min_zoom,
        maxzoom: s.config.max_zoom,
        gazcap: s.config.gaz_cap,
    };
    let result: Result<()> = async {
        while let Some(mut field) = multipart.next_field().await.map_err(multipart_error)? {
            let name = field.name().unwrap_or("").to_owned();
            if name == "file" {
                let filename = field.file_name().unwrap_or("").to_owned();
                if !filename.ends_with(".osm.pbf")
                    || filename.contains(['/', '\\', '\0', '\n', '\r', '\''])
                    || filename.len() > 180
                    || filename.starts_with('.')
                {
                    return Err(Error::new(
                        "input_not_pbf",
                        "Each file must have a safe .osm.pbf filename",
                    ));
                }
                if paths.len() >= 128 {
                    return Err(Error::new("too_large", "At most 128 inputs per build"));
                }
                if paths
                    .iter()
                    .any(|p: &std::path::PathBuf| p.file_name().unwrap() == filename.as_str())
                {
                    return Err(Error::new("invalid_request", "Duplicate input filename"));
                }
                let path = dir.join("inputs").join(filename);
                let mut f = tokio::fs::File::create(&path).await?;
                while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                    f.write_all(&chunk).await?;
                }
                f.flush().await?;
                paths.push(path);
            } else {
                // Do not let Multipart::text allocate an upload-sized string.
                let mut b = vec![];
                while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                    if b.len() + chunk.len() > 1024 {
                        return Err(Error::new("too_large", "Text field exceeds 1 KiB"));
                    }
                    b.extend(chunk);
                }
                let value = std::str::from_utf8(&b)
                    .map_err(|_| Error::new("invalid_request", "Invalid UTF-8 field"))?;
                match name.as_str() {
                    "region" => options.region = value.to_owned(),
                    "minzoom" => {
                        options.minzoom = value
                            .parse()
                            .map_err(|_| Error::new("invalid_request", "Invalid minzoom"))?
                    }
                    "maxzoom" => {
                        options.maxzoom = value
                            .parse()
                            .map_err(|_| Error::new("invalid_request", "Invalid maxzoom"))?
                    }
                    "gazcap" => {
                        options.gazcap = value
                            .parse()
                            .map_err(|_| Error::new("invalid_request", "Invalid gazcap"))?
                    }
                    _ => return Err(Error::new("invalid_request", "Unknown multipart field")),
                }
            }
        }
        if paths.is_empty() {
            return Err(Error::new(
                "input_not_pbf",
                "At least one .osm.pbf file is required",
            ));
        }
        if options.minzoom > options.maxzoom || options.maxzoom > 16 {
            return Err(Error::new(
                "invalid_request",
                "Require 0 <= minzoom <= maxzoom <= 16",
            ));
        }
        if s.config.gaz_cap > 0 {
            options.gazcap = if options.gazcap == 0 {
                s.config.gaz_cap
            } else {
                options.gazcap.min(s.config.gaz_cap)
            };
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return Err(e);
    }
    let inputs: Vec<_> = paths
        .iter()
        .map(|p| crate::scan::Input {
            filename: p.file_name().unwrap().to_string_lossy().into(),
            bytes: p.metadata().map(|m| m.len()).unwrap_or(0),
            sha256: String::new(),
            sorted: false,
            resorted: false,
        })
        .collect();
    let response = json!({"id":id,"state":"queued","inputs":inputs,"links":{"status":format!("/v1/builds/{id}"),"artifacts":format!("/v1/builds/{id}/artifacts"),"bundle":format!("/v1/builds/{id}/bundle")}});
    s.queue(
        jobs::Job {
            id: id.clone(),
            state: "queued",
            stages: jobs::stages(),
            progress: json!({}),
            inputs,
            error: None,
            owner,
            created: Some(Instant::now()),
        },
        options,
        paths,
    )
    .await?;
    drop(lease);
    Ok((StatusCode::ACCEPTED, Json(response)).into_response())
}
async fn status(
    State(s): State<Arc<AppState>>,
    axum::Extension(Auth(owner)): axum::Extension<Auth>,
    Path(id): Path<String>,
) -> Result<Json<jobs::Job>> {
    Ok(Json(s.get(&id, &owner)?))
}
fn ready(s: &AppState, id: &str, owner: &str) -> Result<()> {
    let j = s.get(id, owner)?;
    if j.state != "done" {
        return Err(Error::new("not_ready", "Build is not done"));
    }
    Ok(())
}
async fn manifest(
    State(s): State<Arc<AppState>>,
    axum::Extension(Auth(owner)): axum::Extension<Auth>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let _lease = s.lease(&id)?;
    ready(&s, &id, &owner)?;
    Ok(Json(serde_json::from_slice(
        &tokio::fs::read(s.dir(&id).join("manifest.json")).await?,
    )?))
}
async fn artifact(
    State(s): State<Arc<AppState>>,
    axum::Extension(Auth(owner)): axum::Extension<Auth>,
    Path((id, name)): Path<(String, String)>,
) -> Result<Response> {
    let lease = s.lease(&id)?;
    ready(&s, &id, &owner)?;
    let manifest: Value =
        serde_json::from_slice(&tokio::fs::read(s.dir(&id).join("manifest.json")).await?)?;
    let a = manifest["artifacts"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["name"] == name))
        .ok_or_else(|| Error::new("not_found", "Artifact not found"))?;
    if name.contains(['/', '\\']) || name.starts_with('.') {
        return Err(Error::new("not_found", "Artifact not found"));
    }
    let f = tokio::fs::File::open(s.dir(&id).join(&name)).await?;
    let stream = tokio_util::io::ReaderStream::new(f).map_ok(move |b| {
        let _ = &lease;
        b
    });
    Ok((
        [
            (
                header::CONTENT_TYPE,
                a["content-type"].as_str().unwrap().to_owned(),
            ),
            (header::CONTENT_LENGTH, a["bytes"].to_string()),
            (
                header::ETAG,
                format!("\"{}\"", a["sha256"].as_str().unwrap()),
            ),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}
async fn bundle(
    State(s): State<Arc<AppState>>,
    axum::Extension(Auth(owner)): axum::Extension<Auth>,
    Path(id): Path<String>,
) -> Result<Response> {
    let lease = s.lease(&id)?;
    ready(&s, &id, &owner)?;
    let dir = s.dir(&id);
    let (writer, reader) = tokio::io::duplex(65536);
    tokio::task::spawn_blocking(move || {
        let _lease = lease;
        let bridge = tokio_util::io::SyncIoBridge::new(writer);
        if let Err(e) = crate::bundle::write(&dir, bridge) {
            eprintln!("bundle stream ended: {e}");
        }
    });
    Ok((
        [
            (header::CONTENT_TYPE, "application/gzip".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{id}.tar.gz\""),
            ),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(reader)),
    )
        .into_response())
}
