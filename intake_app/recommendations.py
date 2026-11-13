"""Group official offerings by the student's remaining curriculum requirements."""
from collections import defaultdict
from decimal import Decimal
import json
from pathlib import Path

from .domain import ensure
from .interest_tags import OTHER, classify, load_tags
from .offerings import normalized_name, recommendation_data, school_term

DATA = Path(__file__).resolve().parents[1] / 'data' / 'graduation_requirements'
CS = '20030505'
MAJOR_REQUIRED = {'programming_1', 'programming_2', 'discrete_math', 'capstone_1', 'capstone_2'}
RECOMMENDATION_GROUPS = ('current_major_required', 'future_major_required', 'required_general',
                         'major_credits', 'general_credits')
TERM_ORDER = {'1': 0, '3': 1, '2': 2, '4': 3}
# 2025 education curriculum, PDF page 31, daytime sports electives.
SPORTS_CODES = set('100147 100148 100154 100156 100157 100345 100346 100347 100348 100349 100352 100353 100354 100712'.split())


def codes(rule):
    return set(rule.get('course_codes', ())) | ({rule['course_code']} if 'course_code' in rule else set())


def term_key(term):
    value = school_term(term)
    return int(value[:4]), TERM_ORDER[value[-1]]


def bucket(offering, general_codes):
    if offering['course_code'] in general_codes:
        return 'general'
    if offering['category'] in ('전필', '전선'):
        return 'major' if offering['department_code'] == CS else None
    if offering['category'] in ('교필', '교선'):
        return 'general'
    return None


def is_sport(offering):
    return offering['category'] == '교선' and offering['course_code'] in SPORTS_CODES


def exclusion_map(data):
    excluded = defaultdict(set)
    for rule in data['credit_rules']:
        if rule['type'] == 'exclude_credits':
            for code in codes(rule):
                excluded[code].update(rule['buckets'])
    return excluded


