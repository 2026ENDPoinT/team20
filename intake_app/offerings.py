"""Read official offering snapshots and report matches against confirmed attempts."""
from contextlib import closing
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re
import sqlite3
import unicodedata

from .domain import TERM

LECTURE_CODE = re.compile(r'([0-9]{6})-([0-9]{5})')
SEMESTER_CODES = {'1': '1', '2': '2', 'summer': '3', 'winter': '4'}


def school_term(term):
    if not isinstance(term, str) or not TERM.fullmatch(term):
        raise ValueError('수강 학기 형식을 확인해주세요.')
    year, semester = term.split('-')
    return year + SEMESTER_CODES[semester]


def normalized_name(value):
    return ''.join(unicodedata.normalize('NFKC', value or '').casefold().split())


def offering_details(row, snapshot):
    payload = json.loads(row['payload_json'])
    try:
        credits = Decimal(str(payload.get('credits')))
        credits = float(credits) if credits.is_finite() and 0 <= credits <= 300 else None
    except InvalidOperation:
        credits = None
    return dict(snapshot_id=snapshot['snapshot_id'], snapshot_sha256=snapshot['sha256'],
                offering_id=row['offering_id'], course_code=row['course_code'], section_code=row['section'],
                course_name=row['course_name'], professor=row['professor'] or None, credits=credits)


def compare_offerings(database, document):
    with closing(sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN')
        snapshots = {row['term']: dict(row) for row in db.execute('''
            SELECT a.term, a.snapshot_id, s.sha256 FROM active_terms a JOIN snapshots s
              ON a.term = s.term AND a.snapshot_id = s.snapshot_id
        ''')}
        return [compare_attempt(db, snapshots, row) for row in document['course_attempts']]


def compare_attempt(db, snapshots, row):
    result = dict(course_attempt_id=row['id'], status='pending', reason=None, offering=None, candidates=[])
    if row['source'] == 'sample' or not row['user_confirmed'] or row['completion_status'] != 'completed':
        return dict(result, status='not_checked', reason='completion_not_confirmed')
    snapshot = snapshots.get(school_term(row['term']))
    if snapshot is None:
        return dict(result, reason='term_unavailable')
    code = row['lecture_code']
    if not code:
        return dict(result, reason='missing_lecture_code')
    parts = LECTURE_CODE.fullmatch(code)
    if not parts:
        return dict(result, reason='unsupported_lecture_code')
    candidates = [offering_details(candidate, snapshot) for candidate in db.execute('''
        SELECT offering_id, course_code, section, course_name, professor, payload_json
        FROM course_offerings WHERE snapshot_id = ? AND course_code = ? AND section = ?
        ORDER BY offering_id
    ''', (snapshot['snapshot_id'], *parts.groups()))]
    if not candidates:
        return dict(result, reason='offering_not_in_snapshot')
    if len(candidates) > 1:
        return dict(result, status='ambiguous', reason='multiple_offerings', candidates=candidates)
    offering = candidates[0]
    name_conflict = normalized_name(row['course_name']) != normalized_name(offering['course_name'])
    professor_conflict = (row['professor'] and offering['professor'] and
                          normalized_name(row['professor']) != normalized_name(offering['professor']))
    if name_conflict or professor_conflict:
        return dict(result, reason='course_name_conflict' if name_conflict else 'professor_conflict',
                    candidates=candidates)
    return dict(result, status='offering_matched', offering=offering)
