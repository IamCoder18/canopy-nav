use crate::{Error, Result, config::Config};
use std::{
    fs::File,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
/// Redirect child output to disk (not an unbounded captured pipe). Always reap
/// children, including timeouts, so a timed-out request cannot leave a builder.
pub fn command(mut cmd: Command, log: &Path, timeout: u64, code: &'static str) -> Result<()> {
    let file = File::create(log)?;
    cmd.stdout(Stdio::from(file.try_clone()?))
        .stderr(Stdio::from(file));
    let mut child = cmd.spawn().map_err(|e| Error::new(code, e.to_string()))?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            let mut e = Error::new(code, format!("Builder exited with {status}"));
            use std::io::{Read, Seek, SeekFrom};
            let mut f = File::open(log)?;
            let len = f.metadata()?.len();
            f.seek(SeekFrom::Start(len.saturating_sub(8192)))?;
            f.read_to_string(&mut e.detail)?;
            return Err(e);
        }
        if start.elapsed() > Duration::from_secs(timeout) {
            child.kill()?;
            child.wait()?;
            return Err(Error::new(code, "Builder timed out"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
pub fn build(c: &Config, dir: &Path, inputs: &[PathBuf]) -> Result<()> {
    std::fs::create_dir_all(dir.join("tiles"))?;
    let config = serde_json::json!({"mjolnir":{"tile_dir":dir.join("tiles"),"concurrency":c.threads,"admin":"","timezone":""},"logging":{"type":""}});
    let mut cmd = Command::new(&c.valhalla_bin);
    cmd.arg("--inline-config")
        .arg(config.to_string())
        .arg("-j")
        .arg(c.threads.to_string())
        .args(inputs);
    command(
        cmd,
        &dir.join("valhalla.log"),
        c.build_timeout_secs,
        "valhalla_failed",
    )
}
pub fn version(bin: &str) -> String {
    Command::new(bin)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unavailable".into())
}
