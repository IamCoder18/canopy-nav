use crate::{Error, Result, config::Config, scan::Input};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
#[derive(Clone, Serialize)]
pub struct Stage {
    pub name: &'static str,
    pub state: &'static str,
    pub ms: u64,
}
#[derive(Clone, Serialize)]
pub struct Job {
    pub id: String,
    pub state: &'static str,
    pub stages: Vec<Stage>,
    pub progress: serde_json::Value,
    pub inputs: Vec<Input>,
    pub error: Option<serde_json::Value>,
    #[serde(skip)]
    pub owner: String,
    #[serde(skip)]
    pub created: Option<Instant>,
}
pub struct Rate {
    pub active: usize,
    pub times: VecDeque<Instant>,
}
pub struct State {
    pub config: Config,
    pub jobs: Mutex<HashMap<String, Job>>,
    pub rates: Mutex<HashMap<String, Rate>>,
    pub builds: Arc<Semaphore>,
    /// Prevent TTL/prune racing an upload or a bundle stream.
    pub leases: Mutex<HashMap<String, usize>>,
}
pub struct Lease {
    state: Arc<State>,
    id: String,
    _file: std::fs::File,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut l = self.state.leases.lock().unwrap();
        if let Some(n) = l.get_mut(&self.id) {
            *n -= 1;
            if *n == 0 {
                l.remove(&self.id);
            }
        }
    }
}
pub struct Upload {
    state: Arc<State>,
    key: String,
}
impl Drop for Upload {
    fn drop(&mut self) {
        if let Some(r) = self.state.rates.lock().unwrap().get_mut(&self.key) {
            r.active -= 1;
        }
    }
}
impl State {
    pub fn new(config: Config) -> Arc<Self> {
        Arc::new(Self {
            builds: Arc::new(Semaphore::new(config.max_concurrent_builds)),
            config,
            jobs: Mutex::new(HashMap::new()),
            rates: Mutex::new(HashMap::new()),
            leases: Mutex::new(HashMap::new()),
        })
    }
    pub fn dir(&self, id: &str) -> PathBuf {
        self.config.data_dir.join("builds").join(id)
    }
    pub fn lease(self: &Arc<Self>, id: &str) -> Result<Lease> {
        let mut leases = self.leases.lock().unwrap();
        let file = build_lock(&self.config, id)?;
        fs2::FileExt::lock_shared(&file)?;
        *leases.entry(id.into()).or_default() += 1;
        Ok(Lease {
            state: self.clone(),
            id: id.into(),
            _file: file,
        })
    }
    pub fn upload(self: &Arc<Self>, key: &str) -> Result<Upload> {
        let mut rates = self.rates.lock().unwrap();
        let now = Instant::now();
        let r = rates.entry(key.into()).or_insert(Rate {
            active: 0,
            times: VecDeque::new(),
        });
        while r
            .times
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(3600))
        {
            r.times.pop_front();
        }
        if r.active >= self.config.concurrent_uploads
            || r.times.len() >= self.config.uploads_per_hour
        {
            return Err(Error::new(
                "rate_limited",
                "Upload limit reached; try again later",
            ));
        }
        r.active += 1;
        r.times.push_back(now);
        Ok(Upload {
            state: self.clone(),
            key: key.into(),
        })
    }
    pub fn get(&self, id: &str, owner: &str) -> Result<Job> {
        self.jobs
            .lock()
            .unwrap()
            .get(id)
            .filter(|j| j.owner == owner && self.dir(id).is_dir())
            .cloned()
            .ok_or_else(|| Error::new("not_found", "Build not found"))
    }
    pub fn update(&self, id: &str, f: impl FnOnce(&mut Job)) {
        if let Some(j) = self.jobs.lock().unwrap().get_mut(id) {
            f(j);
            // Diagnostic snapshot for the CLI only, never used to restore jobs.
            if let Ok(bytes) = serde_json::to_vec(j) {
                let path = self.dir(id).join("job.json.tmp");
                if std::fs::write(&path, bytes).is_ok() {
                    let _ = std::fs::rename(path, self.dir(id).join("job.json"));
                }
            }
        }
    }
    pub async fn queue(
        self: &Arc<Self>,
        job: Job,
        options: crate::pipeline::Options,
        paths: Vec<PathBuf>,
    ) -> Result<()> {
        let id = job.id.clone();
        self.jobs.lock().unwrap().insert(id.clone(), job);
        let state = self.clone();
        let lease = self.lease(&id)?;
        tokio::spawn(async move {
            let permit: OwnedSemaphorePermit = state.builds.clone().acquire_owned().await.unwrap();
            state.update(&id, |j| j.state = "running");
            let s = state.clone();
            let build_id = id.clone();
            let r = tokio::task::spawn_blocking(move || {
                crate::pipeline::run(&s, &build_id, options, paths)
            })
            .await;
            match r {
                Ok(Ok(())) => state.update(&id, |j| j.state = "done"),
                other => {
                    let e = match other {
                        Ok(Err(e)) => e,
                        Err(e) => Error::new("internal", e.to_string()),
                        _ => unreachable!(),
                    };
                    state.update(&id,|j|{j.state="failed";for stage in &mut j.stages {if stage.state=="running" {stage.state="failed";}} j.error=Some(serde_json::json!({"code":e.code,"message":e.message,"detail":e.detail}));});
                }
            }
            // Raw uploads and temporary C++ outputs have no reason to survive a build.
            let _ = std::fs::remove_dir_all(state.dir(&id).join("inputs"));
            let _ = std::fs::remove_dir_all(state.dir(&id).join("tiles"));
            drop(permit);
            drop(lease);
        });
        Ok(())
    }
    pub fn sweep(&self) -> Result<()> {
        let leases = self.leases.lock().unwrap();
        let mut jobs = self.jobs.lock().unwrap();
        // CLI pruning is deliberately independent of this process. Forget its
        // deleted snapshots too, rather than leaking registry rows until restart.
        jobs.retain(|id, _| leases.contains_key(id) || self.dir(id).is_dir());
        for entry in std::fs::read_dir(self.config.data_dir.join("builds"))? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if leases.contains_key(&id) {
                continue;
            }
            let expired = jobs
                .get(&id)
                .and_then(|j| j.created)
                .map(|t| t.elapsed().as_secs() > self.config.job_ttl_secs)
                .unwrap_or(
                    entry
                        .metadata()?
                        .modified()?
                        .elapsed()
                        .unwrap_or_default()
                        .as_secs()
                        > self.config.job_ttl_secs,
                );
            if expired {
                let file = build_lock(&self.config, &id)?;
                if fs2::FileExt::try_lock_exclusive(&file).is_ok() {
                    std::fs::remove_dir_all(entry.path())?;
                    jobs.remove(&id);
                }
            }
        }
        Ok(())
    }
}
pub fn build_lock(c: &Config, id: &str) -> Result<std::fs::File> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(Error::new("not_found", "Build not found"));
    }
    let dir = c.data_dir.join("locks");
    std::fs::create_dir_all(&dir)?;
    Ok(std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(id))?)
}
pub fn stages() -> Vec<Stage> {
    [
        "scan",
        "valhalla",
        "pack",
        "gazetteer",
        "tiles",
        "pmtiles",
        "manifest",
    ]
    .into_iter()
    .map(|name| Stage {
        name,
        state: "pending",
        ms: 0,
    })
    .collect()
}
