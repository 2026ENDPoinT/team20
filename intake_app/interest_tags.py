"""Classify elective courses using curated mappings and bilingual title rules."""

import json
from pathlib import Path
import re

from .offerings import normalized_name

DATA = Path(__file__).resolve().parents[1] / 'data' / 'course_interest_tags.json'


def load_tags():
    tags = json.loads(DATA.read_text(encoding='utf-8'))
    by_label = {}
    by_course = {}
    for tag in tags:
        for label in (tag['id'], tag['label'], *tag['aliases']):
            by_label[normalized_name(label)] = tag['id']
        for code in tag['course_codes']:
            by_course.setdefault(code, set()).add(tag['id'])
    return tags, by_label, by_course


def classify(offering, tags, by_course):
    if offering['category'] not in ('전선', '교선'):
        return set()
    known = by_course.get(offering['course_code'])
    if known is not None:
        return known
    names = (offering['course_name'], offering.get('english_name') or '')
    compact = [normalized_name(name) for name in names]
    words = [' '.join(re.findall(r'[a-z0-9]+', name.lower())) for name in names]

    def matches(keyword):
        if keyword.isascii():
            return any(f' {keyword} ' in f' {name} ' for name in words)
        return any(normalized_name(keyword) in name for name in compact)

    return {tag['id'] for tag in tags if any(matches(word) for word in tag['keywords'])}
