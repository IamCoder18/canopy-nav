use crate::{Result, pack};
use std::{io::Write, path::Path};
pub fn write<W: Write>(dir: &Path, out: W) -> Result<()> {
    let gz = flate2::GzBuilder::new()
        .mtime(0)
        .write(out, flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    for name in [
        "manifest.json",
        "map.pmtiles",
        "routing.valhalla.tar",
        "search.gazetteer.jsonl.gz",
    ] {
        pack::append(&mut tar, name, &dir.join(name))?;
    }
    tar.finish()?;
    tar.into_inner()?.finish()?;
    Ok(())
}
