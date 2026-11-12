# 학생 정보·이수 내역 입력 앱

학생 정보와 수강 내역을 입력하고 SQLite에 저장하는 Python·HTML·JavaScript 로컬 앱입니다.

## 실행

프로젝트 루트에서 실행합니다. Python 3.10 이상이 필요합니다.

~~~powershell
python -B -m intake_app.server
~~~

이 컴퓨터에서 기본 python 명령이 Windows 앱 실행 별칭으로 연결된 경우 번들 Python을 사용할 수 있습니다.

~~~powershell
$pythonExe = 'C:\Program Files\WindowsApps\OpenAI.CodexPrimaryRuntime.v26-1110-973-0_26.1110.973.0_x64__3k8sg7r9htsxt\dependencies\python\python.exe'
& $pythonExe -B -m intake_app.server
~~~

브라우저에서 [로컬 앱](http://127.0.0.1:8765)을 엽니다. 포트와 저장 경로는 --port 및 --db로 지정할 수 있습니다. 종료는 터미널에서 Ctrl+C입니다.

## 입력과 저장

- 학생 기본정보와 다음 학기 선호를 입력합니다.
- 과목을 직접 추가하고 수강 학기·요일·시간·장소와 이수 상태를 기록합니다. 과목 정보를 수정하면 이전 확인이 해제됩니다.
- 임시 저장하거나 입력을 확인한 뒤 저장합니다. 필요한 경우 JSON을 내려받을 수 있습니다.

기본 저장 파일은 intake_app/runtime/student_inputs.sqlite이며 앱이 시작할 때 생성됩니다. JSON의 completed_courses에는 사용자가 확인한 이수 완료 과목이 들어갑니다. 다른 탭에서 먼저 저장한 내용이 있으면 버전 충돌을 표시합니다.

## 테스트

~~~powershell
python -B -m unittest discover -s intake_app/tests -v
~~~
