"""Stage Everytime rows and apply explicitly selected changes to a student draft."""
from hashlib import sha256
import json

from .domain import ensure

IDENTITY_FIELDS = ('term', 'lecture_code', 'course_name', 'professor')


def fingerprint(value):
    encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return 'sha256:' + sha256(encoded).hexdigest()


def check_import_sources(document, stored):
    existing = {row['id']: row for row in (stored or {}).get('course_attempts', [])}
    for row in document['course_attempts']:
        previous = existing.get(row['id'], {})
        if row['source'] == 'everytime' or previous.get('source') == 'everytime':
            ensure(previous.get('source') == row['source'] and previous.get('source_ref') == row['source_ref'],
                   '에브리타임 과목은 가져오기 화면에서 추가해주세요.')


def prepare_import(collection, document, origins):
    if not collection['timetables']:
        failures = collection['failures']
        message = failures[0]['message'] if failures else '공유 링크에서 시간표를 찾지 못했습니다.'
        ensure(False, message)
    ensure(len(collection['course_attempts']) <= 300, '공유 과목이 300개를 초과했습니다.')
    existing = document['course_attempts']
    by_key = {row['source_ref']['source_key']: row for row in existing if row['source_ref']}
    tables = {row['source_ref']['source_table_key'] for row in existing if row['source_ref']}
    used_ids = {row['id'] for row in existing}
    rows, changes, hashes = [], [], {}
    for source in collection['course_attempts']:
        table_id, subject_id = source['source_timetable_id'], source['source_subject_id']
        basis = 'source_subject' if subject_id is not None else 'source_position'
        identity = subject_id if subject_id is not None else source['source_position']
        key = fingerprint(['everytime', table_id, basis, identity])
        table_key = fingerprint(['everytime', table_id])
        row = {field: source[field] for field in ('id', *IDENTITY_FIELDS)}
        row.update(completion_status='unconfirmed', user_confirmed=False, source='everytime', review_notes='',
                   source_ref=dict(source_key=key, source_table_key=table_key, identity_basis=basis))
        fields = {field: fingerprint(row[field]) for field in IDENTITY_FIELDS}
        previous = by_key.get(key)
        changed = []
        action = 'add'
        if previous:
            baseline = origins.get(previous['id'])
            if baseline is None:
                action = 'review'
            else:
                changed = [field for field in IDENTITY_FIELDS if baseline.get(field) != fields[field]]
                action = 'unchanged' if not changed else ('update' if basis == 'source_subject' else 'review')
        elif row['id'] in used_ids or (basis == 'source_position' and table_key in tables):
            action = 'review'
        rows.append(row)
        hashes[row['id']] = fields
        changes.append(dict(incoming_attempt_id=row['id'], existing_attempt_id=previous['id'] if previous else None,
                            action=action, changed_fields=changed,
                            previous_values={field: previous[field] for field in changed} if previous else {}))
    issues = [{key: warning[key] for key in ('code', 'course_attempt_id', 'fields') if key in warning}
              for warning in collection['warnings']]
    issues += [{key: failure[key] for key in ('term', 'code', 'message') if key in failure}
               for failure in collection['failures']]
    return dict(imported_at=collection['imported_at'], import_status=collection['import_status'],
                summary=collection['summary'], course_attempts=rows, changes=changes, issues=issues), hashes


def apply_import(document, preview, hashes, accepted_adds, accepted_updates):
    by_id = {row['id']: row for row in document['course_attempts']}
    rows = {row['id']: row for row in preview['course_attempts']}
    choices = {change['incoming_attempt_id']: change for change in preview['changes']}
    origins = {}
    for selected, action in ((accepted_adds, 'add'), (accepted_updates, 'update')):
        ensure(isinstance(selected, list) and len(selected) <= 300 and all(isinstance(item, str) for item in selected),
               '가져올 과목을 다시 선택해주세요.')
        ensure(len(set(selected)) == len(selected), '같은 과목을 여러 번 선택했습니다.')
        for incoming_id in selected:
            change = choices.get(incoming_id)
            ensure(change and change['action'] == action, '적용할 수 없는 과목이 선택됐습니다.')
            row = rows[incoming_id]
            if action == 'add':
                document['course_attempts'].append(dict(row))
                origins[incoming_id] = hashes[incoming_id]
            else:
                previous = by_id[change['existing_attempt_id']]
                for field in change['changed_fields']:
                    previous[field] = row[field]
                previous.update(completion_status='unconfirmed', user_confirmed=False)
                origins[previous['id']] = hashes[incoming_id]
    ensure(origins, '가져올 과목을 선택해주세요.')
    return origins
