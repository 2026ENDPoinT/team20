# 서울과기대 학기별 개설강좌 DB

과거 이수내역을 대조할 때 사용할 개설강좌 목록이다. 실제 학생 이수 여부나 성적은 별도 학생 자료로 확인한다. 수집 범위는 컴퓨터공학과 강좌, 전체 개설 조직의 교필·교선, 교양대학 기필이다. 학교 공개 목록에서 확인되는 학기만 적재할 수 있다. 외부 시간표의 내부 강좌코드와 학교 코드가 같다고 가정하지 않는다.

## 사용법

아래 명령은 이 폴더에서 실행한다. Python 3.10 이상을 사용한다.

~~~powershell
python -B .\courses_db.py list
python -B .\courses_db.py lookup 2026-2 알고리즘
python -B .\courses_db.py lookup 2026-2 109180
python -B .\courses_db.py import-csv 2026-2 ..\crawl_module\only_2026-2\courses-2026-2.csv
python -B .\courses_db.py sync 2023-1 2023-2 2026-1
python -B .\courses_db.py backup .\courses-backup.sqlite3
~~~

`sync`는 기존 `crawl_module/all/seoultech_courses.py`의 조회 함수를 직접 사용한다. 명시한 학기의 학과 목록과 주간·야간 개설강좌를 가져오며 학기별로 검증하고 저장한다. 여러 학기를 한 번에 요청하면 앞 학기의 성공분은 유지되고, 오류가 난 학기에서 중단한다. 실용영어의사소통은 학교 목록에 교필·교선으로 개설된 학기에 포함된다.

`courses.sqlite3`에서 `snapshots`는 적재본의 학기·출처·건수·해시를, `active_terms`는 학기별 활성 버전을, `course_offerings`는 분반별 검색 컬럼과 상세 JSON을 보관한다. 과목코드와 분반번호는 문자열로 보존한다. 분반 ID는 학기·과목코드·분반번호·주야 코드 조합이다. 기존 통합 CSV에 있는 영역 값은 유지하고, 다른 학기를 직접 수집할 때는 과거 교양 영역을 추정하지 않는다.

동일 데이터 재적재 시 기존 버전을 재사용한다. 자료를 바꾸면 새 버전이 쌓인다. 복구할 때는 `list`에서 이전 버전 번호를 확인하고 `python -B .\courses_db.py activate 2026-2 <버전번호>`로 되돌린다. 백업은 새 파일 경로를 지정한다. DB 파일과 백업은 이 폴더의 Git 규칙에서 제외한다.
