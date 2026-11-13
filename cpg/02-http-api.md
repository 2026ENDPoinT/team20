# CPG HTTP API 규약

명세 개정 2 · [JSON 규약](01-json-contracts.md) · [DB 운영](03-data-storage.md)

## 공통

- 브라우저용 경로는 `/api/v1`, 본문은 `application/json; charset=utf-8`이다. JSON 문서는 [모듈 입출력 규약](01-json-contracts.md)의 `kind`와 `schema_version`을 검증한다. 새 공개 HTTP 경로와 파일 스키마 버전은 각각 독립적으로 관리한다.
- 첫 배포 기준은 현재 앱과 같은 로컬 단일 사용자다. `127.0.0.1`에 바인딩하고, 지정된 로컬 Host·Origin만 허용한다. `GET /api/v1/config`는 같은 출처에서 임의 세션 토큰을 제공한다. 모든 후속 API는 `X-App-Token`을 요구한다. 토큰은 메모리에서만 유지하며 공유 URL, 토큰, 학생 입력을 로그에 남기지 않는다. 학생·계획·작업 응답은 `Cache-Control: no-store`다. 공개 다중 사용자 배포의 인증·권한·세션 정책은 별도 설계 항목이다.
- HTTP 쓰기·계산 요청 본문 한도는 1 MiB다. 읽기 엔드포인트에는 본문을 보내지 않는다. 요청 응답에 `X-Request-Id`를 붙여서 로그와 연결한다. 로그에는 요청 ID·경로 템플릿·상태·처리시간만 남긴다.
- 학생 입력의 현재 리비전으로 강한 ETag를 만든다. `GET /student-input`에서 `ETag: "input-3"`을 반환하면 `PUT`·`DELETE`와 수집 적용은 `If-Match: "input-3"`을 보낸다. 누락은 `428`, 현재 값과 다르면 `412`다. 대조와 저장은 같은 DB 트랜잭션에서 실행한다. 저장이 끝나면 새 리비전과 ETag를 반환한다. 변경 사항이 없는 가져오기 적용은 기존 리비전을 유지한다.
- 계산 요청의 저장 리비전·데이터 버전이 오래된 경우 `409`를 반환한다. 화면은 최신 입력을 읽고 사용 중인 과목 추천 또는 시간표 설계를 다시 요청한다. 일반 추천·생성·재조합은 계산 결과를 메모리에 두며 학생 문서를 수정하지 않는다.
- 아래 `{id}`는 불투명 식별자다. `Location`은 생성한 조회 가능한 리소스의 경로다. 브라우저용 API는 학생 입력·공식 데이터 접근 권한을 스스로 확인하며, 요청 본문에서 소유자를 받지 않는다.

## 학생 입력과 수집

이하 경로의 접두사는 `/api/v1`이다.

| 메서드와 경로 | 요청 | 성공 응답과 의미 |
| --- | --- | --- |
| `GET /config` | 없음 | `200 app_config`. `{csrf_token}`, `schema_version=1` |
| `GET /student-input` | 없음 | `200 student_input_state` + ETag. 최초에는 리비전 0인 빈 초안 |
| `PUT /student-input` | `If-Match`, `student_input_save_request`의 `{review_state, document}` | `200 student_input_state` + ETag. 프로필과 과목을 한 번에 저장 |
| `GET /student-input/export` | 없음 | `200 student_input` v2. `Content-Disposition: attachment`, UTF-8 JSON |
| `DELETE /student-input` | `If-Match` | `204`. 입력·예외·저장 과목·저장 시간표 및 관련 미리보기와 실행 맥락을 삭제하고 리비전 증가 |
| `POST /imports/everytime` | `everytime_import_request`. 선택 헤더 `Idempotency-Key` | `202 import_job` + `Location: /api/v1/imports/{id}` |
| `GET /imports/{id}` | 없음 | `200 import_job`. 준비되면 미리보기 제공 |
| `POST /imports/{id}/apply` | `If-Match`, `import_apply_request` | `200 student_input_state` + ETag. 수락된 행만 같은 트랜잭션에서 저장 |