def evaluate(data, document, matches, elective_groups):
    rules = {r['id']: r for group in data['requirements'].values() for r in group}
    general_codes = set().union(*(codes(r) for id, r in rules.items() if id not in MAJOR_REQUIRED))
    attempts = {row['id']: row for row in document['course_attempts']}
    target = term_key(document['student']['target_term'])
    completed, credit_by_code, sports = defaultdict(list), {}, {}
    completion_years = defaultdict(set)
    in_progress = set()
    unresolved = False
    for match in matches:
        attempt = attempts[match['course_attempt_id']]
        if attempt['source'] == 'sample' or attempt['completion_status'] == 'not_completed':
            continue
        if attempt['term'] and term_key(attempt['term']) > target:
            continue
        if match['status'] != 'offering_matched':
            unresolved = True
            continue
        code = match['offering']['course_code']
        if attempt['completion_status'] == 'in_progress':
            in_progress.add(code)
            unresolved = True
            continue
        completed[code].append(match['offering'])
        completion_years[code].add(attempt['term'][:4])

    uncertain_rules, uncertain_codes = set(), set()
    credit_reviews = []
    for review in data['pending_reviews']:
        id = review.get('requirement_id')
        candidates = codes(review) or codes(rules.get(id, {}))
        found = candidates & completed.keys()
        trigger = review['trigger']
        if review['affects'] == 'requirement_satisfaction' and found:
            uncertain_rules.add(id)
        elif trigger == 'multiple_options_completed' and len(found) > 1:
            uncertain_codes.update(found)
            if id in ('programming_1', 'programming_2'):
                credit_reviews.append(dict(title=rules[id]['title'], course_codes=sorted(found)))
        elif trigger == 'listed_course_completed':
            uncertain_codes.update(found)

    admission_year = str(document['student']['admission_year'])
    for group in elective_groups:
        members = set(group['course_codes'])
        if not members <= completed.keys():
            continue
        relevant_years = {admission_year}.union(*(completion_years[code] for code in members))
        if not relevant_years.intersection(group['curriculum_groups']):
            continue
        uncertain_codes.update(members)
        credit_reviews.append(dict(title=group['title'], course_codes=group['course_codes']))

    duplicate_options = set()
    for rule in data['credit_rules']:
        if rule['type'] == 'count_one_course':
            found = set().union(*(codes(rules[id]) for id in rule['requirement_ids'])) & completed.keys()
            if len(found) > 1:
                values = {row['credits'] for code in found for row in completed[code]}
                if len(values) == 1 and None not in values:
                    duplicate_options.update(sorted(found)[1:])
                else:
                    uncertain_codes.update(found)

    excluded = exclusion_map(data)
    totals = dict(total=Decimal(0), major=Decimal(0), general=Decimal(0))
    credit_uncertain = {}
    for code, rows in completed.items():
        if 'total' in excluded[code] or code in duplicate_options:
            continue
        buckets = {bucket(row, general_codes) for row in rows}
        values = {row['credits'] for row in rows}
        if code in uncertain_codes or len(values) != 1 or None in values or len(buckets) != 1 or None in buckets:
            credit_uncertain[code] = {'total', 'major', 'general'} if None in buckets else {'total'} | buckets
            continue
        kind = next(iter(buckets))
        value = Decimal(str(next(iter(values))))
        if any(is_sport(row) for row in rows):
            sports[code] = value
            continue
        credit_by_code[code] = value
        totals['total'] += value
        if kind not in excluded[code]:
            totals[kind] += value

    sports_rule = next(r for r in data['credit_rules'] if r['id'] == 'sports_cap')
    sports_credits = min(sum(sports.values()), Decimal(sports_rule['max']))
    for kind in sports_rule['buckets']:
        totals[kind] += sports_credits
    history_incomplete = unresolved or not document['history_complete']
    individual_review = bool(document['student'].get('recognition_notes'))
    results = []
    for id, rule in rules.items():
        kind = rule['type']
        wanted = rule.get('min', 1)
        group_codes = codes(rule)
        uncertain = id in uncertain_rules or individual_review
        if kind == 'min_credits':
            current = totals[rule['bucket']]
            uncertain |= history_incomplete or any(rule['bucket'] in affected for affected in credit_uncertain.values())
        elif kind == 'min_group_credits':
            current = sum(credit_by_code.get(code, Decimal(0)) for code in group_codes)
            uncertain |= history_incomplete or bool(group_codes & credit_uncertain.keys())
        elif kind == 'min_regular_terms':
            current = document['student'].get('regular_terms_completed')
        else:
            current = len(group_codes & completed.keys())
            uncertain |= history_incomplete
        status = ('met' if current is not None and current >= wanted else
                  'needs_review' if current is None or uncertain else 'not_met')
        results.append(dict(id=id, title=rule['title'], status=status,
                            current=float(current) if current is not None else None,
                            target=wanted, type=kind, source_refs=rule['source_refs']))
    return (rules, results, completed, in_progress, general_codes, credit_reviews,
            sports_credits >= sports_rule['max'])


def eligibility(offering):
    if offering['day_night'] == '야간':
        return 'excluded'
    flags = offering['school_flags']
    # Public fields omit the actual allow-list and registration phase.
    if offering['day_night'] == '주간' and flags.get('other_department_restricted') == 'N' and not (
            offering['note'] or offering['details']):
        return 'no_restriction_recorded'
    return 'needs_review'


