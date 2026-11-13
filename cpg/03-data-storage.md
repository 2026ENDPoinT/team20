# CPG 데이터베이스와 데이터 운영

명세 개정 2 · [JSON 규약](01-json-contracts.md) · [API](02-http-api.md)

## 저장 기준

MVP는 SQLite 한 파일을 사용한다. 공식 규칙과 강좌의 재현 원본은 **버전이 부여된 검수 JSON 묶음**이며 SQLite에는 이를 조회할 수 있게 적재한다. 학생 입력과 사용자가 저장한 과목·시간표의 기준 저장소는 SQLite다. 개발 시 가상 예시 JSON을 저장소에 둘 수 있으며 실제 학생 자료, DB 파일, 수집 임시물은 Git 대상에서 제외한다.

| 데이터 | 유지 위치와 단위 | 갱신 방식 |
| --- | --- | --- |
| 공식 교육과정·규칙·출처 | 버전별 JSON 원본 + SQLite 정규화 | 검수 후 새 데이터셋을 발행, 기존 버전 보존 |
| 학교 개설강좌·분반·교시·코드 연결 | 학기별 검수 JSON 원본 + SQLite 정규화 | 대상 학기의 새 스냅샷만 활성화 |
| 건물·별칭·거리 | 별도 검수 JSON + SQLite, 기능을 켤 때 사용 | 지도 데이터셋 단위 발행 |
| 학생 프로필·이수내역·검토 상태 | SQLite 행 | 한 번의 저장·적용으로 갱신, 리비전 증가 |
| 승인된 개인 예외 | SQLite 행과 출처 참조 | 로컬 관리 작업, 승인·수정 시 학생 리비전 증가 |
| 사용자가 저장한 과목 | SQLite 과목 ID와 저장 시각 | 학생이 추가·삭제. 시간표에 포함하려는 과목만 요청에 반영 |
| 시간표 후보, 매칭·요건·추천 중간 결과 | 프로세스 메모리, 30분 | 입력과 자료 버전이 바뀌면 새 실행 |
| 사용자가 저장한 시간표 | SQLite 메타데이터, 분반 참조, 불변 JSON 스냅샷 | 사용자가 명시적으로 저장 또는 삭제 |
| 에타 원문·공유 링크·원본 식별자 | 수집 처리 메모리 | 파싱·비교에 필요한 시간 동안만 유지 |
| 에타 미리보기·적용 상태 | 프로세스 메모리, 작업 종료 후 30분 | 재수집, 만료, 삭제 시 제거 |
| 학교 HTTP 응답과 CSV | 검수용 작업 영역, 발행 JSON과 분리 | 오류 분석·검수에 필요할 때만 보관. 재배포 범위 확인 전 공개 저장소에는 가상 자료 사용 |
| 수강 인원·잔여석 | MVP 저장 없음 | 출처가 확보되면 관측 시각이 있는 별도 단기 자료로 설계 |

## 개설강좌 조회와 갱신

과목 추천·시간표 생성·신청 실패 재조합은 SQLite의 검수된 학기별 스냅샷을 읽는다. 학교 공개 시간표 조회는 스냅샷을 채우거나 갱신하는 수집 작업에서 실행한다. 이 방식은 동일한 시간표 후보를 계산할 때 학과별 조회 결과, 분반·교시 데이터, 규칙 버전을 함께 고정할 수 있다.

- 과거 학기는 이수내역 매칭에 쓰므로 검수 후 보관하고 정정 자료가 있을 때 새 버전을 발행한다.
- 추천 대상 학기는 개설 목록이 공개되면 먼저 적재한다. MVP에서는 운영자가 필요한 때 수집을 실행한다. 자동 갱신 주기는 학교 공지와 조회 여건을 확인한 뒤 정한다.
- 수집·검수에 성공하면 새 버전을 활성화한다. 실패하면 마지막 검수본을 유지하고 화면에 사용 중인 자료의 수집 시점을 표시한다. 해당 학기의 검수본이 아직 없으면 데이터 미확보 상태를 표시한다.
- 잔여석은 신뢰할 수 있는 조회 원천을 확보한 뒤 관측 시각이 있는 별도 단기 자료로 다룬다. 현재 확인한 `COUR_INWON`은 수강정원이다. [학교 개설강좌 수집기](../../seoultech_class/README.md)

