"""Build and query the SeoulTech building distance database (Python 3.10+)."""

import argparse
from contextlib import closing
import csv
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import unicodedata
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


PROJECT = Path(__file__).resolve().parent
DEFAULT_DB = PROJECT / "campus_distances.sqlite3"
CATALOG = PROJECT / "buildings.json"
SNAPSHOT = PROJECT / "osm_buildings.osm"
OVERPASS_API = "https://overpass-api.de/api/interpreter"
ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright"
CAMPUS_MAP = "https://www.seoultech.ac.kr/site/www/intro/map/map_ajax.jsp"
ROOM = re.compile(r"(?P<building>[^;,\n]+?)\s*[-–]\s*[A-Za-z]*\d[\w-]*(?=$|[\s;,])")

SCHEMA = """
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE buildings (
    building_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('mapped', 'construction', 'no_footprint')),
    latitude REAL,
    longitude REAL,
    osm_url TEXT,
    note TEXT NOT NULL,
    CHECK ((status = 'mapped' AND latitude IS NOT NULL AND longitude IS NOT NULL AND osm_url IS NOT NULL)
        OR (status <> 'mapped' AND latitude IS NULL AND longitude IS NULL AND osm_url IS NULL))
);
CREATE TABLE building_aliases (
    lookup_key TEXT PRIMARY KEY,
    building_id TEXT NOT NULL REFERENCES buildings(building_id)
);
CREATE TABLE building_distances (
    from_building_id TEXT NOT NULL REFERENCES buildings(building_id),
    to_building_id TEXT NOT NULL REFERENCES buildings(building_id),
    straight_line_m REAL NOT NULL CHECK (straight_line_m >= 0),
    PRIMARY KEY (from_building_id, to_building_id)
) WITHOUT ROWID;
"""


def lookup_key(value):
    value = unicodedata.normalize("NFKC", value).casefold().replace("–", "-")
    return "".join(value.split())


def read_overpass(catalog):
    object_refs = {entry[key] for entry in catalog.values() for key in ("osm", "parent") if key in entry}
    ways = sorted(ref.split("/")[1] for ref in object_refs if ref.startswith("way/"))
    relations = sorted(ref.split("/")[1] for ref in object_refs if ref.startswith("relation/"))
    query = f"[out:xml][timeout:20];(way(id:{','.join(ways)});rel(id:{','.join(relations)}););(._;>>;);out body;"
    request = Request(
        OVERPASS_API + "?" + urlencode({"data": query}),
        headers={"User-Agent": "SeoulTechClassroomDistance/1.0"},
    )
    with urlopen(request, timeout=30) as response:
        return ET.fromstring(response.read())


def ring_centroid(way, nodes):
    refs = [nd.attrib["ref"] for nd in way.findall("nd")]
    if len(refs) < 4 or refs[0] != refs[-1]:
        raise ValueError(f"닫힌 건물 도형이 아닙니다. way/{way.attrib['id']}")

    # Translate near the origin to avoid cancellation in the shoelace formula.
    lon0, lat0 = nodes[refs[0]]
    points = [(nodes[ref][0] - lon0, nodes[ref][1] - lat0) for ref in refs]
    twice_area = lon_sum = lat_sum = 0.0
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        cross = x1 * y2 - x2 * y1
        twice_area += cross
        lon_sum += (x1 + x2) * cross
        lat_sum += (y1 + y2) * cross
    if abs(twice_area) < 1e-14:
        raise ValueError(f"건물 도형의 면적이 너무 작습니다. way/{way.attrib['id']}")
    return abs(twice_area) / 2, lon0 + lon_sum / (3 * twice_area), lat0 + lat_sum / (3 * twice_area)


