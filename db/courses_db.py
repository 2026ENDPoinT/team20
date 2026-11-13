"""서울과기대 공개 개설강좌의 학기별 수집·조회 도구."""

import argparse
from contextlib import closing
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
from urllib.error import URLError

ROOT = Path(__file__).resolve().parent
CRAWL = ROOT.parent / "crawl_module"
sys.dont_write_bytecode = True
sys.path.insert(0, str(CRAWL / "all"))
from seoultech_courses import CourseError, DAY_NIGHT, SCHEDULE_PATH, SeoultechClient, clean_cell

COLUMNS = {
    "term": "SP_YMST", "department_code": "LESS_CD", "department": "SP_LESS_CD_NM",
    "organizer": "MNG_LESS_NM", "course_code": "SUBJ_CD", "section": "LECT_NUMB",
    "course_name": "SUBJ_KNM", "english_name": "SUBJ_ENM", "category": "CMPT_DIV_NM",
    "credits": "UNIT", "professor": "PROF_NM", "schedule": "LSTM_LIST",
    "room": "BLDG_COUM", "language": "COUR_LANG", "capacity": "COUR_INWON",
    "day_night": "DN_DIV_NM", "note": "NOTE", "details": "ETC",
}
SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    snapshot_id INTEGER PRIMARY KEY, term TEXT NOT NULL, source TEXT NOT NULL,
    loaded_at TEXT NOT NULL, row_count INTEGER NOT NULL CHECK(row_count > 0),
    sha256 TEXT NOT NULL, UNIQUE(term, sha256), UNIQUE(term, snapshot_id)
);
CREATE TABLE IF NOT EXISTS active_terms (
    term TEXT PRIMARY KEY, snapshot_id INTEGER NOT NULL,
    FOREIGN KEY(term, snapshot_id) REFERENCES snapshots(term, snapshot_id)
);
CREATE TABLE IF NOT EXISTS course_offerings (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(snapshot_id),
    offering_id TEXT NOT NULL, course_code TEXT NOT NULL, section TEXT NOT NULL,
    course_name TEXT NOT NULL, department_code TEXT NOT NULL, category TEXT NOT NULL,
    professor TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY(snapshot_id, offering_id)
);
CREATE INDEX IF NOT EXISTS offering_code ON course_offerings(snapshot_id, course_code, section);
CREATE INDEX IF NOT EXISTS offering_name ON course_offerings(snapshot_id, course_name);
PRAGMA user_version = 1;
"""


def term_code(value):
    value = value.strip()
    match = re.fullmatch(r"([0-9]{4})-?([1-4])", value)
    if not match:
        raise argparse.ArgumentTypeError("학기는 2026-2 또는 20262 형식으로 입력하세요.")
    return "".join(match.groups())


def connect(path):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def load_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if not ({"id"} | COLUMNS.keys()) <= set(reader.fieldnames or ()):
            raise ValueError("전공·교양 통합 CSV의 헤더가 필요합니다.")
        return list(reader)


def collect(term):
    client = SeoultechClient(timeout=8)
    client.request(SCHEDULE_PATH)
    codes = sorted({str(row["ORGN_CD"]) for row in client.departments(term)})
    if "20030505" not in codes:
        raise CourseError(f"{term} 컴퓨터공학과 조회 코드를 확인할 수 없습니다.")
    rows = []
    for code in codes:
        for mode, day_code in DAY_NIGHT.items():
            for raw in client.courses(term, code, mode):
                category = clean_cell(raw.get("CMPT_DIV_NM"))
                general = category in {"교필", "교선"} or (code == "C581671" and category == "기필")
                if code != "20030505" and not general:
                    continue
                row = {key: clean_cell(raw.get(field)) for key, field in COLUMNS.items()}
                row["id"] = ":".join((term, row["course_code"], row["section"], day_code))
                row["group"] = "교양" if general else "전공"
                row["school_flags"] = {key: clean_cell(raw.get(field)) for key, field in {
                    "syllabus_available": "PROG_YN", "other_department_restricted": "OTSH_LIMT_YN",
                    "other_department_allowed": "DLES_COUR_PBT_YN", "engineering_accreditation": "ABEEK_YN",
                }.items()}
                rows.append(row)
    if {row["group"] for row in rows} != {"전공", "교양"}:
        raise CourseError(f"{term} 전공·교양 조회 범위를 확인할 수 없습니다.")
    return rows


def publish(db, term, rows, source):
    records = {}
    for row in rows:
        if (None in row or any(not isinstance(row.get(key), str) for key in COLUMNS)
                or row["term"] != term or any(not row[key].strip() for key in
                    ("course_code", "section", "course_name", "department_code", "day_night"))):
            raise ValueError(f"{term}과 일치하는 학기 및 필수 강좌 필드를 확인하세요.")
        prefix = ":".join((term, row["course_code"], row["section"]))
        key = row.get("id")
        if key not in {prefix + ":" + code for code in DAY_NIGHT.values()}:
            raise ValueError(f"분반 ID가 학기·과목·분반과 일치하지 않습니다. {key}")
        expected_day = {"주간": "day", "야간": "night"}.get(row["day_night"])
        if expected_day and not key.endswith(":" + DAY_NIGHT[expected_day]):
            raise ValueError(f"분반 ID의 주야 코드가 일치하지 않습니다. {key}")
        previous = records.setdefault(key, row)
        if previous != row:
            raise ValueError(f"같은 분반 ID의 내용이 일치하지 않습니다. {key}")
    if not records:
        raise ValueError(f"{term} 강좌가 비어 있습니다.")
    ordered = [records[key] for key in sorted(records)]
    encoded = [json.dumps(row, ensure_ascii=False, sort_keys=True) for row in ordered]
    digest = hashlib.sha256("\n".join(encoded).encode()).hexdigest()
    with db:
        db.execute("BEGIN IMMEDIATE")
        snapshot = db.execute(
            "SELECT snapshot_id FROM snapshots WHERE term = ? AND sha256 = ?", (term, digest)
        ).fetchone()
        if snapshot is None:
            snapshot_id = db.execute(
                "INSERT INTO snapshots(term, source, loaded_at, row_count, sha256) VALUES (?, ?, ?, ?, ?)",
                (term, source, datetime.now(timezone.utc).isoformat(), len(ordered), digest),
            ).lastrowid
            db.executemany("INSERT INTO course_offerings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (
                (snapshot_id, row["id"], row["course_code"], row["section"], row["course_name"],
                 row["department_code"], row["category"], row["professor"], payload)
                for row, payload in zip(ordered, encoded)
            ))
        else:
            snapshot_id = snapshot["snapshot_id"]
        activate(db, term, snapshot_id)
    print(f"{term}: {len(ordered)}개 분반, 활성 버전 {snapshot_id}", flush=True)


def activate(db, term, snapshot_id):
    db.execute(
        "INSERT INTO active_terms VALUES (?, ?) "
        "ON CONFLICT(term) DO UPDATE SET snapshot_id = excluded.snapshot_id", (term, snapshot_id)
    )


def run(args):
    if args.command in {"list", "lookup", "activate", "backup"} and not args.db.is_file():
        raise ValueError(f"DB 파일이 없습니다. 먼저 import-csv 또는 sync를 실행하세요. {args.db}")
    with closing(connect(args.db)) as db:
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if version == 0 and args.command in {"import-csv", "sync"}:
            db.executescript("BEGIN IMMEDIATE;\n" + SCHEMA + "\nCOMMIT;")
        elif version != 1:
            raise ValueError(f"지원하지 않는 DB 스키마 버전입니다. {version}")

        if args.command == "import-csv":
            publish(db, args.term, load_csv(args.path), f"csv:{args.path.name}")
        elif args.command == "sync":
            for term in dict.fromkeys(args.terms):
                print(f"{term} 수집 중", flush=True)
                publish(db, term, collect(term), "guest:cs-and-general")
        elif args.command == "list":
            for row in db.execute(
                "SELECT s.snapshot_id, s.term, s.loaded_at, s.row_count, s.source, "
                "a.snapshot_id IS NOT NULL AS active FROM snapshots s LEFT JOIN active_terms a "
                "ON a.term = s.term AND a.snapshot_id = s.snapshot_id ORDER BY s.term, s.snapshot_id"
            ):
                print(json.dumps(dict(row), ensure_ascii=False))
        elif args.command == "lookup":
            if not db.execute("SELECT 1 FROM active_terms WHERE term = ?", (args.term,)).fetchone():
                raise ValueError(f"{args.term}의 활성 강좌 데이터가 없습니다.")
            rows = db.execute(
                "SELECT o.payload_json FROM active_terms a JOIN course_offerings o USING(snapshot_id) "
                "WHERE a.term = ? AND "
                "(o.course_code = ? OR instr(replace(o.course_name, ' ', ''), ?) > 0) "
                "ORDER BY o.course_code, o.section, o.offering_id",
                (args.term, args.query, args.query.replace(" ", "")),
            )
            print(json.dumps([json.loads(row[0]) for row in rows], ensure_ascii=False, indent=2))
        elif args.command == "activate":
            with db:
                activate(db, args.term, args.snapshot)
        elif args.command == "backup":
            with args.path.open("xb"):
                pass
            try:
                with closing(connect(args.path)) as target:
                    db.backup(target)
            except (sqlite3.Error, OSError):
                args.path.unlink()
                raise
            print(args.path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=ROOT / "courses.sqlite3")
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import-csv")
    importer.add_argument("term", type=term_code)
    importer.add_argument("path", type=Path)
    sync = commands.add_parser("sync")
    sync.add_argument("terms", type=term_code, nargs="+")
    commands.add_parser("list")
    lookup = commands.add_parser("lookup")
    lookup.add_argument("term", type=term_code)
    lookup.add_argument("query", type=str.strip)
    rollback = commands.add_parser("activate")
    rollback.add_argument("term", type=term_code)
    rollback.add_argument("snapshot", type=int)
    backup = commands.add_parser("backup")
    backup.add_argument("path", type=Path)
    args = parser.parse_args()
    if args.command == "lookup" and not args.query:
        parser.error("조회할 과목코드 또는 이름을 입력하세요.")
    try:
        run(args)
    except (CourseError, URLError, TimeoutError, OSError, ValueError, sqlite3.Error) as e:
        parser.exit(1, f"처리 실패: {e}\n")


if __name__ == "__main__":
    main()
