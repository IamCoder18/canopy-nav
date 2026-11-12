use crate::{Error, Result};
use chrono::{DateTime, Utc};
use fs2::FileExt;
use rand::{Rng, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Key {
    pub id: String,
    pub name: String,
    pub hash: String,
    pub created: DateTime<Utc>,
    pub expires: Option<DateTime<Utc>>,
    pub last_used: Option<DateTime<Utc>>,
    #[serde(default)]
    pub revoked: bool,
}
pub fn random_id(prefix: &str) -> String {
    let alphabet = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    // 43 uniformly sampled base62 digits exceed 256 bits of entropy.
    format!(
        "{prefix}{}",
        (0..43)
            .map(|_| alphabet[OsRng.gen_range(0..62)] as char)
            .collect::<String>()
    )
}
pub fn hash(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

/// Separate lock inode survives atomic replacement of keys.json. CLI and server
/// use the same lock, so revocation cannot race a last_used write.
pub fn edit<T>(dir: &Path, f: impl FnOnce(&mut Vec<Key>) -> Result<T>) -> Result<T> {
    fs::create_dir_all(dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(dir.join("keys.lock"))?;
    lock.lock_exclusive()?;
    let path = dir.join("keys.json");
    let mut keys = match fs::read(&path) {
        Ok(b) => serde_json::from_slice(&b)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
        Err(e) => return Err(e.into()),
    };
    let result = f(&mut keys)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.as_file()
        .set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    tmp.write_all(&serde_json::to_vec_pretty(&keys)?)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(result)
}
pub fn verify(dir: &Path, plaintext: &str) -> Result<String> {
    if !plaintext.starts_with("canopy_pk_") {
        return Err(Error::new("unauthorized", "API key required"));
    }
    let wanted = hash(plaintext);
    edit(dir, |keys| {
        let key = keys
            .iter_mut()
            .find(|k| k.hash == wanted && !k.revoked && k.expires.is_none_or(|t| t > Utc::now()))
            .ok_or_else(|| Error::new("unauthorized", "Invalid or expired API key"))?;
        key.last_used = Some(Utc::now());
        Ok(key.id.clone())
    })
}