`student_input_save_request` v1의 `review_state=draft | reviewed`이며 `document`는 v2다. `reviewed`에서 입학연도·학년·추천 학기·과정이 비어 있거나 확인된 `course_attempts` 행의 학기·과목명이 비어 있으면 `422`다. 이수 미확인 행은 `issues`와 함께 저장한다. 학생 입력 PUT에서 에타 출처 행을 추가하거나 기존 원본 참조를 변경할 수 없다. 가져오기 적용 엔드포인트가 `source_key`를 만들고 보존한다. 학생은 기존 에타 행의 과목명·학기·이수 상태를 정정하거나 행을 삭제할 수 있다. 내보내기 JSON은 사용자 열람과 후속 모듈 연동에 쓴다. 앱 전체 복구는 SQLite 백업을 사용한다.

`import_job` v1은 `{import_id, status, created_at, updated_at, expires_at, progress, preview, issues}`다. `status=queued | running | succeeded | failed`, `progress={discovered_tables, requested_tables}`, `preview`는 성공했을 때만 `import_preview`이고 그 밖에는 `null`이다. 전체 실패는 `failed`와 원인 코드를 제공한다. 부분 성공은 `succeeded`와 `partial` 미리보기다. 작업·결과는 메모리에 보관한다. 진행 중에는 2초 간격으로 조회하며 종료 후 30분 동안 적용 가능하다. 서버를 다시 켜거나 시간이 지나면 `404 IMPORT_NOT_FOUND`이고 사용자가 다시 시작한다.

작업 등록 시 `base_revision`을 확인한다. 적용 시 `If-Match`를 먼저 검증한 뒤 본문과 미리보기의 `base_revision`을 현재 값과 대조한다. 오래된 미리보기는 `409 IMPORT_BASE_CHANGED`다. 같은 미리보기에서 모든 수락을 한 번에 제출하고 이미 적용된 작업은 추가 적용을 거부한다. 실제 과목이 추가·변경되면 문서는 `draft`가 되며 영향 없는 과목의 확인 상태는 유지한다. 성공 응답을 잃은 경우 `GET /student-input`으로 반영 상태를 확인한다. `Idempotency-Key`를 쓰면 리비전 검사에 앞서 기존 작업을 찾고, 같은 세션의 같은 요청은 보관 기간 동안 기존 작업을 돌려준다. 동일 키에 다른 요청 본문은 `409 IDEMPOTENCY_KEY_REUSED`다.

한 번에 활성 에타 작업은 1개다. 대기 포함 상한에 도달하면 `429`와 `Retry-After`를 반환한다. 최대 100개 시간표이며 작업 전체 제한은 180초다. 이 한도에 도달하면 성공한 시간표로 부분 결과를 만들고, 성공분이 없으면 실패를 반환한다. 기존 모듈의 개별 요청 제한에 남은 작업 시간도 적용한다. 전체 미리보기나 적용 후보가 300행을 넘으면 자동으로 일부를 자르지 않고 `IMPORT_ROW_LIMIT` 사유를 반환한다. 사용자는 적용 시 행을 골라 기존 문서와 합산 300행 범위를 지킬 수 있다.

## 추천, 시간표, 저장

| 메서드와 경로 | 요청 | 성공 응답과 의미 |
| --- | --- | --- |
| `POST /recommendations` | `recommendation_request` | `200 recommendation_result`. 이수요건 계산·추천과 `context_id` 제공 |
| `GET /saved-courses` | 없음 | `200 saved_course_list`. 사용자가 담아둔 과목 |
| `PUT /saved-courses/{course_id}` | 경로의 공식 과목 ID | `201 saved_course`. 이미 저장된 과목은 기존 항목을 `200`으로 반환 |
| `DELETE /saved-courses/{course_id}` | 경로의 공식 과목 ID | `204`. 삭제 후 같은 요청에도 `204` |
| `GET /contexts/{id}/offerings?offering_id=A&offering_id=B` | 동일 쿼리 키 반복, 최대 100개 | `200 offering_list`. `{context_id, offerings, issues}`. `offerings[]`는 `{offering, eligibility, issues}`, `offering`은 `Offering`, `eligibility=eligible\|conditional\|needs_review` |
| `POST /schedules` | `schedule_request`의 학생 입력 리비전·제약, 선택 사항인 과목 조건 | `200 schedule_result`. 독립적으로 만든 맥락과 시간표 후보, 불가 또는 확인 필요 |
| `POST /schedules/recover` | `recovery_request` | `200 schedule_result`. 재조합 후보와 기준 대비 변경 |
| `POST /plans` | `plan_save_request`의 `{candidate_id, title}` | `201 saved_plan` + `Location: /api/v1/plans/{id}` |
| `GET /plans` | `limit` 기본 20·최대 50, 선택 `cursor` | `200 saved_plan_list`. `{plans, next_cursor}`, 요약은 `{plan_id, title, target_term, total_credits, created_at}` |
| `GET /plans/{id}` | 없음 | `200 saved_plan` |
| `DELETE /plans/{id}` | 없음 | `204`. 같은 사용자의 이미 삭제된 계획에도 동일 응답 |

