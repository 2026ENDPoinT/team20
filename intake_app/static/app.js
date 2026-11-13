'use strict';
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const days = {MON:'월',TUE:'화',WED:'수',THU:'목',FRI:'금',SAT:'토',SUN:'일'};
const statuses = {unconfirmed:'이수 여부 미확인',completed:'이수 완료',in_progress:'수강 중',not_completed:'미이수 / 취소 / F'};
const initial = () => ({kind:'student_input',schema_version:2,student:{department_id:'DEPT_CS',admission_year:null,grade:null,admission_type:'freshman',program_type:null,regular_terms_completed:null,target_term:null,min_credits:null,max_credits:null,interests:[],recognition_notes:'',transfer_recognized_credits:null},history_complete:false,course_attempts:[]});
let state=initial(), version=0, csrf='', step=1, dirty=false, edits=0, saving=false, importPreview=null, importing=false;
const fields={'admission-year':'admission_year',grade:'grade',department:'department_id','admission-type':'admission_type','program-type':'program_type','regular-terms':'regular_terms_completed','target-term':'target_term','min-credits':'min_credits','max-credits':'max_credits','recognition-notes':'recognition_notes','transfer-credits':'transfer_recognized_credits'};
const numeric = new Set(['admission_year','grade','min_credits','max_credits','transfer_recognized_credits','regular_terms_completed']);
const tags=['인공지능','경제·금융','심리','예술·문화','사회·정치','역사','과학기술','철학·윤리','창업','글쓰기'];
function message(text,type='info'){$('#message').textContent=text;$('#message').className='message '+type;$('#message').hidden=false;}
function touch(){clearImportPreview();clearComparison();dirty=true;edits++;$('#save-state').textContent='저장하지 않은 변경사항이 있어요';}
async function api(path,payload){const options=payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':csrf},body:JSON.stringify(payload)};const response=await fetch(path,options);let data;try{data=await response.json();}catch{throw new Error('서버 응답을 읽을 수 없습니다. 서버 실행 상태를 확인해주세요.');}if(!response.ok)throw new Error(data.error||'요청에 실패했습니다.');return data;}
function fillProfile(){for(const [id,key] of Object.entries(fields))$('#'+id).value=state.student[key]??'';$('#history-complete').checked=state.history_complete;$('#transfer-box').hidden=state.student.admission_type!=='transfer';renderTags();}
function renderTags(){const all=[...new Set([...tags,...state.student.interests])];$('#tags').innerHTML=all.map(tag=>`<button class="tag ${state.student.interests.includes(tag)?'selected':''}" aria-pressed="${state.student.interests.includes(tag)}" data-tag="${esc(tag)}">${esc(tag)}</button>`).join('');}
function switchStep(value){step=value;for(let i=1;i<=3;i++){$('#step-'+i).hidden=i!==step;document.querySelector(`[data-step="${i}"]`).classList.toggle('active',i===step);}$('#next').textContent=step===1?'이수 내역 입력 →':step===2?'입력 내용 확인 →':'확인 완료 및 저장';if(step===3)renderSummary();window.scrollTo({top:0,behavior:'smooth'});}
const options=(mapping,current,empty)=>`<option value="">${empty}</option>`+Object.entries(mapping).map(([key,label])=>`<option value="${key}" ${key===current?'selected':''}>${label}</option>`).join('');
const termPattern = /^(19|20)\d{2}-(1|2|summer|winter)$/;
const courseSources = {manual:'직접 입력',ai:'이전 입력',sample:'예시 데이터',everytime:'에브리타임'};
const excludedCourses = new Set();
let editingCourseId = null;

function canConfirm(course) {
  return Boolean(course.course_name.trim() && termPattern.test(course.term ?? ''));
}

function updateSelection(checkboxes, master, button, label) {
  const rows = [...document.querySelectorAll(checkboxes)];
  const selected = rows.filter(input => input.checked).length;
  const all = $(master);
  if (all) {
    all.disabled = rows.length === 0;
    all.checked = rows.length > 0 && selected === rows.length;
    all.indeterminate = selected > 0 && selected < rows.length;
  }
  $(button).disabled = selected === 0;
  $(label).textContent = rows.length ? `${rows.length}건 중 ${selected}건 선택` : '선택할 과목이 없습니다.';
}

function updateCourseSelection() {
  updateSelection('[data-course-selection]:enabled', '#select-all-courses', '#confirm-selected', '#course-selection');
}

function courseDetails(course) {
  const c = course;
  return `<tr data-id="${esc(c.id)}" class="course-detail-row"${editingCourseId===c.id?'':' hidden'}><td colspan="6">
    <div class="course-fields">
      <label>과목명<input data-field="course_name" maxlength="200" value="${esc(c.course_name)}"></label>
      <label>수강 학기<input data-field="term" value="${esc(c.term)}" placeholder="예: 2026-2" list="terms"></label>
      <label>강좌코드<input data-field="lecture_code" maxlength="100" value="${esc(c.lecture_code)}"></label>
      <label>교수명<input data-field="professor" maxlength="200" value="${esc(c.professor)}"></label>
    </div>
    ${(c.meetings ?? []).map((m,i)=>`<div class="meeting" data-meeting="${i}"><label>요일<select data-meeting-field="day">${options(days,m.day,'미확인')}</select></label><label>시작<input type="time" data-meeting-field="start_time" value="${esc(m.start_time)}"></label><label>종료<input type="time" data-meeting-field="end_time" value="${esc(m.end_time)}"></label><label>장소<input data-meeting-field="locations" value="${esc(m.locations.join(', '))}"></label><button class="meeting-remove" data-action="remove-meeting" aria-label="수업 시간 삭제">×</button></div>`).join('')}
    ${c.extraction_warnings?.length ? '<div class="course-warning">'+c.extraction_warnings.map(esc).join('<br>')+'</div>' : ''}
    ${c.course_name_raw ? '<details class="raw"><summary>과목명 원문 보기</summary>'+esc(c.course_name_raw)+'</details>' : ''}
    <label class="raw">확인 메모<textarea data-field="review_notes" maxlength="2000">${esc(c.review_notes)}</textarea></label>
    <div class="button-row">
      ${c.source==='everytime'?'':'<button class="button subtle add-meeting" data-action="add-meeting">＋ 수업 시간</button>'}
      <button class="delete" data-action="delete">과목 삭제</button>
    </div>
  </td></tr>`;
}

function renderCourses() {
  const courses = state.course_attempts;
  $('#course-count').textContent = courses.length;
  $('#course-selection-toolbar').hidden = !courses.length;
  if (!courses.length) {
    $('#course-list').innerHTML = '<div class="empty"><strong>등록한 과목이 없습니다</strong>공유 링크로 가져오거나 과목을 직접 추가하세요.</div>';
    return;
  }
  $('#course-list').innerHTML = `<table class="course-table"><thead><tr>
    <th scope="col"><input id="select-all-courses" type="checkbox" aria-label="미확인 과목 모두 선택"></th>
    <th scope="col">과목</th><th scope="col">학기</th><th scope="col" class="course-code">강좌코드</th><th scope="col">이수 상태</th><th scope="col">편집</th>
  </tr></thead><tbody>${courses.map(c => {
    const selectable = !c.user_confirmed && canConfirm(c);
    const name = c.course_name || '과목명 미입력';
    return `<tr class="course-row" data-id="${esc(c.id)}">
      <td><input type="checkbox" data-course-selection aria-label="${esc(name)} 선택" ${selectable&&!excludedCourses.has(c.id)?'checked':''} ${selectable?'':'disabled'}></td>
      <td><strong data-course-name>${esc(name)}</strong><small data-course-info>${esc([c.professor,courseSources[c.source]].filter(Boolean).join(' · '))}</small></td>
      <td data-course-term>${esc(c.term || '—')}</td><td class="course-code" data-course-code>${esc(c.lecture_code || '—')}</td>
      <td><select data-field="completion_status" aria-label="${esc(name)} 이수 상태">${Object.entries(statuses).map(([value,label])=>`<option value="${value}" ${value===c.completion_status?'selected':''}>${label}</option>`).join('')}</select></td>
      <td><button class="button subtle course-edit" data-action="edit" aria-expanded="${editingCourseId===c.id}">상세</button></td>
    </tr>${courseDetails(c)}`;
  }).join('')}</tbody></table>`;
  updateCourseSelection();
}

function refreshCourseRow(course, row) {
  row.querySelector('[data-course-name]').textContent = course.course_name || '과목명 미입력';
  row.querySelector('[data-course-info]').textContent = [course.professor, courseSources[course.source]].filter(Boolean).join(' · ');
  row.querySelector('[data-course-term]').textContent = course.term || '—';
  row.querySelector('[data-course-code]').textContent = course.lecture_code || '—';
  const status = row.querySelector('[data-field="completion_status"]');
  status.value = course.completion_status;
  status.setAttribute('aria-label', (course.course_name || '과목') + ' 이수 상태');
  const checkbox = row.querySelector('[data-course-selection]');
  checkbox.setAttribute('aria-label', (course.course_name || '과목') + ' 선택');
  checkbox.disabled = course.user_confirmed || !canConfirm(course);
  checkbox.checked = !checkbox.disabled && !excludedCourses.has(course.id);
  updateCourseSelection();
}
function renderSummary(){
 const courses=state.course_attempts, done=courses.filter(c=>c.user_confirmed&&c.completion_status!=='unconfirmed'&&c.course_name&&c.term);
 $('#summary-stats').innerHTML=[['입력한 과목',courses.length],['확인한 과목',done.length],['이수 완료',done.filter(c=>c.completion_status==='completed').length]].map(([label,count])=>`<div class="stat">${label}<strong>${count}<small> 과목</small></strong></div>`).join('');
 const p=state.student;$('#summary-profile').textContent=`컴퓨터공학과 · ${p.admission_year||'입학연도 미입력'} · ${p.grade? p.grade+'학년':'학년 미입력'} · ${p.admission_type==='transfer'?'편입학':'신입학'} / 추천 학기: ${p.target_term||'미입력'} / 관심 주제: ${p.interests.join(', ')||'미선택'}`;
 $('#summary-table').innerHTML=`<table><thead><tr><th>과목</th><th>수강 학기</th><th>강좌코드</th><th>이수 상태</th><th>확인</th></tr></thead><tbody>${courses.map(c=>`<tr><td>${esc(c.course_name)||'미입력'}${c.source==='sample'?'<small>예시 데이터</small>':''}</td><td>${esc(c.term)||'미확인'}</td><td>${esc(c.lecture_code)||'미입력'}</td><td>${statuses[c.completion_status]}</td><td>${c.user_confirmed?'확인함':'확인 필요'}</td></tr>`).join('')}</tbody></table>`;
 const warnings=[];if(!state.history_complete)warnings.push('일부 수강 내역만 입력한 상태입니다.');if(done.length<courses.length)warnings.push(`${courses.length-done.length}개 과목의 이름·학기·이수 상태를 검토해주세요.`);if(courses.some(c=>c.source==='sample'))warnings.push('예시 과목이 포함되어 있습니다. 본인의 이수 내역인지 확인해주세요.');
 $('#review-warnings').innerHTML=warnings.map(w=>`<p class="notice">${esc(w)}</p>`).join('');
}
async function save(reviewed=false){if(saving||importing)return;clearImportPreview();clearComparison();saving=true;$('#save').disabled=true;$('#next').disabled=true;const start=edits;try{const result=await api('/api/input',{document:state,version,reviewed});version=result.version;if(edits===start){state=result.document;dirty=false;fillProfile();renderCourses();if(step===3)renderSummary();$('#save-state').textContent=(reviewed?'확인 완료 · ':'임시 저장 · ')+new Date(result.updated_at).toLocaleTimeString('ko-KR');}else $('#save-state').textContent='저장 중 추가 변경이 있어요. 한 번 더 저장해주세요.';message((reviewed?'입력 확인을 완료하고 저장했습니다.':'임시 저장했습니다.')+(result.warnings.length?' '+result.warnings.join(' '):''),'success');}catch(error){message(error.message,'error');}finally{saving=false;$('#save').disabled=false;$('#next').disabled=false;}}
function addManual() {
  editingCourseId = crypto.randomUUID();
  state.course_attempts.push({
    id: editingCourseId,
    lecture_code: null,
    professor: null,
    source_ref: null,
    course_name: '',
    term: $('#bulk-term').value.trim() || null,
    meetings: [{day: null, start_time: null, end_time: null, locations: []}],
    completion_status: 'unconfirmed',
    user_confirmed: false,
    source: 'manual',
    extraction_ids: [],
    review_notes: '',
    extraction_warnings: [],
  });
  touch();
  renderCourses();
  $('#course-list .course-detail-row:not([hidden]) [data-field="course_name"]').focus();
}
function mergeCourses(){const grouped=new Map(),merged=[];let count=0;for(const c of state.course_attempts){const key=c.source!=='everytime'&&!c.lecture_code&&c.term&&c.course_name.trim()?c.term+'|'+c.course_name.replace(/\s+/g,'').toLowerCase():c.id;if(!grouped.has(key)){grouped.set(key,c);merged.push(c);continue;}const first=grouped.get(key);first.meetings??=[];for(const m of c.meetings??[])if(!first.meetings.some(existing=>JSON.stringify(existing)===JSON.stringify(m)))first.meetings.push(m);first.extraction_ids=[...new Set([...(first.extraction_ids??[]),...(c.extraction_ids??[])])];first.extraction_warnings=[...new Set([...(first.extraction_warnings??[]),...(c.extraction_warnings??[]),'사용자가 동명 과목을 묶었습니다. 같은 과목인지 다시 확인해주세요.'])];first.course_name_raw=[...new Set([first.course_name_raw,c.course_name_raw])].filter(Boolean).join(' / ');first.review_notes=[first.review_notes,c.review_notes].filter(Boolean).join('\n');first.completion_status='unconfirmed';if(c.source==='sample')first.source='sample';first.user_confirmed=false;count++;}state.course_attempts=merged;if(count)touch();renderCourses();message(count?`${count}개 중복 항목을 묶었습니다. 수업 시간과 이수 상태를 다시 확인해주세요.`:'묶을 동명 과목이 없습니다. 학기가 같은 항목만 묶습니다.');}
document.querySelectorAll('[data-step]').forEach(button=>button.addEventListener('click',()=>switchStep(Number(button.dataset.step))));
for(const [id,key] of Object.entries(fields))$('#'+id).addEventListener('input',event=>{let value=event.target.value;state.student[key]=numeric.has(key)?(value===''?null:Number(value)):value;if((key==='target_term'||key==='program_type')&&!value)state.student[key]=null;if(key==='admission_type')$('#transfer-box').hidden=value!=='transfer';touch();});
$('#tags').addEventListener('click',event=>{const tag=event.target.closest('[data-tag]')?.dataset.tag;if(!tag)return;if(state.student.interests.includes(tag))state.student.interests=state.student.interests.filter(t=>t!==tag);else if(state.student.interests.length<20)state.student.interests.push(tag);else return message('관심 태그는 최대 20개입니다.','error');touch();renderTags();});
$('#add-tag').addEventListener('click',()=>{const tag=$('#custom-tag').value.trim();if(!tag)return;if(!state.student.interests.includes(tag)){if(state.student.interests.length>=20)return message('관심 태그는 최대 20개입니다.','error');state.student.interests.push(tag);touch();}$('#custom-tag').value='';renderTags();});
$('#custom-tag').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('#add-tag').click();}});
function setCourseSelected(checkbox, selected) {
  checkbox.checked = selected;
  const id = checkbox.closest('[data-id]').dataset.id;
  if (selected) excludedCourses.delete(id);
  else excludedCourses.add(id);
}