def building_center(entry, objects, nodes):
    ref = entry["osm"]
    feature = objects[ref]
    tagged_feature = objects[entry["parent"]] if "parent" in entry else feature
    tags = {tag.attrib["k"]: tag.attrib["v"] for tag in tagged_feature.findall("tag")}
    if tags.get("building") in (None, "no", "construction", "demolished"):
        raise ValueError(f"건물 태그를 다시 확인해야 합니다. {ref}")

    if "parent" in entry:
        member_ways = {member.attrib["ref"] for member in tagged_feature.findall("member")
                       if member.get("type") == "way" and member.get("role") == "outer"}
        if feature.attrib["id"] not in member_ways:
            raise ValueError(f"무궁관 도형과 건물번호를 다시 대조해야 합니다. {ref}")
    else:
        names = {lookup_key(name) for name in (entry["name"], *entry.get("aliases", []))}
        if all(lookup_key(tags.get(key, "")) not in names for key in ("name", "name:ko")):
            raise ValueError(f"건물 이름을 다시 대조해야 합니다. {ref} / {tags.get('name')}")

    if feature.tag == "way":
        _, lon, lat = ring_centroid(feature, nodes)
        return lat, lon

    area_sum = lon_sum = lat_sum = 0.0
    for member in feature.findall("member"):
        role = member.get("role")
        if role in ("outer", "inner"):
            member_ref = f"{member.attrib['type']}/{member.attrib['ref']}"
            area, lon, lat = ring_centroid(objects[member_ref], nodes)
            weight = area if role == "outer" else -area
            area_sum += weight
            lon_sum += weight * lon
            lat_sum += weight * lat
    if area_sum <= 0:
        raise ValueError(f"건물 관계의 외곽 도형을 확인할 수 없습니다. {ref}")
    return lat_sum / area_sum, lon_sum / area_sum


