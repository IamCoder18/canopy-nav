use canopy_packserver::{Artifact, Result, bundle, gaz, pack, render, scan, tiles};
use serde_json::json;
use std::{fs, path::PathBuf};
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let input = PathBuf::from(&args[1]);
    let out = PathBuf::from(&args[2]);
    fs::create_dir_all(&out)?;
    let scan = scan::read(&input)?;
    let data = render::extract(&[input])?;
    let gazetteer = gaz::entries(&data, 0);
    gaz::write(&gazetteer, &out.join("search.gazetteer.jsonl.gz"))?;
    tiles::build(
        render::features(&data),
        &out.join("map.pmtiles"),
        5,
        16,
        scan.bbox,
    )?;
    let tmp = tempfile::tempdir()?;
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test/fixture.valhalla.tar");
    tar::Archive::new(fs::File::open(fixture)?).unpack(tmp.path())?;
    let n = pack::build(tmp.path(), &out.join("routing.valhalla.tar"))?;
    let mut artifacts = vec![];
    for (name, role, format, ct, extra) in [
        (
            "routing.valhalla.tar",
            "routing",
            "valhalla-gph-tar/1",
            "application/x-tar",
            json!({"tiles":n}),
        ),
        (
            "search.gazetteer.jsonl.gz",
            "search",
            "canopy-gazetteer/1",
            "application/gzip",
            json!({"entries":gazetteer.len()}),
        ),
        (
            "map.pmtiles",
            "basemap",
            "pmtiles/3",
            "application/vnd.pmtiles",
            json!({"minzoom":5,"maxzoom":16,"layers":["roads","water","green"]}),
        ),
    ] {
        let path = out.join(name);
        artifacts.push(Artifact {
            name: name.into(),
            role: role.into(),
            format: format.into(),
            content_type: ct.into(),
            bytes: path.metadata()?.len(),
            sha256: scan::hash_file(&path)?,
            extra,
        });
    }
    let manifest = json!({"format":"canopy-bundle/1","build":{"id":"bld_fixture","created":"2026-11-12T00:00:00Z","packserver":env!("CARGO_PKG_VERSION"),"valhalla":"3.9.1-fixture"},"region":{"name":"Fixture City","bbox":scan.bbox,"counts":scan.counts},"inputs":[scan.input],"artifacts":artifacts});
    fs::write(
        out.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    bundle::write(&out, fs::File::create(out.join("fixture.tar.gz"))?)?;
    Ok(())
}
