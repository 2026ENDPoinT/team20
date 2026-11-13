"""Collect SeoulTech's displayed course-evaluation stars for local use."""

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timedelta, timezone
import math
from pathlib import Path
import re
import sqlite3
import sys
from time import sleep
from urllib.error import HTTPError
from urllib.parse import quote


PROJECT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT.parent / "course_catalog"))
from seoultech_courses import CourseError, DAY_NIGHT, SeoultechClient, select_department, term_order

DEFAULT_DB = PROJECT / "class_stars.sqlite3"
SOURCE = "seoultech_guest_syllabus"
SCHEMA = """
CREATE TABLE IF NOT EXISTS class_ratings (
    term TEXT NOT NULL,
    department_code TEXT NOT NULL,
    subject_code TEXT NOT NULL,
    section TEXT NOT NULL,
    day_night TEXT NOT NULL CHECK (day_night IN ('day', 'night')),
    stars INTEGER CHECK (stars BETWEEN 1 AND 5),
    evaluation_term TEXT,
    status TEXT NOT NULL CHECK (status IN ('rated', 'no_evaluation', 'no_syllabus', 'not_displayed', 'no_instructor')),
    source TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    CHECK ((status = 'rated' AND stars IS NOT NULL) OR (status <> 'rated' AND stars IS NULL)),
    PRIMARY KEY (term, department_code, subject_code, section, day_night)
) WITHOUT ROWID
"""

SYLLABUS_RATING_QUERY = {
    "TYPE": "N", "SQL_ID": "sugang:POPUP_PROGRAM_03",
    "KEY_SQL_ID": "", "KEY_INCREMENT": "", "CALLBACK_SQL_ID": "",
    "INSERT_SQL_ID": "", "UPDATE_SQL_ID": "", "DELETE_SQL_ID": "",
    "KEY_ZERO_LEN": None, "EXEC_TYPE": "B", "USE_INPUT": "N", "USE_ORDER": "Y",
    "EXEC": "", "FAIL": "", "FAIL_MSG": "", "EXEC_CNT": 0, "MSG": "",
}


def optional_syllabus_json(client, path):
    try:
        return client.json_request(path)
    except HTTPError as error:
        if error.code != 404:
            raise
        error.close()
        return None


def evaluation_records(client, course):
    term, subject, section, instructor = (
        str(course[key]) for key in ("SP_YMST", "SUBJ_CD", "LECT_NUMB", "PROF_NUMB")
    )
    filename = quote(f"{subject}_{section}_{instructor}", safe="")
    prefix = f"/json/syllabus/{term}/{filename}"
    # The public syllabus first tries static files, then uses its read-only JSON request.
    syllabus = optional_syllabus_json(client, f"{prefix}_01.json")
    if syllabus is not None:
        if not isinstance(syllabus, list) or not syllabus:
            raise CourseError("강의계획서 응답 형식이 바뀌었습니다.")
        scores = optional_syllabus_json(client, f"{prefix}_02.json")
        return [] if scores is None else scores

    response = client.json_request("/JSONMain", {
        "SP_YMST": term, "SUBJ_CD": subject, "LECT_NUMB": section, "PERS_NUMB": instructor,
        "fsp_action": "xDefaultAction", "fsp_cmd": "execute", "fsp_ds_cmd": [SYLLABUS_RATING_QUERY],
    })
    if not isinstance(response, dict) or "ds_scor" not in response:
        raise CourseError("강의평가 응답에서 평가 목록을 찾지 못했습니다.")
    return response["ds_scor"]


def display_rating(scores):
    if not isinstance(scores, list):
        raise CourseError("강의평가 응답 형식이 바뀌었습니다.")
    if not scores:
        return None, None, "no_evaluation"
    latest = scores[0]
    if not isinstance(latest, dict) or "APPR_AVG_VAL" not in latest:
        raise CourseError("강의평가 응답에서 별점 계산 항목을 찾지 못했습니다.")
    term = str(latest.get("YMST", ""))
    if not re.fullmatch(r"\d{4}[1-4]", term):
        raise CourseError("강의평가 학기를 확인할 수 없습니다.")
    value = latest["APPR_AVG_VAL"]
    score = 0.0 if value is None or str(value).strip() == "" else float(value)
    if not math.isfinite(score) or not 0 <= score <= 100:
        raise CourseError("강의평가 값의 범위가 바뀌었습니다.")
    # The university displays whole stars using these thresholds in both syllabus templates.
    stars = sum(score >= threshold for threshold in (55, 65, 75, 85, 95))
    return stars or None, term, "rated" if stars else "not_displayed"


