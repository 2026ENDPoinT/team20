# CPG JSON 입출력 규약

명세 개정 2 · [상위 명세](README.md) · [HTTP 연결](02-http-api.md) · [저장 매핑](03-data-storage.md)

## 공통 타입과 버전

- UTF-8 JSON, `snake_case`. 파일과 모듈 메시지의 최상위에 `kind`와 양의 정수 `schema_version`을 둔다. 학생 문서는 기존 앱의 v1에서 이행하므로 `student_input` v2, 이 문서의 나머지 신규 메시지는 각각 v1이다. 기존 `everytime_course_import` v1은 어댑터 입력으로 유지한다.
- 아래 표에 열거한 필드는 기본 필수다. `T?`는 키가 있으며 값이 `null`일 수 있음을 뜻한다. `선택`은 키 생략을 허용한다. 배열은 빈 경우 `[]`를 사용한다. 신규 요청에서 알 수 없는 필드는 오류로 돌려준다. 응답 소비자는 같은 버전에서 추가된 필드를 무시할 수 있어야 한다. 필드 제거·의미 변경·새 폐쇄 열거값은 해당 메시지 버전을 올린다.
- `Term`은 `YYYY-1`, `YYYY-2`, `YYYY-summer`, `YYYY-winter` 중 하나다. 정렬은 숫자 연도와 `1 → summer → 2 → winter` 순서로 한다. 추천 학기, 실제 수강 학기, 교육과정 연도, 입학연도는 각자 보존한다. 운영 날짜·시각은 ISO 8601 UTC의 `Z` 표기, 시간표는 `Asia/Seoul` 기준 `HH:MM` 또는 정수 분 `0..1440`으로 표현한다.
- 학점은 유한한 음이 아닌 JSON 숫자로 표현한다. 0.01학점 단위까지 받으며 합계와 비교는 100배 정수 단위로 한다. 희망 최소·최대는 각 0~30 입력 범위이며 공식 수강 상한은 별도다. 총학점과 전공·교양 학점은 포함 관계가 있으므로 단순 합산하지 않는다.
- ID와 원본 코드 모두 문자열이다. ID는 1~100자의 불투명한 값이며 학생 v1의 기존 ID를 유지할 수 있다. `course_id`는 교과목, `offering_id`는 학기별 분반, `course_attempt_id`는 학생의 한 번의 수강, `candidate_id`는 시간표 조합을 가리킨다. `lecture_code`는 에타가 제공한 전체 코드이며 앞자리 0을 보존한다.
- `Issue`는 `{code, message, path, related_ids}`다. `code`는 UI·테스트용 안정 문자열, `message`는 표시용, `path`는 JSON Pointer 또는 `null`, `related_ids`는 관련 ID 배열이다. 정상 응답에도 `issues` 배열로 누락·부분 결과를 전달한다. 오류 HTTP 본문은 별도 규약을 쓴다.
- `SourceRef`는 `{dataset_id, source_id, locator}`다. `locator`는 PDF 파일 쪽수·인쇄면·표 번호·공지 단락 등 근거 위치를 가리킨다. 공식 증빙은 데이터셋 ID를, 승인된 개인 예외의 비공개 증빙은 `dataset_id=null`과 프로필 내 출처 ID를 쓴다. `Evidence`는 `{source_refs, rule_ids, course_attempt_ids}`다. 증빙과 상태는 함께 전달한다.

## 모듈별 경계

| 모듈 | JSON 입력 | JSON 출력 |
| --- | --- | --- |
| 에타 수집·변환 | `everytime_import_request`, 기존 수집기 출력 `everytime_course_import` | `import_preview` |
| 학생 입력·가져오기 적용 | `student_input` 또는 `import_apply_request`, 현재 리비전 | `student_input_state` |
| 공식 규칙 편집·검수 | 공식 교육과정·공지와 출처 | `rules_bundle`, `dataset_manifest` |
| 학교 강좌 변환·검수 | 공개 시간표 응답, 교시·강의실 기준 데이터 | `offerings_bundle`, `period_map`, `dataset_manifest` |
| 건물 거리 변환 | 건물 좌표·별칭·거리 원천 | `campus_distances` |
| 공식 데이터 발행 | `dataset_manifest`와 참조 JSON 파일 | `dataset_validation_result` |
| 과거 이수내역 연결 | `course_matching_request` | `course_matching_result` |
| 교과 이수요건 계산 | `requirement_evaluation_request` | `requirement_evaluation_result` |
| 과목 추천 | `recommendation_request`, 내부 계산 결과와 대상 강좌 | `recommendation_result` |
| 과목 저장·조회 | `course_id` | `saved_course`, `saved_course_list` |
| 시간표 후보 생성 | `schedule_request`, 학생 입력과 대상 학기의 공식 강좌 | `schedule_result` |
| 신청 실패 재조합 | `recovery_request`, 기준 후보와 실행 맥락 | `schedule_result` |
| 시간표 저장·조회 | `plan_save_request`, 후보 참조 | `saved_plan` |
| 여러 학기 계획 확장 | `multi_term_plan_request` | `multi_term_plan_result` |