def recommend(database, document):
    student = document['student']
    if student.get('program_type') is None:
        student = dict(student, program_type='standard_single_major_day')
        document = dict(document, student=student)
    year, grade = student.get('admission_year'), student.get('grade')
    ensure(year and grade, '입학연도와 현재 학년을 입력해주세요.')
    ensure(2021 <= year <= 2026 and student['admission_type'] == 'freshman'
           and student['program_type'] == 'standard_single_major_day',
           '추천은 2021~2026학번 컴퓨터공학과 주간 일반 신입학·단일전공을 지원합니다.')
    data = json.loads((DATA / f'{year}.json').read_text(encoding='utf-8'))
    ensure(all(student.get(key) == value for key, value in data['applies_to'].items()),
           '학생 정보와 일치하는 졸업요건 자료가 없습니다.')
    grade_data = json.loads((DATA.parent / 'course_grades.json').read_text(encoding='utf-8'))
    alternatives = json.loads((DATA.parent / 'course_alternatives.json').read_text(encoding='utf-8'))
    target, matches, offerings = recommendation_data(database, document)
    ensure(target is not None, '추천 학기의 개설강좌 자료가 없습니다.')
    target_year = target['term'][:4]
    target_term = student['target_term'] or f"{target_year}-{target['term'][-1]}"
    ensure(int(target_year) >= year, '입학연도 이후의 개설강좌 자료가 없습니다.')
    if student['target_term'] is None:
        student = dict(student, target_term=target_term)
        document = dict(document, student=student)
    grade_table = grade_data.get(target_year, {}).get('codes_by_grade', {})
    grades = {code: int(level) for level, group in grade_table.items() for code in group}
    # Verified common placement of the five department requirements.
    grades.update({'109003': 1, '109416': 1, '109004': 1, '109417': 1,
                   '109255': 2, '109113': 4, '109114': 4})
    elective_groups = alternatives['major_elective_groups']
    rules, results, completed, in_progress, general_codes, credit_reviews, sports_full = evaluate(
        data, document, matches, elective_groups)
    blocked = set(completed) | in_progress
    alternative_by_code = {}
    selectable_groups = [dict(id=group['course_codes'][0], title=group['title'], members=codes(group))
                         for group in elective_groups if target_year in group['curriculum_groups']]
    selectable_groups.extend(dict(id=id, title=rules[id]['title'], members=codes(rules[id]))
                             for id in ('programming_1', 'programming_2'))
    for group in selectable_groups:
        members = group['members']
        if blocked & members:
            blocked.update(members)
        for code in members:
            alternative_by_code[code] = dict(id=group['id'], title=group['title'])
    statuses = {result['id']: result['status'] for result in results}
    deficits = {rules[r['id']]['bucket']: max(0, r['target'] - r['current'])
                for r in results if rules[r['id']]['type'] == 'min_credits'}
    offered_codes = {offering['course_code'] for offering in offerings}
    for result in results:
        id = result['id']
        if id in MAJOR_REQUIRED:
            levels = {grades[code] for code in codes(rules[id]) if code in grades}
            level = next(iter(levels)) if len(levels) == 1 else None
            result['recommended_grade'] = level
            result['recommendation_group'] = ('current_major_required' if level is not None and level <= grade
                                              else 'future_major_required')
        elif codes(rules[id]):
            result['recommendation_group'] = 'required_general'
        if 'recommendation_group' in result:
            rule_codes = codes(rules[id])
            result['offered'] = bool(rule_codes & offered_codes)
            result['in_progress'] = bool(rule_codes & in_progress)
    groups_by_rule = {result['id']: result['recommendation_group'] for result in results
                      if 'recommendation_group' in result}
    by_code = defaultdict(list)
    excluded = exclusion_map(data)
    review_options = defaultdict(list)
    for review in data['pending_reviews']:
        if review['affects'] == 'requirement_satisfaction':
            for code in codes(review):
                review_options[code].append(review['requirement_id'])
    for offering in offerings:
        code = offering['course_code']
        if code in blocked or 'total' in excluded[code] or (sports_full and is_sport(offering)):
            continue
        state = eligibility(offering)
        if state != 'excluded':
            by_code[code].append(dict(offering, eligibility=state))
    tags, by_label, by_course = load_tags()
    interests = {normalized_name(tag) for tag in student.get('interests', []) if normalized_name(tag)}
    selected = set().union(*(by_label.get(tag, set()) for tag in interests))
    items = []
    for code, sections in by_code.items():
        sections.sort(key=lambda row: (row['eligibility'] == 'needs_review', row['section_code']))
        lead = sections[0]
        kind = bucket(lead, general_codes)
        needed = [id for id, rule in rules.items() if code in codes(rule) and statuses[id] != 'met']
        level = grades.get(code)
        if needed:
            group = groups_by_rule[needed[0]]
        else:
            if kind is None or any(code in codes(rules[id]) for id in MAJOR_REQUIRED):
                continue
            if not (deficits.get(kind, 0) or deficits.get('total', 0)):
                continue
            # Extra general courses in an already fulfilled area require credit-recognition evidence.
            if any(code in codes(rules[id]) and statuses[id] == 'met' for id in rules
                   if id in ('english', 'ethics', 'core_1', 'core_2', 'core_3')):
                allowed = any(r['type'] == 'count_each_distinct_course' and (
                    code in codes(r) or any(code in codes(rules[id]) for id in r.get('requirement_ids', ())))
                    for r in data['credit_rules'])
                if not allowed:
                    continue
            group = f'{kind}_credits'
        reasons = [rules[id]['title'] + (' · 이수내역 확인 필요' if statuses[id] == 'needs_review' else '')
                   for id in needed]
        reasons += [rules[id]['title'] + ' · 인정 여부 확인 필요'
                    for id in review_options[code] if statuses[id] != 'met']
        if group == 'future_major_required':
            reasons.append(f'{level}학년 편성 전공필수' if level else '편성 학년 확인 필요')
        if not reasons:
            reasons = ['전공학점 후보' if kind == 'major' else '교양학점 후보']
            estimate = ' · 추정' if statuses.get(kind) == 'needs_review' else ''
            if deficits.get(kind, 0):
                reasons.append(f'현재 입력 기준 남은 {deficits[kind]:g}학점{estimate}')
            elif deficits.get('total', 0):
                estimate = ' · 추정' if statuses['total'] == 'needs_review' else ''
                reasons.append(f'현재 입력 기준 총 {deficits["total"]:g}학점 남음{estimate}')
        is_major_elective = not needed and kind == 'major'
        lower_grade = is_major_elective and level is not None and level < grade
        if lower_grade:
            reasons.append('현재 학년보다 낮은 학년의 전공선택')
        course_tags = classify(lead, tags, by_course)
        matched_tags = selected & course_tags
        interest = len(matched_tags)
        if matched_tags:
            labels = [tag['label'] for tag in tags if tag['id'] in matched_tags]
            reasons.append('관심 주제 일치 · ' + ', '.join(labels))
        uncertain = all(row['eligibility'] == 'needs_review' for row in sections)
        grade_rank = 0
        if is_major_elective:
            grade_rank = 3 if lower_grade else 2 if level is None else int(level > grade)
        candidate = dict(course_code=code, course_name=lead['course_name'], group=group, lower_grade=lower_grade,
                         recommended_grade=level, requirement_ids=needed, reasons=reasons,
                         interest_tags=[tag['id'] for tag in tags if tag['id'] in course_tags]
                                       or ([OTHER] if OTHER in course_tags else []),
                         eligibility='needs_review' if uncertain else 'no_restriction_recorded',
                         sections=[{key: row[key] for key in ('offering_id','section_code','professor','credits','eligibility')}
                                   for row in sections])
        if code in alternative_by_code:
            candidate['alternative_group'] = alternative_by_code[code]
        items.append(((RECOMMENDATION_GROUPS.index(group), grade_rank, uncertain, -interest, code), candidate))
    items.sort(key=lambda item: item[0])
    return dict(kind='course_recommendations', schema_version=2, target_term=student['target_term'],
                snapshot=target, requirements=results, credit_reviews=credit_reviews,
                partial=bool(credit_reviews) or any(row['status'] == 'needs_review' for row in results),
                candidates=[item for _, item in items])
