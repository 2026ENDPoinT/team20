"""Validation boundary before official course-code matching."""
import math
import re

DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
STATUSES = ['unconfirmed', 'completed', 'in_progress', 'not_completed']
TERM = re.compile(r'^(19|20)\d{2}-(1|2|summer|winter)$')
TIME = re.compile(r'^([01]\d|2[0-3]):[0-5]\d$')

class ValidationError(ValueError):
    pass

def ensure(test, message):
    if not test:
        raise ValidationError(message)

def text(value, name, maximum=200):
    ensure(isinstance(value, str) and len(value) <= maximum, f'{name}: 문자열 길이를 확인하세요.')
    return value.strip()

def number(value, name, low=0, high=300, integer=False, nullable=False):
    if value is None and nullable:
        return None
    ensure(type(value) in ((int,) if integer else (int, float)) and math.isfinite(value)
           and low <= value <= high, f'{name}: {low}~{high} 범위의 숫자를 입력하세요.')
    return value

def term(value, nullable=False):
    if value in (None, '') and nullable:
        return None
    ensure(isinstance(value, str) and TERM.fullmatch(value), '학기는 2026-1, 2026-2, 2026-summer, 2026-winter 형식입니다.')
    return value

def string_list(value, name, limit=20, length=100):
    ensure(isinstance(value, list) and len(value) <= limit, f'{name}: 최대 {limit}개까지 입력할 수 있습니다.')
    return list(dict.fromkeys(text(item, name, length) for item in value if item != ''))

def meeting(value):
    ensure(isinstance(value, dict), '수업 시간 형식이 잘못되었습니다.')
    day = value.get('day')
    ensure(day is None or day in DAYS, '요일을 확인하세요.')
    start, end = value.get('start_time') or None, value.get('end_time') or None
    for clock in (start, end):
        ensure(clock is None or (isinstance(clock, str) and TIME.fullmatch(clock)), '시간은 HH:MM 형식입니다.')
    ensure(not (start and end) or start < end, '종료 시간은 시작 시간보다 늦어야 합니다.')
    return dict(day=day, start_time=start, end_time=end,
                locations=string_list(value.get('locations', []), '장소', 15, 120))

def validate_document(value, final=False):
    ensure(isinstance(value, dict), '입력 데이터는 객체여야 합니다.')
    student = value.get('student')
    ensure(isinstance(student, dict), '학생 정보를 입력하세요.')
    department = student.get('department_id', 'DEPT_CS')
    ensure(department == 'DEPT_CS', '현재 입력 전공은 컴퓨터공학과입니다.')
    admission_type = student.get('admission_type', 'freshman')
    ensure(admission_type in ('freshman', 'transfer'), '입학 유형을 확인하세요.')
    min_credits = number(student.get('min_credits'), '희망 최소학점', 0, 30, nullable=True)
    max_credits = number(student.get('max_credits'), '희망 최대학점', 0, 30, nullable=True)
    ensure(min_credits is None or max_credits is None or min_credits <= max_credits, '최소학점이 최대학점보다 큽니다.')
    year = number(student.get('admission_year'), '입학연도', 1990, 2099, integer=True, nullable=not final)
    grade = number(student.get('grade'), '학년', 1, 4, integer=True, nullable=not final)
    target = term(student.get('target_term'), nullable=not final)
    ensure(year is None or target is None or int(target[:4]) >= year, '추천 대상 학기가 입학연도보다 빠릅니다.')
    profile = dict(department_id=department, admission_year=year, grade=grade,
        admission_type=admission_type, target_term=target, min_credits=min_credits, max_credits=max_credits,
        interests=string_list(student.get('interests', []), '관심 태그'),
        recognition_notes=text(student.get('recognition_notes', ''), '면제·인정 사항', 2000),
        transfer_recognized_credits=number(student.get('transfer_recognized_credits'), '편입 인정학점', nullable=True))
    history = value.get('history_complete', False)
    ensure(type(history) is bool, '전체 이수내역 입력 여부를 확인하세요.')
    courses = value.get('course_attempts', [])
    ensure(isinstance(courses, list) and len(courses) <= 300, '과목은 최대 300개까지 저장할 수 있습니다.')
    rows, ids = [], set()
    for row in courses:
        ensure(isinstance(row, dict), '과목 데이터 형식 오류')
        cid = text(row.get('id'), '입력 과목 ID', 80)
        ensure(cid and cid not in ids, '과목 입력 ID가 중복되거나 비어 있습니다.')
        ids.add(cid)
        name = text(row.get('course_name', ''), '과목명', 200)
        course_term = term(row.get('term'), nullable=not final)
        status = row.get('completion_status', 'unconfirmed')
        ensure(status in STATUSES, '이수 상태를 확인하세요.')
        confirmed = row.get('user_confirmed', False)
        ensure(type(confirmed) is bool, '과목 확인 여부를 확인하세요.')
        if final:
            ensure(bool(name) and confirmed and status != 'unconfirmed', '모든 과목의 이름·학기·이수 상태를 확인하고 확인 체크를 해주세요.')
        meetings = row.get('meetings', [])
        ensure(isinstance(meetings, list) and len(meetings) <= 20, '과목별 수업 시간은 최대 20개입니다.')
        source = row.get('source', 'manual')
        # Existing saved courses may still carry a source from an earlier version.
        ensure(source in ('manual', 'ai', 'sample'), '입력 출처를 확인하세요.')
        ensure(row.get('course_id') is None, '공식 과목 코드는 아직 연결하지 않습니다.')
        rows.append(dict(id=cid, course_id=None, course_name=name,
            course_name_raw=text(row.get('course_name_raw', name), '인식 원문', 500), term=course_term,
            completion_status=status, user_confirmed=confirmed, source=source,
            extraction_ids=string_list(row.get('extraction_ids', []), '추출 참조', 30, 80),
            meetings=[meeting(item) for item in meetings],
            review_notes=text(row.get('review_notes', ''), '확인 메모', 2000),
            extraction_warnings=string_list(row.get('extraction_warnings', []), '추출 확인 사항', 20, 500)))
    return dict(schema_version=1, student=profile, history_complete=history, course_attempts=rows)

def document_warnings(document):
    notes = []
    if not document['history_complete']:
        notes.append('일부 이수내역만 입력되었습니다. 누락 과목을 미이수로 단정할 수 없습니다.')
    seen = set()
    for row in document['course_attempts']:
        key = (row['term'], re.sub(r'\s+', '', row['course_name']).casefold())
        if key in seen and key[1]:
            notes.append(f'같은 학기의 동명 과목 확인: {row["course_name"]}. 필요하면 화면에서 묶어주세요.')
        seen.add(key)
    return list(dict.fromkeys(notes))