HTTP는 브라우저가 필요한 경계에만 둔다. 내부 요청의 데이터셋 ID로 DB에서 고정된 자료를 읽는다. 모듈 함수는 입력 메시지 밖의 전역 활성 버전을 다시 선택하지 않는다.

## 학생 입력

아래는 저장·내보내기에 공통으로 사용하는 `student_input` v2 예시다.

~~~json
{
  "kind": "student_input",
  "schema_version": 2,
  "student": {
    "department_id": "DEPT_CS",
    "admission_year": 2024,
    "grade": 2,
    "admission_type": "freshman",
    "program_type": "standard_single_major_day",
    "target_term": "2026-2",
    "min_credits": 12,
    "max_credits": 18,
    "interests": ["인공지능", "예술·문화"],
    "regular_terms_completed": null,
    "transfer_recognized_credits": null,
    "recognition_notes": ""
  },
  "history_complete": false,
  "course_attempts": [
    {
      "id": "attempt-1",
      "term": "2024-1",
      "lecture_code": "001234-01001",
      "course_name": "예시 과목",
      "professor": "예시 교수",
      "completion_status": "completed",
      "user_confirmed": true,
      "source": "everytime",
      "source_ref": {
        "source_table_key": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "source_key": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "identity_basis": "source_subject"
      },
      "review_notes": ""
    }
  ]
}
~~~

- `department_id`는 `DEPT_CS`, `admission_type`은 `freshman | transfer`, `program_type`은 `standard_single_major_day | other | null`이다. 초안에서는 `admission_year`(1990~2099 정수), `grade`(1~4, 4는 4학년 이상), `target_term`을 `null`로 둘 수 있다. 검토 완료 및 추천 계산에는 세 값과 `program_type` 확인이 필요하다. `target_term`의 연도는 입학연도 이상이어야 한다. 입력 가능 범위와 추천 요건 지원 범위는 다르다.
- `regular_terms_completed`는 학생이 확인한 음이 아닌 정수 또는 `null`이다. 계절학기와 에타 시간표 수를 합산하지 않는다. `history_complete`는 학생의 입력 범위 확인이며 학교 증빙이나 공식 매칭 완료 상태와 독립적이다. 관심 태그는 공백 제거·중복 제외 후 최대 20개다. 편입 인정학점과 인정 메모만으로 공식 학점·면제를 생성하지 않는다.
- `course_attempts` 최대 300개. `id`는 생성 이후 유지한다. `term`은 미정이면 `null`, `course_name`은 미확인이면 `""`, `lecture_code`·`professor`는 미상인 경우 `null`이다. 검토된 개별 과목에는 학기와 이름이 필요하다. `completion_status`는 `unconfirmed | completed | in_progress | not_completed`다. `user_confirmed`는 `unconfirmed`일 때만 `false`다. 취소·미이수는 `not_completed`로 표시한다. 과목의 학기·코드·명칭·교수처럼 식별에 영향을 주는 값을 바꾸면 해당 행은 다시 미확인 상태가 된다.
- `source`는 `manual | everytime | ai | sample`이다. 신규 입력은 처음 두 값만 사용하며 `ai`와 `sample`은 기존 자료 이행용이다. `sample`은 인정학점과 추천 개인화에서 제외한다. `source_ref`는 에타 행만 객체이고 나머지는 `null`이다. `source_table_key`는 `["everytime", table_id]`, `source_key`는 `["everytime", table_id, identity_basis, subject_id_or_position]`의 SHA-256이다. UTF-8 JSON 배열을 공백·줄바꿈 없이 직렬화하고 해시를 소문자 `sha256:…`로 기록한다. 원본 ID는 문자열, ID가 없을 때 순번은 0부터 시작하는 정수다. `identity_basis=source_subject | source_position`이며 순번 기반 행을 순번만으로 병합하지 않는다.
- 공식 과목 ID·인정학점·공식 매칭 상태는 각각 매칭·계산 출력의 소유 필드다. 내보내기 파일은 위 문서를 그대로 사용한다. 이수 완료 화면은 `completed`이며 `user_confirmed=true`인 행을 필요할 때 계산한다.
- `student_input_state`는 `{kind, schema_version, revision, review_state, updated_at, document, issues}`다. `document`는 `student_input`, `revision`은 서버 정수, `review_state`는 `draft | reviewed`, 미저장 시 `updated_at=null`이다. `reviewed`는 프로필과 검토 과정 확인을 뜻한다. 일부 미확인 행은 경고와 함께 유지한다.

