# 서울과기대 강의평가 별점

학교 GUEST 시간표의 강의계획서에서 볼 수 있는 **최근 강의평가 별점과 평가 학기**를 학과·학기별로 조회해 `class_stars.sqlite3`에 저장한다. 학교 화면의 1~5개 별 등급을 사용한다. 조회할 때 사용되는 교원 식별번호, 평가 원점수, 강의계획서 본문은 DB에 넣지 않는다. [서울과기대 공개 시간표](https://for-s.seoultech.ac.kr/html/pub/schedule.jsp)

2026-11-11에 조회한 컴퓨터공학과 2026학년도 2학기 분반 40개를 저장했다. 36개에서 별점을 확인했고 4개는 이전 평가가 없었다. 기존 개설과목 CSV의 분반 40개가 DB 키와 모두 일치한다.

## 실행

`class_stars` 폴더에서 Python 3.10 이상으로 실행한다. [강좌 수집기](../course_catalog/seoultech_courses.py)를 사용하며 추가 패키지나 계정은 필요 없다.

```powershell
python -B .\class_stars.py fetch --year 2026 --semester 2
python -B .\class_stars.py lookup 20262 109004 11001
```

`fetch`는 기본값으로 컴퓨터공학과를 조회한다. `--year`와 `--semester`를 함께 생략하면 학교 시간표의 기본 학기를 사용한다. `--department '학과명'` 또는 `--department-code 학과코드`로 다른 학과를 지정한다. 조회가 성공하면 해당 학기·학과만 갱신하고, 조회 중 서버 오류가 발생하면 기존 DB를 보존한다.

## 시간표 추천에 연결

`class_ratings`의 `term`, `department_code`, `subject_code`, `section`, `day_night`를 기존 개설과목 CSV의 `학년도학기`, `학과코드`, `교과목코드`, `강좌번호`, `주야구분`과 연결한다. `주간`은 `day`, `야간`은 `night`에 해당한다.

```sql
SELECT stars, evaluation_term, status, source
FROM class_ratings
WHERE term = '20262' AND department_code = '20030505'
  AND subject_code = '109004' AND section = '11001' AND day_night = 'day';
```

`evaluation_term`은 별점이 매겨진 과거 학기다. `term`은 학생이 신청하려는 개설 학기다. 같은 과목이라도 분반별 담당교원과 평가 학기가 다를 수 있다. `stars`가 NULL이면 강의계획서가 없거나, 과거 평가가 없거나, 화면에서 별점 대신 `-`로 표시된 경우다. 추천에 사용할 때는 평가 학기를 함께 보고 NULL은 미평가로 처리한다.

## 데이터 출처와 대안

- **학교 강의계획서**. GUEST 시간표에서 `강의계획서 보기`가 요청하는 데이터를 사용한다. 학교가 문서화한 Open API는 확인되지 않아 화면의 요청·표시 형식이 바뀌면 수정이 필요하다. 동봉 DB는 로컬 검토용이다. 공개 앱에서 표시하거나 반복 수집을 운영하기 전에는 학교에 집계 별점과 평가 학기의 제공·재이용 범위를 문의한다. [학교 공개 시간표](https://for-s.seoultech.ac.kr/html/pub/schedule.jsp) · [공공데이터 제공 문의](https://www.seoultech.ac.kr/service/pubinfo/pupdata)
- **에브리타임**. 학교·캠퍼스별 회원 서비스에서 강의평을 제공한다. 외부 앱에서 가져오는 공개 API는 확인되지 않았다. 에타 평점이 필요하면 비누랩스에 서울과기대 강의별 집계 별점·평가 건수의 제공 여부와 저장·표시 권한을 문의할 수 있다. [에브리타임 강의평가 FAQ](https://everytime.kr/page/faq?category=etc) · [비누랩스 제휴 문의](https://www.vinuteam.com/contact/partner)
- **학생 직접 평가**. 자체적으로 수강생의 평가를 받아 강좌별 별점과 응답 수를 집계하는 방법도 있다. 학교 강의평가 등급과 자체 평점은 출처와 평가 방식이 달라 각각 표시한다.
