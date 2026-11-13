"""Generate weekly schedules from the active official offering snapshot."""

from collections import defaultdict
from contextlib import closing
from dataclasses import dataclass
from decimal import Decimal
import re
import sqlite3
from time import monotonic

from crawl_module.classroom_dist.classroom_dist import DEFAULT_DB as DISTANCE_DB, building_names, lookup_key

from .domain import ensure
from .recommendations import recommend

DAYS = "월화수목금토일"
BLOCK = re.compile(r"([월화수목금토일])\(([^)]+)\)")
RANGE = re.compile(r"(\d{1,2})([AB])?(?:\s*[~～-]\s*(\d{1,2})([AB])?)?")
MAX_CANDIDATES = 15
SORTS = {"recommended", "fewest_days", "least_gap"}


def parse_meetings(schedule):
    blocks = BLOCK.findall(schedule or "")
    if not blocks or re.sub(r"[,\s]", "", BLOCK.sub("", schedule)):
        return ()
    occupied = defaultdict(set)
    for day, ranges in blocks:
        for item in ranges.split(","):
            match = RANGE.fullmatch(item.strip())
            if not match:
                return ()
            first, half, last, final_half = match.groups()
            start = 2 * int(first) + int(half == "B")
            end = 2 * int(last or first) + (1 if (final_half if last else half) == "A" else 2)
            if start >= end:
                return ()
            occupied[day].update(range(start, end))
    meetings = []
    for day in DAYS:
        for period in sorted(occupied[day]):
            if meetings and meetings[-1]["day"] == day and meetings[-1]["end"] == period:
                meetings[-1]["end"] += 1
            else:
                meetings.append(dict(day=day, start=period, end=period + 1))
    return meetings


@dataclass(frozen=True)
class Option:
    code: str
    group: str
    section: dict
    units: int
    mask: int
    required_rules: frozenset
    general_rules: frozenset
    preferred: bool
    bucket: str
    uncertain: bool
    interest: int
    building: str | None
    core_area: str | None


def building_data():
    try:
        with closing(sqlite3.connect(DISTANCE_DB.resolve().as_uri() + "?mode=ro", uri=True)) as database:
            aliases = dict(database.execute("SELECT lookup_key, building_id FROM building_aliases"))
            distances = {(a, b): meters for a, b, meters in database.execute(
                "SELECT from_building_id, to_building_id, straight_line_m FROM building_distances"
            )}
    except sqlite3.Error:
        return {}, {}
    return aliases, distances


def room_building(room, aliases):
    buildings = {aliases.get(lookup_key(name)) for name in building_names(room or "")}
    return next(iter(buildings)) if len(buildings) == 1 else None


def timetable_spacing(chosen, distances):
    by_day = defaultdict(list)
    for option in chosen:
        for meeting in option.section["meetings"]:
            by_day[meeting["day"]].append((meeting["start"], meeting["end"], option.building))
    adjacent = missing = 0
    distance = 0
    for meetings in by_day.values():
        meetings.sort(key=lambda meeting: meeting[0])
        for first, second in zip(meetings, meetings[1:]):
            if first[1] != second[0]:
                continue
            adjacent += 1
            a, b = first[2], second[2]
            meters = 0 if a is not None and a == b else distances.get((a, b))
            if meters is None:
                missing += 1
            else:
                distance += meters
    return adjacent, missing, distance


def request_codes(value, field):
    entries = value.get(field, [])
    ensure(isinstance(entries, list) and len(entries) <= 30
           and all(isinstance(code, str) and re.fullmatch(r"[0-9]{6}", code) for code in entries),
           "과목 목록을 확인해주세요.")
    return set(entries)