## 에타 수집과 다시 가져오기

| 메시지 | 필드 |
| --- | --- |
| `everytime_import_request` | `{shared_url, base_revision}`. 공개 공유 URL과 미리보기 기준 학생 리비전 |
| `import_preview` | `{import_id, base_revision, imported_at, import_status, summary, course_attempts, changes, issues}`. `import_status=complete\|partial`. 시각은 UTC. `course_attempts`는 v2 행 배열이며 전부 미확인 |
| `import_apply_request` | `{base_revision, accepted_attempt_ids, accepted_update_ids}`. 두 배열은 미리보기의 `add`, `update` 행 ID만 허용 |

`summary`는 `{discovered_tables, requested_tables, imported_tables, imported_terms, course_attempts, failed_or_skipped_tables}`이고 각 값은 0 이상의 정수다. `changes` 행은 `{incoming_attempt_id, existing_attempt_id, action, changed_fields}`다. `existing_attempt_id`는 추가일 때 `null`, `action=add | unchanged | update | review`, `changed_fields`는 필드 이름 배열이다. 미리보기는 학생 문서를 변경하지 않는다.

원본 과목 ID가 있는 행은 학생 내 `source_key`로 재수집을 비교한다. 마지막으로 수락한 원본과 변경 없는 행은 기존 수동 수정과 이수 확인을 유지한다. 원본에서 달라진 필드는 기존 값·새 값을 표시하고 사용자가 해당 업데이트를 수락할 때 그 필드만 적용한다. 적용한 식별 필드 변경은 이수 확인을 해제한다. 누락·실패·비공개 전환으로 기존 과목을 삭제하지 않는다. 원본 ID가 없는 행은 처음 가져오는 시간표면 `add`다. 이전에 가져온 시간표는 같은 `source_key`와 원본 내용이 일치할 때만 `unchanged`, 그 밖에는 `review`로 분류한다. `review`는 자동 적용에서 제외하며 사용자가 직접 기존 행을 편집하거나 새 항목으로 입력한다. 동명 과목을 자동 병합하지 않는다.

`import_status=complete`는 발견한 공개 시간표를 모두 조회했다는 뜻이다. 조회 성공 시간표가 하나 이상이고 일부 실패가 있으면 `partial`이며, 성공분만 미리보기로 보낸다. 전체 실패는 미리보기 없이 작업 실패다. 수집 결과는 `history_complete`를 변경하지 않는다. 에타 원본 공유 URL·원문 XML·개인 식별자·원본 테이블 ID는 저장된 학생 문서에 포함하지 않는다.

## 공식 데이터 파일

### 발행 단위와 공통 증빙

`dataset_manifest`는 `{dataset_id, dataset_type, dataset_version, created_at, coverage, dependencies, files}`다. `dataset_type=rules | offerings | periods | campus_distances`, `dataset_version`은 변경할 때마다 새로 부여하는 불변 문자열, `dependencies`는 `{dataset_type, dataset_id}` 배열, `files`는 `{path, sha256}` 배열이다. `coverage`는 `{admission_years, terms, department_ids, includes_general_education, status}`다. 배열 세 개는 적용하는 값만 넣고, `status=verified | partial`이다. 교양 포함 여부는 별도로 유지한다. 전체 수집 목표는 2021~2026이고 발행 범위는 검수한 학기와 학과만 표시한다. `dataset_validation_result`는 `{dataset_id, status, counts, issues}`이며 `status=accepted | rejected`, `counts`는 엔터티별 행 수 맵이다.

### 교육과정과 이수요건

`rules_bundle`의 `dataset_id` 다음에 아래 배열을 포함한다. 학번별 룰 묶음은 학교·교양·학과 규칙을 조합한다.

