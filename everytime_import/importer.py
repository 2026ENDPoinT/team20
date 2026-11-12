"""Read public shared timetable XML and retain only pre-matching course data."""
from collections import deque
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid5
import xml.etree.ElementTree as ET

IDENTIFIER = re.compile(r'^[A-Za-z0-9_-]{1,100}$')
SEMESTERS = {'1': '1', '2': '2', '여름': 'summer', '겨울': 'winter',
             'summer': 'summer', 'winter': 'winter'}
MAX_XML_BYTES = 5_000_000


class ImportFailure(ValueError):
    """A request or source format could not be processed reliably."""


def identifier_from_url(url):
    if not isinstance(url, str):
        raise ImportFailure('공유 링크를 문자열로 입력하세요.')
    try:
        parsed = urlsplit(url.strip())
        valid = (parsed.scheme == 'https' and parsed.hostname in ('everytime.kr', 'www.everytime.kr')
                 and parsed.port in (None, 443) and not parsed.username and not parsed.password
                 and not parsed.query and not parsed.fragment)
    except ValueError as exc:
        raise ImportFailure('올바른 에브리타임 공유 링크가 아닙니다.') from exc
    path = parsed.path.rstrip('/')
    identifier = path[2:] if path.startswith('/@') else ''
    if not valid or not IDENTIFIER.fullmatch(identifier):
        raise ImportFailure('https://everytime.kr/@식별자 형식의 공유 링크가 필요합니다.')
    return identifier


def source_term(element):
    year, semester = element.get('year', ''), element.get('semester', '')
    if not re.fullmatch(r'(19|20)\d{2}', year) or semester not in SEMESTERS:
        raise ImportFailure('응답의 학년도·학기를 해석할 수 없습니다.')
    return f'{year}-{SEMESTERS[semester]}'


def parse_table(xml, expected_identifier):
    if not isinstance(xml, str) or len(xml.encode('utf-8')) > MAX_XML_BYTES:
        raise ImportFailure('XML 응답이 없거나 허용 크기를 초과했습니다.')
    if re.search(r'<!\s*(DOCTYPE|ENTITY)', xml, re.I):
        raise ImportFailure('지원하지 않는 XML 선언입니다.')
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise ImportFailure('유효한 XML 응답이 아닙니다.') from exc
    tables = root.findall('table')
    if root.tag != 'response' or len(tables) != 1 or root.find('error') is not None:
        raise ImportFailure('시간표 응답이 아닙니다. 링크 공개 상태와 접근 가능 여부를 확인하세요.')
    table = tables[0]
    if table.get('identifier') != expected_identifier:
        raise ImportFailure('요청한 시간표와 응답 식별자가 다릅니다.')
    term = source_term(table)
    references = {}
    for ref in root.findall('./primaryTables/primaryTable'):
        identifier = ref.get('identifier', '')
        if not IDENTIFIER.fullmatch(identifier):
            raise ImportFailure('연결된 시간표 식별자가 잘못되었습니다.')
        ref_term = source_term(ref)
        if identifier in references and references[identifier] != ref_term:
            raise ImportFailure('같은 시간표 식별자에 서로 다른 학기가 지정됐습니다.')
        references[identifier] = ref_term

    rows, seen, warnings = [], {}, []
    for index, subject in enumerate(table.findall('subject')):
        def value(tag):
            child = subject.find(tag)
            return (child.get('value', '') if child is not None else '').strip()

        source_id = subject.get('id') or None
        # Do not merge by name/code: repeat attempts and separate source subjects remain separate.
        identity = f'id:{source_id}' if source_id else f'position:{index}'
        row = dict(id=str(uuid5(NAMESPACE_URL, f'everytime:{expected_identifier}:{identity}')),
                   term=term, lecture_code=value('internal') or None,
                   course_name=value('name'), professor=value('professor') or None,
                   completion_status='unconfirmed', user_confirmed=False, source='everytime',
                   source_timetable_id=expected_identifier, source_subject_id=source_id)
        if identity in seen:
            if seen[identity] != row:
                raise ImportFailure('같은 원본 과목 ID의 내용이 충돌합니다.')
            continue
        seen[identity] = row
        rows.append(row)
        missing = [field for field in ('lecture_code', 'course_name') if not row[field]]
        if missing:
            warnings.append(dict(course_attempt_id=row['id'], code='missing_matching_fields', fields=missing))
        if source_id is None:
            warnings.append(dict(course_attempt_id=row['id'], code='position_based_id'))
    return dict(identifier=expected_identifier, term=term, courses=rows,
                references=references, warnings=warnings)


