use crate::Result;
use std::{fs::File, io::Write, path::Path};

pub fn append<W: Write>(tar: &mut tar::Builder<W>, name: &str, path: &Path) -> Result<()> {
    let mut header = tar::Header::new_ustar();
    header.set_size(path.metadata()?.len());
    header.set_mode(0o644);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_entry_type(tar::EntryType::Regular);
    header.set_path(name)?;
    header.set_cksum();
    // POSIX permits both checksum encodings; GNU tar uses six octal digits,
    // NUL, space. Match tools/build-pack.mjs byte for byte, not just logically.
    let checksum = format!("{:06o}\0 ", header.cksum()?);
    header.as_mut_bytes()[148..156].copy_from_slice(checksum.as_bytes());
    tar.append(&header, File::open(path)?)?;
    Ok(())
}
pub fn build(dir: &Path, output: &Path) -> Result<usize> {
    let mut paths = walkdir::WalkDir::new(dir)
        .into_iter()
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    paths.retain(|p| p.file_type().is_file() && p.path().extension().is_some_and(|s| s == "gph"));
    paths.sort_by(|a, b| a.path().cmp(b.path()));
    let mut tar = tar::Builder::new(File::create(output)?);
    for p in &paths {
        append(
            &mut tar,
            &p.path().strip_prefix(dir).unwrap().to_string_lossy(),
            p.path(),
        )?;
    }
    tar.finish()?;
    // GNU tar (used by tools/build-pack.mjs) pads archives to 20-block records.
    let mut f = tar.into_inner()?;
    let n = f.metadata()?.len();
    let padding = (10240 - n % 10240) % 10240;
    f.write_all(&vec![0; padding as usize])?;
    Ok(paths.len())
}
