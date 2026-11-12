use crate::{
    Result,
    render::{Data, Point, Tags},
};
use geo::{Area, BoundingRect, Centroid, Contains, LineString, Point as GeoPoint, Polygon};
use rstar::{AABB, RTree, RTreeObject};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs::File, io::Write, path::Path};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub osm: String,
    pub lat: f64,
    pub lon: f64,
    pub importance: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    pub alt: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub street: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub house: Option<String>,
}
fn polygon(p: &[Point], holes: &[Vec<Point>]) -> Polygon {
    let line = |p: &[Point]| LineString::from(p.iter().map(|p| (p[0], p[1])).collect::<Vec<_>>());
    Polygon::new(line(p), holes.iter().map(|h| line(h)).collect())
}
fn entry(id: String, t: &Tags, p: Point) -> Option<Entry> {
    let house = t.get("addr:housenumber").cloned();
    let street = t.get("addr:street").cloned();
    let name = if let Some(h) = &house {
        format!("{} {}", h, street.as_deref().unwrap_or(""))
            .trim()
            .to_owned()
    } else {
        t.get("name")?.clone()
    };
    let (kind, osm) = if house.is_some() {
        (
            "house".into(),
            format!("addr:housenumber/{}", house.as_deref().unwrap()),
        )
    } else if let Some(v) = t.get("place") {
        (v.clone(), format!("place/{v}"))
    } else if let Some(v) = t.get("highway") {
        ("street".into(), format!("highway/{v}"))
    } else if let Some(v) = t.get("waterway") {
        ("water".into(), format!("waterway/{v}"))
    } else if t.get("natural").is_some_and(|v| v == "water") {
        ("water".into(), "natural/water".into())
    } else if let Some(v) = t.get("water") {
        ("water".into(), format!("water/{v}"))
    } else if t.get("boundary").is_some_and(|v| v == "administrative") {
        let kind = match t.get("admin_level").map(String::as_str) {
            Some("2") => "country",
            Some("3" | "4") => "state",
            Some("8") => "city",
            _ => "area",
        };
        (kind.into(), "boundary/administrative".into())
    } else if let Some((k, v)) = [
        "amenity", "shop", "tourism", "leisure", "office", "historic",
    ]
    .iter()
    .find_map(|k| t.get(*k).map(|v| (*k, v)))
    {
        ("poi".into(), format!("{k}/{v}"))
    } else {
        let (k, v) = ["natural", "landuse", "building", "type", "name"]
            .iter()
            .find_map(|k| t.get(*k).map(|v| (*k, v)))
            .unwrap();
        ("area".into(), format!("{k}/{v}"))
    };
    let base: f64 = match kind.as_str() {
        "country" => 0.75,
        "state" => 0.65,
        "city" => 0.55,
        "town" => 0.45,
        "village" => 0.38,
        "suburb" => 0.32,
        "street" => 0.25,
        "house" => 0.12,
        _ => 0.2,
    };
    let population = t
        .get("population")
        .and_then(|s| s.replace([',', ' '], "").parse::<f64>().ok())
        .unwrap_or(0.0);
    let admin = t
        .get("admin_level")
        .and_then(|s| s.parse::<f64>().ok())
        .map(|l| (12.0 - l).max(0.0) * 0.008)
        .unwrap_or(0.0);
    let mut alt: Vec<_> = t
        .iter()
        .filter(|(k, _)| {
            k.starts_with("name:")
                || ["alt_name", "official_name", "ref", "short_name"].contains(&k.as_str())
        })
        .flat_map(|(_, v)| v.split(';').map(str::to_owned))
        .filter(|v| v != &name)
        .collect();
    alt.sort();
    alt.dedup();
    Some(Entry {
        id,
        name,
        kind,
        osm,
        lat: p[1],
        lon: p[0],
        importance: (base + population.max(1.0).log10() * 0.025 + admin).min(1.0),
        city: t.get("addr:city").cloned(),
        state: t.get("addr:state").cloned(),
        country: t.get("addr:country").cloned(),
        alt,
        street,
        house,
    })
}
struct Admin {
    level: u8,
    name: String,
    polygon: Polygon,
}
impl RTreeObject for Admin {
    type Envelope = AABB<[f64; 2]>;
    fn envelope(&self) -> Self::Envelope {
        let b = self.polygon.bounding_rect().unwrap();
        AABB::from_corners([b.min().x, b.min().y], [b.max().x, b.max().y])
    }
}
fn context(admins: &RTree<Admin>, point: Point) -> [Option<String>; 3] {
    let mut hits: Vec<_> = admins
        .locate_in_envelope_intersecting(&AABB::from_point(point))
        .filter(|a| a.polygon.contains(&GeoPoint::new(point[0], point[1])))
        .collect();
    hits.sort_by(|a, b| {
        a.level
            .cmp(&b.level)
            .then(
                b.polygon
                    .unsigned_area()
                    .total_cmp(&a.polygon.unsigned_area()),
            )
            .then(a.name.cmp(&b.name))
    });
    let mut result = [None, None, None];
    for a in hits {
        match a.level {
            2 => result[2] = Some(a.name.clone()),
            3 | 4 => result[1] = Some(a.name.clone()),
            6..=8 => result[0] = Some(a.name.clone()),
            _ => {}
        }
    }
    result
}
pub fn entries(d: &Data, cap: usize) -> Vec<Entry> {
    let mut admins = vec![];
    for r in d.relations.values() {
        if r.tags.get("boundary").is_none_or(|v| v != "administrative") {
            continue;
        }
        let (Some(name), Some(level)) = (
            r.tags.get("name"),
            r.tags.get("admin_level").and_then(|v| v.parse::<u8>().ok()),
        ) else {
            continue;
        };
        let holes = d.rings(r, true);
        for p in d.rings(r, false) {
            let outer = polygon(&p, &[]);
            let inner: Vec<_> = holes
                .iter()
                .filter(|h| outer.contains(&GeoPoint::new(h[0][0], h[0][1])))
                .cloned()
                .collect();
            admins.push(Admin {
                level,
                name: name.clone(),
                polygon: polygon(&p, &inner),
            });
        }
    }
    for w in d.ways.values() {
        if w.tags.get("boundary").is_none_or(|v| v != "administrative") {
            continue;
        }
        let (Some(name), Some(level)) = (
            w.tags.get("name"),
            w.tags.get("admin_level").and_then(|v| v.parse::<u8>().ok()),
        ) else {
            continue;
        };
        let p = d.line(w);
        if p.len() == w.refs.len() && p.len() >= 4 && p.first() == p.last() {
            admins.push(Admin {
                level,
                name: name.clone(),
                polygon: polygon(&p, &[]),
            });
        }
    }
    let admins = RTree::bulk_load(admins);
    let mut out = vec![];
    for (id, (p, t)) in &d.places {
        if let Some(e) = entry(format!("node/{id}"), t, *p) {
            out.push(e);
        }
    }
    let mut streets: BTreeMap<String, Vec<(&crate::render::Way, Vec<Point>)>> = BTreeMap::new();
    for w in d.ways.values() {
        let points = d.line(w);
        if points.is_empty() {
            continue;
        }
        if w.tags.contains_key("highway")
            && w.tags.contains_key("name")
            && !w.tags.contains_key("addr:housenumber")
        {
            for run in d.runs(w) {
                streets
                    .entry(format!(
                        "{}\0{:?}",
                        w.tags["name"].to_lowercase(),
                        context(&admins, run[run.len() / 2])
                    ))
                    .or_default()
                    .push((w, run));
            }
            continue;
        }
        let p =
            if points.len() == w.refs.len() && points.len() >= 4 && points.first() == points.last()
            {
                polygon(&points, &[])
                    .centroid()
                    .map(|p| [p.x(), p.y()])
                    .unwrap_or(points[0])
            } else {
                points[points.len() / 2]
            };
        if let Some(e) = entry(format!("way/{}", w.id), &w.tags, p) {
            out.push(e);
        }
    }
    for parts in streets.values() {
        // Length-weighted midpoint across all fragments, never one row per way.
        let segments: Vec<_> = parts
            .iter()
            .flat_map(|(_, p)| p.windows(2).map(|s| (s[0], s[1])))
            .collect();
        let len =
            |a: Point, b: Point| ((a[0] - b[0]) * (a[1].to_radians().cos())).hypot(a[1] - b[1]);
        let mut left = segments.iter().map(|(a, b)| len(*a, *b)).sum::<f64>() / 2.0;
        let mut p = parts[0].1[0];
        for (a, b) in segments {
            let l = len(a, b);
            if left <= l && l > 0.0 {
                let f = left / l;
                p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
                break;
            }
            left -= l;
        }
        if let Some(mut e) = entry(format!("way/{}", parts[0].0.id), &parts[0].0.tags, p) {
            for (w, _) in parts.iter().skip(1) {
                if let Some(other) = entry(String::new(), &w.tags, p) {
                    e.alt.extend(other.alt);
                }
            }
            e.alt.sort();
            e.alt.dedup();
            out.push(e);
        }
    }
    for r in d.relations.values() {
        let rings = d.rings(r, false);
        if rings.is_empty() {
            continue;
        }
        if let Some(p) = polygon(&rings[0], &[]).centroid() {
            if let Some(e) = entry(format!("relation/{}", r.id), &r.tags, [p.x(), p.y()]) {
                out.push(e);
            }
        }
    }
    for e in &mut out {
        let [city, state, country] = context(&admins, [e.lon, e.lat]);
        if city.is_some() {
            e.city = city;
        }
        if state.is_some() {
            e.state = state;
        }
        if country.is_some() {
            e.country = country;
        }
    }
    out.sort_by(|a, b| b.importance.total_cmp(&a.importance).then(a.id.cmp(&b.id)));
    if cap > 0 {
        out.truncate(cap);
    }
    out
}
pub fn write(entries: &[Entry], path: &Path) -> Result<()> {
    let mut gz = flate2::GzBuilder::new()
        .mtime(0)
        .write(File::create(path)?, flate2::Compression::default());
    for e in entries {
        serde_json::to_writer(&mut gz, e)?;
        gz.write_all(b"\n")?;
    }
    gz.finish()?;
    Ok(())
}
