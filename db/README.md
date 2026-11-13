# 서울과기대 학기별 개설강좌 DB

## 에브리타임 별점

에브리타임에 로그인해 시간표의 **수업 목록에서 검색**을 연다. 교양 전체를 수집하려면 전공/영역은 전체, 구분은 기필·교필·교선으로 설정한다. 개발자 도구의 Network에서 첫 검색과 목록 하단 스크롤마다 반환되는 Response XML을 복사한다. UTF-8 파일 한 개에 여러 응답을 이어 붙이거나 여러 파일로 저장할 수 있다. 공식 목록과 대조한 뒤 빠진 분반만 추가 검색한다.

저장소 루트에서 실행한다. 파일 이름은 캡처한 파일로 바꾼다.

~~~powershell
python -B -m crawl_module.everytime_ratings --term 2026-2 --general --dry-run first.xml next.xml
python -B -m crawl_module.everytime_ratings --term 2026-2 --general first.xml next.xml
python -B -m crawl_module.everytime_ratings --term 2026-2 --department-code 20030505 --shift day major.xml
~~~

활성 공식 스냅샷에서 강좌코드·과목명·교수명이 일치하는 분반을 `db/everytime_ratings.sqlite3`에 저장한다. `offering_id`가 기본 키이고 `lecture_id`는 에브리타임 출처 식별값이다. XML의 `now`는 원본 시각 기준으로 `observed_at`에, 가져오기 시각은 UTC `imported_at`에 기록한다. 별점 `0`은 `unrated`와 NULL로 저장한다. 더 최근에 확인한 별점으로 갱신하고, 미확보 분반은 실행 결과에 표시한다.

별점 DB는 공식 강좌 DB와 함께 Git으로 공유한다. 기본 파일에는 2026년 2학기 컴퓨터공학과 주간 40개와 교양 685개 분반이 들어 있다. 팀원은 `git clone` 또는 `git pull` 후 기본 설정으로 앱을 실행하면 된다. 별점을 다시 수집할 때는 현재 활성 공식 스냅샷과의 대조 결과를 확인한 뒤 갱신된 DB를 커밋한다.

과거 이수내역을 대조할 때 사용할 개설강좌 목록이다. 실제 학생 이수 여부나 성적은 별도 학생 자료로 확인한다. 수집 범위는 컴퓨터공학과 강좌, 전체 개설 조직의 교필·교선, 교양대학 기필이다. 학교 공개 목록에서 확인되는 학기만 적재할 수 있다. 외부 시간표의 내부 강좌코드와 학교 코드가 같다고 가정하지 않는다.

## 사용법

아래 명령은 이 폴더에서 실행한다. Python 3.10 이상을 사용한다.

~~~powershell
python -B .\courses_db.py list
python -B .\courses_db.py lookup 2026-2 알고리즘
python -B .\courses_db.py lookup 2026-2 109180
python -B .\courses_db.py sync 2026-2
python -B .\courses_db.py sync 2023-1 2023-2 2026-1
python -B .\courses_db.py backup .\courses-backup.sqlite3
~~~

`sync`는 기존 `crawl_module/all/seoultech_courses.py`의 조회 함수를 직접 사용한다. 명시한 학기의 학과 목록과 주간·야간 개설강좌를 가져오며 학기별로 검증하고 저장한다. 여러 학기를 한 번에 요청하면 앞 학기의 성공분은 유지되고, 오류가 난 학기에서 중단한다. 실용영어의사소통은 학교 목록에 교필·교선으로 개설된 학기에 포함된다.

`courses.sqlite3`에서 `snapshots`는 적재본의 학기·출처·건수·해시를, `active_terms`는 학기별 활성 버전을, `course_offerings`는 분반별 검색 컬럼과 상세 JSON을 보관한다. 과목코드와 분반번호는 문자열로 보존한다. 분반 ID는 학기·과목코드·분반번호·주야 코드 조합이다. 학기별 공식 강좌 갱신에는 공통 `sync` 경로를 사용한다. 계절학기는 전공 분반이 없어도 교양 강좌가 조회되면 적재한다. `import-csv`는 기존 CSV를 별도로 검증할 때 사용하는 명령이며, 입력 파일에 따라 상세 필드가 다를 수 있다.

동일 데이터 재적재 시 기존 버전을 재사용한다. 자료를 바꾸면 새 버전이 쌓인다. 복구할 때는 `list`에서 이전 버전 번호를 확인하고 `python -B .\courses_db.py activate 2026-2 <버전번호>`로 되돌린다. 백업은 새 파일 경로를 지정한다. `courses.sqlite3`와 `everytime_ratings.sqlite3`를 공유하며, 백업과 SQLite 임시 파일은 Git에서 제외한다.