`offering_list`와 `saved_plan_list`는 v1이다. 계획 목록은 `created_at`과 `plan_id` 내림차순의 커서 페이지네이션이다. `next_cursor`가 `null`이면 마지막 페이지다. `saved_plan`에는 화면이 저장된 계획을 다시 그릴 수 있도록 후보의 `offerings` 상세도 포함한다. `plan_save_request.title`은 공백 제거 후 1~80자다. 같은 입력 리비전의 같은 후보를 같은 제목으로 다시 저장하면 기존 리소스를 `200`으로 반환한다.

`POST /schedules`는 시간표 화면에서 바로 호출할 수 있다. 요청의 `input_revision`을 기준으로 대상 학기와 최신 공식 개설 자료를 읽어 실행 맥락을 생성한다. `selections`가 생략되거나 빈 배열이면 수강 가능한 과목을 자동으로 채운다. 저장한 과목은 학생이 골라 `selections`로 보낸 항목만 사용한다. 과목 저장에는 활성 공식 과목 목록에서 확인된 ID를 받으며, 과목 목록의 변경은 학생 입력 리비전과 기존 계획의 제약을 바꾸지 않는다. 저장 목록은 `saved_at`과 `course_id` 내림차순이다.

프로필의 필수 입력 누락은 `422`다. 과목 추천에서 지원 범위 밖인 학생은 `coverage_status=unsupported`와 이유, 빈 추천 목록을 반환한다. 시간표 설계는 수강 자격과 일정·학점이 확인되는 범위에서 후보를 만들고, 요건 평가 근거가 부족한 항목은 확인 필요로 표시한다. 대상 학기 공식 데이터가 미발행이면 `TARGET_TERM_DATA_UNAVAILABLE` 이유와 함께 과목 추천은 빈 목록을, 시간표는 `undetermined`를 반환한다. 탐색 불가·자료 부족·부분 탐색은 `200` 도메인 결과다. 화면은 원인을 표시하며 후보가 0개인 경우 임의로 제약을 완화하지 않는다.

추천·시간표 실행 맥락과 후보는 생성부터 30분 동안 유효하다. 상세 조회·재조합·저장 시 현재 학생 리비전과 실행에 사용한 데이터셋·엔진 버전을 다시 비교한다. 데이터 발행 또는 입력 수정이 있었으면 해당 기능을 다시 요청한다. 저장된 계획은 이전 버전으로 열 수 있다. 저장 계획으로 재조합하려면 현재 입력·공식 데이터·엔진이 기준안과 일치해야 한다. 아니면 `409 PLAN_REBUILD_REQUIRED`로 새 후보 생성을 안내한다. 저장 계획의 분반과 제약이 유효하고 임시 캐시만 만료된 경우 DB에 저장된 맥락과 대상 학기 자료로 재조합할 수 있다.

초기 탐색 예산은 요청당 최대 100,000개 탐색 노드와 2초다. 먼저 도달하는 값을 적용한다. 시간 초과 후에도 이미 찾은 유효 후보는 `search_status=truncated`로 반환한다. 이 예산과 정렬 변경은 `scheduler` 버전을 올린다. 장기 계획 HTTP 경로는 여러 학기 데이터와 검증 기준이 마련된 뒤 추가한다.

## 오류 응답

HTTP 오류는 `application/problem+json`과 Problem Details 형식을 사용한다. `type`은 `about:blank`, `title`은 HTTP 상태의 표준 제목, `status`는 HTTP 상태와 동일, `detail`은 안전한 설명이다. 확장 `code`·`request_id`·`issues`로 UI 분기와 필드 위치를 제공한다. 요청 URL이나 공유 식별자는 오류 상세에 포함하지 않는다. [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)

~~~json
{
  "type": "about:blank",
  "title": "Unprocessable Content",
  "status": 422,
  "detail": "최소 학점은 최대 학점 이하여야 합니다.",
  "code": "VALIDATION_ERROR",
  "request_id": "req-example",
  "issues": [
    {"code": "CREDIT_RANGE_INVALID", "message": "학점 범위를 확인해 주세요.", "path": "/constraints/min_credits", "related_ids": []}
  ]
}
~~~

