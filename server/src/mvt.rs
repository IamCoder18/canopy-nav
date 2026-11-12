//! Minimal Mapbox Vector Tile v2 encoder. All geometry is tile-local, extent 4096.
use std::collections::BTreeMap;
pub fn varint(mut n: u64, out: &mut Vec<u8>) {
    while n >= 128 {
        out.push((n as u8 & 127) | 128);
        n >>= 7;
    }
    out.push(n as u8);
}
fn uint(field: u64, n: u64, out: &mut Vec<u8>) {
    varint(field << 3, out);
    varint(n, out);
}
fn bytes(field: u64, b: &[u8], out: &mut Vec<u8>) {
    varint((field << 3) | 2, out);
    varint(b.len() as u64, out);
    out.extend(b);
}
fn zig(n: i32) -> u64 {
    ((n << 1) ^ (n >> 31)) as u32 as u64
}
#[derive(Clone, Debug)]
pub struct Feature {
    pub class: String,
    pub name: String,
    pub polygon: bool,
    pub paths: Vec<Vec<[i32; 2]>>,
}
pub fn geometry(f: &Feature) -> Vec<u8> {
    let mut out = vec![];
    let mut cursor = [0i32; 2];
    for path in &f.paths {
        if path.len() < if f.polygon { 3 } else { 2 } {
            continue;
        }
        varint(9, &mut out); // MoveTo count 1
        varint(zig(path[0][0] - cursor[0]), &mut out);
        varint(zig(path[0][1] - cursor[1]), &mut out);
        cursor = path[0];
        varint((((path.len() - 1) as u64) << 3) | 2, &mut out);
        for p in &path[1..] {
            varint(zig(p[0] - cursor[0]), &mut out);
            varint(zig(p[1] - cursor[1]), &mut out);
            cursor = *p;
        }
        if f.polygon {
            varint(15, &mut out);
        } // ClosePath count 1
    }
    out
}
pub fn encode(layers: &BTreeMap<&str, Vec<Feature>>) -> Vec<u8> {
    let mut tile = vec![];
    for (name, features) in layers {
        let mut layer = vec![];
        bytes(1, name.as_bytes(), &mut layer);
        let mut values = vec![];
        let mut value_ids = BTreeMap::new();
        for f in features {
            for v in [&f.class, &f.name] {
                if !value_ids.contains_key(v) {
                    let i = values.len() as u64;
                    values.push(v.clone());
                    value_ids.insert(v.clone(), i);
                }
            }
        }
        for f in features {
            let mut feature = vec![];
            let mut tags = vec![];
            varint(0, &mut tags);
            varint(value_ids[&f.class], &mut tags);
            if !f.name.is_empty() {
                varint(1, &mut tags);
                varint(value_ids[&f.name], &mut tags);
            }
            bytes(2, &tags, &mut feature);
            uint(3, if f.polygon { 3 } else { 2 }, &mut feature);
            bytes(4, &geometry(f), &mut feature);
            bytes(2, &feature, &mut layer);
        }
        bytes(3, b"class", &mut layer);
        bytes(3, b"name", &mut layer);
        for value in values {
            let mut v = vec![];
            bytes(1, value.as_bytes(), &mut v);
            bytes(4, &v, &mut layer);
        }
        uint(5, 4096, &mut layer);
        uint(15, 2, &mut layer);
        bytes(3, &layer, &mut tile);
    }
    tile
}
