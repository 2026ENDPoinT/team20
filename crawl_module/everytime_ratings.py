"""Import Everytime timetable XML and store ratings by official offering."""

import argparse
from collections import Counter, defaultdict
from contextlib import closing
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re
import sqlite3
import sys
from xml.etree import ElementTree as ET

from intake_app.offerings import LECTURE_CODE, active_snapshots, normalized_name, school_term


ROOT = Path(__file__).resolve().parents[1]
XML_DECLARATION = re.compile(r'<\?xml\s+[^?]*\?>')
SHIFT = {'day': '00500001', 'night': '00500002'}
SCHEMA = '''
CREATE TABLE IF NOT EXISTS everytime_ratings (
    offering_id TEXT PRIMARY KEY NOT NULL,
    term TEXT NOT NULL,
    official_snapshot_id INTEGER NOT NULL,
    lecture_id TEXT,
    rating REAL CHECK (rating > 0 AND rating <= 5),
    status TEXT NOT NULL CHECK (status IN ('rated', 'unrated')),
    observed_at TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    CHECK ((status = 'rated' AND rating IS NOT NULL) OR (status = 'unrated' AND rating IS NULL))
)
'''


def read_responses(xml):
    # Network responses are copied as consecutive standalone UTF-8 documents.
    if re.search(r'<!\s*(DOCTYPE|ENTITY)\b', xml, re.IGNORECASE):
        raise ValueError('DTD 또는 ENTITY가 포함된 XML은 가져올 수 없습니다.')
    bundle = ET.fromstring('<bundle>' + XML_DECLARATION.sub('', xml.replace('\ufeff', '')) + '</bundle>')
    if (not len(bundle) or (bundle.text or '').strip()
            or any(response.tag != 'response' or (response.tail or '').strip() for response in bundle)):
        raise ValueError('에브리타임 XML 응답을 찾을 수 없습니다.')
    for response in bundle:
        observed_at = datetime.strptime(response.attrib['now'], '%Y-%m-%d %H:%M:%S').isoformat()
        for subject in response.findall('subject'):
            yield observed_at, subject.attrib