| 배열 | 행의 필드와 제약 |
| --- | --- |
| `sources` | `{source_id, title, url, published_at, checked_at, archive_sha256}`. 게시·해시 미상은 `null` |
| `courses` | `{course_id, course_code, name, source_refs}`. 코드 변경·재사용 시 공식 근거를 보고 ID를 배정 |
| `curriculum_courses` | `{curriculum_id, course_id, curriculum_year, department_id, credits, credit_category, general_education_area, source_refs}`. `credit_category=major_required\|major_elective\|basic_general\|core_general\|foundation_general\|general_elective\|other`, 교양 영역과 학점은 미확인 시 `null` |
| `course_groups` | `{group_id, name, members, source_refs}`. `members`는 `{course_id, admission_years}` 배열. 빈 학번 배열은 그룹이 참조된 규칙의 적용 범위와 동일 |
| `requirement_sets` | `{set_id, admission_year, department_id, admission_type, program_type, rule_ids, recognition_rule_ids, source_refs}`. 적용 키로 한 묶음이 선택돼야 함 |
| `requirement_rules` | `{rule_id, scope, kind, parameters, enforcement, verification_status, source_refs}`. `scope=university_common\|university_general_education\|university_track\|department`, `enforcement=required\|recommended` |
| `recognition_rules` | `{rule_id, kind, parameters, verification_status, source_refs}`. 적용 범위는 요건 묶음의 참조로 부여하며 명시적인 수강학기 적용 범위를 추가할 수 있음 |
| `eligibility_rules` | `{rule_id, course_id, offering_id, valid_terms, conditions, verification_status, source_refs}`. `course_id`와 `offering_id` 중 하나만 지정. `conditions`는 동시에 적용 |
| `credit_load_policies` | `{policy_id, department_id, admission_years, admission_types, program_types, grades, term_types, max_credits, verification_status, source_refs}`. `term_types`는 `regular\|summer\|winter` 배열. 적용 학과가 공통이면 `department_id=null`, 범위가 전체인 배열은 `[]` |
| `course_tags` | `{course_id, tag, basis, source_refs}`. `basis=official_description\|curated`. 추천용 편집 태그는 선정 근거를 기록하며 이수구분·수강 자격에 사용하지 않음 |

`verification_status`는 `verified | pending | conflicting`이다. 검증되지 않은 필수 규칙은 충족 결과의 `needs_review` 근거가 된다. 권고는 추천 참고로만 사용한다. 아래 `parameters`는 `kind`별 구별 타입이다.

| 요건 `kind` | `parameters` |
| --- | --- |
| `min_credits` | `{bucket, min, group_id}`. `bucket=total\|major\|general\|course_group`, 마지막 경우만 `group_id` 필수값이고 그 밖은 `null` |
| `required_course` | `{course_id}` |
| `choose_n` | `{group_id, n}`. 서로 다른 인정 과목을 센다 |
| `all_of` | `{child_rule_ids}`. 순환 참조 금지 |
| `min_regular_terms` | `{min}`. 확인된 이수 정규학기 수와 비교 |

| 인정 `kind` | `parameters` |
| --- | --- |
| `substitution` | `{requirement_rule_id, substitute_course_ids, min_count, term_from, term_to}`. 지정 조건 충족에만 적용 |
| `credit_exclusion` / `credit_cap` | 각각 `{group_id, buckets, term_from, term_to}` / `{group_id, buckets, max_credits, term_from, term_to}`. `buckets`는 `total\|major\|general` 배열 |
| `repeat_or_equivalence` | `{group_id, credit_mode, term_from, term_to}`. `credit_mode=one_attempt\|each_distinct_course`. 한 번 인정 시 가장 최근의 인정 가능한 완료 행을 사용하되 다른 정책이 필요한 경우 확인 대기 |

적용 시작·종료가 없는 때만 `term_from` 또는 `term_to`를 `null`로 둔다. 학점 인정과 필수조건 대체 효과를 분리한다. 승인된 개인 예외는 별도 `{exception_id, type, rule_id, attempt_id, bucket, credits, verification_status, source_refs}`로 전달하며 `type=requirement_waiver | credit_award | credit_exclusion`이다. 해당 효과에 필요 없는 키는 `null`, 확인 전에는 계산에 자동 반영하지 않는다. 학점 분류가 공식 자료로 확정되지 않으면 대상 학점을 확인 대기로 남긴다.

수강 자격 `conditions[]`는 `{type, values}`다. `type=department_in | grade_in | admission_type_in | prerequisite_all | corequisite_all`을 사용한다. `values`는 각각 학과 ID, 학년 정수, 입학 유형, 교과목 ID, 교과목 ID 배열이다. `prerequisite_all`은 확인된 선이수를, `corequisite_all`은 확인된 선이수 또는 같은 계획 내의 동시 편성을 허용한다. 자유형식 비고 중 제한으로 의심되는 미해석 항목은 근거와 함께 검토 대기다.