## 논리 스키마와 키

JSON 숫자 학점은 SQLite에서 100배 정수 `*_cents`로 저장한다. 시각은 UTC 문자열, 교시·시간 구간은 정수 분, 외부 코드는 `TEXT`다. ID, 데이터셋 참조, 학기, 필터 조건은 컬럼으로 둔다. 모듈별로 구조가 달라지는 규칙 조건과 저장 시점에 고정할 결과는 JSON 컬럼을 사용한다. 복합 참조는 참조된 행의 데이터셋 ID를 함께 갖는다.

### 공식 자료

| 테이블 | 기본키와 필수 관계 |
| --- | --- |
| `datasets` | `dataset_id`. `dataset_type`, `dataset_version`, `manifest_json`, `manifest_sha256`, `published_at`. `(dataset_type, dataset_version)` 고유 |
| `dataset_dependencies` | `(dataset_id, dependency_dataset_id)`. 각각 `datasets` 참조 |
| `active_datasets` | `(dataset_type, scope_key)`. `dataset_id` 참조. 규칙·거리는 `global`, 강좌·교시는 대상 학기. 발행 트랜잭션에서 교체 |
| `source_documents` | `(dataset_id, source_id)`. 공식 URL·위치·검증일·선택 보관 해시. 엔터티의 `source_refs`는 이 테이블과 검증 시 대조 |
| `courses` / `curriculum_courses` | 각각 `(rules_dataset_id, course_id)` / `(rules_dataset_id, curriculum_id)`. 교육과정 행은 같은 규칙 데이터셋의 과목을 참조 |
| `course_groups` / `course_group_members` | 그룹 `(rules_dataset_id, group_id)`. 멤버는 `(rules_dataset_id, group_id, course_id)`와 적용 학번 정보 |
| `requirement_sets` / `requirement_rules` | `(rules_dataset_id, set_id)` / `(rules_dataset_id, rule_id)`. 묶음의 `(rules_dataset_id, admission_year, department_id, admission_type, program_type)` 고유. 규칙 유형·검증 상태와 `parameters_json` 저장 |
| `recognition_rules` / `eligibility_rules` | 각각 `(rules_dataset_id, rule_id)`. `parameters_json`/`conditions_json`, 검증 상태, 출처. 과목과 분반 참조를 발행 검수에서 확인 |
| `credit_load_policies` / `course_tags` | 각각 `(rules_dataset_id, policy_id)` / `(rules_dataset_id, course_id, tag)`. 상한 적용 조건, 태그 선정 근거와 출처 |
| `requirement_set_rules` / `requirement_set_recognition_rules` | `(rules_dataset_id, set_id, rule_id)`. 양쪽 행을 복합 외래키로 연결 |
| `course_offerings` | `(offering_dataset_id, offering_id)`. `term`, `course_code`, `section_code`, `attendance_type`, 학점·언어·정원·비고. 알려진 경우 `(rules_dataset_id, course_id)` 외래키 |
| `offering_meetings` | `(offering_dataset_id, offering_id, meeting_index)`. 분반 행 복합 외래키, 요일·시각·강의실과 원본 교시 |
| `lecture_code_links` / `lecture_code_link_candidates` | 각각 `(offering_dataset_id, term, lecture_code)` / `(offering_dataset_id, term, lecture_code, offering_id)`. 링크 검증 상태와 출처, 후보는 같은 데이터셋 분반 외래키 |
| `period_entries` | `(period_dataset_id, term, attendance_type, period_code)`. 공식 교시의 시작·끝, 근거 |
| `buildings` / `building_aliases` / `building_distances` | 건물 `(distance_dataset_id, building_id)`, 별칭 `(distance_dataset_id, normalized_alias)`, 거리 `(distance_dataset_id, from_building_id, to_building_id, method)`. 거리 양 끝 건물 참조 |

