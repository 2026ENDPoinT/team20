# 에브리타임 공유 시간표 → JSON

공유 링크의 학기별 수강내역을 가져오는 모듈이다. CLI는 수집 JSON을 저장한다. [입력 앱](../intake_app/README.md)에서는 수집 결과를 미리 보고 저장한 뒤 공식 개설강좌 DB와 대조할 수 있다.

Python 3.10 이상을 사용한다. 시간표 조회에는 Python 표준 HTTP 라이브러리를 사용한다. 현재 체크아웃한 저장소 루트(`AGENTS.md`가 있는 폴더)에서 실행한다.

```powershell
python -B -m everytime_import 'https://everytime.kr/@공유식별자'
```

기본 결과(저장소 루트 기준): `everytime_import/runtime/course_import.json`

```powershell
python -B -m everytime_import 'https://everytime.kr/@공유식별자' --output 'everytime_import/runtime/my_courses.json'
```

같은 출력 경로로 실행하면 최신 수집 결과로 교체한다. 과거 결과와 누적 병합하지 않는다. 기존 파일을 보관하려면 다른 출력 경로를 지정한다. 실제 사용자 결과가 있는 `runtime/`는 Git에서 제외한다.

## 요청과 수집

- `https://everytime.kr/@공유식별자`와 `https://everytime.kr/app/@공유식별자`를 모두 지원한다.
- `POST https://api.everytime.kr/find/timetable/table/friend`
- `application/x-www-form-urlencoded`: `identifier=...&friendInfo=true`
- Python 표준 HTTP 라이브러리로 조회하고 표준 XML 파서로 해석한다.
- `primaryTables`에서 발견한 식별자를 중복 없이 순회한다. 기본 최대 100개이며 `--max-tables`로 줄일 수 있다.
- 정규학기는 `YYYY-1`, `YYYY-2`, 계절학기는 `YYYY-summer`, `YYYY-winter`로 변환한다.
- 빈 시간표도 조회 성공으로 기록한다. 오류·접근 불가·학기 불일치는 실패로 기록하며 성공한 학기의 결과는 보존한다.
- 종료 코드: `0` 전체 수집 성공, `2` 일부/전체 시간표 실패 또는 조회 제한으로 미완료(JSON은 저장), `1` 잘못된 입력·파일 저장 실패 등.
- 실패했다고 임의로 비공개 자료에 접근하거나 다른 인증 방식으로 재시도하지 않는다. 재실행하면 전체를 새로 조회한다.

## 결과 형식

```json
{
  "schema_version": 1,
  "kind": "everytime_course_import",
  "imported_at": "UTC 수집시각",
  "source": {"provider": "everytime", "root_identifier": "공유식별자"},
  "import_status": "complete",
  "official_matching_status": "not_started",
  "history_complete": false,
  "summary": {
    "discovered_tables": 1,
    "requested_tables": 1,
    "imported_tables": 1,
    "imported_terms": 1,
    "course_attempts": 1,
    "failed_or_skipped_tables": 0
  },
  "timetables": [{"identifier": "공유식별자", "term": "2024-1", "course_count": 1}],
  "course_attempts": [{
    "id": "결정적 UUID",
    "term": "2024-1",
    "lecture_code": "001234-01001",
    "course_name": "예시 과목",
    "professor": "예시 교수",
    "completion_status": "unconfirmed",
    "user_confirmed": false,
    "source": "everytime",
    "source_timetable_id": "공유식별자",
    "source_subject_id": "원본 과목 ID"
  }],
  "failures": [],
  "warnings": []
}
```

`lecture_code`는 응답의 `internal.value` 전체를 문자열 그대로 보존한다. 코드 분해·공식 과목 연결을 하지 않는다. 학점, 수업 시간·요일·강의실, 사용자 이름, XML 원문은 저장하지 않는다. 한 과목에 수업 일정이 여러 개 있어도 과목 한 건으로 저장한다.

같은 시간표의 같은 원본 과목 ID만 중복 제거한다. 이름이나 강좌코드만으로 합치지 않으며 학기가 다른 수강내역도 유지한다. 원본 과목 ID가 있으면 재수집해도 내부 ID가 같다. 없으면 XML 과목 순번을 사용하고 경고한다. 코드가 없는 수동 입력 과목은 `lecture_code: null`로 유지하고 연결 필수 정보 누락 경고를 남긴다.

`complete`는 공개 링크에서 발견한 시간표를 모두 조회했다는 뜻이다. 학생의 전체 이수내역이나 실제 이수 완료를 보증하지 않는다. 사용자 확인 전까지 모든 과목은 `unconfirmed`, `history_complete`는 `false`다. 정규학기 이수 횟수를 가져온 시간표 개수로 계산하지 않는다.

## Python에서 호출

```python
from everytime_import import collect, save_json

result = collect('https://everytime.kr/@공유식별자')
save_json(result, 'everytime_import/runtime/course_import.json')
# 입력 앱의 가져오기 어댑터는 수집 행을 학생 입력 v2 형식으로 바꾼다.
```

## 테스트

```powershell
python -B -m unittest discover -s everytime_import/tests -v
```

테스트는 가상 XML을 사용하며 실제 공유 링크를 호출하지 않는다. 실제 API 형식과 계절학기 값은 2026-11-12에 제공받은 공개 링크 응답을 통해 확인했다. 이후 서비스 응답이 변경되면 파서 수정이 필요할 수 있다.
