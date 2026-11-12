use crate::{Error, Result};
use std::{env, path::PathBuf};

#[derive(Clone, Debug, serde::Serialize)]
pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
    pub valhalla_bin: String,
    pub osmium_bin: String,
    pub max_upload_bytes: usize,
    pub max_concurrent_builds: usize,
    pub job_ttl_secs: u64,
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub gaz_cap: usize,
    pub uploads_per_hour: usize,
    pub concurrent_uploads: usize,
    pub build_timeout_secs: u64,
    pub threads: usize,
}
impl Config {
    pub fn from_env() -> Result<Self> {
        fn s(k: &str, default: &str) -> String {
            env::var(format!("PACKSERVER_{k}")).unwrap_or(default.into())
        }
        fn n<T: std::str::FromStr>(k: &str, default: &str) -> Result<T> {
            s(k, default)
                .parse()
                .map_err(|_| Error::new("internal", format!("Invalid PACKSERVER_{k}")))
        }
        let c = Self {
            port: n("PORT", "8787")?,
            data_dir: s("DATA_DIR", "/var/lib/packserver").into(),
            valhalla_bin: s("VALHALLA_BIN", "valhalla_build_tiles"),
            osmium_bin: s("OSMIUM_BIN", "osmium"),
            max_upload_bytes: n::<usize>("MAX_UPLOAD_MB", "2048")?
                .checked_mul(1024 * 1024)
                .ok_or_else(|| Error::new("internal", "Upload cap overflow"))?,
            max_concurrent_builds: n("MAX_CONCURRENT_BUILDS", "2")?,
            job_ttl_secs: n("JOB_TTL_SECS", "86400")?,
            min_zoom: n("MIN_ZOOM", "5")?,
            max_zoom: n("MAX_ZOOM", "16")?,
            gaz_cap: n("GAZ_CAP", "0")?,
            uploads_per_hour: n("UPLOADS_PER_HOUR", "10")?,
            concurrent_uploads: n("CONCURRENT_UPLOADS", "2")?,
            build_timeout_secs: n("BUILD_TIMEOUT_SECS", "7200")?,
            threads: n("THREADS", "2")?,
        };
        if c.min_zoom > c.max_zoom
            || c.max_zoom > 16
            || c.max_concurrent_builds == 0
            || c.concurrent_uploads == 0
            || c.uploads_per_hour == 0
            || c.threads == 0
            || c.max_upload_bytes == 0
        {
            return Err(Error::new(
                "internal",
                "Invalid limits or zoom range (0 <= min <= max <= 16; limits must be positive)",
            ));
        }
        std::fs::create_dir_all(c.data_dir.join("builds"))?;
        Ok(c)
    }
}
