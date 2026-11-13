"""Classify elective courses using curated mappings and bilingual title rules."""

import json
from pathlib import Path
import re

from .offerings import normalized_name

OTHER = 'other'
GROUPS = {'전선': '전공', '교선': '교양'}

DATA = Path(__file__).resolve().parents[1] / 'data' / 'course_interest_tags.json'


def load_tags():
    tags = json.loads(DATA.read_text(encoding='utf-8'))
    by_label = {}
    by_course = {}
    for tag in tags:
        for label in (tag['id'], tag['label'], *tag['aliases']):
            by_label.setdefault(normalized_name(label), set()).add(tag['id'])
        for code, names in tag['courses'].items():
            for name in names:
                key = (tag['group'], code, normalized_name(name))
                by_course.setdefault(key, set()).add(tag['id'])
    # An explicit selection of a fixed label or ID refers only to that tag.
    for tag in tags:
        for label in (tag['id'], tag['label']):
            by_label[normalized_name(label)] = {tag['id']}
    return tags, by_label, by_course


def classify(offering, tags, by_course):
    group = GROUPS.get(offering['category'])
    if group is None:
        return set()
    known = by_course.get((group, offering['course_code'], normalized_name(offering['course_name'])))
    if known is not None:
        return known
    names = (offering['course_name'], offering.get('english_name') or '')
    compact = [normalized_name(name) for name in names]
    words = [' '.join(re.findall(r'[a-z0-9]+', name.lower())) for name in names]

    def matches(keyword):
        if keyword.isascii():
            return any(f' {keyword} ' in f' {name} ' for name in words)
        return any(normalized_name(keyword) in name for name in compact)

    matched = {tag['id'] for tag in tags if tag['group'] == group
               and any(matches(word) for word in tag['keywords'])}
    return matched or {OTHER}
