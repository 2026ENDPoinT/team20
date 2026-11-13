#!/usr/bin/env python3
"""서울과기대 GUEST 시간표를 조회하고 CSV로 저장한다. Python 3.10+, 외부 패키지 불필요."""

from __future__ import annotations

import argparse
import csv
import html
import http.cookiejar
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener


BASE_URL = "https://for-s.seoultech.ac.kr"
SCHEDULE_PATH = "/html/pub/schedule.jsp"
SEMESTERS = {"1": "1학기", "2": "2학기", "3": "여름학기", "4": "겨울학기"}
DAY_NIGHT = {"day": "00500001", "night": "00500002"}
SCRIPT_DIR = Path(__file__).resolve().parent

# 공개 시간표의 scheduleList 열 이름과 실제 JSON 응답을 기준으로 매핑한다.
CSV_FIELDS = [
    ("SP_YMST", "학년도학기"),
    ("DN_DIV_NM", "주야구분"),
    ("LESS_CD", "학과코드"),
    ("SUBJ_CD", "교과목코드"),
    ("SUBJ_KNM", "교과목명"),
    ("SUBJ_ENM", "영문교과목명"),
    ("LECT_NUMB", "강좌번호"),
    ("CMPT_DIV_NM", "이수구분"),
    ("UNIT", "학점"),
    ("LSTM_LIST", "강의시간"),
    ("COUR_INWON", "수강정원"),
    ("SP_LESS_CD_NM", "개설학과"),
    ("MNG_LESS_NM", "주관학과"),
    ("PROF_NM", "담당교수"),
    ("BLDG_COUM", "강의실"),
    ("COUR_LANG", "수업언어"),
    ("NOTE", "비고"),
    ("ETC", "기타"),
    ("PROG_YN", "강의계획서여부"),
    ("OTSH_LIMT_YN", "타학과제한여부"),
    ("DLES_COUR_PBT_YN", "타학과수강가능여부"),
    ("ABEEK_YN", "공학인증여부"),
]


class CourseError(Exception):
    """사용자에게 표시할 조회/응답 형식 오류."""


def check_api_error(data: object) -> None:
    if isinstance(data, dict) and data.get("ErrorCode") not in (None, 0, "0"):
        message = str(data.get("ErrorMsg") or "상세 메시지 없음")
        raise CourseError(f"서버 조회 오류 ({data['ErrorCode']}): {message[:300]}")


