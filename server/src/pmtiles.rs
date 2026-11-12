//! PMTiles v3: Hilbert ids, gzip directory/tiles, clustered content deduplication.
use crate::Result;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::{Seek, SeekFrom, Write},
    path::Path,
};
pub fn gzip(data: &[u8]) -> Result<Vec<u8>> {
    let mut gz = flate2::GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), flate2::Compression::default());
    gz.write_all(data)?;
    Ok(gz.finish()?)
}
pub fn tile_id(z: u8, mut x: u32, mut y: u32) -> u64 {
    let mut d = 0u64;
    let mut s = (1u32 << z) / 2;
    while s > 0 {
        let rx = u32::from(x & s > 0);
        let ry = u32::from(y & s > 0);
        d += (s as u64 * s as u64) * ((3 * rx) ^ ry) as u64;
        if ry == 0 {
            if rx == 1 {
                x = (1u32 << z) - 1 - x;
                y = (1u32 << z) - 1 - y;
            }
            std::mem::swap(&mut x, &mut y);
        }
        s /= 2;
    }
    ((1u64 << (2 * z)) - 1) / 3 + d
}
#[derive(Clone, Debug)]
pub struct Entry {
    pub id: u64,
    pub offset: u64,
    pub length: u64,
    pub run: u64,
}
pub fn directory(entries: &[Entry]) -> Result<Vec<u8>> {
    let mut b = vec![];
    crate::mvt::varint(entries.len() as u64, &mut b);
    let mut last = 0;
    for e in entries {
        crate::mvt::varint(e.id - last, &mut b);
        last = e.id;
    }
    for e in entries {
        crate::mvt::varint(e.run, &mut b);
    }
    for e in entries {
        crate::mvt::varint(e.length, &mut b);
    }
    let mut end = 0;
    for (i, e) in entries.iter().enumerate() {
        crate::mvt::varint(
            if i > 0 && e.offset == end {
                0
            } else {
                e.offset + 1
            },
            &mut b,
        );
        end = e.offset + e.length;
    }
    gzip(&b)
}
pub struct Writer {
    file: File,
    spool: tempfile::NamedTempFile,
    entries: Vec<Entry>,
    hashes: HashMap<[u8; 32], (u64, u64)>,
    bytes: u64,
    min: u8,
    max: u8,
    bbox: [f64; 4],
    addressed: u64,
}
impl Writer {
    pub fn new(path: &Path, min: u8, max: u8, bbox: [f64; 4]) -> Result<Self> {
        Ok(Self {
            file: File::create(path)?,
            spool: tempfile::NamedTempFile::new_in(path.parent().unwrap())?,
            entries: vec![],
            hashes: HashMap::new(),
            bytes: 0,
            min,
            max,
            bbox,
            addressed: 0,
        })
    }
    pub fn tile(&mut self, id: u64, data: &[u8]) -> Result<()> {
        let hash: [u8; 32] = Sha256::digest(data).into();
        let (offset, length) = if let Some(p) = self.hashes.get(&hash) {
            *p
        } else {
            let gz = gzip(data)?;
            let p = (self.bytes, gz.len() as u64);
            self.spool.write_all(&gz)?;
            self.bytes += p.1;
            self.hashes.insert(hash, p);
            p
        };
        if let Some(e) = self
            .entries
            .last_mut()
            .filter(|e| e.id + e.run == id && e.offset == offset && e.length == length)
        {
            e.run += 1;
        } else {
            self.entries.push(Entry {
                id,
                offset,
                length,
                run: 1,
            });
        }
        self.addressed += 1;
        Ok(())
    }
    pub fn finish(mut self) -> Result<u64> {
        let mut root = directory(&self.entries)?;
        let mut leaves = vec![];
        if root.len() > 16257 {
            let mut chunk = 4096;
            loop {
                leaves.clear();
                let mut pointers = vec![];
                for entries in self.entries.chunks(chunk) {
                    let b = directory(entries)?;
                    pointers.push(Entry {
                        id: entries[0].id,
                        offset: leaves.len() as u64,
                        length: b.len() as u64,
                        run: 0,
                    });
                    leaves.extend(b);
                }
                root = directory(&pointers)?;
                if root.len() <= 16257 {
                    break;
                }
                chunk *= 2;
            }
        }
        let meta = gzip(&serde_json::to_vec(
            &serde_json::json!({"name":"Canopy offline map","format":"pbf","attribution":"© OpenStreetMap contributors","vector_layers":[{"id":"roads","fields":{"class":"String","name":"String"}},{"id":"water","fields":{"class":"String"}},{"id":"green","fields":{"class":"String"}}]}),
        )?)?;
        let root_off = 127;
        let meta_off = root_off + root.len() as u64;
        let leaf_off = meta_off + meta.len() as u64;
        let tile_off = leaf_off + leaves.len() as u64;
        let mut h = [0u8; 127];
        h[..7].copy_from_slice(b"PMTiles");
        h[7] = 3;
        for (at, n) in [
            (8, root_off),
            (16, root.len() as u64),
            (24, meta_off),
            (32, meta.len() as u64),
            (40, leaf_off),
            (48, leaves.len() as u64),
            (56, tile_off),
            (64, self.bytes),
            (72, self.addressed),
            (80, self.entries.len() as u64),
            (88, self.hashes.len() as u64),
        ] {
            h[at..at + 8].copy_from_slice(&n.to_le_bytes());
        }
        h[96] = 1;
        h[97] = 2;
        h[98] = 2;
        h[99] = 1;
        h[100] = self.min;
        h[101] = self.max;
        for (at, n) in [
            (102, self.bbox[0]),
            (106, self.bbox[1]),
            (110, self.bbox[2]),
            (114, self.bbox[3]),
            (119, (self.bbox[0] + self.bbox[2]) / 2.0),
            (123, (self.bbox[1] + self.bbox[3]) / 2.0),
        ] {
            h[at..at + 4].copy_from_slice(&((n * 1e7).round() as i32).to_le_bytes());
        }
        h[118] = self.min;
        self.file.write_all(&h)?;
        self.file.write_all(&root)?;
        self.file.write_all(&meta)?;
        self.file.write_all(&leaves)?;
        self.spool.seek(SeekFrom::Start(0))?;
        std::io::copy(&mut self.spool, &mut self.file)?;
        Ok(self.addressed)
    }
}
