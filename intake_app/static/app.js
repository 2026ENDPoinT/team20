'use strict';
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const days = {MON:'월',TUE:'화',WED:'수',THU:'목',FRI:'금',SAT:'토',SUN:'일'};
const statuses = {unconfirmed:'이수 여부 미확인',completed:'이수 완료',in_progress:'수강 중',not_completed:'미이수 / 취소 / F'};
const initial = () => ({kind:'student_input',schema_version:2,student:{department_id:'DEPT_CS',admission_year:null,grade:null,admission_type:'freshman',program_type:null,regular_terms_completed:null,min_credits:null,max_credits:null,interests:[],transfer_recognized_credits:null},history_complete:false,course_attempts:[]});
let state=initial(), version=0, csrf='', step=1, dirty=false, edits=0, saving=false, importPreview=null, importing=false;
const draftKey = 'course-compass-input-draft';
const recommendationPage = location.pathname === '/recommendations';
document.title = (recommendationPage ? '과목 추천' : '수강 정보') + ' · 수강나침반';
$(recommendationPage ? '#recommend-nav' : '#home-nav').setAttribute('aria-current', 'page');
if (recommendationPage) $('#recommend-nav').removeAttribute('target');
let saveTimer, pendingSave, draftConflict = false, loaded = false;
const fields={'admission-year':'admission_year',grade:'grade',department:'department_id','admission-type':'admission_type','program-type':'program_type','regular-terms':'regular_terms_completed','min-credits':'min_credits','max-credits':'max_credits','transfer-credits':'transfer_recognized_credits'};
const numeric = new Set(['admission_year','grade','min_credits','max_credits','transfer_recognized_credits','regular_terms_completed']);
const tags=['인공지능','경제·금융','심리','예술·문화','사회·정치','역사','과학기술','철학·윤리','창업','글쓰기'];
function message(text,type='info'){$('#message').textContent=text;$('#message').className='message '+type;$('#message').hidden=false;}
function touch() {
  clearImportPreview(); clearComparison();
  if (!recommendationPage) clearRecommendations();
  dirty = true;
  edits++;
  cacheDraft();
  $('#save-state').textContent = '자동 저장 대기 중';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(), 300);
}

function cacheDraft() {
  try { localStorage.setItem(draftKey, JSON.stringify({version, document:state})); }
  catch { /* The server saves valid input when browser storage is unavailable. */ }
}