class SeoultechClient:
    def __init__(self, timeout: float = 30):
        self.timeout = timeout
        # GUEST 페이지와 같은 세션을 사용한다. 학번/비밀번호를 받거나 저장하지 않는다.
        self.opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.opener.addheaders = [
            ("User-Agent", "SeoultechCourseCsv/1.0 (public guest timetable)"),
            ("Referer", BASE_URL + SCHEDULE_PATH),
            ("Accept", "application/json, text/html;q=0.9"),
        ]

    def request(self, path: str, payload: dict | None = None) -> bytes:
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {} if payload is None else {"Content-Type": "application/json; charset=utf-8"}
        request = Request(BASE_URL + path, data=body, headers=headers)
        for attempt in range(3):
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    # 로그인 화면으로 리다이렉트된 응답을 데이터로 취급하지 않는다.
                    if "/view/login.jsp" in response.geturl():
                        raise CourseError("공개 조회 요청이 로그인 화면으로 이동했습니다. 사이트 변경 여부를 확인하세요.")
                    return response.read()
            except HTTPError as exc:
                if exc.code not in {429, 500, 502, 503, 504} or attempt == 2:
                    raise
                exc.close()
            except (URLError, TimeoutError):
                if attempt == 2:
                    raise
            time.sleep(attempt + 1)
        raise CourseError("서버에 연결하지 못했습니다.")

    def json_request(self, path: str, payload: dict | None = None) -> object:
        raw = self.request(path, payload)
        try:
            data = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CourseError(f"{path} 응답이 JSON 형식이 아닙니다. 사이트 점검 또는 구조 변경을 확인하세요.") from exc
        check_api_error(data)
        return data

    def default_term(self) -> tuple[int, str, str | None]:
        page = self.request(SCHEDULE_PATH).decode("utf-8-sig")
        year = re.search(r'id=[\"\']edt_Shyr[\"\'][^>]*\bvalue=[\"\'](\d{4})[\"\']', page)
        semester = re.search(r"\$\(['\"]#cbo_Smst['\"]\)\.val\(['\"]([1-4])['\"]\)", page)
        maximum = re.search(r"\bvar\s+maxYmst\s*=\s*['\"](\d{4}[1-4])['\"]", page)
        if not year or not semester:
            raise CourseError("사이트의 기본 학년도/학기를 찾지 못했습니다. 공개 시간표 페이지 구조가 변경되었을 수 있습니다.")
        return int(year[1]), semester[1], maximum[1] if maximum else None

    def departments(self, term: str) -> list[dict]:
        try:
            data = self.json_request(f"/json/combo/{term}/less/less.json")
        except HTTPError as exc:
            # 공개 페이지 refreshLessCombo()도 정적 파일 실패 시 같은 조회를 사용한다.
            if exc.code not in {403, 404, 410}:
                raise
            exc.close()
            command = {
                "TYPE": "N", "SQL_ID": "admin:LESS_SEARCH",
                "KEY_SQL_ID": "", "KEY_INCREMENT": "", "CALLBACK_SQL_ID": "",
                "INSERT_SQL_ID": "", "UPDATE_SQL_ID": "", "DELETE_SQL_ID": "",
                "KEY_ZERO_LEN": None, "EXEC_TYPE": "B", "USE_INPUT": "N", "USE_ORDER": "Y",
                "EXEC": "", "FAIL": "", "FAIL_MSG": "", "EXEC_CNT": 0, "MSG": "",
            }
            response = self.json_request("/JSONMain", {
                "SP_YMST": term, "fsp_action": "xDefaultAction", "fsp_cmd": "execute",
                "fsp_ds_cmd": [command],
            })
            if not isinstance(response, dict):
                raise CourseError("학과 목록 응답 형식이 변경되었습니다.")
            data = response.get("ds_less")
        if not isinstance(data, list) or any(
            not isinstance(row, dict) or not row.get("ORGN_CD") or not row.get("ORGN_NM")
            for row in data
        ):
            raise CourseError("학과 목록 응답에 ORGN_CD/ORGN_NM이 없습니다.")
        return data

    def courses(self, term: str, department_code: str, day_night: str) -> list[dict]:
        data = self.json_request("/JSONMain", {
            "fsp_action": "GridAction", "fsp_cmd": "getScheduleGridData",
            "SP_YMST": term, "LESS_CD": department_code, "DN_DIV": DAY_NIGHT[day_night],
            "SUBJ_NM": "", "LECT_DIV": "", "DOTW_CD": "",
        })
        if not isinstance(data, dict) or not isinstance(data.get("rows"), list):
            raise CourseError("강좌 응답의 rows 배열을 찾지 못했습니다.")
        rows = data["rows"]
        try:
            count = int(data["records"])
        except (KeyError, TypeError, ValueError) as exc:
            raise CourseError("강좌 응답의 records 건수를 확인할 수 없습니다.") from exc
        if count != len(rows):
            raise CourseError(f"서버의 전체 건수({count})와 수신 건수({len(rows)})가 달라 저장을 중단했습니다.")
        for row in rows:
            if not isinstance(row, dict) or any(row.get(key) in (None, "") for key in ("SUBJ_CD", "LECT_NUMB", "SUBJ_KNM")):
                raise CourseError("강좌 응답의 교과목코드/강좌번호/교과목명이 올바르지 않습니다.")
            if str(row.get("SP_YMST")) != term or str(row.get("LESS_CD")) != department_code:
                raise CourseError("요청한 학기/학과와 다른 데이터가 반환되어 저장을 중단했습니다.")
            if row.get("DN_DIV") != DAY_NIGHT[day_night]:
                raise CourseError("요청한 주야구분과 다른 데이터가 반환되었습니다.")
        return rows


def select_department(departments: list[dict], name: str, code: str | None) -> dict:
    matches = [row for row in departments if (
        str(row["ORGN_CD"]) == code if code is not None else str(row["ORGN_NM"]).strip() == name.strip()
    )]
    if len(matches) == 1:
        return matches[0]
    candidates = [row for row in departments if name.strip() in str(row["ORGN_NM"])] if code is None else []
    hint = ", ".join(f"{row['ORGN_NM']} ({row['ORGN_CD']})" for row in candidates[:10])
    raise CourseError(
        f"학과를 하나로 결정할 수 없습니다: {code or name}. "
        + (f"후보: {hint}. --department-code로 지정하세요." if hint else "--list-departments로 목록을 확인하세요.")
    )


def clean_cell(value: object) -> str:
    text = "" if value is None else str(value)
    text = re.sub(r"<br\s*/?>", "; ", text, flags=re.IGNORECASE)
    text = html.unescape(text).strip()
    # CSV를 Excel로 열 때 원격 문자열이 수식으로 실행되지 않게 한다.
    return "'" + text if text.startswith(("=", "+", "-", "@", "\t", "\r")) else text