$('#course-list').addEventListener('input', event => {
  const input = event.target;
  if (input.id === 'select-all-courses') {
    for (const checkbox of document.querySelectorAll('[data-course-selection]:enabled')) {
      setCourseSelected(checkbox, input.checked);
    }
    updateCourseSelection();
    return;
  }
  const row = input.closest('[data-id]');
  if (!row) return;
  const course = state.course_attempts.find(item => item.id === row.dataset.id);
  if (input.hasAttribute('data-course-selection')) {
    setCourseSelected(input, input.checked);
    updateCourseSelection();
    return;
  }
  const field = input.dataset.field;
  const meetingField = input.dataset.meetingField;
  if (field === 'completion_status') {
    if (input.value !== 'unconfirmed' && !canConfirm(course)) {
      input.value = course.completion_status;
      return message('과목명과 올바른 수강 학기를 먼저 입력해주세요.', 'error');
    }
    course.completion_status = input.value;
    course.user_confirmed = input.value !== 'unconfirmed';
    excludedCourses.delete(course.id);
  } else if (field) {
    course[field] = ['term','lecture_code','professor'].includes(field) ? input.value || null : input.value;
    if (field !== 'review_notes') {
      course.user_confirmed = false;
      course.completion_status = 'unconfirmed';
    }
  } else if (meetingField) {
    const meeting = course.meetings[Number(input.closest('[data-meeting]').dataset.meeting)];
    meeting[meetingField] = meetingField === 'locations'
      ? input.value.split(',').map(value => value.trim()).filter(Boolean)
      : input.value || null;
  } else {
    return;
  }
  touch();
  refreshCourseRow(course, row.classList.contains('course-row') ? row : row.previousElementSibling);
});