def load_offerings(args):
    term = school_term(args.term)
    uri = args.official_db.resolve().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(uri, uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN')
        snapshot = active_snapshots(db).get(term)
        if snapshot is None:
            raise ValueError(f'{args.term} 공식 개설강좌 스냅샷이 없습니다.')
        rows = db.execute('SELECT * FROM course_offerings WHERE snapshot_id = ?', (snapshot['snapshot_id'],))
        expected = defaultdict(list)
        for row in rows:
            if args.shift and row['offering_id'].rsplit(':', 1)[-1] != SHIFT[args.shift]:
                continue
            if args.general:
                if json.loads(row['payload_json']).get('group') != '교양':
                    continue
            elif row['department_code'] != args.department_code:
                continue
            expected[f"{row['course_code']}-{row['section']}"].append(row)
    if not expected:
        raise ValueError('지정한 범위의 공식 분반이 없습니다.')
    return term, snapshot['snapshot_id'], expected


def parse_rating(value):
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise ValueError('별점 형식 오류') from None
    if not number.is_finite() or not 0 <= number <= 5:
        raise ValueError('별점 범위 오류')
    return number if number else None


def collect(files, expected):
    observations = defaultdict(lambda: defaultdict(set))
    skipped = Counter()
    for source in files:
        xml = sys.stdin.read() if source == '-' else Path(source).read_text(encoding='utf-8-sig')
        for observed_at, subject in read_responses(xml):
            code = subject.get('code', '')
            if not LECTURE_CODE.fullmatch(code):
                skipped['코드 형식 오류'] += 1
                continue
            if code not in expected:
                skipped['대상 범위 밖'] += 1
                continue
            name = normalized_name(subject.get('name'))
            professor = normalized_name(subject.get('professor'))
            matches = [row for row in expected[code] if name and professor
                       and name == normalized_name(row['course_name'])
                       and professor == normalized_name(row['professor'])]
            if len(matches) != 1:
                skipped['과목명·교수명 불일치 또는 분반 모호'] += 1
                continue
            try:
                rating = parse_rating(subject.get('lectureRate', ''))
            except ValueError as error:
                skipped[str(error)] += 1
                continue
            lecture_id = subject.get('lectureId') or None
            observations[matches[0]['offering_id']][observed_at].add((lecture_id, rating))

    accepted = {}
    for offering_id, history in observations.items():
        latest = max(history)
        if len(history[latest]) != 1:
            skipped['같은 수집 시각에 분반 별점 충돌'] += 1
            continue
        lecture_id, rating = next(iter(history[latest]))
        accepted[offering_id] = (lecture_id, rating, latest)
    return accepted, skipped


def save(path, term, snapshot, accepted):
    imported_at = datetime.now(timezone.utc).isoformat(timespec='seconds')
    with closing(sqlite3.connect(path)) as db, db:
        db.execute(SCHEMA)
        result = db.executemany('''
            INSERT INTO everytime_ratings
                (offering_id, term, official_snapshot_id, lecture_id, rating, status, observed_at, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(offering_id) DO UPDATE SET
                official_snapshot_id = excluded.official_snapshot_id, lecture_id = excluded.lecture_id,
                rating = excluded.rating, status = excluded.status,
                observed_at = excluded.observed_at, imported_at = excluded.imported_at
            WHERE excluded.observed_at > everytime_ratings.observed_at
               OR (excluded.observed_at = everytime_ratings.observed_at
                   AND excluded.lecture_id IS everytime_ratings.lecture_id
                   AND excluded.rating IS everytime_ratings.rating
                   AND excluded.official_snapshot_id <> everytime_ratings.official_snapshot_id)
        ''', ((key, term, snapshot, lecture_id, float(rating) if rating is not None else None,
               'rated' if rating is not None else 'unrated', observed_at, imported_at)
              for key, (lecture_id, rating, observed_at) in accepted.items()))
        return result.rowcount


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--term', required=True, help='학기 (예: 2026-2)')
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument('--general', action='store_true', help='공식 DB의 교양 범위')
    scope.add_argument('--department-code', help='공식 DB의 개설 조직 코드')
    parser.add_argument('--shift', choices=SHIFT, help='주간 또는 야간으로 범위를 제한')
    parser.add_argument('--official-db', type=Path, default=ROOT / 'db' / 'courses.sqlite3')
    parser.add_argument('--db', type=Path, default=ROOT / 'db' / 'everytime_ratings.sqlite3')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('files', nargs='+', help='UTF-8 XML 응답 파일. - 는 표준 입력')
    args = parser.parse_args(argv)
    if args.files.count('-') > 1:
        parser.error('표준 입력은 한 번만 지정할 수 있습니다.')
    if args.db.resolve() == args.official_db.resolve():
        parser.error('별점 DB와 공식 강좌 DB는 다른 파일이어야 합니다.')
    try:
        term, snapshot, expected = load_offerings(args)
        accepted, skipped = collect(args.files, expected)
        missing = [row['offering_id'] for rows in expected.values() for row in rows
                   if row['offering_id'] not in accepted]
        rated = sum(rating is not None for _, rating, _ in accepted.values())
        print(f'공식 분반 {len(accepted) + len(missing)}개 중 {len(accepted)}개 확인 '
              f'(별점 {rated}, 미평가 {len(accepted) - rated}, 미확보 {len(missing)})')
        for reason, count in sorted(skipped.items()):
            print(f'{reason}: {count}행')
        for offering_id in sorted(missing):
            print(f'미확보 {offering_id}')
        if not args.dry_run and accepted:
            print(f'저장 또는 갱신: {save(args.db, term, snapshot, accepted)}개')
    except (OSError, sqlite3.Error, ValueError, KeyError, ET.ParseError) as error:
        print(f'가져오기 실패: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