def generate(database, document, request, *, max_nodes=60000, seconds=2, ratings_db=None):
    student = document["student"]
    lower = request.get("min_credits")
    upper = request.get("max_credits")
    if lower is None:
        lower = int(student["min_credits"]) if student.get("min_credits") is not None else 15
    if upper is None:
        upper = int(student["max_credits"]) if student.get("max_credits") is not None else 18
    ensure(type(lower) is int and type(upper) is int and 1 <= lower <= upper <= 30,
           "학점 범위는 1~30 사이의 정수로 입력해주세요.")
    required = request_codes(request, "required")
    preferred = request_codes(request, "preferred") - required
    locked = request.get("locked_offering_ids", [])
    ensure(isinstance(locked, list) and len(locked) <= 30
           and all(isinstance(item, str) and 0 < len(item) <= 100 for item in locked),
           "고정 분반 목록을 확인해주세요.")
    locked = set(locked)
    blocked = request.get("blocked_days", [])
    ensure(isinstance(blocked, list) and all(isinstance(day, str) and day in tuple(DAYS) for day in blocked),
           "제외할 요일을 확인해주세요.")
    sort = request.get("sort", "recommended")
    ensure(isinstance(sort, str) and sort in SORTS, "정렬 기준을 확인해주세요.")

    document = dict(document, student=dict(student, target_term=None, recognition_notes=""))
    result, pool, alternatives, deficits = recommend(database, document, schedule_context=True, ratings_db=ratings_db)
    candidates = {row["course_code"]: row for row in result["candidates"]}
    rules = {rule["id"]: rule for rule in result["requirements"]}
    buckets = ("major", "general")
    earned = {key: round((rules.get(key, {}).get("current") or 0) * 100) for key in buckets}
    limits = {key: round(deficits.get(key, 0) * 100) for key in buckets}
    group_limits = {
        rule_id: round(max(0, rule["target"] - (rule["current"] or 0)) * 100)
        for rule_id, rule in rules.items() if rule["type"] == "min_group_credits"
    }
    aliases, distances = building_data()
    options = defaultdict(list)
    unknown_times = set()
    for section in pool:
        code = section["course_code"]
        candidate = candidates.get(code, {})
        rule_ids = candidate.get("requirement_ids", ())
        explicitly_selected = code in required or code in preferred or section["offering_id"] in locked
        level = section.get("recommended_grade")
        needs_grade_confirmation = section["credit_bucket"] == "major" and (
            level is None or level > student["grade"]
        )
        if not explicitly_selected and (needs_grade_confirmation or section.get("core_area_occupied")
                                        or (section["credit_bucket"] is None and not rule_ids)):
            continue
        meetings = parse_meetings(section["schedule"])
        credits = section["credits"]
        if not meetings or credits is None or credits <= 0:
            unknown_times.add(code)
            continue
        if any(m["day"] in blocked for m in meetings):
            continue
        mask = 0
        for meeting in meetings:
            offset = DAYS.index(meeting["day"]) * 204
            mask |= ((1 << (meeting["end"] - meeting["start"])) - 1) << (offset + meeting["start"])
        options[code].append(Option(
            code, alternatives.get(code, {}).get("id", code),
            dict(offering_id=section["offering_id"], course_code=code, course_name=section["course_name"],
                 section_code=section["section_code"], professor=section["professor"], credits=credits,
                 schedule=section["schedule"], room=section["room"], meetings=meetings,
                 category=section["category"], eligibility=section["eligibility"],
                 recommended_grade=level, core_area=section.get("core_area"),
                 everytime_rating=section["everytime_rating"]),
            int(Decimal(str(credits)) * 100), mask,
            frozenset(r for r in rule_ids if rules[r].get("recommendation_group") == "current_major_required"),
            frozenset(r for r in rule_ids if rules[r].get("recommendation_group") == "required_general"),
            code in preferred, section["credit_bucket"], section["eligibility"] == "needs_review",
            candidate.get("interest_score", 0), room_building(section["room"], aliases),
            section.get("core_area"),
        ))

    response = dict(target_term=result["target_term"], snapshot=result["snapshot"], candidates=[], issues=[])
    available_ids = {option.section["offering_id"] for items in options.values() for option in items}
    if locked - available_ids:
        response["issues"] = ["고정한 분반의 시간, 학점, 개설 여부 또는 수강 조건을 확인해주세요."]
        return dict(response, outcome="undetermined", search_status="complete")
    for code, items in options.items():
        fixed = [option for option in items if option.section["offering_id"] in locked]
        if len(fixed) > 1:
            response["issues"] = [f"과목 {code}에 고정한 분반이 두 개 이상입니다."]
            return dict(response, outcome="no_feasible_plan", search_status="complete")
        if fixed:
            required.add(code)
            options[code] = fixed
    missing = required - options.keys()
    if missing:
        response["issues"] = [f"필수 과목 {code}의 편성 가능한 분반이 없습니다." for code in sorted(missing)]
        return dict(response, outcome="undetermined" if missing & unknown_times else "no_feasible_plan",
                    search_status="complete")
    groups = [options[code][0].group for code in required]
    if len(set(groups)) != len(groups):
        response["issues"] = ["같은 택1 그룹의 과목을 둘 이상 필수로 지정했습니다."]
        return dict(response, outcome="no_feasible_plan", search_status="complete")
    required_areas = [options[code][0].core_area for code in required if options[code][0].core_area]
    if len(set(required_areas)) != len(required_areas):
        response["issues"] = ["같은 핵심교양 영역에서 둘 이상 필수 과목으로 지정했습니다."]
        return dict(response, outcome="no_feasible_plan", search_status="complete")
    # Explore both elective buckets early, even when one has many more offerings.
    elective_codes = {
        bucket: sorted(
            (code for code, items in options.items() if items[0].bucket == bucket),
            key=lambda code: (-options[code][0].interest, code),
        )
        for bucket in buckets
    }
    elective_positions = {code: position for codes in elective_codes.values()
                          for position, code in enumerate(codes)}
    keys = sorted(options, key=lambda code: (
        code not in required, len(options[code]) if code in required else 0,
        not options[code][0].required_rules, not options[code][0].general_rules,
        code not in preferred, elective_positions.get(code, len(options)),
        earned.get(options[code][0].bucket, 0), code,
    ))
    for items in options.values():
        items.sort(key=lambda option: (option.uncertain, option.section["section_code"]))
    remaining = [0] * (len(keys) + 1)
    for index in range(len(keys) - 1, -1, -1):
        remaining[index] = remaining[index + 1] + max(item.units for item in options[keys[index]])

    plans = {}
    start = monotonic()
    day_mask = (1 << 204) - 1
    nodes = 0
    truncated = False
    chosen = []
    used = set()
    used_areas = set()
    low, high = lower * 100, upper * 100
    max_required = len(required)

    def record(mask, units):
        days = gaps = 0
        for index in range(len(DAYS)):
            bits = (mask >> (index * 204)) & day_mask
            if bits:
                days += 1
                gaps += bits.bit_length() - ((bits & -bits).bit_length() - 1) - bits.bit_count()
        major = set().union(*(item.required_rules for item in chosen))
        general = set().union(*(item.general_rules for item in chosen))
        group_progress = {
            rule_id: min(limit, sum(item.units for item in chosen if rule_id in item.general_rules))
            for rule_id, limit in group_limits.items()
        }
        completed_groups = sum(0 < limit == group_progress[rule_id]
                               for rule_id, limit in group_limits.items())
        discrete_general = general - group_limits.keys()
        counts = defaultdict(int)
        for item in chosen:
            counts[item.bucket] += item.units
        applied = {key: min(counts[key], limits[key]) for key in buckets}
        balance = abs(earned["major"] + applied["major"] - earned["general"] - applied["general"])
        adjacent, missing_distances, distance = timetable_spacing(chosen, distances)
        preferred_count = sum(item.preferred for item in chosen)
        uncertain = sum(item.uncertain for item in chosen)
        key = tuple(sorted(item.code for item in chosen))
        order = (-len(major), -(len(discrete_general) + completed_groups),
                 -sum(group_progress.values()), -preferred_count,
                 -sum(applied.values()), balance, high - units, adjacent)
        if sort != "recommended":
            order += (days,) if sort == "fewest_days" else (gaps,)
        order += (uncertain, days, gaps, -sum(item.interest for item in chosen),
                  missing_distances, distance,
                  tuple(sorted(item.section["offering_id"] for item in chosen)))
        if key in plans and plans[key][0] <= order:
            return
        if key not in plans and len(plans) == MAX_CANDIDATES:
            worst = max(plans, key=lambda entry: plans[entry][0])
            if plans[worst][0] <= order:
                return
            del plans[worst]
        plans[key] = (order, dict(credits=units / 100, days=days, gap_periods=gaps / 2,
                                  major_credits=counts["major"] / 100, general_credits=counts["general"] / 100,
                                  adjacent_sessions=adjacent,
                                  provisional=bool(uncertain), requirements=sorted(major | general),
                                  offerings=[item.section for item in chosen]))

    def search(index, mask, units):
        nonlocal nodes, truncated
        nodes += 1
        if nodes > max_nodes or monotonic() - start > seconds:
            truncated = True
            return
        if units + remaining[index] < low:
            return
        if index >= max_required and low <= units <= high:
            record(mask, units)
        for position in range(index, len(keys)):
            if truncated or units + remaining[position] < low:
                return
            for item in options[keys[position]]:
                if (units + item.units > high or mask & item.mask or item.group in used
                        or item.core_area in used_areas):
                    continue
                chosen.append(item)
                used.add(item.group)
                if item.core_area:
                    used_areas.add(item.core_area)
                search(position + 1, mask | item.mask, units + item.units)
                if item.core_area:
                    used_areas.remove(item.core_area)
                used.remove(item.group)
                chosen.pop()
                if truncated:
                    return
            if position < max_required:
                break

    search(0, 0, 0)
    response["candidates"] = [plan for _, plan in sorted(plans.values(), key=lambda pair: pair[0])]
    if truncated:
        response["issues"].append("탐색 한도 안에서 찾은 결과입니다.")
    if not plans and unknown_times:
        response["issues"].append(f"시간 또는 학점을 확인할 수 없는 과목 {len(unknown_times)}개를 제외했습니다.")
    if not plans and not response["issues"]:
        response["issues"].append("필수 과목의 시간 충돌이나 학점·요일 조건을 확인해주세요.")
    outcome = ("feasible" if any(not row["provisional"] for row in response["candidates"]) else
               "provisional" if plans else "undetermined" if truncated or unknown_times else "no_feasible_plan")
    return dict(response, outcome=outcome, search_status="truncated" if truncated else "complete")