def straight_line_m(lat1, lon1, lat2, lon2):
    phi1, phi2 = map(math.radians, (lat1, lat2))
    delta_lon = math.radians(lon2 - lon1)
    hav = math.sin((phi2 - phi1) / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lon / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(math.sqrt(min(1.0, hav)))


def build_database(db_path, osm_path, online):
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    root = read_overpass(catalog) if online else ET.parse(osm_path).getroot()
    if root.tag != "osm" or root.find("error") is not None or root.find("remark") is not None:
        raise ValueError("OSM 응답이 불완전하거나 XML 형식이 다릅니다.")
    nodes = {node.attrib["id"]: (float(node.attrib["lon"]), float(node.attrib["lat"]))
             for node in root.findall("node")}
    objects = {f"{element.tag}/{element.attrib['id']}": element
               for element in root if element.tag in ("way", "relation")}

    rows, aliases, centers = [], {}, {}
    for building_id, entry in catalog.items():
        lat = lon = osm_url = None
        status = entry.get("status", "mapped")
        if status == "mapped":
            lat, lon = building_center(entry, objects, nodes)
            if not (37.625 <= lat <= 37.637 and 127.073 <= lon <= 127.086):
                raise ValueError(f"캠퍼스 범위를 벗어난 건물입니다. {building_id} {entry['name']}")
            centers[building_id] = (lat, lon)
            osm_url = f"https://www.openstreetmap.org/{entry['osm']}"
        rows.append((building_id, entry["name"], status, lat, lon, osm_url, entry.get("note", "")))
        for name in (building_id, entry["name"], *entry.get("aliases", [])):
            key = lookup_key(name)
            if aliases.setdefault(key, building_id) != building_id:
                raise ValueError(f"두 건물이 같은 이름을 사용합니다. {name}")

    metadata = {
        "source_api": OVERPASS_API if online else root.get("source_url", "사용자 제공 OSM XML"),
        "source_snapshot_at": root.get("retrieved_date", ""),
        "catalog_source": CAMPUS_MAP,
        "attribution": "© OpenStreetMap contributors",
        "attribution_url": ATTRIBUTION_URL,
        "data_license": "ODbL 1.0",
        "coordinate_system": "WGS84",
        "distance_method": "haversine_between_building_centroids",
        "generated_at": datetime.now(timezone(timedelta(hours=9))).isoformat(timespec="seconds"),
    }
    meta = root.find("meta")
    if online and meta is not None:
        metadata["source_snapshot_at"] = meta.get("osm_base", "")

    # Create a complete database beside the destination, then publish it in one step.
    with tempfile.TemporaryDirectory(prefix=".classroom_dist-", dir=db_path.parent) as temp:
        staged_db = Path(temp) / db_path.name
        with closing(sqlite3.connect(staged_db)) as db, db:
            db.execute("PRAGMA foreign_keys = ON")
            db.executescript(SCHEMA)
            db.executemany("INSERT INTO metadata VALUES (?, ?)", metadata.items())
            db.executemany("INSERT INTO buildings VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
            db.executemany("INSERT INTO building_aliases VALUES (?, ?)", aliases.items())
            db.executemany("INSERT INTO building_distances VALUES (?, ?, ?)", (
                (origin, destination, round(straight_line_m(*point_a, *point_b), 1))
                for origin, point_a in centers.items() for destination, point_b in centers.items()
            ))
        staged_db.replace(db_path)
    print(f"건물 {len(centers)}/{len(rows)}개, 서로 다른 건물 {math.comb(len(centers), 2)}쌍 저장")


def building_names(text):
    """Parse course cells like '미래관-313 미래관-B104' without splitting names on spaces."""
    rest = unicodedata.normalize("NFKC", text).strip(" \t\r\n;,")
    while rest:
        match = ROOM.match(rest)
        if match is None:
            yield rest
            return
        yield match["building"]
        rest = rest[match.end():].lstrip(" \t\r\n;,")


def resolve_building(db, value):
    def find(name):
        return db.execute("""
            SELECT b.building_id, b.name, b.status FROM building_aliases a
            JOIN buildings b USING (building_id) WHERE a.lookup_key = ?
        """, (lookup_key(name),)).fetchone()

    match = find(value)
    if match:
        return match
    names = list(building_names(value))
    if len(names) == 1:
        match = find(names[0])
    if match is None:
        raise ValueError(f"건물 하나 또는 강의실 하나를 지정해 주세요. {value!r}")
    return match


def print_distance(db, origin, destination):
    id_a, name_a, status_a = resolve_building(db, origin)
    id_b, name_b, status_b = resolve_building(db, destination)
    if status_a != "mapped" or status_b != "mapped":
        raise ValueError(f"거리 데이터가 없습니다. {name_a} ({status_a}), {name_b} ({status_b})")
    distance, = db.execute("""
        SELECT straight_line_m FROM building_distances WHERE from_building_id = ? AND to_building_id = ?
    """, (id_a, id_b)).fetchone()
    print(f"{name_a} → {name_b}: 직선거리 {distance:.1f} m")


def audit_courses(db, path):
    buildings, unresolved = set(), set()
    course_count = empty_count = 0
    with path.open(encoding="utf-8-sig", newline="") as file:
        courses = csv.DictReader(file)
        if "강의실" not in (courses.fieldnames or []):
            raise ValueError("CSV에 강의실 열이 없습니다.")
        for course in courses:
            course_count += 1
            names = list(building_names(course["강의실"] or ""))
            if not names:
                empty_count += 1
            for name in names:
                try:
                    _, label, status = resolve_building(db, name)
                except ValueError:
                    unresolved.add(name)
                else:
                    if status == "mapped":
                        buildings.add(label)
                    else:
                        unresolved.add(f"{label} ({status})")
    print(f"분반 {course_count}개, 강의실 빈 칸 {empty_count}개")
    print(f"거리 조회 가능 건물 {len(buildings)}개: {', '.join(sorted(buildings))}")
    if unresolved:
        print(f"미확인 건물: {', '.join(sorted(unresolved))}")
    return int(bool(unresolved))


def main():
    parser = argparse.ArgumentParser(description="서울과기대 건물 중심 간 직선거리")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite 파일 경로")
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build", help="OSM 도형에서 거리 DB 생성")
    source = build.add_mutually_exclusive_group()
    source.add_argument("--osm-file", type=Path, default=SNAPSHOT, help="OSM XML 파일")
    source.add_argument("--online", action="store_true", help="Overpass에서 지정 건물 도형 갱신")
    distance = commands.add_parser("distance", help="두 건물 또는 강의실의 건물 간 거리 조회")
    distance.add_argument("origin")
    distance.add_argument("destination")
    audit = commands.add_parser("audit", help="개설과목 CSV의 강의실 매핑 확인")
    audit.add_argument("courses", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "build":
            build_database(args.db, args.osm_file, args.online)
        else:
            with closing(sqlite3.connect(args.db.resolve().as_uri() + "?mode=ro", uri=True)) as db:
                if args.command == "audit":
                    return audit_courses(db, args.courses)
                print_distance(db, args.origin, args.destination)
    except (OSError, ValueError, KeyError, ET.ParseError, sqlite3.Error) as error:
        print(f"오류: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
