# 서울과기대 강의 건물 거리

서울과기대 공릉캠퍼스에서 강의·실습 공간이 확인된 23개 건물을 목록에 담았다. 그중 좌표가 확인된 22개 건물의 위·경도와 서로 다른 건물 231쌍의 거리를 `campus_distances.sqlite3`에 저장했다. 학군단은 수업 배정이 확인됐지만 OSM에서 부지 경계만 확인되어 좌표와 거리값이 비어 있다.

## 포함 기준

2026-11-11 기준, 2026학년도 2학기 공개 시간표의 학과·전공·기관 검색 항목 74개를 주·야간으로 조회했다. 중복을 제거한 1,990개 분반에서 강의실이 배정된 건물과 학교 자료에서 강의·실습 장소로 확인한 건물을 포함했다. 체육관, 도예실습실, 건축 설계 스튜디오가 있는 무궁관-A, 골프 실습이 진행되는 제1파워플랜트도 포함한다. 청운관 남관·북관은 학교 건물번호 6번을 사용한다. [공개 시간표](https://for-s.seoultech.ac.kr/html/pub/schedule.jsp) · [무궁관 시설 안내](https://newsletter.seoultech.ac.kr/enewspaper/mainview.php?mvid=223) · [골프 실습 안내](https://times.seoultech.ac.kr/reports?category=44&idx=22228) · [청운관 건물번호 안내](https://www.seoultech.ac.kr/service/info/notice/?bidx=554184&bnum=4691&do=commonview)

불암학사, KB학사, 성림학사, 수림학사, 누리학사, 창명학사 등 기숙사 6곳과 대학본부·어린이집 등 강의·실습 장소로 확인되지 않은 시설은 목록에서 제외했다. 하이테크관은 기존 건물 철거 및 신축 공사 중이다. [학교 생활관 안내](https://www.seoultech.ac.kr/life/support/life) · [하이테크관 공사 공지](https://seoultech.ac.kr/service/info/notice?bidx=890360&bnum=4691&do=commonview)

## 조회

Python 3.10 이상에서 추가 패키지나 API 키 없이 실행한다. PowerShell에서 이 폴더를 열고 아래 명령을 실행하면 된다.

```powershell
python .\classroom_dist.py distance '아름관-405' '미래관-313'
python .\classroom_dist.py distance 'Techno Cube(테크노 큐브)-403' '미래관-B104'
python .\classroom_dist.py distance 54 60
python .\classroom_dist.py audit '..\course_catalog\2026_2_컴퓨터공학과_개설과목.csv'
```

기존 컴퓨터공학과 CSV의 40개 분반을 검사했다. 세 건물에 속한 강의실이 모두 매핑됐고, 한 칸에 여러 호실이 있는 행도 확인했다.

| 건물 A | 건물 B | 직선거리 |
| --- | --- | ---: |
| 아름관 | 미래관 | 96.7 m |
| 미래관 | Techno Cube | 153.0 m |
| 아름관 | Techno Cube | 84.3 m |

## 시간표 추천에 연결

`buildings`에는 학교 건물번호(`building_id`), 건물명, WGS84 위·경도, OSM 출처 링크, 매핑 상태가 들어 있다. `building_aliases`의 `lookup_key`는 건물명·별칭·번호를 유니코드 NFKC로 정규화하고 영문 대소문자와 공백 차이를 없앤 값이다. Python에서 `resolve_building(db, 강의실_문자열)`로 건물번호, 건물명, 상태를 얻을 수 있다. CSV의 한 셀에 여러 호실이 들어 있는 경우 `building_names(셀_문자열)`으로 건물명들을 얻을 수 있다.

`building_distances`는 출발·도착 건물번호로 조회한다. 두 방향과 동일 건물의 0 m가 들어 있어 매핑된 22개 건물 기준 총 484행이다. 좌표가 없는 건물은 거리 행이 없으므로, 거리 조회 결과가 비어 있으면 미확인 상태로 처리한다.

```sql
SELECT straight_line_m
FROM building_distances
WHERE from_building_id = '54' AND to_building_id = '60';
```

거리는 건물 외곽 도형의 면적 중심점 사이를 하버사인 공식으로 계산한 미터값이다. 내부 중정은 중심점 계산에서 면적을 빼고, 여러 동으로 묶인 건물은 외곽 도형의 면적으로 가중한다. 무궁관 고층부(57)와 저층부(57-A)는 학교 지도에서 위치를 대조해 OSM 관계의 북쪽·남쪽 도형을 각각 사용했다. 도보 동선, 출입구, 층간 이동은 계산에 포함되지 않는다.

## 출처와 재생성

위치 원본은 **OpenStreetMap API v0.6**의 `GET /api/0.6/map`으로 받았다. 학교 주변의 작은 범위에서 건물의 점·외곽선·관계를 한 번에 받아 건물별 중심을 계산할 수 있고, ODbL 공개 데이터라 좌표와 파생 거리표를 저장해 재사용할 수 있다. 카카오 로컬 API의 운영 안내에서는 반환된 위·경도 저장을 허용하지 않는다. [OSM API 문서](https://wiki.openstreetmap.org/wiki/API_v0.6#Retrieving_map_data_by_bounding_box:_GET_/api/0.6/map) · [OSM 라이선스](https://www.openstreetmap.org/copyright) · [카카오 운영 안내](https://devtalk.kakao.com/t/api/151497)

건물번호와 명칭은 학교 캠퍼스 지도 및 2025년 대학요람과 대조했다. 무궁관 저층부 번호는 학교 건물번호 안내에서 추가로 확인했다. [서울과기대 캠퍼스지도](https://www.seoultech.ac.kr/site/www/intro/map/map_ajax.jsp) · [2025 대학요람](https://www.seoultech.ac.kr/storage/www/brochure/SNUST6AB7F47939E14EAEB04FA09523EACA83.pdf) · [건물번호 안내](https://health.seoultech.ac.kr/info/aed)

`buildings.json`은 학교 건물번호와 OSM 객체의 매핑이다. `osm_buildings.osm`은 API 응답에서 매핑에 쓰인 객체만 추린 자료다. 전체 거리 DB는 동봉된 도형으로 오프라인에서 재생성할 수 있다. 도형 검증이나 DB 생성이 실패하면 기존 DB를 보존한다.

```powershell
python .\classroom_dist.py build
```

`build --online`은 지정된 OSM 객체의 도형을 읽기 전용 Overpass API로 한 번에 조회한다. 실행 환경의 Overpass 연결이 시간 초과되어 동봉 DB는 검증된 v0.6 응답으로 생성했다. 캠퍼스에 건물이 추가되거나 OSM 객체가 교체되면 `buildings.json`의 대응표를 갱신한다. [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)

지도 데이터와 여기서 계산한 거리 데이터의 출처는 **© OpenStreetMap contributors, ODbL 1.0**이다. 외부에 공개할 때는 출처 표시와 파생 데이터베이스에 적용되는 ODbL 조건을 따른다. [OSM 저작권 및 이용 조건](https://www.openstreetmap.org/copyright)