수강학점 상한은 대상 학기 유형과 학생의 학과·학번·입학 유형·과정·학년으로 찾는다. 적용 가능한 검증 정책이 여러 개면 동시에 적용되는 상한 중 가장 낮은 값을 사용한다. 정책끼리 상충하거나 승인된 예외의 적용 여부를 확인 못 하면 상한을 미확정으로 반환한다. 관심 태그는 공백과 대소문자를 정규화한 뒤 `course_tags`와 비교한다.

### 학기별 개설강좌와 교시·거리

`offerings_bundle`은 `{dataset_id, term, sources, offerings, lecture_code_links}`다. `sources`는 규칙 묶음과 같은 행 형태다. 강좌의 `Offering` 형태는 다음 예시와 같다. 아래 코드와 시각은 설명용이다.

~~~json
{
  "offering_id": "off-example",
  "course_id": "course-example",
  "term": "2026-2",
  "course_code": "001234",
  "section_code": "01001",
  "department_id": "DEPT_CS",
  "attendance_type": "day",
  "course_name": "예시 과목",
  "professor": null,
  "credits": 3,
  "language": "ko",
  "capacity": 40,
  "eligibility_data_status": "unknown",
  "schedule_status": "known",
  "meetings": [
    {"day": "MON", "start_minute": 540, "end_minute": 615, "mode": "in_person", "building_id": "54", "room_label": "예시관-405", "raw_schedule": "월(1 ~ 2)"}
  ],
  "availability": {"seat_status": "unknown", "available_seats": null, "observed_at": null},
  "notes": [],
  "source_refs": [{"dataset_id": "offerings-2026-2-example", "source_id": "src-offerings-example", "locator": "row 1"}]
}
~~~

- `course_id`·`department_id`·`professor`·`credits`·`capacity`는 미확인이면 `null`이다. `attendance_type=day | night | unknown`, `language=ko | en | other | unknown`, `schedule_status=known | asynchronous | unknown`이다. `day`는 `MON..SUN`, 미확인 요일과 교시의 분 값은 `null`이며 원문을 보존한다. `mode=in_person | online | unknown`은 일정별 방식이다. 온라인 비동기는 공식 근거가 있을 때만 `asynchronous`와 빈 일정 배열로 표시한다. `building_id`·`room_label`은 없으면 `null`이다. 충돌은 같은 요일 반열린 구간 `[start_minute, end_minute)`에 대해 검사한다.
- `eligibility_data_status=verified | partial | unknown`은 해당 분반 제한 자료의 검증 범위다. 알려진 제한 위반은 검증 범위와 무관하게 제외한다. 확인된 규칙이 0건이고 범위가 `verified`일 때만 제한이 없다고 판단할 수 있다. 제한 범위를 확인 못 한 분반은 추천에서 `needs_review`로 표시하고 확정 시간표에서 제외한다.
- `availability.seat_status=available | full | unknown`이며 확인값에는 관측 시각이 필요하다. 정원만 있으면 `unknown`이며 잔여석은 `null`이다. 미래 잔여석 연동에서는 5분을 넘긴 관측을 판정에 쓰지 않는다. `notes`는 출처에 표시된 비고와 기타 안내를 보존하는 문자열 배열이다.
- 학교 필드 매핑은 `SP_YMST → term`, `SUBJ_CD → course_code`, `LECT_NUMB → section_code`, `UNIT → credits`, `COUR_INWON → capacity`, `LSTM_LIST → raw_schedule`, `BLDG_COUM → room_label`, `COUR_LANG → language`, `NOTE/ETC → notes`다. `CMPT_DIV_NM`은 원본 적재 자료에 보존하며 학생의 인정 구분은 학번별 규칙으로 계산한다. 학기·과목번호·분반번호가 실제로 분반을 식별하는지 검증한다. 중복 조회 행은 원본 키와 내용이 같을 때만 합치며, 충돌한 행은 검수 대상으로 남긴다.
- `lecture_code_links[]`는 `{term, lecture_code, offering_ids, verification_status, source_refs}`다. 에타의 전체 코드와 학교 과목·분반 코드의 대응이 자료로 검증된 범위에서만 링크를 발행한다. `offering_ids`가 하나이고 검증 상태가 `verified`여야 자동 연결 후보가 된다. 학교 강좌와 커리큘럼을 연결할 수 없는 강좌는 `course_id=null`로 보존한다.
- `period_map`은 `{dataset_id, term, sources, entries}`이며 `entries[]`는 `{attendance_type, period_code, start_minute, end_minute, source_refs}`다. 시간표 대상 강좌 데이터는 사용한 교시표 버전을 매니페스트로 참조한다. 두 행이 정확히 맞붙으면 충돌은 아니며 공강과 연강 지표에 반영할 수 있다.
- `campus_distances`는 `{dataset_id, sources, buildings, distances}`다. `buildings[]`는 `{building_id, name, aliases, lat, lon, source_refs}`, `distances[]`는 `{from_building_id, to_building_id, method, meters}`다. 미상 좌표는 `null`, `method=straight_line | walking_route`이며 현재 원천은 직선거리다. 값이 없는 쌍을 0m로 해석하지 않는다.