def fetch(args):
    client = SeoultechClient()
    year, semester, maximum = client.default_term()
    term = f"{args.year or year}{args.semester or semester}"
    if maximum and term_order(term) > term_order(maximum):
        raise CourseError("학교에서 아직 공개하지 않은 학기입니다.")
    department = select_department(client.departments(term), args.department, args.department_code)
    dept_code = str(department["ORGN_CD"])
    courses = [(shift, course) for shift in DAY_NIGHT for course in client.courses(term, dept_code, shift)]
    if not courses:
        raise CourseError("공개 시간표에 조회된 분반이 없습니다.")

    retrieved_at = datetime.now(timezone(timedelta(hours=9))).isoformat(timespec="seconds")
    ratings = []
    for shift, course in courses:
        if course.get("PROG_YN") != "Y":
            stars, evaluation_term, status = None, None, "no_syllabus"
        elif not course.get("PROF_NUMB"):
            stars, evaluation_term, status = None, None, "no_instructor"
        else:
            stars, evaluation_term, status = display_rating(evaluation_records(client, course))
            sleep(0.15)
        ratings.append((term, dept_code, str(course["SUBJ_CD"]), str(course["LECT_NUMB"]),
                        shift, stars, evaluation_term, status, SOURCE, retrieved_at))

    # Only replace the requested department and term, once every read has succeeded.
    with closing(sqlite3.connect(args.db)) as db, db:
        db.execute(SCHEMA)
        db.execute("DELETE FROM class_ratings WHERE term = ? AND department_code = ?", (term, dept_code))
        db.executemany("INSERT INTO class_ratings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ratings)
    counts = Counter(row[7] for row in ratings)
    print(f"{term} {department['ORGN_NM']} 분반 {len(ratings)}개, 별점 {counts['rated']}개 저장")
    print(", ".join(f"{status}={count}" for status, count in sorted(counts.items())))


def lookup(args):
    uri = args.db.resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as db:
        rows = db.execute("""
            SELECT department_code, day_night, stars, evaluation_term, status FROM class_ratings
            WHERE term = ? AND subject_code = ? AND section = ?
            ORDER BY department_code, day_night
        """, (args.term, args.subject, args.section)).fetchall()
    if not rows:
        raise CourseError("저장된 분반이 없습니다.")
    for department, shift, stars, evaluation_term, status in rows:
        label = "주간" if shift == "day" else "야간"
        value = f"{'★' * stars} ({stars}/5)" if stars is not None else f"별점 없음 ({status})"
        assessed = f" / 평가 학기 {evaluation_term[:4]}-{evaluation_term[4:]}" if evaluation_term else ""
        print(f"{department} {label} {args.subject}-{args.section}: {value}{assessed}")


def main():
    parser = argparse.ArgumentParser(description="서울과기대 강의계획서의 강의평가 별점 조회")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("fetch", help="공개 시간표에서 학과별 분반과 별점 조회")
    download.add_argument("--year", type=int, choices=range(1900, 2100), metavar="YYYY")
    download.add_argument("--semester", choices=("1", "2", "3", "4"))
    download.add_argument("--department", default="컴퓨터공학과")
    download.add_argument("--department-code")
    download.set_defaults(run=fetch)
    show = commands.add_parser("lookup", help="저장된 분반의 별점 조회")
    show.add_argument("term")
    show.add_argument("subject")
    show.add_argument("section")
    show.set_defaults(run=lookup)
    args = parser.parse_args()
    if args.command == "fetch" and ((args.year is None) != (args.semester is None)):
        parser.error("--year와 --semester를 함께 지정해 주세요.")
    try:
        args.run(args)
    except (CourseError, OSError, ValueError, KeyError, sqlite3.Error) as error:
        print(f"오류: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