분반 ID는 검증된 학교 식별 키에 고정한다. 학기·교과목번호·분반번호가 유일한지 발행 전 검사한다. 주·야간 등으로 구분이 필요한 충돌은 실제 학교 식별자를 확보한 뒤 매핑 테이블에서 해결한다. 서로 다른 행에 같은 ID를 덮어쓰지 않는다. `course_offerings(offering_dataset_id, term, department_id, course_id)`, `course_offerings(offering_dataset_id, term, course_code, section_code)`와 `course_group_members(rules_dataset_id, course_id)`에 조회 인덱스를 둔다.

### 학생·저장 계획

| 테이블 | 기본키와 필수 관계 |
| --- | --- |
| `profile_state` | `profile_id`. 로컬 MVP에서 하나의 프로필 슬롯 사용. `revision`, `review_state`, `updated_at` 유지. 삭제 후에도 리비전 카운터만 유지하여 오래된 요청 재적용 방지 |
| `student_profiles` | `profile_id` → `profile_state`. 학생 문서의 프로필 값과 `history_complete`, 관심 태그는 순서 있는 JSON 배열 |
| `course_attempts` | `(profile_id, course_attempt_id)` → `student_profiles`. 학기·원본 강좌코드·이름·교수·이수 상태·출처와 메모. 에타 행에 `source_table_key`, `source_key`, `identity_basis`, 마지막으로 수락한 원본의 필드별 해시를 저장 |
| `student_exceptions` | `(profile_id, exception_id)`. 관련 과목 시도 또는 규칙 버전 참조, 효과와 증빙 참조, 승인 상태와 시각 |
| `student_exception_sources` | `(profile_id, source_id)`. 승인된 개인 예외의 근거 위치와 검토 시각. 증빙 원문은 적재하지 않는다 |
| `saved_courses` | `(profile_id, course_id)`. `profile_id`는 학생 프로필 참조. 저장 시 과목명과 `saved_at`을 보관하고 과목 ID를 활성 자료에서 검증한다. 데이터셋이 바뀌어도 저장한 과목 ID를 유지 |
| `saved_plans` | `plan_id`, `profile_id`, `input_revision`, `target_term`, `candidate_id`, `title`, `created_at`, `snapshot_json`. 동일 `(profile_id, input_revision, candidate_id, title)` 고유 |
| `saved_plan_datasets` | `(plan_id, dataset_id)`. 사용한 규칙·과거/대상 강좌·교시·거리 자료 참조 |
| `saved_plan_offerings` | `(plan_id, offering_dataset_id, offering_id)`. 선택 분반과 저장된 기준 분반을 참조하고 역할을 기록 |

`course_attempts`에는 `source=everytime AND identity_basis=source_subject`일 때만 `(profile_id, source_key)` 부분 고유 인덱스를 적용한다. `source_position`은 과목 순번 기반으로 재수집 비교가 불안정하므로 고유키로 병합하지 않는다. 임시 원본 ID나 원문 대신 학기·코드·이름·교수별 값의 정규화 JSON 해시를 비교한다. 저장한 계획의 스냅샷에는 과목 선택 조건과 나머지 제약, 기준안, 실행 맥락, 저장 당시 표시 정보, 사용자가 지정한 대체 조건이 들어간다. 과목 저장 목록의 이후 변경과 시간표는 독립적으로 관리한다.

## 공식 자료 발행