## 실행 맥락, 강좌 연결, 교과 이수요건

`RunContext`는 `{context_id, input_revision, target_term, data_versions, engine_versions}`다. `data_versions`는 `{rules_dataset_id, past_offerings_dataset_ids, target_offerings_dataset_id, period_map_dataset_id, distance_dataset_id}`다. 과거 버전은 학기별로 많아질 수 있다. 확보하지 못한 단일 버전은 `null`이다. `engine_versions`는 `{matcher, evaluator, recommender, scheduler}` 네 버전 문자열을 가진다. 한 실행 안에서 버전은 고정한다.

| 메시지 | 필드와 결과 |
| --- | --- |
| `course_matching_request` | `{context, course_attempts}`. 사용자가 검토한 학생 문서의 전체 행 |
| `course_matching_result` | `{context, matches, issues}`. `matches[]`는 `{course_attempt_id, status, offering_dataset_id, offering_id, course_id, candidate_offering_ids, evidence, issues}` |
| `requirement_evaluation_request` | `{context, document, matches, verified_exceptions}`. 예외는 서버가 확인한 자료를 공급 |
| `requirement_evaluation_result` | `{context, coverage_status, totals, rule_results, issues}`. `coverage_status=covered\|partial\|unsupported` |

매칭 상태는 `matched | pending | ambiguous | unmatched`다. `matched`일 때만 공식 세 참조 필드에 값을 넣으며 나머지는 `null`이다. 미확인, 코드·자료 누락, 내용 충돌은 `pending`, 복수 후보는 `ambiguous`, 검수된 범위의 후보 0건은 `unmatched`다. 이름이나 교수는 확인에 쓰며 명칭 유사도만으로 확정하지 않는다. 원래 학생 기록은 보존한다.

`totals`는 `{total, major, general}`의 `CreditTotal` 세 개이며 `CreditTotal={confirmed, missing_at_least, target}`다. `confirmed`는 확인 근거로 인정된 학점 합계다. `missing_at_least`는 미해결 자료를 감안해도 확실한 부족량을 계산할 수 있을 때만 숫자이며 그 밖에는 `null`이다. 기준 미상이면 `target=null`이다. `rule_results[]`는 `{rule_id, status, current, target, evidence, issues}`다. `status=met | not_met | needs_review | not_applicable`, `current`와 `target`은 학점·횟수·이수 조건의 진행을 나타내는 숫자 또는 `null`이다. 확인된 완료 과목만 실제 인정에 포함한다. 이력이 불완전하고 누락 자료에 따라 결과가 바뀔 수 있으면 `needs_review`다. 현재 수강과 향후 계획은 별도 예상 결과로 표시한다.

## 추천, 시간표, 재조합

`recommendation_request`는 `{input_revision, limit}`다. `limit`은 1~100, 기본 30으로 생략할 수 있다. 서버가 프로필의 `target_term`과 저장 버전으로 맥락을 만든다. `recommendation_result`는 `{context, evaluation, recommendations, issues}`다. `recommendations[]`는 `{course_id, name, rank, priority_group, eligibility, offering_ids, reasons}`다. `rank`는 1부터 시작하고, `priority_group=major_required | core_general | basic_foundation | major_elective | general_elective`다. `eligibility=eligible | conditional | needs_review`이며 `conditional`은 동시수강 등 조합 검사 조건을 뜻한다. 과목의 상태는 가능한 분반 중 가장 확실한 상태를 사용한다. 알려진 자격 위반 분반은 후보 ID에서 제외한다. `reasons[]`는 `{code, message, rule_ids}`다. 공식 근거로 아직 확정 못 한 필수조건은 검토 이유로 표시한다.

