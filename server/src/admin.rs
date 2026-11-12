use crate::{Error, Result, auth, config::Config};
use chrono::{NaiveDate, Utc};
use clap::Subcommand;
#[derive(Subcommand)]
pub enum Admin {
    #[command(subcommand)]
    Key(Key),
    #[command(subcommand)]
    Jobs(Jobs),
    Doctor,
}
#[derive(Subcommand)]
pub enum Key {
    Create {
        #[arg(long)]
        name: String,
        #[arg(long)]
        expires: Option<String>,
    },
    List {
        #[arg(long)]
        json: bool,
    },
    Revoke {
        id: String,
    },
}
#[derive(Subcommand)]
pub enum Jobs {
    List {
        #[arg(long)]
        json: bool,
    },
    Prune {
        #[arg(long)]
        all: bool,
    },
}
pub fn run(c: Config, cmd: Admin) -> Result<()> {
    match cmd {
        Admin::Key(Key::Create { name, expires }) => {
            let expires = expires
                .map(|v| {
                    NaiveDate::parse_from_str(&v, "%Y-%m-%d")
                        .map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc())
                        .map_err(|_| Error::new("invalid_request", "Expiry must be YYYY-MM-DD"))
                })
                .transpose()?;
            if expires.is_some_and(|d| d <= Utc::now()) {
                return Err(Error::new(
                    "invalid_request",
                    "Expiry must be in the future",
                ));
            }
            let plaintext = auth::random_id("canopy_pk_");
            let key = auth::Key {
                id: auth::random_id("key_"),
                name,
                hash: auth::hash(&plaintext),
                created: Utc::now(),
                expires,
                last_used: None,
                revoked: false,
            };
            auth::edit(&c.data_dir, |keys| {
                keys.push(key);
                Ok(())
            })?;
            println!("{plaintext}");
        }
        Admin::Key(Key::List { json }) => {
            let keys = auth::edit(&c.data_dir, |keys| Ok(keys.clone()))?;
            let rows:Vec<_>=keys.iter().map(|k|serde_json::json!({"id":k.id,"name":k.name,"created":k.created,"expires":k.expires,"last_used":k.last_used,"revoked":k.revoked})).collect();
            if json {
                println!("{}", serde_json::to_string_pretty(&rows)?);
            } else {
                for k in rows {
                    println!(
                        "{}\t{}\trevoked={}\texpires={}",
                        k["id"], k["name"], k["revoked"], k["expires"]
                    );
                }
            }
        }
        Admin::Key(Key::Revoke { id }) => auth::edit(&c.data_dir, |keys| {
            let key = keys
                .iter_mut()
                .find(|k| k.id == id)
                .ok_or_else(|| Error::new("not_found", "Key not found"))?;
            key.revoked = true;
            Ok(())
        })?,
        Admin::Jobs(cmd) => {
            let mut rows = vec![];
            for entry in std::fs::read_dir(c.data_dir.join("builds"))? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let age = entry
                    .metadata()?
                    .modified()?
                    .elapsed()
                    .unwrap_or_default()
                    .as_secs();
                if let Jobs::Prune { all } = cmd {
                    if all || age > c.job_ttl_secs {
                        let file =
                            crate::jobs::build_lock(&c, &entry.file_name().to_string_lossy())?;
                        if fs2::FileExt::try_lock_exclusive(&file).is_ok() {
                            std::fs::remove_dir_all(entry.path())?;
                        }
                    }
                } else {
                    let bytes = walkdir::WalkDir::new(entry.path())
                        .into_iter()
                        .filter_map(|e| e.ok())
                        .filter_map(|e| e.metadata().ok())
                        .filter(|m| m.is_file())
                        .map(|m| m.len())
                        .sum::<u64>();
                    let snapshot = std::fs::read(entry.path().join("job.json"))
                        .ok()
                        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
                    rows.push(serde_json::json!({"id":entry.file_name().to_string_lossy(),"age_secs":age,"bytes":bytes,"status":snapshot,"manifest":entry.path().join("manifest.json").exists()}));
                }
            }
            if let Jobs::List { json } = cmd {
                if json {
                    println!("{}", serde_json::to_string_pretty(&rows)?);
                } else {
                    for row in rows {
                        println!("{row}");
                    }
                }
            }
        }
        Admin::Doctor => {
            println!(
                "valhalla: {} ({})",
                c.valhalla_bin,
                crate::valhalla::version(&c.valhalla_bin)
            );
            println!("osmium: {}", crate::valhalla::version(&c.osmium_bin));
            println!("free_bytes: {}", fs2::available_space(&c.data_dir)?);
            let used = walkdir::WalkDir::new(&c.data_dir)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter_map(|e| e.metadata().ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .sum::<u64>();
            println!("used_bytes: {used}\n{}", serde_json::to_string_pretty(&c)?);
        }
    }
    Ok(())
}
pub fn server_lock(c: &Config) -> Result<std::fs::File> {
    use fs2::FileExt;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(c.data_dir.join("serve.lock"))?;
    lock.try_lock_exclusive().map_err(|_| {
        Error::new(
            "internal",
            "Service is running; stop it before offline pruning (TTL sweeping runs online)",
        )
    })?;
    Ok(lock)
}