def write_csv(path: Path, rows: list[dict], year: int, semester: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8-sig", newline="", dir=path.parent, delete=False) as handle:
            temp_path = Path(handle.name)
            writer = csv.writer(handle)
            writer.writerow(["학년도", "학기"] + [label for _, label in CSV_FIELDS])
            for row in rows:
                writer.writerow([year, SEMESTERS[semester]] + [clean_cell(row.get(key)) for key, _ in CSV_FIELDS])
        os.replace(temp_path, path)
    finally:
        if temp_path is not None and temp_path.exists():
            temp_path.unlink()


def term_order(term: str) -> tuple[int, int]:
    return int(term[:4]), {"1": 0, "3": 1, "2": 2, "4": 3}[term[4]]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    parser.add_argument("--year", type=int, help="학년도. 생략하면 사이트 기본 학년도")
    parser.add_argument("--semester", choices=SEMESTERS, help="1=1학기, 2=2학기, 3=여름, 4=겨울. 생략하면 사이트 기본 학기")
    parser.add_argument("--department", default="컴퓨터공학과", help="학과명 (정확히 일치)")
    parser.add_argument("--department-code", help="학과코드로 선택 (--department보다 우선)")
    parser.add_argument("--day-night", choices=["all", "day", "night"], default="all", help="전체/주간/야간")
    parser.add_argument("--list-departments", action="store_true", help="선택한 학기의 학과 목록만 출력")
    parser.add_argument("--output", type=Path, help="CSV 경로. 기본값은 프로그램 폴더의 학년도_학기_학과명_개설과목.csv")
    parser.add_argument("--raw-json", type=Path, help="원본 행과 조회 조건을 별도 JSON 파일로 저장")
    parser.add_argument("--timeout", type=float, default=30, help="요청별 제한 시간(초)")
    args = parser.parse_args(argv)
    if args.year is not None and not 1900 <= args.year <= 2100:
        parser.error("--year는 1900~2100 범위여야 합니다.")
    if args.timeout <= 0:
        parser.error("--timeout은 0보다 커야 합니다.")
    return args


def run(args: argparse.Namespace) -> int:
    client = SeoultechClient(args.timeout)
    default_year, default_semester, maximum = client.default_term()
    year, semester = args.year or default_year, args.semester or default_semester
    term = f"{year}{semester}"
    if maximum and term_order(term) > term_order(maximum):
        raise CourseError(f"사이트에서 조회할 수 있는 최신 학기는 {maximum[:4]}학년도 {SEMESTERS[maximum[4]]}입니다.")
    print(f"조회 학기: {year}학년도 {SEMESTERS[semester]}")
    departments = client.departments(term)
    if args.list_departments:
        for row in departments:
            print(f"{row['ORGN_CD']}\t{row['ORGN_NM']}")
        return 0
    department = select_department(departments, args.department, args.department_code)
    code, name = str(department["ORGN_CD"]), str(department["ORGN_NM"])
    print(f"조회 학과: {name} ({code})")
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    output = (args.output or SCRIPT_DIR / f"{year}_{semester}_{safe_name}_개설과목.csv").resolve()
    if args.raw_json and args.raw_json.resolve() == output:
        raise CourseError("--raw-json과 --output은 서로 다른 경로를 지정해야 합니다.")
    rows = []
    for mode in (DAY_NIGHT if args.day_night == "all" else [args.day_night]):
        fetched = client.courses(term, code, mode)
        print(f"  {'주간' if mode == 'day' else '야간'}: {len(fetched)}건")
        rows.extend(fetched)
    if not rows:
        raise CourseError("조회 결과가 0건입니다. 학기/주야구분을 확인하세요. 기존 CSV는 변경하지 않았습니다.")
    rows.sort(key=lambda row: (str(row.get("SUBJ_CD", "")), str(row.get("LECT_NUMB", "")), str(row.get("DN_DIV", ""))))
    write_csv(output, rows, year, semester)
    print(f"CSV 저장 완료: {output}")
    print(f"총 {len(rows)}개 강좌 / {len({row['SUBJ_CD'] for row in rows})}개 교과목 (분반별 1행)")
    if args.raw_json:
        args.raw_json.parent.mkdir(parents=True, exist_ok=True)
        args.raw_json.write_text(json.dumps({
            "source": BASE_URL + SCHEDULE_PATH, "term": term, "department": department,
            "day_night": args.day_night, "records": len(rows), "rows": rows,
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"원본 JSON 저장 완료: {args.raw_json.resolve()}")
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        return run(parse_args(argv))
    except CourseError as exc:
        print(f"오류: {exc}", file=sys.stderr)
    except HTTPError as exc:
        print(f"오류: 서버가 HTTP {exc.code}로 응답했습니다. 잠시 후 다시 시도하세요.", file=sys.stderr)
    except (URLError, TimeoutError) as exc:
        print(f"오류: 사이트 연결 실패: {exc}", file=sys.stderr)
    except (OSError, UnicodeError) as exc:
        print(f"오류: {exc}. CSV가 Excel에서 열려 있다면 닫은 뒤 다시 실행하세요.", file=sys.stderr)
    except KeyboardInterrupt:
        print("\n조회가 취소되었습니다.", file=sys.stderr)
        return 130
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
