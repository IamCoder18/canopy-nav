use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use canopy_packserver::{
    api, auth,
    config::Config,
    gaz,
    jobs::{self, State},
    mvt, pack, pipeline, pmtiles,
    render::{Data, Tags, Way},
    scan,
};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tower::ServiceExt;
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}
fn sorted() -> &'static Vec<u8> {
    static BYTES: OnceLock<Vec<u8>> = OnceLock::new();
    BYTES.get_or_init(||{
        let out=Command::new("node").args(["--input-type=module","-e","import {readFileSync} from 'node:fs'; import {parseOsmXml,encodeSorted} from './tools/osm2pbf.mjs'; const {nodes,ways}=parseOsmXml(readFileSync('test/fixture.osm','utf8')); process.stdout.write(await encodeSorted(nodes,ways));"]).current_dir(root()).output().unwrap();
        assert!(out.status.success(),"{}",String::from_utf8_lossy(&out.stderr));out.stdout
    })
}
fn config(dir: &Path) -> Config {
    Config {
        port: 8787,
        data_dir: dir.into(),
        valhalla_bin: "missing-valhalla".into(),
        osmium_bin: "missing-osmium".into(),
        max_upload_bytes: 1024 * 1024,
        max_concurrent_builds: 2,
        job_ttl_secs: 86400,
        min_zoom: 5,
        max_zoom: 14,
        gaz_cap: 0,
        uploads_per_hour: 10,
        concurrent_uploads: 2,
        threads: 2,
        build_timeout_secs: 10,
    }
}
fn state() -> (tempfile::TempDir, Arc<State>, String) {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir(d.path().join("builds")).unwrap();
    let key = auth::random_id("canopy_pk_");
    auth::edit(d.path(), |keys| {
        keys.push(auth::Key {
            id: "key_test".into(),
            name: "test".into(),
            hash: auth::hash(&key),
            created: chrono::Utc::now(),
            expires: None,
            last_used: None,
            revoked: false,
        });
        Ok(())
    })
    .unwrap();
    let s = State::new(config(d.path()));
    (d, s, key)
}
fn stub(dir: &Path, real_tiles: bool) -> String {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("builder");
    let emission = if real_tiles {
        format!(
            "tar -xf '{}' -C \"$tiles\"",
            root().join("test/fixture.valhalla.tar").display()
        )
    } else {
        "mkdir -p \"$tiles/0/000\"; printf fake-gph > \"$tiles/0/000/001.gph\"".into()
    };
    fs::write(&script,format!("#!/bin/sh\nif [ \"$1\" = --version ]; then echo 3.9.1-fixture; exit 0; fi\ntiles=$(printf '%s' \"$2\" | sed -n 's/.*\"tile_dir\":\"\\([^\"]*\\)\".*/\\1/p')\nmkdir -p \"$tiles\"\n{emission}\n")).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    script.to_string_lossy().into()
}
#[test]
fn scan_detects_disorder_and_extracts_real_fixture() {
    let s = scan::read(&root().join("test/fixture.osm.pbf")).unwrap();
    assert!(s.disorder.is_some());
    assert!(!s.input.sorted);
    assert_eq!(s.input.sha256.len(), 64);
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("sorted.osm.pbf");
    fs::write(&p, sorted()).unwrap();
    let s = scan::read(&p).unwrap();
    assert!(s.input.sorted);
    assert!(s.counts.nodes > 50);
    let data = canopy_packserver::render::extract(&[p]).unwrap();
    let entries = gaz::entries(&data, 0);
    assert!(entries.iter().any(|e| e.name == "Blue Yonder Cafe"));
    assert!(entries.iter().all(|e| e.house.is_none()));
    let bad = dir.path().join("bad.osm.pbf");
    fs::write(&bad, b"not pbf").unwrap();
    assert_eq!(scan::read(&bad).err().unwrap().code, "input_not_pbf");
}
fn tags(pairs: &[(&str, &str)]) -> Tags {
    pairs
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect()
}
#[test]
fn gaz_merges_streets_retains_string_houses_alts_and_admin_holes() {
    let mut d = Data {
        ways: BTreeMap::new(),
        nodes: BTreeMap::new(),
        places: BTreeMap::new(),
        relations: BTreeMap::new(),
    };
    for (id, p) in [
        (1, [0., 0.]),
        (2, [1., 0.]),
        (3, [2., 0.]),
        (4, [-3., -3.]),
        (5, [3., -3.]),
        (6, [3., 3.]),
        (7, [-3., 3.]),
        (8, [1.5, 1.5]),
        (9, [2.5, 1.5]),
        (12, [2.5, 2.5]),
        (13, [1.5, 2.5]),
    ] {
        d.nodes.insert(id, p);
    }
    for (id, refs) in [(10, vec![1, 2]), (11, vec![2, 3])] {
        d.ways.insert(
            id,
            Way {
                id,
                refs,
                tags: tags(&[
                    ("name", "Main Street"),
                    ("highway", "residential"),
                    ("name:fr", "Rue Principale"),
                ]),
            },
        );
    }
    d.ways.insert(
        20,
        Way {
            id: 20,
            refs: vec![4, 5, 6, 7, 4],
            tags: Tags::new(),
        },
    );
    d.relations.insert(
        30,
        canopy_packserver::render::Relation {
            id: 30,
            members: vec![(20, "outer".into()), (21, "inner".into())],
            tags: tags(&[
                ("boundary", "administrative"),
                ("admin_level", "8"),
                ("name", "Test City"),
            ]),
        },
    );
    d.ways.insert(
        21,
        Way {
            id: 21,
            refs: vec![8, 9, 12, 13, 8],
            tags: Tags::new(),
        },
    );
    d.places.insert(
        41,
        (
            [2., 2.],
            tags(&[("name", "In the enclave"), ("amenity", "cafe")]),
        ),
    );
    d.places.insert(
        40,
        (
            [0.5, 0.],
            tags(&[("addr:housenumber", "12A"), ("addr:street", "Main Street")]),
        ),
    );
    let e = gaz::entries(&d, 0);
    let streets: Vec<_> = e.iter().filter(|e| e.kind == "street").collect();
    assert_eq!(streets.len(), 1);
    assert_eq!(streets[0].lon, 1.);
    assert_eq!(streets[0].city.as_deref(), Some("Test City"));
    assert_eq!(streets[0].alt, vec!["Rue Principale"]);
    let house = e.iter().find(|e| e.kind == "house").unwrap();
    assert_eq!(house.house.as_deref(), Some("12A"));
    assert_eq!(house.name, "12A Main Street");
    assert_eq!(house.osm, "addr:housenumber/12A");
    assert_eq!(
        e.iter().find(|e| e.name == "In the enclave").unwrap().city,
        None
    );
    assert_eq!(
        e.iter().find(|e| e.id == "relation/30").unwrap().kind,
        "city"
    );
    assert_eq!(gaz::entries(&d, 1).len(), 1);
}
#[test]
fn missing_references_split_lines_and_do_not_invent_area_boundaries() {
    let mut d = Data {
        ways: BTreeMap::new(),
        nodes: BTreeMap::new(),
        places: BTreeMap::new(),
        relations: BTreeMap::new(),
    };
    for (id, p) in [(1, [0., 0.]), (2, [1., 0.]), (3, [2., 0.]), (4, [3., 0.])] {
        d.nodes.insert(id, p);
    }
    d.ways.insert(
        10,
        Way {
            id: 10,
            refs: vec![1, 2, 999, 3, 4],
            tags: tags(&[("highway", "primary"), ("name", "Main")]),
        },
    );
    d.ways.insert(
        20,
        Way {
            id: 20,
            refs: vec![1, 2, 999, 3, 1],
            tags: tags(&[("landuse", "forest")]),
        },
    );
    let features = canopy_packserver::render::features(&d);
    assert_eq!(features.len(), 2);
    assert!(
        features
            .iter()
            .all(|f| f.layer == "roads" && f.points.len() == 2)
    );
    let gaz = gaz::entries(&d, 0);
    assert_eq!(gaz.len(), 1);
    assert!(gaz[0].lon <= 1. || gaz[0].lon >= 2.);
}
fn var(bytes: &[u8], pos: &mut usize) -> u64 {
    let mut value = 0;
    let mut shift = 0;
    loop {
        let b = bytes[*pos];
        *pos += 1;
        value |= ((b & 127) as u64) << shift;
        if b < 128 {
            return value;
        }
        shift += 7;
    }
}
fn gunzip(b: &[u8]) -> Vec<u8> {
    let mut out = vec![];
    flate2::read::GzDecoder::new(b)
        .read_to_end(&mut out)
        .unwrap();
    out
}
fn u64at(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}
#[test]
fn mvt_commands_round_trip_and_layers_are_v2() {
    let f = mvt::Feature {
        class: "primary".into(),
        name: "Main".into(),
        polygon: false,
        paths: vec![vec![[10, 20], [30, 40], [50, 30]]],
    };
    let b = mvt::geometry(&f);
    let mut p = 0;
    assert_eq!(var(&b, &mut p), 9);
    assert_eq!(var(&b, &mut p), 20);
    assert_eq!(var(&b, &mut p), 40);
    assert_eq!(var(&b, &mut p), 18);
    assert_eq!(var(&b, &mut p), 40);
    assert_eq!(var(&b, &mut p), 40);
    assert_eq!(var(&b, &mut p), 40);
    assert_eq!(var(&b, &mut p), 19);
    assert_eq!(p, b.len());
    let polygon = mvt::Feature {
        polygon: true,
        ..f.clone()
    };
    assert_eq!(mvt::geometry(&polygon).last(), Some(&15));
    let tile = mvt::encode(&BTreeMap::from([("roads", vec![f])]));
    let mut p = 0;
    assert_eq!(var(&tile, &mut p), 26);
    let n = var(&tile, &mut p);
    assert_eq!(p + n as usize, tile.len());
    assert!(tile.windows(5).any(|w| w == b"roads"));
    assert!(tile.windows(2).any(|w| w == [120, 2]));
}
#[test]
fn pmtiles_header_hilbert_dedup_and_leaf_limits() {
    assert_eq!(
        (0..2)
            .flat_map(|y| (0..2).map(move |x| pmtiles::tile_id(1, x, y)))
            .collect::<Vec<_>>(),
        vec![1, 4, 2, 3]
    );
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("map.pmtiles");
    let mut w = pmtiles::Writer::new(&p, 0, 16, [-1., 50., 1., 52.]).unwrap();
    w.tile(0, b"same").unwrap();
    w.tile(1, b"same").unwrap();
    w.tile(3, b"different").unwrap();
    w.finish().unwrap();
    let b = fs::read(&p).unwrap();
    assert_eq!(&b[..8], b"PMTiles\x03");
    assert_eq!(u64at(&b, 72), 3);
    assert_eq!(u64at(&b, 80), 2);
    assert_eq!(u64at(&b, 88), 2);
    assert_eq!(&b[96..100], &[1, 2, 2, 1]);
    let root = gunzip(&b[127..127 + u64at(&b, 16) as usize]);
    let mut pos = 0;
    assert_eq!(var(&root, &mut pos), 2);
    assert_eq!(var(&root, &mut pos), 0);
    assert_eq!(var(&root, &mut pos), 3);
    assert_eq!(var(&root, &mut pos), 2);
    assert_eq!(var(&root, &mut pos), 1);
    let mut w = pmtiles::Writer::new(&p, 0, 16, [-1., 50., 1., 52.]).unwrap();
    let mut id = 0;
    let mut random = 1234567u64;
    for i in 0..40000u64 {
        random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
        id += 1 + (random >> 32) % 10000;
        w.tile(id, &i.to_le_bytes()).unwrap();
    }
    w.finish().unwrap();
    let b = fs::read(p).unwrap();
    assert!(u64at(&b, 16) <= 16257);
    assert!(u64at(&b, 48) > 0);
}
#[test]
fn tar_is_deterministic_and_matches_gnu_ustar() {
    let d = tempfile::tempdir().unwrap();
    let tiles = d.path().join("tiles");
    fs::create_dir_all(tiles.join("0/000")).unwrap();
    fs::write(tiles.join("0/000/001.gph"), b"test tile").unwrap();
    let a = d.path().join("a.tar");
    let b = d.path().join("b.tar");
    pack::build(&tiles, &a).unwrap();
    pack::build(&tiles, &b).unwrap();
    assert_eq!(fs::read(&a).unwrap(), fs::read(&b).unwrap());
    let status = Command::new("tar")
        .args([
            "--create",
            "--format=ustar",
            "--mode=644",
            "--mtime=@0",
            "--owner=0",
            "--group=0",
            "--numeric-owner",
            "--file",
        ])
        .arg(&b)
        .arg("--directory")
        .arg(&tiles)
        .arg("0/000/001.gph")
        .status()
        .unwrap();
    assert!(status.success());
    assert_eq!(fs::read(a).unwrap(), fs::read(b).unwrap());
}
fn bomb() -> Body {
    Body::from_stream(futures_util::stream::poll_fn(
        |_| -> std::task::Poll<Option<std::result::Result<axum::body::Bytes, std::io::Error>>> {
            panic!("body polled before rejection")
        },
    ))
}
#[tokio::test]
async fn auth_and_length_rejections_never_poll_the_body() {
    let (_d, s, key) = state();
    let app = api::router(s.clone());
    let r = app
        .clone()
        .oneshot(
            Request::get("/v1/auth-check")
                .header("x-api-key", &key)
                .body(bomb())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    let r = app
        .clone()
        .oneshot(
            Request::get("/v1/auth-check")
                .header("x-api-key", &key)
                .header("x-packserver-upload-length", s.config.max_upload_bytes + 1)
                .body(bomb())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
    for auth in [None, Some("canopy_pk_wrong")] {
        let mut req = Request::post("/v1/builds").header("expect", "100-continue");
        if let Some(key) = auth {
            req = req.header("x-api-key", key);
        }
        let r = app
            .clone()
            .oneshot(req.body(bomb()).unwrap())
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(r.headers()["connection"], "close");
    }
    let r = app
        .clone()
        .oneshot(
            Request::post("/v1/builds")
                .header("x-api-key", &key)
                .header("content-length", s.config.max_upload_bytes + 1)
                .body(bomb())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let _a = s.upload("key_test").unwrap();
    let _b = s.upload("key_test").unwrap();
    let r = app
        .oneshot(
            Request::post("/v1/builds")
                .header("x-api-key", key)
                .body(bomb())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(r.headers().contains_key("retry-after"));
}
#[tokio::test]
async fn stream_cap_and_no_admin_http_surface() {
    let (_d, s, key) = state();
    let app = api::router(s.clone());
    let body = format!(
        "--test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"big.osm.pbf\"\r\n\r\n{}\r\n--test--\r\n",
        "x".repeat(s.config.max_upload_bytes)
    );
    let r = app
        .clone()
        .oneshot(
            Request::post("/v1/builds")
                .header("x-api-key", &key)
                .header("content-type", "multipart/form-data; boundary=test")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        fs::read_dir(s.config.data_dir.join("builds"))
            .unwrap()
            .count(),
        0
    );
    for p in [
        "/v1/admin/keys",
        "/v1/keys",
        "/v1/builds/nope/artifacts/..%2Fkeys.json",
    ] {
        let r = app
            .clone()
            .oneshot(
                Request::get(p)
                    .header("x-api-key", &key)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }
}
#[tokio::test]
async fn malformed_path_rejections_use_the_json_error_envelope() {
    let (_d, s, key) = state();
    let response = api::router(s)
        .oneshot(
            Request::get("/v1/builds/%FF")
                .header("x-api-key", key)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(response.headers()["content-type"], "application/json");
    let value: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    assert_eq!(value["error"]["code"], "invalid_request");
    assert!(value["error"]["detail"].is_string());
}
#[tokio::test]
async fn pipeline_api_artifact_hashes_and_bundle_roundtrip() {
    let (d, s, key) = state();
    let mut c = s.config.clone();
    c.valhalla_bin = stub(d.path(), false);
    let s = State::new(c);
    let app = api::router(s.clone());
    let mut body=b"--test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"fixture.osm.pbf\"\r\nContent-Type: application/octet-stream\r\n\r\n".to_vec();
    body.extend(sorted());
    body.extend(b"\r\n--test--\r\n");
    let r = app
        .clone()
        .oneshot(
            Request::post("/v1/builds")
                .header("x-api-key", &key)
                .header("content-type", "multipart/form-data; boundary=test")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::ACCEPTED);
    let v: serde_json::Value =
        serde_json::from_slice(&to_bytes(r.into_body(), usize::MAX).await.unwrap()).unwrap();
    let id = v["id"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let j = s.get(id, "key_test").unwrap();
            if j.state == "failed" {
                panic!("{:?}", j.error);
            }
            if j.state == "done" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let get = |suffix: &str| {
        Request::get(format!("/v1/builds/{id}{suffix}"))
            .header("x-api-key", &key)
            .body(Body::empty())
            .unwrap()
    };
    let r = app.clone().oneshot(get("/artifacts")).await.unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&to_bytes(r.into_body(), usize::MAX).await.unwrap()).unwrap();
    for a in manifest["artifacts"].as_array().unwrap() {
        let name = a["name"].as_str().unwrap();
        assert_eq!(a["sha256"], scan::hash_file(&s.dir(id).join(name)).unwrap());
        let r = app
            .clone()
            .oneshot(get(&format!("/artifacts/{name}")))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(
            r.headers()["etag"],
            format!("\"{}\"", a["sha256"].as_str().unwrap())
        );
    }
    let r = app.clone().oneshot(get("/bundle")).await.unwrap();
    let bytes = to_bytes(r.into_body(), usize::MAX).await.unwrap();
    let tar = gunzip(&bytes);
    let mut a = tar::Archive::new(&tar[..]);
    let names: Vec<_> = a
        .entries()
        .unwrap()
        .map(|e| e.unwrap().path().unwrap().to_string_lossy().to_string())
        .collect();
    assert_eq!(
        names,
        vec![
            "manifest.json",
            "map.pmtiles",
            "routing.valhalla.tar",
            "search.gazetteer.jsonl.gz"
        ]
    );
    let r = app.oneshot(get("/bundle")).await.unwrap();
    assert_eq!(bytes, to_bytes(r.into_body(), usize::MAX).await.unwrap());
}
#[test]
fn unsorted_refusal_names_ids_and_osmium_command() {
    let (d, s, _) = state();
    let id = "bld_unsorted";
    let dir = s.dir(id);
    fs::create_dir(&dir).unwrap();
    let p = dir.join("fixture.osm.pbf");
    fs::copy(root().join("test/fixture.osm.pbf"), &p).unwrap();
    s.jobs.lock().unwrap().insert(
        id.into(),
        jobs::Job {
            id: id.into(),
            state: "running",
            stages: jobs::stages(),
            progress: serde_json::json!({}),
            inputs: vec![],
            error: None,
            owner: String::new(),
            created: Some(Instant::now()),
        },
    );
    let err = pipeline::run(
        &s,
        id,
        pipeline::Options {
            region: "test".into(),
            minzoom: 5,
            maxzoom: 5,
            gazcap: 0,
        },
        vec![p],
    )
    .unwrap_err();
    assert_eq!(err.code, "input_unsorted");
    assert!(
        err.detail.contains("fixture.osm.pbf")
            && err.detail.contains("osmium sort")
            && err.detail.contains("100")
    );
    drop(d);
}

#[tokio::test]
async fn expect_continue_is_not_sent_to_unauthenticated_sockets() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (_d, s, _key) = state();
    let listener = tokio::net::TcpListener::bind("[::1]:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, api::router(s)).await.unwrap();
    });
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    socket.write_all(b"POST /v1/builds HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer canopy_pk_bad\r\nExpect: 100-continue\r\nContent-Length: 1000000\r\n\r\n").await.unwrap();
    let mut response = [0; 4096];
    let n = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut response))
        .await
        .unwrap()
        .unwrap();
    let text = String::from_utf8_lossy(&response[..n]);
    assert!(text.starts_with("HTTP/1.1 401"));
    assert!(!text.contains("100 Continue"));
    server.abort();
}

#[test]
fn hourly_limit_revoke_and_live_prune_leases() {
    let (_d, s, key) = state();
    for _ in 0..10 {
        drop(s.upload("key_test").unwrap());
    }
    assert_eq!(s.upload("key_test").err().unwrap().code, "rate_limited");
    auth::edit(&s.config.data_dir, |keys| {
        keys[0].revoked = true;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        auth::verify(&s.config.data_dir, &key).unwrap_err().code,
        "unauthorized"
    );
    let id = "bld_held";
    fs::create_dir(s.dir(id)).unwrap();
    let lease = s.lease(id).unwrap();
    canopy_packserver::admin::run(
        s.config.clone(),
        canopy_packserver::admin::Admin::Jobs(canopy_packserver::admin::Jobs::Prune { all: true }),
    )
    .unwrap();
    assert!(s.dir(id).exists());
    drop(lease);
    canopy_packserver::admin::run(
        s.config.clone(),
        canopy_packserver::admin::Admin::Jobs(canopy_packserver::admin::Jobs::Prune { all: true }),
    )
    .unwrap();
    assert!(!s.dir(id).exists());
}

#[test]
fn sort_fallback_records_original_hash_and_union_deduplicates() {
    use std::os::unix::fs::PermissionsExt;
    let (d, s, _key) = state();
    let sorted_path = d.path().join("canonical.osm.pbf");
    fs::write(&sorted_path, sorted()).unwrap();
    let script = d.path().join("osmium");
    fs::write(
        &script,
        format!("#!/bin/sh\ncp '{}' \"$4\"\n", sorted_path.display()),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    let mut c = s.config.clone();
    c.osmium_bin = script.to_string_lossy().into();
    c.valhalla_bin = stub(d.path(), false);
    let s = State::new(c);
    let id = "bld_sorted";
    fs::create_dir(s.dir(id)).unwrap();
    let p = s.dir(id).join("unsorted.osm.pbf");
    fs::copy(root().join("test/fixture.osm.pbf"), &p).unwrap();
    let original = scan::hash_file(&p).unwrap();
    pipeline::run(
        &s,
        id,
        pipeline::Options {
            region: "sorted".into(),
            minzoom: 5,
            maxzoom: 5,
            gazcap: 0,
        },
        vec![p],
    )
    .unwrap();
    let m: serde_json::Value =
        serde_json::from_slice(&fs::read(s.dir(id).join("manifest.json")).unwrap()).unwrap();
    assert_eq!(m["inputs"][0]["sha256"], original);
    assert_eq!(m["inputs"][0]["resorted"], true);
    assert_eq!(m["inputs"][0]["sorted"], false);
    let one = canopy_packserver::render::extract(&[sorted_path.clone()]).unwrap();
    let two = canopy_packserver::render::extract(&[sorted_path.clone(), sorted_path]).unwrap();
    assert_eq!(gaz::entries(&one, 0).len(), gaz::entries(&two, 0).len());
}
#[test]
#[ignore = "requires native Valhalla and osmium"]
fn real_valhalla_pipeline() {
    let d = tempfile::tempdir().unwrap();
    let mut c = config(d.path());
    c.valhalla_bin =
        std::env::var("PACKSERVER_VALHALLA_BIN").unwrap_or("valhalla_build_tiles".into());
    let s = State::new(c);
    let id = "bld_real";
    fs::create_dir_all(s.dir(id)).unwrap();
    let p = s.dir(id).join("fixture.osm.pbf");
    fs::write(&p, sorted()).unwrap();
    pipeline::run(
        &s,
        id,
        pipeline::Options {
            region: "fixture".into(),
            minzoom: 5,
            maxzoom: 14,
            gazcap: 0,
        },
        vec![p],
    )
    .unwrap();
    assert!(s.dir(id).join("manifest.json").exists());
}
