'use strict';
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const days = {MON:'월',TUE:'화',WED:'수',THU:'목',FRI:'금',SAT:'토',SUN:'일'};
const initial = () => ({kind:'student_input',schema_version:2,student:{department_id:'DEPT_CS',admission_year:null,grade:null,admission_type:'freshman',regular_terms_completed:null,min_credits:null,max_credits:null,interests:[],transfer_recognized_credits:null},history_complete:false,course_attempts:[]});
let state=initial(), version=0, csrf='', step=1, dirty=false, edits=0, saving=false, importPreview=null, importing=false;
const draftKey = 'course-compass-input-draft';
const recommendationPage = location.pathname === '/recommendations';
const schedulePage = location.pathname === '/schedules';
document.title = (schedulePage ? '시간표 생성' : recommendationPage ? '과목 추천' : '수강 정보') + ' · 수강나침반';
$(schedulePage ? '#schedule-nav' : recommendationPage ? '#recommend-nav' : '#home-nav').setAttribute('aria-current', 'page');
if (recommendationPage) $('#recommend-nav').removeAttribute('target');
let saveTimer, pendingSave, draftConflict = false, loaded = false;
const fields={'admission-year':'admission_year',grade:'grade',department:'department_id','admission-type':'admission_type','regular-terms':'regular_terms_completed','min-credits':'min_credits','max-credits':'max_credits','transfer-credits':'transfer_recognized_credits'};
const numeric = new Set(['admission_year','grade','min_credits','max_credits','transfer_recognized_credits','regular_terms_completed']);
let tags = [], interestAliases = {};
function message(text,type='info'){$('#message').textContent=text;$('#message').className='message '+type;$('#message').hidden=false;}
function touch() {
  clearImportPreview();
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
function fillProfile(){for(const [id,key] of Object.entries(fields))$('#'+id).value=state.student[key]??'';$('#transfer-box').hidden=state.student.admission_type!=='transfer';renderTags();}
function renderTags() {
  $('#tags').innerHTML = ['전공', '교양'].map(group => `<fieldset class="interest-group">
    <legend>${group}</legend><div class="tags">${tags.filter(tag => tag.group === group).map(tag => {
      const selected = state.student.interests.includes(tag.id);
      return `<button type="button" class="tag${selected ? ' selected' : ''}" aria-pressed="${selected}" data-tag="${esc(tag.id)}">${esc(tag.label)}</button>`;
    }).join('')}</div></fieldset>`).join('');
}
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

function courseDetails(course) {
  const c = course;
  return `<tr data-id="${esc(c.id)}" class="course-detail-row"${editingCourseId===c.id?'':' hidden'}><td colspan="4">
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
  if (!courses.length) {
    $('#course-list').innerHTML = '<div class="empty"><strong>등록한 과목이 없습니다</strong>공유 링크로 가져오거나 과목을 직접 추가하세요.</div>';
    return;
  }
  $('#course-list').innerHTML = `<table class="course-table"><thead><tr>
    <th scope="col">과목</th><th scope="col">학기</th><th scope="col" class="course-code">강좌코드</th><th scope="col">편집</th>
  </tr></thead><tbody>${courses.map(c => {
    const name = c.course_name || '과목명 미입력';
    return `<tr class="course-row" data-id="${esc(c.id)}">
      <td><strong data-course-name>${esc(name)}</strong><small data-course-info>${esc([c.professor,courseSources[c.source]].filter(Boolean).join(' · '))}</small></td>
      <td data-course-term>${esc(c.term || '—')}</td><td class="course-code" data-course-code>${esc(c.lecture_code || '—')}</td>
      <td><button class="button subtle course-edit" data-action="edit" aria-expanded="${editingCourseId===c.id}">상세</button></td>
    </tr>${courseDetails(c)}`;
  }).join('')}</tbody></table>`;
}

function refreshCourseRow(course, row) {
  row.querySelector('[data-course-name]').textContent = course.course_name || '과목명 미입력';
  row.querySelector('[data-course-info]').textContent = [course.professor, courseSources[course.source]].filter(Boolean).join(' · ');
  row.querySelector('[data-course-term]').textContent = course.term || '—';
  row.querySelector('[data-course-code]').textContent = course.lecture_code || '—';
}

function renderSummary() {
  const courses = state.course_attempts;
  const student = state.student;
  const interests = tags.filter(tag => student.interests.includes(tag.id)).map(tag => tag.label);
  $('#summary-profile').textContent = `컴퓨터공학과 · ${student.admission_year}학번 · ${student.grade}학년 · 과목 ${courses.length}건${interests.length ? ' · ' + interests.join(', ') : ''}`;
  $('#summary-table').innerHTML = courses.length ? `<table><thead><tr><th>과목</th><th>수강 학기</th><th>강좌코드</th></tr></thead>
    <tbody>${courses.map(row => `<tr><td>${esc(row.course_name || '미입력')}</td><td>${esc(row.term || '미입력')}</td>
      <td>${esc(row.lecture_code || '—')}</td></tr>`).join('')}</tbody></table>` : '';
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
  state.history_complete = false;
  editingCourseId = crypto.randomUUID();
  state.course_attempts.push({
    id: editingCourseId,
    lecture_code: null,
    professor: null,
    source_ref: null,
    course_name: '',
    term: null,
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
for (const [id, key] of Object.entries(fields)) {
  const input = $('#' + id);
  input.addEventListener('input', () => {
    const value = input.value;
    if ((key === 'min_credits' || key === 'max_credits') && input.validity.stepMismatch) {
      input.setCustomValidity('희망학점은 정수로 입력해주세요.');
      input.reportValidity();
    } else {
      input.setCustomValidity('');
    }
    state.student[key] = numeric.has(key) ? (value === '' ? null : Number(value)) : value;
    if (key === 'admission_type') $('#transfer-box').hidden = value !== 'transfer';
    touch();
  });
}
$('#tags').addEventListener('click', event => {
  const button = event.target.closest('[data-tag]');
  if (!button) return;
  const tag = button.dataset.tag;
  const selected = !state.student.interests.includes(tag);
  state.student.interests = selected ? [...state.student.interests, tag] : state.student.interests.filter(id => id !== tag);
  button.classList.toggle('selected', selected);
  button.setAttribute('aria-pressed', String(selected));
  touch();
});
$('#course-list').addEventListener('input', event => {
  const input = event.target;
  const row = input.closest('[data-id]');
  if (!row) return;
  const course = state.course_attempts.find(item => item.id === row.dataset.id);
  const field = input.dataset.field;
  const meetingField = input.dataset.meetingField;
  if (field) {
    course[field] = ['term','lecture_code','professor'].includes(field) ? input.value || null : input.value;
    if (field !== 'review_notes') {
      if (!canConfirm(course)) {
        course.user_confirmed = false;
        course.completion_status = 'unconfirmed';
      } else if (course.source === 'manual' && !course.user_confirmed) {
        course.user_confirmed = true;
        course.completion_status = 'completed';
      }
      state.history_complete = false;
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
    state.history_complete = false;
    if (editingCourseId === course.id) editingCourseId = null;
  }
  if (action === 'add-meeting') (course.meetings ??= []).push({day:null,start_time:null,end_time:null,locations:[]});
  if (action === 'remove-meeting') course.meetings.splice(Number(button.closest('[data-meeting]').dataset.meeting), 1);
  touch();
  renderCourses();
});

$('#add-course').addEventListener('click', addManual);
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
  if (step === 1 && (!state.student.admission_year || !state.student.grade)) {
    return message('입학연도와 현재 학년을 입력해주세요.', 'error');
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
  touch();
  renderCourses();
});
function useDocument(document) {
  state = document || initial();
  for (const key of ['min_credits', 'max_credits']) {
    if (state.student[key] != null) state.student[key] = Math.round(state.student[key]);
  }
  state.student.interests = [...new Set(state.student.interests.flatMap(value =>
    interestAliases[value.normalize('NFKC').toLowerCase().replace(/\s/g, '')] || []))];
  delete state.student.target_term;
  delete state.student.recognition_notes;
}

async function init() {
  try {
    const config = await api('/api/config');
    csrf = config.csrf_token;
    tags = config.interest_tags;
    interestAliases = config.interest_aliases;
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
    $('#home-panel').hidden = recommendationPage || schedulePage;
    $('#schedule-panel').hidden = !schedulePage;
    renderBasket();
    if (schedulePage) {
      fillScheduleDefaults();
      renderCalendar();
    }
    if (!recommendationPage && !schedulePage && !version) openProfile();
  } catch (error) {
    if (!$('#profile-dialog').open) openProfile();
    message(error.message, 'error');
    $('#next').disabled = true;
  }
}

function clearImportPreview() {
  importPreview = null;
  $('#import-preview').hidden = true;
  $('#import-summary').hidden = true;
  $('#import-table').replaceChildren();
}

function clearRecommendations() {
  $('#recommendation-metrics').hidden = true;
  $('#recommendation-summary').textContent = '';
  $('#recommendation-results').replaceChildren();
}

function renderImportPreview(preview) {
  const failures = preview.summary.failed_or_skipped_tables;
  const excluded = preview.official_excluded_count || 0;
  $('#import-summary').textContent = [
    `공식 분반 일치 ${preview.course_attempts.length}건`,
    failures ? `조회하지 못한 시간표 ${failures}개` : '',
    excluded ? `공식 분반과 대조되지 않은 ${excluded}건 제외` : '',
    state.course_attempts.length ? `기존 수강내역 ${state.course_attempts.length}건 교체` : '',
  ].filter(Boolean).join(' · ');
  $('#import-summary').hidden = false;
  if (!preview.course_attempts.length) return;
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

$('#discard-import').addEventListener('click', () => { clearImportPreview(); $('#shared-url').focus(); });

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
  $('#import-progress').textContent = '공유 시간표를 불러와 공식 강좌와 대조하는 중입니다.';
  const start = edits;
  try {
    const result = await api('/api/import/preview', {version, shared_url: $('#shared-url').value.trim(), official_only:true});
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
    fillProfile();
    $('#save-state').textContent = '가져온 과목을 저장했어요';
    clearImportPreview();
    clearRecommendations();
    renderCourses();
    if (step === 3) renderSummary();
    message(`선택한 ${selected.length}건으로 수강내역을 교체했습니다.`, 'success');
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

function everytimeRatingLabel(rating) {
  if (rating?.status === 'rated') return `★ ${rating.score.toFixed(2)}`;
  if (rating?.status === 'unrated') return '미평가';
  return '자료 없음';
}

function recommendationTable(entries) {
  return `<div class="table-wrap"><table><thead><tr><th>과목</th><th>편성 학년</th><th>추천 이유</th><th>분반</th><th>담기</th></tr></thead>
    ${entries.map(courses => `<tbody>
      ${courses.length > 1 ? `<tr><th colspan="5" scope="rowgroup">${esc(courses[0].alternative_group.title)} · 택1</th></tr>` : ''}
      ${courses.map(course => `<tr><td><span class="course-title">${esc(course.course_name)}</span><small>${esc(course.course_code)}</small></td>
      <td>${course.recommended_grade ?? '—'}</td><td>${course.reasons.map(reason => reason.startsWith('관심 주제 일치')
        ? `<span class="reason-highlight">${esc(reason)}</span>` : esc(reason)).join('<br>')}</td>
      <td><details><summary>${course.sections.length}개${course.eligibility==='needs_review'?' · 수강제한 확인 필요':''}</summary>
      ${course.sections.map(section => `<small>${esc(section.section_code)} · ${esc(section.professor || '교수 미정')} · ${esc(section.credits ?? '—')}학점 · 에타 ${esc(everytimeRatingLabel(section.everytime_rating))}${section.eligibility==='needs_review'?' · 제한 확인 필요':''}</small>`).join('')}
      </details></td><td><button type="button" class="button secondary basket-add" data-basket-add="${esc(course.course_code)}" data-course-name="${esc(course.course_name)}">+</button></td></tr>`).join('')}
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
    const priority = rows.length > 0 && required.length > 0 &&
      (group === 'current_major_required' || group === 'required_general');
    const open = group === 'current_major_required' && required.length > 0;
    return `<details class="result-panel${priority ? ' result-panel--priority' : ''}"${open ? ' open' : ''}>
      <summary>${title}${priority ? '<span class="priority-label">우선 확인</span>' : ''}<span class="count">${count}</span></summary><div class="result-body">${content}</div></details>`;
  });
  const creditReviews = result.credit_reviews.length
    ? `<p class="notice">택1 과목을 모두 이수해 인정학점 확인이 필요합니다. 아래 과목의 학점은 확인 전까지 합계에서 보류했습니다.</p>
      <ul>${result.credit_reviews.map(review => `<li>${esc(review.title)} (${esc(review.course_codes.join(' / '))})</li>`).join('')}</ul>`
    : '';
  const checks = `<details class="result-panel"><summary>학번별 이수요건</summary><div class="result-body">${creditReviews}<div class="table-wrap"><table>
    <thead><tr><th>요건</th><th>상태</th><th>확인한 값 / 기준</th></tr></thead><tbody>
    ${result.requirements.map(rule => `<tr><td>${esc(rule.title)}</td>
      <td><span class="state-pill ${esc(rule.status)}">${recommendationStatus[rule.status]}</span></td><td>${esc(rule.current ?? '—')} / ${esc(rule.target)}</td></tr>`).join('')}
    </tbody></table></div></div></details>`;
  const metrics = $('#recommendation-metrics');
  const fulfilled = result.requirements.filter(rule => rule.status === 'met').length;
  metrics.innerHTML = `<span><strong>${esc(result.target_term)}</strong>추천 학기</span>
    <span><strong>${recommendationEntries(candidates).length}</strong>추천 후보</span>
    <span><strong>${fulfilled} / ${result.requirements.length}</strong>충족한 이수요건</span>`;
  metrics.hidden = false;
  $('#recommendation-summary').textContent = result.partial ? '일부 이수요건은 확인이 필요합니다.' : '';
  const results = $('#recommendation-results');
  results.innerHTML = '<div class="results-title"><h2>추천 과목과 이수요건</h2><button type="button" class="button secondary">모두 펼치기</button></div>'
    + checks + sections.join('');
  renderBasket();
  const panels = Array.from(results.querySelectorAll(':scope > details'));
  const toggle = results.querySelector('.results-title button');
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

const basketKey = 'course-compass-basket';
const scheduleDays = [...'월화수목금토일'];
let scheduleChoices = new Map();

function readBasket() {
  try {
    const rows = JSON.parse(localStorage.getItem(basketKey));
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

function writeBasket(rows) {
  try {
    localStorage.setItem(basketKey, JSON.stringify(rows));
    renderBasket();
  } catch {
    $('#basket-status').textContent = '브라우저에 바구니를 저장할 수 없습니다.';
    return false;
  }
  return true;
}

function renderBasket() {
  const rows = readBasket();
  const codes = new Set(rows.map(row => row.code));
  $('#basket-count').textContent = rows.length;
  $('#schedule-basket-count').textContent = rows.length;
  $('#basket-list').innerHTML = rows.length
    ? rows.map(row => `<div class="basket-row"><span><strong>${esc(row.name)}</strong><small>${esc(row.code)}</small></span><button type="button" class="button secondary" data-basket-remove="${esc(row.code)}" aria-label="${esc(row.name)} 바구니에서 삭제">삭제</button></div>`).join('')
    : '<p>추천 과목 옆의 + 버튼으로 과목을 담으세요.</p>';
  if (schedulePage) {
    $('#schedule-basket-list').innerHTML = rows.length
      ? rows.map(row => `<label class="basket-row"><span><strong>${esc(row.name)}</strong><small>${esc(row.code)}</small></span>
        <select data-schedule-course="${esc(row.code)}" aria-label="${esc(row.name)} 편성 조건">
          <option value="">미지정</option><option value="required">필수 포함</option><option value="preferred">선호</option>
        </select></label>`).join('')
      : '<p>바구니가 비어 있어도 시간표를 생성할 수 있어요.</p>';
    for (const select of document.querySelectorAll('[data-schedule-course]')) {
      select.value = scheduleChoices.get(select.dataset.scheduleCourse) || '';
    }
  }
  for (const button of document.querySelectorAll('[data-basket-add]')) {
    const added = codes.has(button.dataset.basketAdd);
    button.textContent = added ? '✓' : '+';
    button.disabled = added;
    button.setAttribute('aria-label', button.dataset.courseName + (added ? ' 담김' : ' 바구니에 담기'));
  }
}

$('#open-basket').addEventListener('click', () => {
  renderBasket();
  $('#basket-dialog').showModal();
});
$('#basket-list').addEventListener('click', event => {
  const button = event.target.closest('[data-basket-remove]');
  if (!button) return;
  scheduleChoices.delete(button.dataset.basketRemove);
  writeBasket(readBasket().filter(row => row.code !== button.dataset.basketRemove));
});
$('#recommendation-results').addEventListener('click', event => {
  const button = event.target.closest('[data-basket-add]');
  if (!button) return;
  const rows = readBasket();
  if (rows.some(row => row.code === button.dataset.basketAdd)) return;
  if (writeBasket([...rows, {code:button.dataset.basketAdd, name:button.dataset.courseName}])) {
    $('#basket-status').textContent = button.dataset.courseName + ' 과목을 바구니에 담았어요.';
  }
});
window.addEventListener('storage', event => {
  if (event.key === basketKey) renderBasket();
});

$('#schedule-basket-list').addEventListener('change', event => {
  const select = event.target.closest('[data-schedule-course]');
  if (select) scheduleChoices.set(select.dataset.scheduleCourse, select.value);
});
$('#schedule-days').innerHTML = scheduleDays.map(day =>
  `<label class="schedule-day"><input type="checkbox" name="blocked-day" value="${day}"> ${day}</label>`
).join('');

let scheduleCandidates = [];

function scheduleClassDays(plan) {
  return scheduleDays.filter(day => plan.offerings.some(offering =>
    offering.meetings.some(meeting => meeting.day === day)));
}

function scheduleGapLabel(plan) {
  return plan.gap_periods ? `수업 사이 빈 시간 합계 ${plan.gap_periods}교시` : '수업 사이 빈 시간 없음';
}

function scheduleCourseMix(plan) {
  return "전공 " + plan.major_credits + "학점 · 교양 " + plan.general_credits + "학점";
}

function scheduleSpacing(plan) {
  return plan.adjacent_sessions ? "연강 " + plan.adjacent_sessions + "회" : "연강 없음";
}

function renderCalendar(plan = null) {
  const entries = (plan?.offerings ?? []).flatMap((offering, color) =>
    offering.meetings.map(meeting => ({...meeting, offering, color: color % 6})));
  const visibleDays = scheduleDays.filter((day, index) => index < 5 ||
    entries.some(meeting => meeting.day === day));
  const first = Math.min(2, ...entries.map(meeting => 2 * Math.floor(meeting.start / 2)));
  const end = Math.max(20, ...entries.map(meeting => 2 * Math.ceil(meeting.end / 2)));
  const rows = [];
  for (let tick = first; tick < end; tick++) {
    const cells = [];
    if (tick % 2 === 0) {
      cells.push(`<th class="schedule-period" scope="row" rowspan="2">${tick / 2}</th>`);
    }
    for (const day of visibleDays) {
      const meeting = entries.find(entry => entry.day === day && entry.start <= tick && tick < entry.end);
      if (!meeting) {
        cells.push('<td class="schedule-empty"></td>');
      } else if (meeting.start === tick) {
        const {offering} = meeting;
        cells.push(`<td class="schedule-slot schedule-color-${meeting.color}" rowspan="${meeting.end - meeting.start}">
          <div class="schedule-class-block" title="${esc(offering.course_name)} · ${esc(offering.schedule)}">
          <strong>${esc(offering.course_name)}</strong><small>${esc(offering.category)} · ${esc(offering.section_code)}</small></div></td>`);
      }
    }
    rows.push(`<tr class="schedule-half${tick % 2 ? ' period-end' : ''}">${cells.join('')}</tr>`);
  }
  $('#schedule-calendar').innerHTML = `<table class="schedule-grid" aria-label="요일과 교시별 시간표">
    <thead><tr><th scope="col">교시</th>${visibleDays.map(day => `<th scope="col">${day}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
}

function showSchedule(index) {
  const plan = scheduleCandidates[index];
  if (!plan) return;
  for (const button of document.querySelectorAll('[data-schedule-index]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.scheduleIndex) === index));
  }
  $('#schedule-preview-summary').textContent = `${index + 1}위 · ${plan.credits}학점 · 수업 요일 ${scheduleClassDays(plan).join("·")} (${plan.days}일) · ${scheduleCourseMix(plan)} · ${scheduleSpacing(plan)} · ${scheduleGapLabel(plan)}${plan.provisional ? ' · 수강 자격 확인 필요' : ''}`;
  renderCalendar(plan);
  const locked = new Set($('#schedule-locks').value.split(/[\s,]+/).filter(Boolean));
  $('#schedule-offering-table').innerHTML = `<table><thead><tr><th>과목·분반</th><th>교시</th><th>강의실</th><th>학점</th><th>에타 별점</th><th>수강 자격</th></tr></thead>
    <tbody>${plan.offerings.map(row => `<tr>
      <td>${esc(row.course_name)}<small>${esc(row.course_code)}-${esc(row.section_code)}</small>
        <button type="button" class="button subtle" data-lock-offering="${esc(row.offering_id)}"${locked.has(row.offering_id) ? ' disabled' : ''}>${locked.has(row.offering_id) ? '고정됨' : '분반 고정'}</button></td>
      <td>${esc(row.schedule)}</td><td>${esc(row.room || '미정')}</td>
      <td>${esc(row.credits)}</td><td>${esc(everytimeRatingLabel(row.everytime_rating))}</td>
      <td>${row.eligibility === 'needs_review' ? '수강 자격 확인' : '제한 기록 없음'}</td>
    </tr>`).join('')}</tbody></table>`;
  $('#schedule-offerings').hidden = false;
}

function renderSchedules(result) {
  scheduleCandidates = result.candidates;
  const found = scheduleCandidates.length > 0;
  $('#schedule-status').textContent = [result.target_term,
    found ? `후보 ${scheduleCandidates.length}개` :
      result.outcome === 'undetermined' ? '편성 가능 여부 확인 필요' : '조건에 맞는 시간표가 없어요.',
    ...result.issues].join(' · ');
  $('#schedule-form').hidden = found;
  $('#schedule-candidates').hidden = !found;
  if (!found) return;
  const list = $('#schedule-results');
  list.innerHTML = scheduleCandidates.map((plan, index) => `<button type="button"
    class="schedule-candidate${index < 3 ? ' rank-' + (index + 1) : ''}" data-schedule-index="${index}" aria-pressed="false">
    <strong class="schedule-rank">${index + 1}위</strong>
    <span><strong>${plan.credits}학점 · 수업 ${scheduleClassDays(plan).join("·")} (${plan.days}일)</strong>
      <small>${scheduleCourseMix(plan)} · ${scheduleSpacing(plan)}${plan.provisional ? ' · 잠정' : ''}</small></span>
  </button>`).join('');
  list.scrollTop = 0;
  showSchedule(0);
  list.querySelector('button').focus({preventScroll:true});
}

$('#schedule-results').addEventListener('click', event => {
  const candidate = event.target.closest('[data-schedule-index]');
  if (candidate) showSchedule(Number(candidate.dataset.scheduleIndex));
});

$('#edit-schedule-conditions').addEventListener('click', () => {
  $('#schedule-candidates').hidden = true;
  $('#schedule-form').hidden = false;
  $('#schedule-min').focus();
});

$('#schedule-offering-table').addEventListener('click', event => {
  const button = event.target.closest('[data-lock-offering]');
  if (!button) return;
  const input = $('#schedule-locks');
  const ids = new Set(input.value.split(/[\s,]+/).filter(Boolean));
  ids.add(button.dataset.lockOffering);
  input.value = [...ids].join(', ');
  button.textContent = '고정됨';
  button.disabled = true;
  $('#schedule-candidates').hidden = true;
  $('#schedule-form').hidden = false;
  input.closest('details').open = true;
  $('#generate-schedule').focus();
});

function fillScheduleDefaults() {
  const min = state.student.min_credits;
  const max = state.student.max_credits;
  $('#schedule-min').value = Math.max(1, min ?? Math.min(15, max || 18));
  $('#schedule-max').value = Math.max(1, max ?? Math.max(18, min || 15));
}

$('#schedule-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#generate-schedule');
  if (button.disabled) return;
  button.disabled = true;
  $('#schedule-results').replaceChildren();
  $('#schedule-offerings').hidden = true;
  $('#schedule-offerings').open = false;
  $('#schedule-preview-summary').textContent = '후보가 준비되면 시간표에 표시돼요.';
  renderCalendar();
  $('#schedule-status').textContent = '조건에 맞는 시간표를 찾고 있어요.';
  try {
    if (!await save()) throw new Error('학생 정보를 저장한 뒤 다시 시도해주세요.');
    const latest = await api('/api/input');
    const selects = [...document.querySelectorAll('[data-schedule-course]')];
    const result = await api('/api/schedules', {
      version:latest.version,
      min_credits:Number($('#schedule-min').value), max_credits:Number($('#schedule-max').value),
      required:selects.filter(row => row.value === 'required').map(row => row.dataset.scheduleCourse),
      locked_offering_ids:$('#schedule-locks').value.split(/[\s,]+/).filter(Boolean),
      preferred:selects.filter(row => row.value === 'preferred').map(row => row.dataset.scheduleCourse),
      blocked_days:[...document.querySelectorAll('[name="blocked-day"]:checked')].map(row => row.value),
      sort:$('#schedule-sort').value,
    });
    renderSchedules(result);
  } catch (error) {
    $('#schedule-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

init();
