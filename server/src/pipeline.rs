use crate::{Artifact, Error, Result, jobs::State, scan};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{path::PathBuf, process::Command, sync::Arc, time::Instant};
#[derive(Clone, Serialize, Deserialize)]
pub struct Options {
    pub region: String,
    pub minzoom: u8,
    pub maxzoom: u8,
    pub gazcap: usize,
}
fn stage<T>(s: &State, id: &str, name: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    s.update(id, |j| {
        let stage = j.stages.iter_mut().find(|x| x.name == name).unwrap();
        stage.state = "running";
    });
    let t = Instant::now();
    let result = f();
    s.update(id, |j| {
        let stage = j.stages.iter_mut().find(|x| x.name == name).unwrap();
        stage.state = if result.is_ok() { "done" } else { "failed" };
        stage.ms = t.elapsed().as_millis() as u64;
    });
    result
}
pub fn run(s: &Arc<State>, id: &str, options: Options, mut paths: Vec<PathBuf>) -> Result<()> {
    let dir = s.dir(id);
    let (inputs, counts, bbox) = stage(s, id, "scan", || {
        let mut inputs = vec![];
        let mut counts = scan::Counts::default();
        let mut bbox = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        for path in &mut paths {
            let mut scan = scan::read(path)?;
            if let Some(disorder) = scan.disorder {
                let original = path.clone();
                let sorted = path.with_file_name(format!("sorted-{}", scan.input.filename));
                let mut cmd = Command::new(&s.config.osmium_bin);
                cmd.arg("sort").arg(&original).arg("-o").arg(&sorted);
                if crate::valhalla::command(
                    cmd,
                    &dir.join("sort.log"),
                    s.config.build_timeout_secs,
                    "input_unsorted",
                )
                .is_err()
                {
                    return Err(Error{code:"input_unsorted",message:"Input PBF is not type-sorted; valhalla_build_tiles requires sorted input.".into(),detail:format!("{disorder} in {}. Run: osmium sort -o sorted.osm.pbf '{}'",scan.input.filename,scan.input.filename.replace('\'',"'\\''"))});
                }
                let verified = scan::read(&sorted)?;
                if verified.disorder.is_some() {
                    return Err(Error::new(
                        "input_unsorted",
                        "osmium did not produce sorted input",
                    ));
                }
                scan.input.resorted = true;
                *path = sorted;
            }
            counts.nodes += scan.counts.nodes;
            counts.ways += scan.counts.ways;
            counts.relations += scan.counts.relations;
            counts.routable += scan.counts.routable;
            scan::bounds(&mut bbox, scan.bbox[0], scan.bbox[1]);
            scan::bounds(&mut bbox, scan.bbox[2], scan.bbox[3]);
            inputs.push(scan.input);
        }
        s.update(id, |j| {
            j.inputs = inputs.clone();
            j.progress = json!(&counts);
        });
        Ok((inputs, counts, bbox))
    })?;
    stage(s, id, "valhalla", || {
        crate::valhalla::build(&s.config, &dir, &paths)
    })?;
    let tiles = stage(s, id, "pack", || {
        crate::pack::build(&dir.join("tiles"), &dir.join("routing.valhalla.tar"))
    })?;
    if tiles == 0 {
        return Err(Error::new(
            "valhalla_failed",
            "Valhalla produced no routing tiles",
        ));
    }
    let data = stage(s, id, "gazetteer", || {
        let data = crate::render::extract(&paths)?;
        let entries = crate::gaz::entries(&data, options.gazcap);
        crate::gaz::write(&entries, &dir.join("search.gazetteer.jsonl.gz"))?;
        s.update(id, |j| j.progress["entries"] = json!(entries.len()));
        Ok((data, entries.len()))
    })?;
    let features = stage(s, id, "tiles", || Ok(crate::render::features(&data.0)))?;
    drop(data.0);
    let map_tiles = stage(s, id, "pmtiles", || {
        crate::tiles::build(
            features,
            &dir.join("map.pmtiles"),
            options.minzoom,
            options.maxzoom,
            bbox,
        )
    })?;
    stage(s, id, "manifest", || {
        let defs = [
            (
                "routing.valhalla.tar",
                "routing",
                "valhalla-gph-tar/1",
                "application/x-tar",
                json!({"tiles":tiles}),
            ),
            (
                "search.gazetteer.jsonl.gz",
                "search",
                "canopy-gazetteer/1",
                "application/gzip",
                json!({"entries":data.1}),
            ),
            (
                "map.pmtiles",
                "basemap",
                "pmtiles/3",
                "application/vnd.pmtiles",
                json!({"minzoom":options.minzoom,"maxzoom":options.maxzoom,"layers":["roads","water","green"],"tiles":map_tiles}),
            ),
        ];
        let mut artifacts = vec![];
        for (name, role, format, ct, extra) in defs {
            let path = dir.join(name);
            artifacts.push(Artifact {
                name: name.into(),
                role: role.into(),
                format: format.into(),
                bytes: path.metadata()?.len(),
                sha256: scan::hash_file(&path)?,
                content_type: ct.into(),
                extra,
            });
        }
        let created = chrono::Utc::now().to_rfc3339();
        let manifest = json!({"format":"canopy-bundle/1","build":{"id":id,"created":created,"packserver":env!("CARGO_PKG_VERSION"),"valhalla":crate::valhalla::version(&s.config.valhalla_bin)},"region":{"name":options.region,"bbox":bbox,"counts":counts},"inputs":inputs,"artifacts":artifacts});
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
        Ok(())
    })
}