추천 기본 순서는 확인된 미충족 전공필수 → 영역교양 → 기초·학문기초 → 전공선택·일반교양이다. 마지막 두 범주는 남은 인정학점 부족이 더 큰 쪽을 먼저 두고 동률은 전공선택을 앞세운다. 관심 태그는 관련 교양 내 순위에 반영한다. 동률은 `course_id`로 정렬한다. 동일 과목의 분반은 한 추천 항목으로 묶는다.

`saved_course`는 `{course_id, course_name, saved_at}`이다. `saved_course_list`는 `{courses}`이고 `courses`에 메시지 헤더를 뺀 같은 행을 담는다. 과목은 사용자가 저장할 때 목록에 추가한다. 시간표 화면에서 저장한 과목 중 골라 필수 또는 선호 조건으로 지정할 수 있다.

과목을 지정하지 않은 `schedule_request` 예시

~~~json
{
  "kind": "schedule_request",
  "schema_version": 1,
  "input_revision": 3,
  "selections": [],
  "constraints": {
    "min_credits": 12,
    "max_credits": 18,
    "blocked_times": [{"day": "FRI", "start_minute": 0, "end_minute": 1440}],
    "allowed_languages": ["ko"]
  },
  "sort": "recommended",
  "limit": 10
}
~~~

- `schedule_request`는 `{input_revision, selections, constraints, sort, limit}`다. 서버는 `input_revision`의 학생 문서와 `target_term`을 읽어 시간표 실행 맥락을 만든다. 매칭·이수요건 계산 로직을 공유하며 시간표 요청 자체에서 필요한 데이터를 조회한다. 시간표의 `context_id`는 응답에서 제공한다.
- `selections`는 생략 또는 빈 배열을 허용한다. 둘 다 대상 학기에 검증된 수강 가능 과목·분반을 찾아 자동으로 채우는 요청이다. 값이 있으면 고유 `course_id` 최대 12개의 `{course_id, priority}`를 받으며 `priority=required | optional`이다. `optional`은 선호 과목이며, 추천 목록에서 저장한 과목을 가져올 때 화면 기본값이다. 그 밖의 수강 가능 과목도 함께 채울 수 있다. 필수 과목을 포함할 수 없는 경우 이유를 반환하고, 선호 과목이 빠지면 누락과 이유를 표시한다. 저장 목록은 학생이 지정한 항목을 선택 조건으로 보낼 때만 반영한다.
- `constraints.min_credits/max_credits`는 학생이 해당 계획에 적용할 희망 범위이며 `null`이면 저장된 프로필값을 사용한다. 둘 다 미정이면 희망 한도를 추가하지 않는다. 검증된 공식 상한은 항상 함께 적용한다. 공식 상한을 확인 못 했으면 후보는 `provisional`이다. `blocked_times`는 해당 요일의 반열린 시간 구간 배열이며 수업 불가 요일은 `0..1440`이다. `allowed_languages`가 빈 배열이면 언어 제한을 적용하지 않는다. 제한을 선택한 경우 미확인 언어는 그 제한을 충족한다고 간주하지 않는다.
- 서로 다른 필수 과목 의도를 충족하고 동일 과목 중복 편성을 피한다. 유효한 후보는 최소 한 과목을 담는다. 공식 동시수강 조건은 후보 완성 시 다시 확인한다. 시간·자격·학점을 확인할 수 없는 분반은 생성 후보에서 제외하고 원인을 반환한다. `sort=recommended | fewest_campus_days | least_gap | fewest_changes`이며 마지막 값은 재조합에서만 허용한다. `limit`은 1~30이고 생략하면 10이다.
- 최초 기본 정렬은 포함된 선호 과목 수, 충족할 수 있는 것으로 확인된 남은 필수조건 수, 해소되는 것으로 확인된 인정학점 부족량의 내림차순이다. 이어 등교일·빈 시간 오름차순과 정렬된 분반 ID 순으로 비교한다. 이수요건 자료가 부족할 경우 해당 지표를 동률로 두고 확인 필요 사유를 반환한다. 재조합 기본 정렬은 유지 가능한 기존 분반 수 내림차순, 같은 과목 대체 우선, 이후 최초 정렬 기준을 적용한다. 선택한 정렬 기준은 기본 정렬보다 우선하고 동률에는 기본 정렬을 적용한다.