1. 공식 원문·학교 조회 결과에서 학과·학기·주야·교양 범위를 기록한다. 교육과정 연도와 적용 학번의 근거를 함께 추적한다.
2. JSON으로 변환한 뒤 필수 필드, 코드 문자열, 건수, 해시, 출처 참조, 과목·규칙 ID, 택1 그룹, 적용 범위, 규칙 순환, 교시·분반 충돌을 검증한다. 규칙 문서에 있는 모호한 대체·소급 규정은 `pending` 또는 `conflicting`으로 유지한다. 학교 응답 오류와 검증된 0행 범위를 구분한다.
3. 공식 강좌가 참조하는 규칙·교시 버전을 매니페스트에 적는다. 활성화할 버전 간 참조가 맞는지 검사한다. 규칙 교체가 강좌 참조와 호환되지 않으면 필요한 강좌 묶음과 함께 검수·활성화한다.
4. 한 트랜잭션에서 새 행과 참조를 적재하고 `active_datasets`를 교체한다. 같은 데이터셋 ID와 매니페스트 해시로 재실행하면 변경하지 않는다. 같은 ID에 다른 해시가 오면 거부한다. 적재가 실패하면 기존 활성 버전을 유지한다.
5. 이전 버전 복구는 참조가 맞는 활성 포인터 세트로 되돌린다. 저장 계획이 참조하는 버전은 삭제하지 않는다. 캐시에서는 버전이 맞지 않는 실행을 다시 생성하도록 안내한다.

SQLite 연결마다 외래키를 켜고, 발행·이행 후 외래키 검사를 실행한다. 학생 저장·가져오기 적용은 ETag 대조부터 과목 변경과 리비전 증가까지 단일 쓰기 트랜잭션이다. 배치와 저장은 짧은 트랜잭션으로 분리하고 실제 네트워크 요청은 트랜잭션 밖에서 실행한다. DB 스키마 번호는 `PRAGMA user_version`과 순차 마이그레이션으로 관리한다. 기존 앱처럼 서버가 매번 고정값을 덮어쓰는 코드는 이행 시 교체한다. [SQLite 외래키 문서](https://www.sqlite.org/foreignkeys.html)

## 기존 데이터 이행과 삭제

1. 기존 `student_input.document_json`을 읽어 구조와 버전을 확인한다. SQLite의 백업 기능으로 로컬 스냅샷을 만든 뒤 새 테이블로 옮긴다. 파일은 로컬 복구용으로만 유지한다.
2. 기존 프로필, 시도 ID, 이수 확인과 메모를 유지한다. 신규 `lecture_code`, `professor`, `source_ref`, `regular_terms_completed`는 자료가 있을 때만 채우고 없으면 `null`이다. 기존 입력에 일반 과정 확인 정보가 없으면 `program_type=null`로 이행한다. 상태와 확인 여부가 서로 어긋나는 행은 미확인으로 옮기고 이행 보고서에 ID와 사유를 남긴다. 과거 시간표의 `meetings`, 추출 보조 필드는 표준 문서에서 제거하되 원본 백업에서 복구할 수 있다.
3. 원본과 이행 결과의 학생·과목 수, ID, 상태, 리비전, 예외 건수를 비교하고 유효하지 않은 행이나 예외를 보고한다. 기존 리비전을 이어 사용하되 이행 완료 시 한 번 증가시켜 이전 창의 저장을 차단한다. 하나의 트랜잭션으로 끝내고 실패 시 롤백한다.
4. 사용자가 삭제하면 학생과 이수내역·예외·저장 과목·저장 계획 행, 에타 미리보기와 실행 캐시를 지운다. 학생 삭제 이후 로컬 복구 백업에 남아 있는 정보는 별도이며, 이행 백업은 검증 후 삭제하도록 운영 체크리스트에 기록한다. 공개 서비스를 준비할 때는 운영 백업·복구와 삭제 보존 기간을 먼저 정한다.

DB 쓰기 실패, 손상, 잘못된 발행에 대비해 발행/이행 전 SQLite 백업과 매니페스트 해시를 남긴다. 공식 데이터 JSON으로 공식 테이블은 재생성할 수 있고 학생 자료는 DB 백업에서 복원한다. 복원할 때는 테스트 DB에 먼저 올려 과목 행과 저장 계획의 버전 참조를 확인한다.
