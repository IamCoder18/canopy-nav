//! Shared two-pass OSM extraction. Retain only tagged features, member ways,
//! and referenced coordinates; never materialise the entire PBF node table.
use crate::{Error, Result};
use osmpbf::{Element, ElementReader};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};
pub type Tags = BTreeMap<String, String>;
pub type Point = [f64; 2];
#[derive(Clone)]
pub struct Way {
    pub id: i64,
    pub refs: Vec<i64>,
    pub tags: Tags,
}
#[derive(Clone)]
pub struct Relation {
    pub id: i64,
    pub members: Vec<(i64, String)>,
    pub tags: Tags,
}
pub struct Data {
    pub ways: BTreeMap<i64, Way>,
    pub nodes: BTreeMap<i64, Point>,
    pub places: BTreeMap<i64, (Point, Tags)>,
    pub relations: BTreeMap<i64, Relation>,
}
fn tags<'a>(it: impl Iterator<Item = (&'a str, &'a str)>) -> Tags {
    it.map(|(k, v)| (k.into(), v.into())).collect()
}
fn interesting(t: &Tags) -> bool {
    [
        "name",
        "addr:housenumber",
        "highway",
        "waterway",
        "water",
        "landuse",
        "leisure",
        "natural",
        "boundary",
    ]
    .iter()
    .any(|k| t.contains_key(*k))
}
pub fn extract(paths: &[PathBuf]) -> Result<Data> {
    let mut d = Data {
        ways: BTreeMap::new(),
        nodes: BTreeMap::new(),
        places: BTreeMap::new(),
        relations: BTreeMap::new(),
    };
    let mut member_ids = BTreeSet::new();
    // Relations first so untagged boundary/multipolygon members survive pass 1.
    for path in paths {
        ElementReader::from_path(path)
            .map_err(pbf_error)?
            .for_each(|e| {
                if let Element::Relation(r) = e {
                    let t = tags(r.tags());
                    if interesting(&t) {
                        let members: Vec<_> = r
                            .members()
                            .filter(|m| matches!(m.member_type, osmpbf::RelMemberType::Way))
                            .map(|m| (m.member_id, m.role().unwrap_or("").to_owned()))
                            .collect();
                        member_ids.extend(members.iter().map(|(id, _)| *id));
                        d.relations.entry(r.id()).or_insert(Relation {
                            id: r.id(),
                            members,
                            tags: t,
                        });
                    }
                }
            })
            .map_err(pbf_error)?;
    }
    let mut needed: BTreeSet<i64> = BTreeSet::new();
    for path in paths {
        ElementReader::from_path(path)
            .map_err(pbf_error)?
            .for_each(|e| {
                if let Element::Way(w) = e {
                    let t = tags(w.tags());
                    if interesting(&t) || member_ids.contains(&w.id()) {
                        let refs: Vec<_> = w.refs().collect();
                        needed.extend(&refs);
                        d.ways.entry(w.id()).or_insert(Way {
                            id: w.id(),
                            refs,
                            tags: t,
                        });
                    }
                }
            })
            .map_err(pbf_error)?;
    }
    for path in paths {
        ElementReader::from_path(path)
            .map_err(pbf_error)?
            .for_each(|e| {
                let node = match e {
                    Element::Node(n) => Some((n.id(), [n.lon(), n.lat()], tags(n.tags()))),
                    Element::DenseNode(n) => Some((n.id(), [n.lon(), n.lat()], tags(n.tags()))),
                    _ => None,
                };
                if let Some((id, p, t)) = node {
                    if needed.contains(&id) {
                        d.nodes.entry(id).or_insert(p);
                    }
                    if interesting(&t) {
                        d.places.entry(id).or_insert((p, t));
                    }
                }
            })
            .map_err(pbf_error)?;
    }
    Ok(d)
}
fn pbf_error(e: impl std::fmt::Display) -> Error {
    Error::new("input_not_pbf", e.to_string())
}
impl Data {
    pub fn line(&self, way: &Way) -> Vec<Point> {
        way.refs
            .iter()
            .filter_map(|id| self.nodes.get(id).copied())
            .collect()
    }
    /// Extracts may omit references at their edge. Never join a road across an
    /// absent node: that would draw a connection that the input does not supply.
    pub fn runs(&self, way: &Way) -> Vec<Vec<Point>> {
        way.refs
            .split(|id| !self.nodes.contains_key(id))
            .filter(|refs| refs.len() >= 2)
            .map(|refs| refs.iter().map(|id| self.nodes[id]).collect())
            .collect()
    }
    /// Join relation rings on OSM node identity, not floating point proximity.
    pub fn rings(&self, r: &Relation, inner: bool) -> Vec<Vec<Point>> {
        let mut pieces: Vec<Vec<i64>> = r
            .members
            .iter()
            .filter(|(_, role)| (role == "inner") == inner)
            .filter_map(|(id, _)| self.ways.get(id).map(|w| w.refs.clone()))
            .collect();
        let mut rings = vec![];
        while let Some(mut line) = pieces.pop() {
            loop {
                if line.first() == line.last() {
                    break;
                }
                let found = pieces
                    .iter()
                    .position(|p| p.first() == line.last() || p.last() == line.last());
                let Some(i) = found else {
                    break;
                };
                let mut next = pieces.swap_remove(i);
                if next.last() == line.last() {
                    next.reverse();
                }
                line.extend(next.into_iter().skip(1));
            }
            if line.len() >= 4 && line.first() == line.last() {
                let points: Vec<_> = line
                    .iter()
                    .filter_map(|id| self.nodes.get(id).copied())
                    .collect();
                if points.len() == line.len() {
                    rings.push(points);
                }
            }
        }
        rings
    }
}
#[derive(Clone)]
pub struct Feature {
    pub layer: &'static str,
    pub class: String,
    pub name: String,
    pub points: Vec<Point>,
    pub holes: Vec<Vec<Point>>,
    pub polygon: bool,
    pub min_zoom: u8,
}
pub fn road_zoom(s: &str) -> Option<u8> {
    Some(match s {
        "motorway" | "trunk" => 0,
        "primary" => 8,
        "secondary" => 10,
        "tertiary" => 12,
        "residential" | "unclassified" | "road" => 13,
        "living_street" => 14,
        "service" | "track" => 15,
        _ => return None,
    })
}
fn classification(t: &Tags) -> Option<(&'static str, String, bool, u8)> {
    if let Some(h) = t.get("highway") {
        return road_zoom(h).map(|z| ("roads", h.clone(), false, z));
    }
    if let Some(w) = t.get("waterway") {
        return Some(("water", w.clone(), false, 5));
    }
    if t.get("natural").is_some_and(|s| s == "water") || t.contains_key("water") {
        return Some(("water", "water".into(), true, 5));
    }
    for k in ["landuse", "leisure", "natural"] {
        if let Some(c) = t.get(k) {
            if [
                "forest",
                "wood",
                "grass",
                "meadow",
                "park",
                "garden",
                "recreation_ground",
                "grassland",
                "scrub",
                "heath",
                "nature_reserve",
            ]
            .contains(&c.as_str())
            {
                return Some(("green", c.clone(), true, 5));
            }
        }
    }
    None
}
pub fn features(d: &Data) -> Vec<Feature> {
    let mut out = vec![];
    let mut members = BTreeSet::new();
    for r in d.relations.values() {
        if let Some((layer, class, true, z)) = classification(&r.tags) {
            let holes = d.rings(r, true);
            for points in d.rings(r, false) {
                let polygon = geo::Polygon::new(
                    geo::LineString::from(points.iter().map(|p| (p[0], p[1])).collect::<Vec<_>>()),
                    vec![],
                );
                use geo::Contains;
                let contained = holes
                    .iter()
                    .filter(|h| polygon.contains(&geo::Point::new(h[0][0], h[0][1])))
                    .cloned()
                    .collect();
                out.push(Feature {
                    layer,
                    class: class.clone(),
                    name: r.tags.get("name").cloned().unwrap_or_default(),
                    points,
                    holes: contained,
                    polygon: true,
                    min_zoom: z,
                });
            }
            members.extend(r.members.iter().map(|(id, _)| *id));
        }
    }
    for w in d.ways.values() {
        if members.contains(&w.id) {
            continue;
        }
        if let Some((layer, class, polygon, z)) = classification(&w.tags) {
            let runs = if polygon {
                let points = d.line(w);
                if points.len() != w.refs.len()
                    || points.len() < 4
                    || w.refs.first() != w.refs.last()
                {
                    continue;
                }
                vec![points]
            } else {
                d.runs(w)
            };
            for points in runs {
                out.push(Feature {
                    layer,
                    class: class.clone(),
                    name: w.tags.get("name").cloned().unwrap_or_default(),
                    points,
                    holes: vec![],
                    polygon,
                    min_zoom: z,
                });
            }
        }
    }
    out
}
