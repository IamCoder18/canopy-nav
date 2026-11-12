pub mod admin;
pub mod api;
pub mod auth;
pub mod bundle;
pub mod config;
pub mod gaz;
pub mod jobs;
pub mod mvt;
pub mod pack;
pub mod pipeline;
pub mod pmtiles;
pub mod render;
pub mod scan;
pub mod tiles;
pub mod valhalla;

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    pub code: &'static str,
    pub message: String,
    pub detail: String,
}
impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: String::new(),
        }
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new(
            if e.raw_os_error() == Some(28) {
                "disk_full"
            } else {
                "internal"
            },
            e.to_string(),
        )
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::new("internal", e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
pub struct Artifact {
    pub name: String,
    pub role: String,
    pub format: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(rename = "content-type")]
    pub content_type: String,
    #[serde(flatten)]
    pub extra: serde_json::Value,
}