`recovery_request`는 `{baseline, locked_offering_ids, failed_offering_ids, replacements, sort, limit}`다. `baseline={candidate_id, saved_plan_id}`는 둘 중 정확히 한 값만 사용하고 다른 값은 `null`이다. 고정·실패 분반은 기준안의 분반이어야 하고 둘은 서로소이며 실패 분반은 최소 한 개다. 기준안의 실행 맥락과 선택·제약을 승계한다. 확정 분반은 분반 ID 그대로 남기고 실패 분반은 탐색에서 제외한다. 실패한 과목의 기본 대체 범위는 같은 과목의 다른 분반이다. `replacements[]`에 사용자가 허용한 `{course_id, allowed_course_ids}`를 추가하면 대상 학기 개설 목록에서 수강 조건을 충족하는 다른 과목으로 바꿀 수 있다. 한 대체 과목으로 두 선택을 충족시키지 않으며 교과 이수요건 변화는 새로 계산한다.

`schedule_result`는 `{context, search_id, outcome, search_status, baseline_candidate_id, candidates, issues}`다. `outcome=feasible | provisional | no_feasible_plan | undetermined`이고 `search_status=complete | truncated`다. 후보가 없고 탐색을 끝냈으며 자료 누락이 결론에 영향이 없을 때만 `no_feasible_plan`이다. 탐색 한도나 자료 누락으로 결론을 낼 수 없으면 `undetermined`다. `baseline_candidate_id`는 최초 생성이면 `null`이다.

각 `Candidate`는 `{candidate_id, offering_ids, total_credits, metrics, omitted_course_ids, projected_rule_results, changes, issues}`다. `metrics={campus_days, gap_minutes, changed_count, walking_distance_m}`다. `campus_days`는 확인된 대면 수업 요일 수로, 장소·수업 방식이 미확인일 때 `null`이다. `gap_minutes`는 요일별 수업 사이 빈 시간의 합, `changed_count`는 유지 외의 변경 행 수다. 정렬에서 미확인 지표는 확인값 뒤로 보낸다. 이동 점수가 꺼져 있거나 일부 거리가 미확인인 경우 `walking_distance_m=null`이다. 변경 내역은 `{before_offering_id, after_offering_id, status}` 배열이며 `status=kept | replaced | dropped | added`, 해당하지 않는 전후 ID는 `null`이다. 최초 생성의 `changes`는 `[]`다. `projected_rule_results`는 예정 수강으로 계산한 요건 변화이며 실제 인정 결과와 분리한다. 부분 탐색은 후보가 있어도 전체 최적을 보장하지 않는다.

자료가 부족해 조합 가능성을 판단하지 못한 결과 예시

~~~json
{
  "kind": "schedule_result",
  "schema_version": 1,
  "context": {
    "context_id": "ctx-example",
    "input_revision": 3,
    "target_term": "2026-2",
    "data_versions": {
      "rules_dataset_id": "rules-example",
      "past_offerings_dataset_ids": ["offerings-2024-1-example"],
      "target_offerings_dataset_id": "offerings-2026-2-example",
      "period_map_dataset_id": "periods-2026-2-example",
      "distance_dataset_id": null
    },
    "engine_versions": {"matcher": "1", "evaluator": "1", "recommender": "1", "scheduler": "1"}
  },
  "search_id": "search-example",
  "outcome": "undetermined",
  "search_status": "complete",
  "baseline_candidate_id": null,
  "candidates": [],
  "issues": [
    {"code": "OFFERING_ELIGIBILITY_UNKNOWN", "message": "대상 학기의 개설강좌 중 수강 제한이 미확인인 항목이 있습니다.", "path": null, "related_ids": ["off-example"]}
  ]
}
~~~

`plan_save_request`는 `{candidate_id, title}`다. `saved_plan`은 `{plan_id, title, created_at, context, plan_request, candidate, offerings}`다. `offerings`는 후보의 `Offering` 상세 배열이다. `plan_request`는 최초 `schedule_request`와 재조합 시 적용한 `recovery_request`를 각각 `initial`, `recovery`에 담는다. 최초 계획은 `recovery=null`이다. DB는 저장된 기준안과 선택·제약을 재조합에 사용할 수 있도록 버전과 함께 유지한다.

## 여러 학기 계획 확장

`multi_term_plan_request`는 `{input_revision, graduation_target_term, term_constraints}`를 사용한다. `term_constraints[]`는 `{term, min_credits, max_credits, include_summer_or_winter}`다. `multi_term_plan_result`는 `{context, graduation_target_term, term_plans, projected_rule_results, issues}`이며 `term_plans[]`는 `{term, availability_basis, course_ids, offering_ids, assumptions}`다. `availability_basis=published | historical_pattern | unknown`으로 미래 개설의 근거를 표시한다. 학기별 성적 반영 시점·선수과목 연결·예상 개설 근거가 필요하다. 이 계약은 확장 초안이며 v1 MVP 경로는 한 학기 계획까지다.