$('#course-list').addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const course = state.course_attempts.find(row => row.id === button.closest('[data-id]').dataset.id);
  const action = button.dataset.action;
  if (action === 'edit') {
    editingCourseId = editingCourseId === course.id ? null : course.id;
    for (const detail of document.querySelectorAll('.course-detail-row')) {
      detail.hidden = detail.dataset.id !== editingCourseId;
      detail.previousElementSibling.querySelector('[data-action="edit"]').setAttribute('aria-expanded', !detail.hidden);
    }
    return;
  }
  if (action === 'delete') {
    state.course_attempts = state.course_attempts.filter(row => row.id !== course.id);
    excludedCourses.delete(course.id);
    if (editingCourseId === course.id) editingCourseId = null;
  }
  if (action === 'add-meeting') (course.meetings ??= []).push({day:null,start_time:null,end_time:null,locations:[]});
  if (action === 'remove-meeting') course.meetings.splice(Number(button.closest('[data-meeting]').dataset.meeting), 1);
  touch();
  renderCourses();
});

$('#confirm-selected').addEventListener('click', () => {
  const selected = new Set([...document.querySelectorAll('[data-course-selection]:checked:enabled')]
    .map(input => input.closest('[data-id]').dataset.id));
  if (!selected.size) return;
  for (const course of state.course_attempts) {
    if (!selected.has(course.id)) continue;
    course.completion_status = 'completed';
    course.user_confirmed = true;
  }
  touch();
  renderCourses();
  message(`선택한 ${selected.size}건을 이수 완료로 표시했습니다.`, 'success');
});
$('#add-course').addEventListener('click', addManual);
$('#merge').addEventListener('click', mergeCourses);
$('#apply-term').addEventListener('click',()=>{const value=$('#bulk-term').value.trim();if(!termPattern.test(value))return message('학기 형식을 확인해주세요. 예: 2026-2','error');let count=0;for(const c of state.course_attempts)if(!c.term){c.term=value;c.user_confirmed=false;count++;}if(count)touch();renderCourses();message(`${count}개 과목에 학기를 적용했습니다.`);});
$('#history-complete').addEventListener('change',event=>{state.history_complete=event.target.checked;touch();renderSummary();});$('#save').addEventListener('click',()=>save());$('#next').addEventListener('click',()=>step<3?switchStep(step+1):save(true));
$('#export').addEventListener('click',()=>{const payload={...state,course_attempts:state.course_attempts.map(({meetings,course_name_raw,extraction_ids,extraction_warnings,...row})=>({...row,completion_status:row.user_confirmed?row.completion_status:'unconfirmed'}))};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='student-input.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
async function init() {
  try {
    const config = await api('/api/config');
    csrf = config.csrf_token;
    const saved = await api('/api/input');
    if (saved.document) {
      state = saved.document;
      version = saved.version;
      const label = saved.review_state === 'reviewed' ? '확인 완료 저장본' : '임시 저장본';
      $('#save-state').textContent = label + '을 불러왔어요';
    }
    fillProfile();
    renderCourses();
  } catch (error) {
    message(error.message, 'error');
    $('#save').disabled = true;
    $('#next').disabled = true;
  }
}

function clearImportPreview() {
  importPreview = null;
  $('#import-preview').hidden = true;
  $('#import-table').replaceChildren();
}

function clearComparison() {
  $('#comparison-summary').textContent = '';
  $('#comparison-table').replaceChildren();
}

const importActions = {add:'추가', update:'변경', unchanged:'이미 가져옴', review:'직접 확인 필요'};
const importFields = {term:'학기',lecture_code:'강좌코드',course_name:'과목명',professor:'교수명'};

function renderImportPreview(preview) {
  const changes = new Map(preview.changes.map(change => [change.incoming_attempt_id, change]));
  const failures = preview.summary.failed_or_skipped_tables;
  const missing = preview.issues.filter(issue => issue.code === 'missing_matching_fields').length;
  $('#import-summary').textContent = [
    `과목 ${preview.course_attempts.length}건`,
    failures ? `조회하지 못한 시간표 ${failures}개` : '',
    missing ? `강좌코드 또는 과목명 확인 필요 ${missing}건` : '',
  ].filter(Boolean).join(' · ');
  $('#import-table').innerHTML = `<table><thead><tr><th><input id="select-all-imports" type="checkbox" aria-label="가져올 과목 모두 선택"></th><th>과목</th><th>학기</th><th>강좌코드</th><th>상태</th></tr></thead><tbody>
    ${preview.course_attempts.map(row => {
      const change = changes.get(row.id);
      const selectable = change.action === 'add' || change.action === 'update';
      const differences = change.changed_fields.map(field =>
        `<small>${importFields[field]} ${esc(change.previous_values[field] ?? '없음')} → ${esc(row[field] ?? '없음')}</small>`).join('');
      return `<tr><td>${selectable ? `<input type="checkbox" value="${esc(row.id)}" data-import-action="${change.action}" aria-label="${esc(row.course_name || '이름 미입력 과목')}" ${change.action==='add'?'checked':''}>` : ''}</td>
        <td>${esc(row.course_name || '이름 미입력')}${row.professor ? `<small>${esc(row.professor)}</small>` : ''}</td>
        <td>${esc(row.term)}</td><td>${esc(row.lecture_code ?? '없음')}</td><td>${importActions[change.action]}${differences}</td></tr>`;
    }).join('')}
    </tbody></table>`;
  $('#import-preview').hidden = false;
  updateImportSelection();
}

function updateImportSelection() {
  updateSelection('[data-import-action]', '#select-all-imports', '#apply-import', '#import-selection');
}

$('#import-table').addEventListener('input', event => {
  if (event.target.id === 'select-all-imports') {
    for (const checkbox of document.querySelectorAll('[data-import-action]')) checkbox.checked = event.target.checked;
  }
  updateImportSelection();
});

$('#import-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (importing || saving) return;
  if (dirty) return message('먼저 현재 입력을 임시 저장한 뒤 가져와주세요.', 'error');
  importing = true;
  clearImportPreview();
  $('#preview-import').disabled = true;
  $('#import-progress').hidden = false;
  $('#import-progress').textContent = '공개 시간표를 확인하는 중입니다.';
  const start = edits;
  try {
    const result = await api('/api/import/preview', {version, shared_url: $('#shared-url').value.trim()});
    if (start !== edits || result.base_revision !== version) {
      return message('입력이 변경됐습니다. 저장 후 공유 링크를 다시 가져와주세요.', 'error');
    }
    importPreview = result;
    $('#shared-url').value = '';
    renderImportPreview(result);
  } catch (error) {
    message(error.message, 'error');
  } finally {
    importing = false;
    $('#preview-import').disabled = false;
    $('#import-progress').hidden = true;
  }
});

$('#apply-import').addEventListener('click', async () => {
  if (!importPreview || importing || saving || dirty) return;
  const selected = action => [...document.querySelectorAll(`[data-import-action="${action}"]:checked`)].map(input => input.value);
  const adds = selected('add');
  const updates = selected('update');
  if (!adds.length && !updates.length) return message('가져올 과목을 선택해주세요.', 'error');
  importing = true;
  $('main').inert = true;
  $('#apply-import').disabled = true;
  $('#preview-import').disabled = true;
  try {
    const result = await api('/api/import/apply', {
      version, import_id:importPreview.import_id, accepted_attempt_ids:adds, accepted_update_ids:updates,
    });
    version = result.version;
    state = result.document;
    dirty = false;
    fillProfile();
    $('#save-state').textContent = '가져온 과목을 임시 저장했어요';
    clearImportPreview();
    clearComparison();
    renderCourses();
    if (step === 3) renderSummary();
    message(`${adds.length}건 추가 · ${updates.length}건 갱신. 이수 완료한 과목을 선택해 한 번에 확인할 수 있습니다.`, 'success');
  } catch (error) {
    message(error.message, 'error');
  } finally {
    importing = false;
    $('main').inert = false;
    updateImportSelection();
    $('#preview-import').disabled = false;
  }
});

const comparisonReasons = {
  completion_not_confirmed:'확인된 이수 완료 과목만 대조합니다.',
  term_unavailable:'이 학기의 공식 자료가 없습니다.',
  missing_lecture_code:'강좌코드가 없습니다.',
  unsupported_lecture_code:'지원하는 강좌코드 형식과 다릅니다.',
  offering_not_in_snapshot:'현재 수집 범위에서 분반을 찾지 못했습니다.',
  multiple_offerings:'후보가 여러 개입니다.',
  course_name_conflict:'공식 과목명과 다릅니다.',
  professor_conflict:'공식 교수명과 다릅니다.',
};

$('#compare-offerings').addEventListener('click', async () => {
  if (dirty || saving || importing || !version) return message('이수 상태를 확인하고 입력을 저장해주세요.', 'error');
  const button = $('#compare-offerings');
  button.disabled = true;
  clearComparison();
  const start = edits;
  try {
    const result = await api('/api/offerings/compare', {version});
    if (edits !== start || result.input_revision !== version || dirty) return;
    const matches = result.matches.filter(item => item.status !== 'not_checked');
    const linked = matches.filter(item => item.status === 'offering_matched').length;
    $('#comparison-summary').textContent = matches.length
      ? `분반 연결 ${linked}건 · 확인 필요 ${matches.length-linked}건`
      : '이수 완료로 확인한 과목이 없습니다.';
    const attempts = new Map(state.course_attempts.map(row => [row.id, row]));
    $('#comparison-table').innerHTML = matches.length ? `<table><thead><tr><th>입력 과목</th><th>학기</th><th>공식 분반</th><th>개설 학점</th><th>결과</th></tr></thead><tbody>
      ${matches.map(item => {
        const row = attempts.get(item.course_attempt_id);
        const candidates = item.offering ? [item.offering] : item.candidates;
        const details = candidates.map(o => `${esc(o.course_code)}-${esc(o.section_code)} · ${esc(o.course_name)}${o.professor ? ` · ${esc(o.professor)}` : ''}`).join('<br>');
        return `<tr><td>${esc(row.course_name)}</td><td>${esc(row.term)}</td><td>${details||'—'}</td>
          <td>${esc(item.offering?.credits ?? '—')}</td><td>${item.offering ? '분반 연결' : esc(comparisonReasons[item.reason])}</td></tr>`;
      }).join('')}</tbody></table>` : '';
  } catch (error) {
    message(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

init();
