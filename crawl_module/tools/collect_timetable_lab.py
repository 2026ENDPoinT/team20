"""2026년 2학기 GUEST 개설강좌에서 컴퓨터공학과·교양 분반 CSV를 만든다."""

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import csv
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from threading import local
from urllib.error import URLError

LAB_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LAB_DIR.parent / "course_catalog"))
from seoultech_courses import BASE_URL, SCHEDULE_PATH, CourseError, SeoultechClient, clean_cell

TERM = "20262"
CS = "20030505"
LIBERAL_COLLEGE = "C581671"
INTERNATIONAL_OFFICE = "20050109"
OUTPUT = LAB_DIR / "data" / "courses-2026-2.csv"
CORE_AREAS = {
    "1영역 · 사상과 문화": "100764 100643 100766 100865 100864",
    "2영역 · 역사와 문명": "100639 100829 100762 100861 101018",
    "3영역 · 인간과 사회": "100798 100799 100057 100831 100784 101019",
    "4영역 · 과학과 기술": "100063 100356 100357",
    "5영역 · 예술과 미래": "100358 100359 100371",
}
AREA_BY_CODE = {code: area for area, codes in CORE_AREAS.items() for code in codes.split()}
AREA_BY_NUMBER = {area[0]: area for area in CORE_AREAS}
CSV_COLUMNS = [
    ("term", "SP_YMST"), ("department_code", "LESS_CD"), ("department", "SP_LESS_CD_NM"),
    ("organizer", "MNG_LESS_NM"), ("course_code", "SUBJ_CD"), ("section", "LECT_NUMB"),
    ("course_name", "SUBJ_KNM"), ("english_name", "SUBJ_ENM"), ("category", "CMPT_DIV_NM"),
    ("credits", "UNIT"), ("professor", "PROF_NM"), ("schedule", "LSTM_LIST"),
    ("room", "BLDG_COUM"), ("language", "COUR_LANG"), ("capacity", "COUR_INWON"),
    ("day_night", "DN_DIV_NM"), ("note", "NOTE"), ("details", "ETC"),
]


def get_source():
    client = SeoultechClient(timeout=15)
    client.request(SCHEDULE_PATH)
    departments = client.departments(TERM)
    state = local()

    def get_department_rows(department):
        if not hasattr(state, "client"):
            state.client = SeoultechClient(timeout=15)
            state.client.request(SCHEDULE_PATH)
        code = str(department["ORGN_CD"])
        return [row for mode in ("day", "night") for row in state.client.courses(TERM, code, mode)]

    with ThreadPoolExecutor(max_workers=4) as pool:
        return [row for rows in pool.map(get_department_rows, departments) for row in rows]


def classify(row):
    code = row["LESS_CD"]
    category = row["CMPT_DIV_NM"]
    name = re.sub(r"\s+", "", row["SUBJ_KNM"])
    if code == CS and category not in {"교필", "교선"}:
        return "전공", "컴퓨터공학과"
    if "실용영어의사소통" in name and code == INTERNATIONAL_OFFICE:
        return "교양", "국제화"
    if row["SUBJ_CD"] in AREA_BY_CODE:
        return "교양", AREA_BY_CODE[row["SUBJ_CD"]]
    note = f"{row.get('NOTE') or ''} {row.get('ETC') or ''}"
    area = re.search(r"(?:제\s*)?([1-5])\s*영역", note)
    if area:
        return "교양", AREA_BY_NUMBER[area[1]]
    if code == INTERNATIONAL_OFFICE:
        return "교양", "외국어"
    named_areas = (
        ("논리적글쓰기", "글쓰기와 논리"), ("창의적사고", "창의"),
        ("삶의윤리학", "인성"), ("인간과공동체", "인성"),
        ("컴퓨팅사고와인공지능", "S/W"), ("취창업진로설계", "진로"),
        ("STella", "진로"),
    )
    for fragment, label in named_areas:
        if fragment in name:
            return "교양", label
    if re.search(r"미분적분학|일반물리학", name):
        return "교양", "학문기초교양"
    if category == "기필":
        return "교양", "기초필수"
    return "교양", "기타 교양"


def build_rows(source):
    results = {}
    for row in source:
        code, category = row["LESS_CD"], row["CMPT_DIV_NM"]
        if code != CS and category not in {"교필", "교선"} and not (
            code == LIBERAL_COLLEGE and category == "기필"
        ):
            continue
        key = (row["SP_YMST"], row["SUBJ_CD"], row["LECT_NUMB"], row["DN_DIV"])
        group, area = classify(row)
        record = {
            "id": ":".join(key), "group": group, "area": area,
            "source_url": BASE_URL + SCHEDULE_PATH,
            **{name: row.get(source_key) for name, source_key in CSV_COLUMNS},
        }
        if key in results and results[key] != record:
            raise CourseError(f"같은 분반 ID에 서로 다른 강좌 정보가 있습니다: {key}")
        results[key] = record
    rows = sorted(results.values(), key=lambda row: (
        row["group"] != "전공", row["course_name"], row["course_code"], row["section"],
    ))
    has_required_english = any(
        row["department_code"] == INTERNATIONAL_OFFICE
        and row["category"] == "교필"
        and "실용영어의사소통" in re.sub(r"\s+", "", row["course_name"])
        for row in rows
    )
    if not all(any(row["group"] == group for row in rows) for group in ("전공", "교양")) or not has_required_english:
        raise CourseError("컴퓨터공학과·교양·국제교류처 실용영어의사소통의 수집 범위를 확인하세요.")
    return rows


def write_csv(rows):
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=OUTPUT.parent, mode="w", encoding="utf-8-sig",
                                         newline="", delete=False) as temporary:
            temporary_path = Path(temporary.name)
            writer = csv.DictWriter(temporary, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows({name: clean_cell(value) for name, value in row.items()} for row in rows)
        os.replace(temporary_path, OUTPUT)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def write_browser_snapshot():
    """Keep the double-clickable pages backed by the same CSV as the HTTP pages."""
    csv_text = OUTPUT.read_bytes().decode("utf-8-sig")
    target = OUTPUT.with_suffix(".js")
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, mode="w", encoding="utf-8",
                                         newline="", delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write("const timetableLabCSV = " + json.dumps(csv_text, ensure_ascii=True) + ";\n")
        os.replace(temporary_path, target)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main():
    try:
        rows = build_rows(get_source())
        write_csv(rows)
        write_browser_snapshot()
    except (CourseError, URLError, TimeoutError, OSError, ValueError) as error:
        raise SystemExit(f"수집 실패: {error}") from error
    print(f"{OUTPUT} · {len(rows)}개 분반 · {dict(Counter(row['group'] for row in rows))}")


if __name__ == "__main__":
    main()