| HTTP | 코드 예시 | 처리 |
| --- | --- | --- |
| `400` | `MALFORMED_JSON` | 잘못된 본문 또는 쿼리 문법 |
| `403` | `LOCAL_ACCESS_REQUIRED`, `APP_TOKEN_INVALID` | 로컬 출처·토큰 검증 실패 |
| `404` | `IMPORT_NOT_FOUND`, `CONTEXT_NOT_FOUND`, `CANDIDATE_NOT_FOUND`, `PLAN_NOT_FOUND`, `COURSE_NOT_FOUND` | 해당 사용자에게 보이는 대상 없음 또는 임시 결과 만료 |
| `409` | `IMPORT_BASE_CHANGED`, `IMPORT_NOT_READY`, `IMPORT_ALREADY_APPLIED`, `INPUT_REVISION_CHANGED`, `DATASET_CHANGED`, `PLAN_REBUILD_REQUIRED` | 최신 입력으로 재요청하거나 상태 확인 |
| `412` | `ETAG_MISMATCH` | 현재 리비전을 다시 읽고 사용자 변경 사항을 보존하여 재시도 |
| `413` / `415` | `BODY_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | 크기 또는 미디어 타입 제한 |
| `422` | `VALIDATION_ERROR`, `SCHEMA_VERSION_UNSUPPORTED` | 필드·버전·고정/실패 ID 관계 등 도메인 유효성 오류 |
| `428` | `IF_MATCH_REQUIRED` | 현재 ETag 필요 |
| `429` | `IMPORT_LIMIT_REACHED` | `Retry-After` 이후 재시도 |
| `500` / `503` | `INTERNAL_ERROR` / `SERVICE_UNAVAILABLE` | 예기치 않은 처리 오류 또는 일시적 저장 불가 |

## 외부 시스템 어댑터

| 원천 | 현재 확인한 요청·응답 | 내부 처리 |
| --- | --- | --- |
| 에브리타임 | 공개 `https://everytime.kr/@…`에서 식별자 추출. `POST https://api.everytime.kr/find/timetable/table/friend`, form `identifier`와 `friendInfo=true`, XML의 `table`과 `primaryTables` | 기존 수집기와 입력 검사 재사용. 공개 링크 형식·허용 호스트·응답 식별자·크기·학기 일치 검증. 임의 리다이렉트나 비공개 인증 요청은 보내지 않는다. [기존 수집기](<C:/Users/김재민/Desktop/team20/everytime_import/README.md>) |
| 서울과기대 개설강좌 | GUEST 공개 시간표의 `POST /JSONMain`. `fsp_action=GridAction`, `fsp_cmd=getScheduleGridData`, `SP_YMST`, `LESS_CD`, `DN_DIV`와 `SUBJ_NM/LECT_DIV/DOTW_CD` 필터. 응답 `ErrorCode`, `records`, `rows` | 학과·주야·학기별로 배치 수집. 오류·건수·키를 검증한 뒤 강좌 JSON으로 변환. 0행은 독립 검수 후에만 빈 정상 범위로 발행. 학교 페이지가 쓰는 요청 규약이다. [수집기 검증 기록](../../seoultech_class/README.md) |
| 건물 거리 | 기존 `buildings.json`과 `campus_distances.sqlite3` | 거리 JSON으로 변환해 별도 발행. 시간표 요청 때 지도에 실시간 질의하지 않는다. [건물 거리 원천](../../seoultech_class/classroom_dist/README.md) |

일시적 네트워크 오류는 원천별 상한과 전체 제한 내에서만 재시도한다. 에타 실패는 사용자 작업의 결과로 기록하고, 학교 배치 실패는 이미 발행한 데이터셋을 유지한다. 공식 규칙 JSON 편집·발행과 승인된 개인 예외 입력은 MVP에서 로컬 관리 작업이다. 브라우저용 데이터 발행·관리자 API와 실제 수강신청 제출 기능은 정의하지 않는다.

HTTP 구현과 동시에 Markdown 규약을 [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html), 파일·메시지 검증을 [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)로 옮긴다. 위 API 표와 상태 규칙으로 먼저 수동 검토하고, 구현 PR에서는 계약 예시를 스키마와 통합 테스트로 검증한다.