def fetch_xml(identifier):
    """PowerShell is the tested transport; subprocess input is data, never shell code."""
    if not IDENTIFIER.fullmatch(identifier):
        raise ImportFailure('시간표 식별자가 잘못되었습니다.')
    executable = shutil.which('pwsh') or shutil.which('powershell')
    if not executable:
        raise ImportFailure('PowerShell(pwsh 또는 powershell)이 필요합니다.')
    try:
        result = subprocess.run(
            [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
             str(Path(__file__).with_name('transport.ps1'))],
            input=json.dumps({'identifier': identifier}), capture_output=True,
            encoding='utf-8', timeout=40,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        payload = json.loads(result.stdout.lstrip('\ufeff'))
    except subprocess.TimeoutExpired as exc:
        raise ImportFailure('시간표 요청 시간이 초과됐습니다.') from exc
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ImportFailure('PowerShell 응답을 읽지 못했습니다.') from exc
    if not isinstance(payload, dict) or result.returncode or payload.get('ok') is not True:
        status = payload.get('status') if isinstance(payload, dict) else None
        raise ImportFailure(f'시간표 요청 실패 (HTTP {status or "상태 확인 불가"}).')
    xml = payload.get('xml')
    if not isinstance(xml, str):
        raise ImportFailure('시간표 XML이 없습니다.')
    return xml


def collect(shared_url, *, fetcher=fetch_xml, max_tables=100):
    """Collect each reachable table once. Partial failures are explicit, not empty successes."""
    first = identifier_from_url(shared_url)
    if type(max_tables) is not int or not 1 <= max_tables <= 100:
        raise ImportFailure('최대 시간표 수는 1~100이어야 합니다.')
    queue, discovered = deque([first]), {first: None}
    courses, tables, failures, warnings = [], [], [], []
    requested = 0
    while queue and requested < max_tables:
        identifier = queue.popleft()
        requested += 1
        try:
            parsed = parse_table(fetcher(identifier), identifier)
            if discovered[identifier] and discovered[identifier] != parsed['term']:
                raise ImportFailure('목록의 학기와 실제 시간표 학기가 다릅니다.')
            discovered[identifier] = parsed['term']
        except (ImportFailure, OSError) as exc:
            failures.append(dict(identifier=identifier, term=discovered[identifier],
                                 code='table_failed', message=str(exc)))
            continue
        tables.append(dict(identifier=identifier, term=parsed['term'], course_count=len(parsed['courses'])))
        courses.extend(parsed['courses'])
        warnings.extend(parsed['warnings'])
        for ref, ref_term in parsed['references'].items():
            if ref not in discovered:
                discovered[ref] = ref_term
                queue.append(ref)
            elif discovered[ref] is not None and discovered[ref] != ref_term:
                issue = dict(identifier=ref, code='reference_term_conflict',
                             message='시간표 목록 간 학기 정보가 다릅니다.')
                if issue not in failures:
                    failures.append(issue)
    for identifier in queue:
        failures.append(dict(identifier=identifier, term=discovered[identifier],
                             code='table_limit', message='조회 개수 제한으로 미조회했습니다.'))
    return dict(schema_version=1, kind='everytime_course_import',
                imported_at=datetime.now(timezone.utc).isoformat(),
                source=dict(provider='everytime', root_identifier=first),
                import_status='partial' if failures else 'complete',
                official_matching_status='not_started', history_complete=False,
                summary=dict(discovered_tables=len(discovered), requested_tables=requested,
                             imported_tables=len(tables), imported_terms=len({t['term'] for t in tables}),
                             course_attempts=len(courses),
                             failed_or_skipped_tables=len({f['identifier'] for f in failures})),
                timetables=tables, course_attempts=courses, failures=failures, warnings=warnings)


def save_json(document, output):
    """Replace a snapshot atomically; interrupted writes do not corrupt the previous JSON."""
    output = Path(output)
    data = json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=output.parent,
                                         prefix=output.name+'.', suffix='.tmp', delete=False) as stream:
            temporary = stream.name
            stream.write(data)
        os.replace(temporary, output)
    finally:
        if temporary and Path(temporary).exists():
            Path(temporary).unlink()
