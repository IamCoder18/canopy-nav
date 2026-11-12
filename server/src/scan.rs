use crate::{Error, Result};
use osmpbf::{Element, ElementReader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub struct Counts {
    pub nodes: u64,
    pub ways: u64,
    pub relations: u64,
    pub routable: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Input {
    pub filename: String,
    pub bytes: u64,
    pub sha256: String,
    pub sorted: bool,
    pub resorted: bool,
}
pub struct Scan {
    pub input: Input,
    pub counts: Counts,
    pub bbox: [f64; 4],
    pub disorder: Option<String>,
}
pub fn hash_file(path: &Path) -> Result<String> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut b = [0u8; 65536];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(hex::encode(h.finalize()))
}
pub fn read(path: &Path) -> Result<Scan> {
    let mut counts = Counts::default();
    let mut bbox = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut last = (0u8, i64::MIN);
    let mut disorder = None;
    let reader =
        ElementReader::from_path(path).map_err(|e| Error::new("input_not_pbf", e.to_string()))?;
    reader
        .for_each(|e| {
            let (kind, id) = match e {
                Element::Node(n) => {
                    counts.nodes += 1;
                    bounds(&mut bbox, n.lon(), n.lat());
                    (0, n.id())
                }
                Element::DenseNode(n) => {
                    counts.nodes += 1;
                    bounds(&mut bbox, n.lon(), n.lat());
                    (0, n.id())
                }
                Element::Way(w) => {
                    counts.ways += 1;
                    if w.tags().any(|(k, _)| k == "highway") {
                        counts.routable += 1;
                    }
                    (1, w.id())
                }
                Element::Relation(r) => {
                    counts.relations += 1;
                    (2, r.id())
                }
            };
            if (kind, id) < last && disorder.is_none() {
                let types = ["node", "way", "relation"];
                disorder = Some(format!(
                    "{} {} appears after {} {}",
                    types[kind as usize], id, types[last.0 as usize], last.1
                ));
            }
            last = (kind, id);
        })
        .map_err(|e| Error::new("input_not_pbf", e.to_string()))?;
    if counts.nodes == 0 {
        return Err(Error::new("input_not_pbf", "PBF contains no nodes"));
    }
    if !bbox.iter().all(|v| v.is_finite())
        || bbox[0] < -180.0
        || bbox[2] > 180.0
        || bbox[1] < -90.0
        || bbox[3] > 90.0
    {
        return Err(Error::new(
            "input_not_pbf",
            "PBF has coordinates outside longitude/latitude bounds",
        ));
    }
    Ok(Scan {
        input: Input {
            filename: path.file_name().unwrap().to_string_lossy().into(),
            bytes: path.metadata()?.len(),
            sha256: hash_file(path)?,
            sorted: disorder.is_none(),
            resorted: false,
        },
        counts,
        bbox,
        disorder,
    })
}
pub fn bounds(b: &mut [f64; 4], x: f64, y: f64) {
    b[0] = b[0].min(x);
    b[1] = b[1].min(y);
    b[2] = b[2].max(x);
    b[3] = b[3].max(y);
}
