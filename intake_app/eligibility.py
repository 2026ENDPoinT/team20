"""Interpret verified registration notes from the official offering snapshot."""

import re
import unicodedata


# This app currently plans for regular, single-major CS freshmen and continuing students.
CS_AFFILIATIONS = {'정보통신대학', '컴퓨터공학과'}
KNOWN_TARGETS = CS_AFFILIATIONS | {
    '공과대학', '에너지바이오대학', '창의융합대학', 'ST자유전공학부',
    '미래융합대학', '에너지신기술융합학과(계약학과)',
}
EXCLUSIVE_NOTES = {
    '[교환학생_한국어]외국인 교환학생 전용',
    'ST자유전공학부 전용 강좌',
    '미래융합대학 전용 강좌(미융대 학생만 수강 가능)',
    '에너지신기술융합학과(계약학과) 전용 강좌',
    '에너지신기술융합학과(계약학과) 전용 강좌 **타학과 수강신청 금지**',
}
ENGLISH_SECOND_TERM = (
    '2. 공대, 기경대, 인사대, 국제대, 자유전공(1유형) 수강 '
    '(정통대, 에바대, 조형대, 창의융합대학생은 1학기에 수강)'
)
NEUTRAL_DETAILS = re.compile(
    r'학문기초교양|공통필수|기초필수|체육|제[1-5]영역|원격수업 교과목\(온라인100%\)|'
    r'택1\s*,\s*(?:제[1-5]영역|공통필수 (?:실용영어의사소통|인성영역|글쓰기논리)|2과목 그룹\d+)'
)
OPEN_NOTES = {
    '', '절대평가', '수강대상자 구분 없음(영어강의)',
    '수강제한 없음 / 강좌 당 28명 제한 / 수강신청 후 분반',
    '수강제한 없음 / 수강신청 후 수강 학생수에 맞춰 분반 / 공동평가',
}


def clean(value):
    return ' '.join(unicodedata.normalize('NFKC', value or '').split())


def eligibility(offering, term):
    """Return the decision and its source or reason for the current CS profile."""
    if offering['day_night'] == '야간':
        return 'excluded', '야간 분반은 주간 과정 추천 대상이 아닙니다.'

    original_note = (offering.get('note') or '').strip()
    note = clean(original_note)
    details = clean(offering.get('details'))
    restriction = offering['school_flags'].get('other_department_restricted')
    if any(word in note for word in ('우선', '정정', '제한 해제')):
        return 'needs_review', original_note
    if term == '20262' and any(clean(line) == ENGLISH_SECOND_TERM for line in original_note.splitlines()):
        return 'excluded', ENGLISH_SECOND_TERM.removeprefix('2. ')
    if note in EXCLUSIVE_NOTES:
        return 'excluded', original_note
    targets = re.fullmatch(r'수강대상\s*:\s*([^/]+?)(?:\s*/\s*수강신청 후 분반)?', note)
    if targets:
        names = {re.sub(r'\s+\(', '(', name.strip()) for name in targets[1].split(',')}
        if names <= KNOWN_TARGETS:
            if not names & CS_AFFILIATIONS:
                return 'excluded', original_note
            if restriction == 'N' and offering['day_night'] == '주간' and (
                    not details or NEUTRAL_DETAILS.fullmatch(details)):
                return 'no_restriction_recorded', original_note
        return 'needs_review', original_note

    if (offering['day_night'] == '주간' and restriction == 'N' and note in OPEN_NOTES
            and (not details or NEUTRAL_DETAILS.fullmatch(details))):
        return 'no_restriction_recorded', original_note or None
    if restriction == 'Y' and ('수강제한 없음' in note or '수강대상자 구분 없음' in note):
        return 'needs_review', f'{original_note} / 공식 DB에 타학과 제한도 기록되어 있습니다.'
    return 'needs_review', (original_note or (details if not NEUTRAL_DETAILS.fullmatch(details) else '')
                            or '공식 DB에 수강 가능 대상이나 예외가 명시되어 있지 않습니다.')
