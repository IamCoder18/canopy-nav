use crate::{
    Result, mvt, pmtiles,
    render::{Feature, Point},
};
use geo::{BooleanOps, CoordsIter, LineString, MultiLineString, Polygon, Rect, Simplify};
use std::{collections::BTreeMap, path::Path};
pub fn project(p: Point) -> Point {
    let lat = p[1].clamp(-85.05112878, 85.05112878).to_radians();
    [
        (p[0] + 180.0) / 360.0,
        (1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / std::f64::consts::PI) / 2.0,
    ]
}
fn line(p: &[Point]) -> LineString {
    LineString::from(p.iter().map(|p| (p[0], p[1])).collect::<Vec<_>>())
}
fn quantize(l: &LineString, x: u32, y: u32, n: f64, polygon: bool, outer: bool) -> Vec<[i32; 2]> {
    let mut p: Vec<_> = l
        .coords_iter()
        .map(|p| {
            [
                ((p.x * n - x as f64) * 4096.0).round() as i32,
                ((p.y * n - y as f64) * 4096.0).round() as i32,
            ]
        })
        .collect();
    p.dedup();
    if polygon && p.first() == p.last() {
        p.pop();
    }
    if polygon {
        let area: i64 = p
            .iter()
            .zip(p.iter().cycle().skip(1))
            .map(|(a, b)| a[0] as i64 * b[1] as i64 - b[0] as i64 * a[1] as i64)
            .sum();
        if (area > 0) != outer {
            p.reverse();
        }
        if area.abs() < 8 {
            p.clear();
        }
    }
    p
}
pub fn build(features: Vec<Feature>, path: &Path, min: u8, max: u8, bbox: [f64; 4]) -> Result<u64> {
    let features: Vec<_> = features
        .into_iter()
        .map(|mut f| {
            f.points = f.points.into_iter().map(project).collect();
            f.holes = f
                .holes
                .into_iter()
                .map(|h| h.into_iter().map(project).collect())
                .collect();
            f
        })
        .collect();
    let mut archive = pmtiles::Writer::new(path, min, max, bbox)?;
    for z in min..=max {
        let n = (1u32 << z) as f64;
        // Spatial buckets contain indices, not copies of geometry. Only one zoom
        // is resident; encoded tile bytes immediately spill to the archive spool.
        let mut buckets: BTreeMap<(u32, u32), Vec<usize>> = BTreeMap::new();
        for (i, f) in features.iter().enumerate().filter(|(_, f)| f.min_zoom <= z) {
            let mut b = [
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ];
            for p in &f.points {
                crate::scan::bounds(&mut b, p[0], p[1]);
            }
            let lo_x = (b[0] * n - 0.08).floor().max(0.0) as u32;
            let hi_x = (b[2] * n + 0.08).floor().min(n - 1.0) as u32;
            let lo_y = (b[1] * n - 0.08).floor().max(0.0) as u32;
            let hi_y = (b[3] * n + 0.08).floor().min(n - 1.0) as u32;
            for x in lo_x..=hi_x {
                for y in lo_y..=hi_y {
                    buckets.entry((x, y)).or_default().push(i);
                }
            }
        }
        let mut order: Vec<_> = buckets.into_iter().collect();
        order.sort_by_key(|((x, y), _)| pmtiles::tile_id(z, *x, *y));
        for ((x, y), ids) in order {
            let rect = Rect::new(
                geo::Coord {
                    x: (x as f64 - 0.08) / n,
                    y: (y as f64 - 0.08) / n,
                },
                geo::Coord {
                    x: (x as f64 + 1.08) / n,
                    y: (y as f64 + 1.08) / n,
                },
            )
            .to_polygon();
            let tolerance = (if z < 10 { 2.0 } else { 1.0 }) / (4096.0 * n);
            let mut layers: BTreeMap<&str, Vec<mvt::Feature>> = BTreeMap::new();
            for i in ids {
                let f = &features[i];
                let mut paths = vec![];
                if f.polygon {
                    let p =
                        Polygon::new(line(&f.points), f.holes.iter().map(|p| line(p)).collect())
                            .simplify(tolerance);
                    for p in p.intersection(&rect) {
                        let outer = quantize(p.exterior(), x, y, n, true, true);
                        if outer.len() < 3 {
                            continue;
                        }
                        paths.push(outer);
                        for h in p.interiors() {
                            let q = quantize(h, x, y, n, true, false);
                            if q.len() >= 3 {
                                paths.push(q);
                            }
                        }
                    }
                } else {
                    let l = line(&f.points).simplify(tolerance);
                    for l in rect.clip(&MultiLineString(vec![l]), false) {
                        let q = quantize(&l, x, y, n, false, false);
                        if q.len() >= 2 {
                            paths.push(q);
                        }
                    }
                }
                if !paths.is_empty() {
                    layers.entry(f.layer).or_default().push(mvt::Feature {
                        class: f.class.clone(),
                        name: f.name.clone(),
                        polygon: f.polygon,
                        paths,
                    });
                }
            }
            if !layers.is_empty() {
                archive.tile(pmtiles::tile_id(z, x, y), &mvt::encode(&layers))?;
            }
        }
    }
    archive.finish()
}