function forgetDraft(savedDocument) {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey));
    if (draft && draft.version < version && JSON.stringify(draft.document) === savedDocument) {
      localStorage.removeItem(draftKey);
    }
  } catch { /* Browser storage is optional. */ }
}
async function api(path,payload){const options=payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':csrf},body:JSON.stringify(payload)};const response=await fetch(path,options);let data;try{data=await response.json();}catch{throw new Error('서버 응답을 읽을 수 없습니다. 서버 실행 상태를 확인해주세요.');}if(!response.ok)throw Object.assign(new Error(data.error||'요청에 실패했습니다.'),{status:response.status});return data;}
function fillProfile(){for(const [id,key] of Object.entries(fields))$('#'+id).value=state.student[key]??'';$('#history-complete').checked=state.history_complete;$('#transfer-box').hidden=state.student.admission_type!=='transfer';renderTags();}
function renderTags(){const all=[...new Set([...tags,...state.student.interests])];$('#tags').innerHTML=all.map(tag=>`<button class="tag ${state.student.interests.includes(tag)?'selected':''}" aria-pressed="${state.student.interests.includes(tag)}" data-tag="${esc(tag)}">${esc(tag)}</button>`).join('');}
function switchStep(value) {
  step = value;
  for (let i = 1; i <= 3; i++) {
    $('#step-' + i).hidden = i !== step;
    const indicator = document.querySelector(`[data-step="${i}"]`);
    indicator.classList.toggle('active', i === step);
    if (i === step) indicator.setAttribute('aria-current', 'step');
    else indicator.removeAttribute('aria-current');
  }
  $('#back').hidden = step === 1;
  $('#next').textContent = step === 3 ? '확인 및 저장' : '다음';
  if (step === 3) renderSummary();
  $('#profile-dialog').scrollTop = 0;
  const heading = $('#step-' + step).querySelector('h2');
  if (heading) { heading.tabIndex = -1; heading.focus({preventScroll:true}); }
}
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
 const p=state.student;$('#summary-profile').textContent=`컴퓨터공학과 · ${p.admission_year||'입학연도 미입력'} · ${p.grade? p.grade+'학년':'학년 미입력'} · ${p.admission_type==='transfer'?'편입학':'신입학'} / 관심 주제: ${p.interests.join(', ')||'미선택'}`;
 $('#summary-table').innerHTML=`<table><thead><tr><th>과목</th><th>수강 학기</th><th>강좌코드</th><th>이수 상태</th><th>확인</th></tr></thead><tbody>${courses.map(c=>`<tr><td>${esc(c.course_name)||'미입력'}${c.source==='sample'?'<small>예시 데이터</small>':''}</td><td>${esc(c.term)||'미확인'}</td><td>${esc(c.lecture_code)||'미입력'}</td><td>${statuses[c.completion_status]}</td><td>${c.user_confirmed?'확인함':'확인 필요'}</td></tr>`).join('')}</tbody></table>`;
 const warnings=[];if(!state.history_complete)warnings.push('일부 수강 내역만 입력한 상태입니다.');if(done.length<courses.length)warnings.push(`${courses.length-done.length}개 과목의 이름·학기·이수 상태를 검토해주세요.`);if(courses.some(c=>c.source==='sample'))warnings.push('예시 과목이 포함되어 있습니다. 본인의 이수 내역인지 확인해주세요.');
 $('#review-warnings').innerHTML=warnings.map(w=>`<p class="notice">${esc(w)}</p>`).join('');
}
async function save(reviewed = false) {
  clearTimeout(saveTimer);
  while (pendingSave) await pendingSave;
  if (!loaded || importing || draftConflict) return false;
  if (!reviewed && !dirty) return true;
  const revision = edits;
  const draft = JSON.stringify(state);
  $('#save-state').textContent = '저장 중';
  saving = true;
  pendingSave = (async () => {
    try {
      const result = await api('/api/input', {document:JSON.parse(draft), version, reviewed});
      version = result.version;
      if (revision === edits) {
        dirty = false;
        forgetDraft(draft);
        $('#save-state').textContent = '저장됨';
      } else {
        cacheDraft();
      }
      return true;
    } catch (error) {
      draftConflict = error.status === 409;
      $('#save-state').textContent = error.message;
      if (reviewed) message(error.message, 'error');
      return false;
    } finally {
      saving = false;
      pendingSave = null;
    }
  })();
  if (!await pendingSave) return false;
  if (dirty) return save(reviewed);
  return true;
}
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
for(const [id,key] of Object.entries(fields))$('#'+id).addEventListener('input',event=>{let value=event.target.value;state.student[key]=numeric.has(key)?(value===''?null:Number(value)):value;if(key==='program_type'&&!value)state.student[key]=null;if(key==='admission_type')$('#transfer-box').hidden=value!=='transfer';touch();});
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
$('#history-complete').addEventListener('change', event => {
  state.history_complete = event.target.checked;
  touch();
  renderSummary();
});
function openProfile() {
  const dialog = $('#profile-dialog');
  if (!dialog.open) dialog.showModal();
  $('#message').hidden = true;
  switchStep(1);
}
$('#my-info').addEventListener('click', openProfile);
$('#edit-profile').addEventListener('click', openProfile);
$('#close-profile').addEventListener('click', async () => {
  const changed = dirty;
  const saved = await save();
  $('#profile-dialog').close();
  if (saved && changed && recommendationPage) $('#run-recommendations').click();
});
$('#profile-dialog').addEventListener('close', () => save());
$('#profile-dialog').addEventListener('cancel', event => {
  if (importing) event.preventDefault();
});
$('#back').addEventListener('click', () => switchStep(step - 1));
$('#next').addEventListener('click', async () => {
  if (!loaded || importing) return;
  if (step === 1 && (!state.student.admission_year || !state.student.grade || !state.student.program_type)) {
    return message('입학연도, 현재 학년, 이수 과정을 입력해주세요.', 'error');
  }
  const next = $('#next');
  next.disabled = true;
  $('#back').disabled = true;
  try {
    if (!await save(step === 3)) return;
    $('#message').hidden = true;
    if (step < 3) switchStep(step + 1);
    else {
      $('#profile-dialog').close();
      if (recommendationPage) $('#run-recommendations').click();
    }
  } finally {
    next.disabled = false;
    $('#back').disabled = false;
  }
});
function confirmHistoryChange(text) {
  const dialog = $('#confirm-dialog');
  $('#confirm-text').textContent = text;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => {
    resolve(dialog.returnValue === 'confirm');
  }, {once:true}));
}
$('#delete-all').addEventListener('click', async () => {
  if (importing || !state.course_attempts.length) return;
  if (!await confirmHistoryChange('현재 수강내역을 모두 삭제할까요?')) return;
  state.course_attempts = [];
  state.history_complete = false;
  editingCourseId = null;
  excludedCourses.clear();
  touch();
  renderCourses();
});
$('#export').addEventListener('click',()=>{const payload={...state,course_attempts:state.course_attempts.map(({meetings,course_name_raw,extraction_ids,extraction_warnings,...row})=>({...row,completion_status:row.user_confirmed?row.completion_status:'unconfirmed'}))};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='student-input.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
function useDocument(document) {
  state = document || initial();
  delete state.student.target_term;
  delete state.student.recognition_notes;
}

async function init() {
  try {
    const config = await api('/api/config');
    csrf = config.csrf_token;
    const saved = await api('/api/input');
    version = saved.version;
    useDocument(saved.document);
    loaded = true;
    let draft;
    try { draft = JSON.parse(localStorage.getItem(draftKey)); } catch { /* Browser storage is optional. */ }
    if (draft?.document && draft.version === version) {
      useDocument(draft.document);
      dirty = true;
      edits++;
      await save();
    }
    fillProfile();
    renderCourses();
    if (!dirty) $('#save-state').textContent = version ? '저장됨' : '변경사항은 자동으로 저장됩니다.';
    $('#recommendations').hidden = !recommendationPage;
    if (recommendationPage && version) $('#run-recommendations').click();
    if (recommendationPage && !version) $('#recommendation-summary').textContent = '내 정보에서 학생 정보와 이수내역을 입력해주세요.';
    $('#home-panel').hidden = recommendationPage;
    if (!recommendationPage && !version) openProfile();
  } catch (error) {
    if (!$('#profile-dialog').open) openProfile();
    message(error.message, 'error');
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

function clearRecommendations() {
  $('#recommendation-metrics').hidden = true;
  $('#recommendation-summary').textContent = '';
  $('#recommendation-results').replaceChildren();
}

function renderImportPreview(preview) {
  const failures = preview.summary.failed_or_skipped_tables;
  const missing = preview.issues.filter(issue => issue.code === 'missing_matching_fields').length;
  $('#import-summary').textContent = [
    `과목 ${preview.course_attempts.length}건`,
    failures ? `조회하지 못한 시간표 ${failures}개` : '',
    missing ? `강좌코드 또는 과목명 확인 필요 ${missing}건` : '',
    state.course_attempts.length ? `기존 수강내역 ${state.course_attempts.length}건 교체` : '',
  ].filter(Boolean).join(' · ');
  $('#import-table').innerHTML = `<table><thead><tr><th><input id="select-all-imports" type="checkbox" aria-label="가져올 과목 모두 선택"></th><th>과목</th><th>학기</th><th>강좌코드</th></tr></thead><tbody>
    ${preview.course_attempts.map(row => `<tr><td><input type="checkbox" value="${esc(row.id)}" data-import-action aria-label="${esc(row.course_name || '이름 미입력 과목')}" checked></td>
      <td>${esc(row.course_name || '이름 미입력')}${row.professor ? `<small>${esc(row.professor)}</small>` : ''}</td>
      <td>${esc(row.term)}</td><td>${esc(row.lecture_code ?? '없음')}</td></tr>`).join('')}
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
  if (importing) return;
  if (!await save() || importing) return;
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
  const selected = [...document.querySelectorAll('[data-import-action]:checked')].map(input => input.value);
  if (!selected.length) return message('가져올 과목을 선택해주세요.', 'error');
  const failures = importPreview.summary.failed_or_skipped_tables;
  if ((state.course_attempts.length || failures) && !await confirmHistoryChange(
    `${failures ? `조회하지 못한 시간표가 ${failures}개 있습니다. ` : ''}기존 수강내역 ${state.course_attempts.length}건을 선택한 ${selected.length}건으로 교체할까요?`
  )) return;
  importing = true;
  $('#profile-content').inert = true;
  $('#close-profile').disabled = true;
  $('#apply-import').disabled = true;
  $('#preview-import').disabled = true;
  try {
    const result = await api('/api/import/apply', {
      version, import_id:importPreview.import_id, accepted_attempt_ids:selected, replace:true,
    });
    version = result.version;
    useDocument(result.document);
    dirty = false;
    editingCourseId = null;
    excludedCourses.clear();
    fillProfile();
    $('#save-state').textContent = '가져온 과목을 저장했어요';
    clearImportPreview();
    clearComparison();
    clearRecommendations();
    renderCourses();
    if (step === 3) renderSummary();
    message(`선택한 ${selected.length}건으로 수강내역을 교체했습니다. 이수 상태를 확인해주세요.`, 'success');
  } catch (error) {
    message(error.message, 'error');
  } finally {
    importing = false;
    $('#profile-content').inert = false;
    $('#close-profile').disabled = false;
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
  if (!await save() || !version) return message('이수 상태를 확인하고 입력을 저장해주세요.', 'error');
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

const recommendationStatus = {met:'충족', not_met:'미충족', needs_review:'확인 필요'};
const recommendationGroups = [
  ['current_major_required', '이번에 챙길 전공필수'],
  ['future_major_required', '다음 전공필수'],
  ['required_general', '필수 교양'],
  ['major_credits', '전공선택'],
  ['general_credits', '교양'],
];

function recommendationEntries(courses) {
  const entries = new Map();
  for (const course of courses) {
    const key = course.alternative_group ? `alternative-${course.alternative_group.id}` : course.course_code;
    if (!entries.has(key)) entries.set(key, []);
    entries.get(key).push(course);
  }
  return Array.from(entries.values());
}

function recommendationTable(entries) {
  return `<div class="table-wrap"><table><thead><tr><th>과목</th><th>편성 학년</th><th>추천 이유</th><th>분반</th></tr></thead>
    ${entries.map(courses => `<tbody>
      ${courses.length > 1 ? `<tr><th colspan="4" scope="rowgroup">${esc(courses[0].alternative_group.title)} · 택1</th></tr>` : ''}
      ${courses.map(course => `<tr><td><span class="course-title">${esc(course.course_name)}</span><small>${esc(course.course_code)}</small></td>
      <td>${course.recommended_grade ?? '—'}</td><td>${course.reasons.map(reason => reason.startsWith('관심 주제 일치')
        ? `<span class="reason-highlight">${esc(reason)}</span>` : esc(reason)).join('<br>')}</td>
      <td><details><summary>${course.sections.length}개${course.eligibility==='needs_review'?' · 수강제한 확인 필요':''}</summary>
      ${course.sections.map(section => `<small>${esc(section.section_code)} · ${esc(section.professor || '교수 미정')} · ${esc(section.credits ?? '—')}학점${section.eligibility==='needs_review'?' · 제한 확인 필요':''}</small>`).join('')}
      </details></td></tr>`).join('')}
    </tbody>`).join('')}
  </table></div>`;
}

function renderRecommendations(result) {
  const candidates = result.candidates;
  const sections = recommendationGroups.map(([group, title]) => {
    const rows = candidates.filter(course => course.group === group);
    const entries = recommendationEntries(rows);
    const required = result.requirements.filter(rule => rule.recommendation_group === group && rule.status !== 'met');
    const creditRule = result.requirements.find(rule => rule.id === group.replace('_credits', ''));
    let content;
    if (required.length) {
      content = required.map(rule => {
        const options = rows.filter(course => course.requirement_ids.includes(rule.id));
        const notes = [
          rule.recommended_grade ? `${rule.recommended_grade}학년` : '',
          rule.type === 'choose_n' ? `택${rule.target}` : '',
          rule.type === 'min_group_credits' ? `현재 입력 기준 ${Math.max(0, rule.target - rule.current)}학점 남음` : '',
          rule.in_progress ? '수강 중인 과목 있음' : '',
          rule.status === 'needs_review' ? '확인 필요' : '',
        ].filter(Boolean);
        return `<h3>${esc(rule.title)}${notes.length ? ` · ${esc(notes.join(' · '))}` : ''}</h3>
          ${options.length ? recommendationTable(options.map(course => [course])) : `<p>이번 학기 ${rule.offered ? '추천 후보가' : '개설 과목이'} 없습니다.</p>`}`;
      }).join('');
    } else if (group.endsWith('_credits')) {
      const main = entries.filter(entry => entry.some(course => !course.lower_grade));
      const lower = entries.filter(entry => entry.every(course => course.lower_grade));
      const remaining = creditRule ? Math.max(0, creditRule.target - creditRule.current) : 0;
      const progress = remaining
        ? `<p>현재 입력 기준 ${remaining}학점 남음${creditRule.status === 'needs_review' ? ' · 확인 필요' : ''}</p>`
        : '';
      content = progress + (main.length ? recommendationTable(main) : '') +
        (lower.length ? `<details><summary>저학년 전공선택 더 보기 · ${lower.length}개</summary>${recommendationTable(lower)}</details>` : '') +
        (!rows.length ? '<p>이번 학기 추천 후보가 없습니다.</p>' : '');
    } else {
      content = '<p>남은 요건이 없습니다.</p>';
    }
    const count = group.endsWith('_credits') ? `후보 ${entries.length}개` : `남은 요건 ${required.length}개`;
    const priority = group === 'current_major_required' || group === 'required_general';
    const open = group === 'current_major_required' && required.length > 0;
    return `<details class="result-panel${priority ? ' result-panel--priority' : ''}"${open ? ' open' : ''}>
      <summary>${title}<span class="count">${count}</span></summary><div class="result-body">${content}</div></details>`;
  });
  const creditReviews = result.credit_reviews.length
    ? `<p class="notice">택1 과목을 모두 이수해 인정학점 확인이 필요합니다. 아래 과목의 학점은 확인 전까지 합계에서 보류했습니다.</p>
      <ul>${result.credit_reviews.map(review => `<li>${esc(review.title)} (${esc(review.course_codes.join(' / '))})</li>`).join('')}</ul>`
    : '';
  const checks = `<details class="result-panel"><summary>학번별 이수요건</summary><div class="result-body">${creditReviews}<div class="table-wrap"><table>
    <thead><tr><th>요건</th><th>상태</th><th>확인한 값 / 기준</th></tr></thead><tbody>
    ${result.requirements.map(rule => `<tr><td>${esc(rule.title)}</td>
      <td><span class="state-pill ${esc(rule.status)}">${recommendationStatus[rule.status]}</span></td><td>${esc(rule.current ?? '—')} / ${esc(rule.target)}</td></tr>`).join('')}
    </tbody></table></div></details>`;
  const metrics = $('#recommendation-metrics');
  const fulfilled = result.requirements.filter(rule => rule.status === 'met').length;
  metrics.innerHTML = `<span><strong>${esc(result.target_term)}</strong>추천 학기</span>
    <span><strong>${recommendationEntries(candidates).length}</strong>추천 후보</span>
    <span><strong>${fulfilled} / ${result.requirements.length}</strong>충족한 이수요건</span>`;
  metrics.hidden = false;
  $('#recommendation-summary').textContent = result.partial ? '일부 이수요건은 확인이 필요합니다.' : '';
  const results = $('#recommendation-results');
  results.innerHTML = '<div class="results-title"><h2>추천 과목과 이수요건</h2><button type="button" class="button secondary">모두 펼치기</button></div>'
    + sections.join('') + checks;
  const panels = Array.from(results.querySelectorAll(':scope > details'));
  const toggle = results.querySelector('button');
  function updateToggleLabel() {
    toggle.textContent = panels.some(panel => panel.open) ? '모두 접기' : '모두 펼치기';
  }
  updateToggleLabel();
  panels.forEach(panel => panel.addEventListener('toggle', updateToggleLabel));
  toggle.addEventListener('click', () => {
    const open = panels.every(panel => !panel.open);
    panels.forEach(panel => { panel.open = open; });
    updateToggleLabel();
  });
}

$('#run-recommendations').addEventListener('click', async () => {
  if (!await save() || !version) {
    $('#recommendation-summary').textContent = '내 정보에서 학생 정보와 이수내역을 입력해주세요.';
    return;
  }
  const button = $('#run-recommendations');
  button.disabled = true;
  clearRecommendations();
  $('#recommendation-summary').textContent = '추천을 계산하는 중입니다.';
  const start = edits;
  try {
    if (!$('#profile-dialog').open) {
      const latest = await api('/api/input');
      if (start !== edits || dirty) return;
      if (latest.version !== version) {
        version = latest.version;
        useDocument(latest.document);
        fillProfile();
        renderCourses();
      }
    }
    const result = await api('/api/recommendations', {version, automatic_term:true});
    if (edits === start && result.input_revision === version && !dirty) renderRecommendations(result);
  } catch (error) {
    $('#recommendation-summary').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

init();
