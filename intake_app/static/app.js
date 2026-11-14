'use strict';
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const days = {MON:'월',TUE:'화',WED:'수',THU:'목',FRI:'금',SAT:'토',SUN:'일'};
const initial = () => ({kind:'student_input',schema_version:2,student:{department_id:'DEPT_CS',admission_year:null,grade:null,admission_type:'freshman',regular_terms_completed:null,min_credits:null,max_credits:null,interests:[],transfer_recognized_credits:null},history_complete:false,course_attempts:[]});
let state=initial(), version=0, csrf='', step=1, dirty=false, edits=0, saving=false, importPreview=null, importing=false;
const draftKey = 'course-compass-input-draft';
const profileKey = 'course-compass-public-profile';
let browserStorage = false;
let importVisitor;
function readBrowserProfile() {
  const saved = localStorage.getItem(profileKey);
  return saved ? JSON.parse(saved) : {version:0, document:null, review_state:'draft', updated_at:null};
}
function writeBrowserProfile(expectedVersion, result, reviewed) {
  const write = () => {
    if (readBrowserProfile().version !== expectedVersion) {
      throw Object.assign(new Error('다른 창에서 학생 정보를 저장했어요. 새로고침한 뒤 확인해주세요.'), {status:409});
    }
    const saved = {version:expectedVersion + 1, document:result.document,
      review_state:reviewed ? 'reviewed' : 'draft', updated_at:new Date().toISOString()};
    localStorage.setItem(profileKey, JSON.stringify(saved));
    return {...saved, warnings:result.warnings};
  };
  return navigator.locks ? navigator.locks.request(profileKey, write) : write();
}
const recommendationPage = location.pathname === '/recommendations';
const schedulePage = location.pathname === '/schedules';
document.title = (schedulePage ? '시간표 생성' : recommendationPage ? '과목 추천' : '홈') + ' · 수강나침반';
$(schedulePage ? '#schedule-nav' : recommendationPage ? '#recommend-nav' : '#home-nav').setAttribute('aria-current', 'page');
let saveTimer, pendingSave, draftConflict = false, loaded = false;
const fields={'admission-year':'admission_year',grade:'grade',department:'department_id','admission-type':'admission_type','regular-terms':'regular_terms_completed','min-credits':'min_credits','max-credits':'max_credits','transfer-credits':'transfer_recognized_credits'};
const numeric = new Set(['admission_year','grade','min_credits','max_credits','transfer_recognized_credits','regular_terms_completed']);
let tags = [], interestAliases = {};
let supportsScheduleExclusions = false;
let geminiAdvisorAvailable = null;
let advisorChatAvailable = false;
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
async function requestApi(path, payload, retry = true) {
  const headers = {'Content-Type':'application/json','X-App-Token':csrf};
  if (browserStorage && path.startsWith('/api/import/')) {
    importVisitor ??= crypto.randomUUID();
    headers['X-Course-Visitor'] = importVisitor;
  }
  const options = payload === undefined ? {} : {method:'POST', headers, body:JSON.stringify(payload)};
  const response = await fetch(path, options);
  if (browserStorage && payload !== undefined && response.status === 403 && retry) {
    const config = await requestApi('/api/config');
    csrf = config.csrf_token;
    return requestApi(path, payload, false);
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('서버 응답을 읽을 수 없습니다. 잠시 뒤 다시 시도해주세요.'); }
  if (!response.ok) {
    throw Object.assign(new Error(data.error || '요청에 실패했습니다.'), {status:response.status});
  }
  return data;
}

async function api(path, payload) {
  if (!browserStorage || path === '/api/config') return requestApi(path, payload);
  const saved = readBrowserProfile();
  if (path === '/api/input' && payload === undefined) return saved;
  if (saved.version !== payload.version) {
    throw Object.assign(new Error('다른 창에서 학생 정보를 저장했어요. 새로고침한 뒤 확인해주세요.'), {status:409});
  }
  const result = await requestApi(path, {...payload, document:payload.document ?? saved.document ?? initial()});
  if (path === '/api/input' || path === '/api/import/apply') {
    return writeBrowserProfile(saved.version, result, payload.reviewed === true);
  }
  return result;
}
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

function renderHistoryChart(courses) {
  const counts = new Map();
  for (const course of courses) {
    if (course.term && course.source !== 'sample') {
      counts.set(course.term, (counts.get(course.term) ?? 0) + 1);
    }
  }
  const order = {'1': 0, summer: 1, '2': 2, winter: 3};
  const semesters = [...counts.keys()].sort((a, b) =>
    a.slice(0, 4).localeCompare(b.slice(0, 4)) || order[a.slice(5)] - order[b.slice(5)]);
  const latest = semesters.slice(-6);
  const widget = $('#history-analytics');
  widget.hidden = !latest.length;
  if (!latest.length) return;
  const max = Math.max(...latest.map(term => counts.get(term)));
  widget.innerHTML = `<figure class="viz history-viz"><figcaption>${semesters.length > 6 ? '최근 6개 학기 입력 과목 수' : '학기별 입력 과목 수'}</figcaption>
    <ul class="semester-bars">${latest.map(term => {
      const count = counts.get(term);
      const label = term.replace('-summer', ' 여름').replace('-winter', ' 겨울');
      return `<li><strong>${count}개</strong><meter min="0" max="${max}" value="${count}" aria-label="${esc(label)} 입력 과목 수"></meter><span>${esc(label)}</span></li>`;
    }).join('')}</ul>
  </figure>`;
}

const iconPaths = {
  profile: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-3a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v3',
  tag: 'M3 4h9l9 9-8 8-10-10V4Zm4 4h.01',
  book: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 1 4 17.5Zm0 12A2.5 2.5 0 0 1 6.5 15H20M9 7h7m-7 4h5',
  grid: 'M3 4h18v16H3zM3 9h18m-12 0v11m6-11v11',
  check: 'm5 12 4 4L19 6',
  calendarOff: 'M4 6h16v15H4zM4 10h16M8 3v5m8-5v5m-7 5 6 5m0-5-6 5',
};

function lineIcon(name) {
  return `<svg class="line-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPaths[name]}"/></svg>`;
}

function renderSummary() {
  const courses = state.course_attempts;
  const student = state.student;
  renderHistoryChart(courses);
  const interests = tags.filter(tag => student.interests.includes(tag.id));
  const profile = [
    ['전공', $('#department').selectedOptions[0]?.textContent || '미입력'],
    ['입학연도', student.admission_year ? `${student.admission_year}학번` : '미입력'],
    ['현재 학년', student.grade ? `${student.grade}학년` : '미입력'],
    ['희망학점', student.min_credits != null || student.max_credits != null
      ? `${student.min_credits ?? '—'}–${student.max_credits ?? '—'}학점` : '미지정'],
  ];
  $('#summary-profile').innerHTML = `<section class="review-profile">
    <h3>${lineIcon('profile')} 학생 정보</h3>
    <dl>${profile.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
  </section>
  <section class="review-interests">
    <h3>${lineIcon('tag')} 관심 분야</h3>
    ${interests.length ? ['전공', '교양'].map(group => {
      const groupTags = interests.filter(tag => tag.group === group);
      return groupTags.length ? `<div class="review-interest-group"><strong>${group}</strong>
        <ul>${groupTags.map(tag => `<li>${esc(tag.label)}</li>`).join('')}</ul></div>` : '';
    }).join('') : '<p>선택한 관심 분야가 없어요.</p>'}
  </section>`;
  $('#review-course-count').textContent = `${courses.length}과목`;
  $('#summary-table').innerHTML = courses.length ? `<table><thead><tr><th>과목</th><th>수강 학기</th><th>강좌코드</th></tr></thead>
    <tbody>${courses.map(row => `<tr><td>${esc(row.course_name || '미입력')}</td><td>${esc(row.term || '미입력')}</td>
      <td>${esc(row.lecture_code || '—')}</td></tr>`).join('')}</tbody></table>` : '<p>입력한 이수내역이 없어요.</p>';
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
$('#profile-dialog').addEventListener('close', async () => {
  if (await save() && schedulePage) {
    loadScheduleRecommendations();
    if (!$('#schedule-form').hidden) refreshBasketPreview();
  }
});
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
function confirmHistoryChange(text, title = '수강내역 변경 확인') {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
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
    browserStorage = config.browser_storage === true;
    $('#public-data-handling').hidden = !browserStorage;
    $('#local-data-handling').hidden = browserStorage;
    $('#browser-storage-notice').hidden = !browserStorage;
    supportsScheduleExclusions = config.schedule_course_exclusions === true;
    geminiAdvisorAvailable = config.gemini_advisor ?? null;
    advisorChatAvailable = config.advisor_chat === true;
    advisorOpen.hidden = !advisorChatAvailable;
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
      loadScheduleRecommendations();
    }
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

const recommendationStatus = {met:'충족', not_met:'미충족', needs_review:'미충족'};
const majorRequiredGroups = ['current_major_required', 'future_major_required'];
const generalElectiveLimit = 30;
const recommendationGroups = [
  ['major_required', '전공필수'],
  ['required_general', '교양필수'],
  ['major_credits', '전공선택'],
  ['general_credits', '교양선택'],
];

function matchesRecommendationGroup(actual, group) {
  return group === 'major_required' ? majorRequiredGroups.includes(actual) : actual === group;
}

function renderMajorRequired(rules, renderRule) {
  const current = rules.filter(rule => rule.recommendation_group === majorRequiredGroups[0]);
  const future = rules.filter(rule => rule.recommendation_group === majorRequiredGroups[1]);
  if (!rules.length) return '<p>남은 요건이 없습니다.</p>';
  return `${current.length ? `<section class="major-required-current">
    <h3>이번에 챙길 과목 <span class="count">${current.length}</span></h3>
    ${current.map(renderRule).join('')}</section>` : ''}
    ${future.length ? `<details class="major-required-future"${current.length ? '' : ' open'}>
      <summary>이후 학년 <span class="count">${future.length}</span></summary>
      <div class="major-required-future-body">${future.map(renderRule).join('')}</div>
    </details>` : ''}`;
}

let scheduleRecommendationRequest = 0;
let scheduleSelectionGroups = {};
let scheduleGroupTitles = {};

function recommendationSelectionGroups(result) {
  if (result.selection_groups) return result.selection_groups;
  const singleChoiceRules = new Set(result.requirements
    .filter(rule => rule.type === 'choose_n' && rule.target === 1)
    .map(rule => rule.id));
  return Object.fromEntries(result.candidates.map(course => {
    const groups = (course.requirement_ids ?? []).filter(id => singleChoiceRules.has(id));
    if (course.alternative_group) groups.push(`alternative:${course.alternative_group.id}`);
    return [course.course_code, groups];
  }));
}

async function loadScheduleRecommendations() {
  const request = ++scheduleRecommendationRequest;
  closeScheduleSections(false);
  clearScheduleSearch();
  const panel = $('#schedule-recommendations');
  if (!version) {
    panel.innerHTML = '<button type="button" class="button secondary" data-schedule-profile>학생 정보 입력</button>';
    return;
  }
  panel.textContent = '추천 과목을 불러오는 중이에요.';
  try {
    const result = await api('/api/recommendations', {version, automatic_term:true});
    if (request !== scheduleRecommendationRequest) return;
    recommendedCourses = new Map(result.candidates.map(course => [course.course_code, course]));
    scheduleSelectionGroups = recommendationSelectionGroups(result);
    scheduleGroupTitles = {...Object.fromEntries(result.requirements.map(rule => [rule.id, rule.title])),
      ...result.core_area_titles};
    const [year, semester] = result.target_term.split('-');
    $('#schedule-term').textContent = `${year}년 ${semester}학기`;
    panel.innerHTML = recommendationGroups.map(([group, title]) => {
      const courses = displayedRecommendationCourses(result.candidates, group);
      const rules = result.requirements.filter(rule =>
        rule.status !== 'met' && matchesRecommendationGroup(rule.recommendation_group, group));
      if (!courses.length && !rules.length) return '';
      const cards = (rows, showReason) => rows.map(course => scheduleCourseCard(course, showReason)).join('');
      const heading = group === 'major_required' ? 'h4' : 'h3';
      const renderRule = rule => {
        const matches = courses.filter(course => course.requirement_ids.includes(rule.id));
        const needed = Math.max(0, rule.target - (rule.current ?? 0));
        const unit = rule.type === 'min_group_credits' ? '학점' : '과목';
        return `<section class="schedule-req-group"><${heading}>${esc(rule.title)}</${heading}>
          ${needed ? `<small>${needed}${unit} 필요</small>` : ''}
          ${matches.length ? cards(matches, false) : `<p>${rule.offered ? '후보 없음' : '이번 학기 미개설'}</p>`}</section>`;
      };
      const content = group === 'major_required' ? renderMajorRequired(rules, renderRule)
        : rules.length ? rules.map(renderRule).join('') : cards(courses, true);
      return `<details class="schedule-rec-group"${group === 'major_required' || group === 'required_general' ? ' open' : ''}>
        <summary>${esc(title)} <span>${courses.length}</span></summary>
        ${content}</details>`;
    }).join('') || '<p>후보 없음</p>';
    renderBasket();
  } catch (error) {
    if (request === scheduleRecommendationRequest) panel.textContent = error.message;
  }
}

function scheduleCourseCard(course, showReason) {
  const area = scheduleSelectionGroups[course.course_code]?.find(group => group.startsWith('core_'));
  return `<div class="schedule-rec-course">
    <div class="schedule-rec-info"><strong>${esc(course.course_name)}</strong><span>${esc(courseCredits(course))}학점</span></div>
    ${showReason ? `<small>${esc(scheduleGroupTitles[area] || course.reasons[0])}</small>` : ''}
    <div class="schedule-rec-actions"><button type="button" class="button secondary" data-view-sections="${esc(course.course_code)}" aria-haspopup="dialog">분반 보기</button>
    <button type="button" class="button secondary" data-basket-add="${esc(course.course_code)}" data-course-name="${esc(course.course_name)}">선택</button></div>
  </div>`;
}

function displayedRecommendationCourses(candidates, group) {
  const courses = candidates.filter(course => matchesRecommendationGroup(course.group, group));
  return group === 'general_credits' ? courses.slice(0, generalElectiveLimit) : courses;
}

function recommendationEntries(courses) {
  const entries = new Map();
  for (const course of courses) {
    const key = course.alternative_group ? `alternative-${course.alternative_group.id}` : course.course_code;
    if (!entries.has(key)) entries.set(key, []);
    entries.get(key).push(course);
  }
  return Array.from(entries.values());
}

function renderEverytimeRating(rating) {
  if (rating?.status === 'rated' && Number.isFinite(rating.score)) return `★ ${rating.score.toFixed(2)}`;
  if (rating?.status === 'unrated') return '미평가';
  return '<span title="별점 자료 없음" aria-label="별점 자료 없음" role="img">—</span>';
}

function renderEligibilityNote(section) {
  const reason = section.eligibility_reason;
  const label = section.eligibility === 'needs_review' ? '제한 확인' : reason ? '수강 조건' : '';
  return reason ? `<span title="${esc(reason)}">${label}</span>` : label;
}

function courseCredits(course) {
  return [...new Set(course.sections.map(section => section.credits ?? '—'))].join(' / ') || '—';
}

function recommendationCourse(course, requirementTitle = '') {
  const matched = course.reasons.find(reason => reason.startsWith('관심 주제 일치'));
  const reasons = course.reasons.filter(reason => reason !== matched && reason !== requirementTitle &&
    !['전공학점 후보', '교양학점 후보'].includes(reason) && !reason.startsWith('현재 입력 기준'));
  const courseName = esc(course.course_name);
  const grade = course.recommended_grade ? `${course.recommended_grade}학년` : '';
  const meta = [course.course_code, grade, `${courseCredits(course)}학점`].filter(Boolean).join(' · ');
  const scores = course.sections.filter(section =>
    section.eligibility === course.eligibility && section.everytime_rating?.status === 'rated')
    .map(section => section.everytime_rating.score).filter(Number.isFinite);
  const score = scores.length ? Math.max(...scores) : null;
  return `<div class="rec-item">
    <div class="rec-item-main">
      <strong class="course-title">${courseName}</strong>
      <small>${esc(meta)}</small>
      ${reasons.length ? `<details class="rec-reasons"><summary>추천 이유</summary>
        <ul>${reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></details>` : ''}
    </div>
    <div class="rec-signals">
      ${matched ? `<span class="rec-highlight">${lineIcon('tag')} ${esc(matched.replace(/^관심 주제 일치 · /, ''))}</span>` : ''}
      <span class="rec-score">${score !== null ? `최고 분반 ★ ${score.toFixed(2)}` : '별점 자료 없음'}</span>
    </div>
    <div class="rec-item-actions">
      <button type="button" class="button secondary" data-view-sections="${esc(course.course_code)}"
        aria-label="${courseName} 분반 ${course.sections.length}개 보기" aria-haspopup="dialog">분반 ${course.sections.length}개</button>
      <button type="button" class="button secondary basket-add" data-basket-add="${esc(course.course_code)}" data-course-name="${courseName}">+</button>
      ${course.eligibility === 'needs_review' ? '<small>수강 조건 확인</small>' : ''}
    </div>
  </div>`;
}

function recommendationList(entries, startRank = null, requirementTitle = '') {
  const ranked = startRank !== null;
  const tag = ranked ? 'ol' : 'ul';
  return `<${tag} class="rec-list${ranked ? ' rec-ranked' : ''}" role="list"${ranked ? ` start="${startRank}"` : ''}>${entries.map((courses, index) =>
    `<li class="rec-list-entry">
      ${ranked ? `<span class="rec-rank-number">${startRank + index}<span class="sr-only">위</span></span>` : ''}
      <div class="rec-entry-courses">
        ${courses.length > 1 ? `<div class="rec-choice-title">${esc(courses[0].alternative_group.title)} <span>택1</span></div>` : ''}
        ${courses.map(course => recommendationCourse(course, requirementTitle)).join('')}
      </div>
    </li>`).join('')}</${tag}>`;
}

let recommendedCourses = new Map();
let sectionCourse = null;

function showSections(course) {
  sectionCourse = course;
  $('#section-title').textContent = course.course_name;
  $('#section-meta').textContent = `${course.course_code} · 학점 ${courseCredits(course)}`;
  $('#section-status').textContent = '';
  $('#section-list').innerHTML = `<table><thead><tr><th>분반</th><th>교수</th><th>수업 시간</th><th>별점</th><th>담기</th></tr></thead>
    <tbody>${course.sections.map(section => `<tr>
      <td>${esc(section.section_code)}</td><td>${esc(section.professor || '교수 미정')}</td>
      <td>${esc(section.schedule || '미정')}${section.eligibility_reason || section.eligibility === 'needs_review'
        ? `<details class="section-condition"><summary>${section.eligibility === 'needs_review' ? '제한 확인' : '수강 조건'}</summary>${esc(section.eligibility_reason || '수강 조건을 확인해 주세요.')}</details>` : ''}</td>
      <td class="section-rating">${renderEverytimeRating(section.everytime_rating)}</td>
      <td><button type="button" class="button secondary" data-add-section="${esc(section.offering_id)}">담기</button></td>
    </tr>`).join('')}</tbody></table>`;
  updateSectionButtons(readBasket());
  $('#section-dialog').showModal();
  $('#section-list').scrollTop = 0;
}

function updateSectionButtons(rows) {
  const selected = rows.find(row => row.code === sectionCourse?.course_code)?.offeringId;
  for (const button of document.querySelectorAll('[data-add-section]')) {
    const added = selected === button.dataset.addSection;
    button.textContent = schedulePage ? (added ? '고정됨' : '고정') : (added ? '담김' : '담기');
    button.setAttribute('aria-pressed', String(added));
  }
}

let sectionPickerTrigger;
let sectionPreviewRevision = 0;
let previewSection = null;
let pinnedPreview = null;
let fixedPreviewOfferings = [];

const scheduleConditionsTab = $('#schedule-conditions-tab');
const scheduleBasketTab = $('#schedule-basket-tab');
const scheduleTabs = [scheduleConditionsTab, scheduleBasketTab];

function selectScheduleTab(selectedTab) {
  if (selectedTab === scheduleConditionsTab) closeScheduleSections(false);
  for (const tab of scheduleTabs) {
    const selected = tab === selectedTab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
  }
}

for (const tab of scheduleTabs) {
  tab.addEventListener('click', () => selectScheduleTab(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'Home') next = scheduleConditionsTab;
    else if (event.key === 'End') next = scheduleBasketTab;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      next = tab === scheduleConditionsTab ? scheduleBasketTab : scheduleConditionsTab;
    } else return;
    event.preventDefault();
    selectScheduleTab(next);
    next.focus();
  });
}

async function openScheduleSections(code, trigger) {
  selectScheduleTab(scheduleBasketTab);
  closeScheduleSections(false);
  const request = sectionPreviewRevision;
  const inline = trigger.hasAttribute('data-basket-sections');
  const picker = $('#schedule-section-picker');
  sectionPickerTrigger = trigger;
  if (inline) {
    trigger.closest('.basket-row').after($('#schedule-section-area'));
    trigger.setAttribute('aria-expanded', 'true');
  }
  picker.setAttribute('role', inline ? 'region' : 'dialog');
  const message = $('#schedule-section-error');
  message.textContent = '분반을 불러오는 중이에요.';
  message.hidden = false;
  trigger.setAttribute('aria-busy', 'true');
  try {
    const courses = await loadBasketSections([{code}]);
    if (request !== sectionPreviewRevision || $('#schedule-form').hidden) return;
    const course = courses[code];
    if (!course) throw new Error('이번 학기에 선택할 수 있는 분반이 없어요.');
    message.hidden = true;
    sectionCourse = course;
    previewSection = pinnedPreview = null;
    $('#schedule-section-title').textContent = course.course_name;
    $('#schedule-section-list').innerHTML = course.sections.map(section => `<article class="schedule-rec-course" data-preview-section="${esc(section.offering_id)}">
      <div class="schedule-rec-info"><strong>${esc(section.section_code)} · ${esc(section.professor || '교수 미정')}</strong><span>${renderEverytimeRating(section.everytime_rating)}</span></div>
      <small>${esc(section.schedule || '시간 미정')}</small>
      ${section.eligibility_reason ? `<details class="section-condition"><summary>${section.eligibility === 'needs_review' ? '제한 확인' : '수강 조건'}</summary>${esc(section.eligibility_reason)}</details>` : ''}
      <div class="schedule-rec-actions"><button type="button" class="button secondary" data-pin-preview>미리보기</button>
      <button type="button" class="button secondary" data-add-section="${esc(section.offering_id)}">고정</button></div>
    </article>`).join('');
    $('#schedule-recommendations').inert = !inline;
    picker.hidden = false;
    $('#schedule-section-list').scrollTop = 0;
    updateSectionButtons(readBasket());
    renderSelectedCalendar();
    if (!inline) $('#close-schedule-sections').focus();
  } catch (error) {
    if (request === sectionPreviewRevision) {
      message.textContent = error.status === 404
        ? '분반을 불러오려면 앱 서버를 재시작한 뒤 새로고침해 주세요.' : error.message;
      message.hidden = false;
    }
  } finally {
    trigger.removeAttribute('aria-busy');
    if (request === sectionPreviewRevision) sectionPickerTrigger?.removeAttribute('aria-busy');
  }
}

function closeScheduleSections(restoreFocus = true) {
  ++sectionPreviewRevision;
  $('#schedule-section-error').hidden = true;
  if (!sectionPickerTrigger) return;
  const trigger = sectionPickerTrigger;
  if (trigger.hasAttribute('data-basket-sections')) {
    trigger.setAttribute('aria-expanded', 'false');
    $('#schedule-recommendation-pane').append($('#schedule-section-area'));
  }
  $('#schedule-section-picker').hidden = true;
  $('#schedule-recommendations').inert = false;
  $('#return-to-schedule-sections').hidden = true;
  sectionCourse = previewSection = pinnedPreview = null;
  if (restoreFocus && trigger.isConnected) trigger.focus();
  sectionPickerTrigger = null;
  renderSelectedCalendar();
}

function renderRecommendations(result) {
  const candidates = result.candidates;
  recommendedCourses = new Map(candidates.map(course => [course.course_code, course]));
  let displayedCount = 0;
  const sections = recommendationGroups.map(([group, title]) => {
    const rows = displayedRecommendationCourses(candidates, group);
    const entries = recommendationEntries(rows);
    displayedCount += entries.length;
    const required = result.requirements.filter(rule =>
      rule.status !== 'met' && matchesRecommendationGroup(rule.recommendation_group, group));
    const creditRule = result.requirements.find(rule => rule.id === group.replace('_credits', ''));
    let content;
    let remaining = 0;
    const heading = group === 'major_required' ? 'h4' : 'h3';
    const renderRule = rule => {
      const options = rows.filter(course => course.requirement_ids.includes(rule.id));
      const notes = [
        rule.recommended_grade ? `${rule.recommended_grade}학년` : '',
        rule.type === 'choose_n' ? `택${rule.target}` : '',
        rule.type === 'min_group_credits' ? `현재 입력 기준 ${Math.max(0, rule.target - rule.current)}학점 남음` : '',
        rule.in_progress ? '수강 중인 과목 있음' : '',
      ].filter(Boolean);
      const availability = options.length ? '' : `<span class="requirement-availability${rule.offered ? ' no-candidates' : ''}">
        ${lineIcon('calendarOff')} ${rule.offered ? '추천 가능한 분반 없음' : '이번 학기 미개설'}
      </span>`;
      return `<div class="requirement-heading">
        <${heading}>${esc(rule.title)}</${heading}>
        <div class="requirement-status">
          ${notes.length ? `<span class="requirement-meta">${esc(notes.join(' · '))}</span>` : ''}
          ${availability}</div></div>
        ${options.length ? recommendationList(options.map(course => [course]), null, rule.title) : ''}`;
    };
    if (group === 'major_required') {
      content = renderMajorRequired(required, renderRule);
    } else if (required.length) {
      content = required.map(renderRule).join('');
    } else if (group.endsWith('_credits')) {
      const featured = entries.slice(0, 5);
      const additional = entries.slice(featured.length);
      remaining = creditRule ? Math.max(0, creditRule.target - creditRule.current) : 0;
      content = (entries.length ? recommendationList(featured, 1)
        : '<p>이번 학기 추천 후보가 없습니다.</p>') +
        (additional.length ? `<details class="rec-more"><summary>다른 후보 ${additional.length}개 보기</summary>
          ${recommendationList(additional, featured.length + 1)}</details>` : '');
    } else {
      content = '<p>남은 요건이 없습니다.</p>';
    }
    const count = group.endsWith('_credits') ? `후보 ${entries.length}개` : `남은 요건 ${required.length}개`;
    const priority = (group === 'major_required' && required.length > 0) ||
      (group === 'required_general' && rows.length > 0 && required.length > 0);
    const open = group === 'major_required' && required.length > 0;
    return `<details class="result-panel${priority ? ' result-panel--priority' : ''}"${open ? ' open' : ''}>
      <summary>${lineIcon(group.includes("major") ? "book" : "grid")}${title}${remaining ? `<span class="rec-remaining" title="현재 입력 기준">${remaining}학점 남음</span>` : ''}${priority ? '<span class="priority-label">우선 확인</span>' : ''}<span class="count">${count}</span></summary><div class="result-body">${content}</div></details>`;
  });
  const creditReviews = result.credit_reviews.length
    ? `<p class="notice">택1 과목을 모두 이수해 인정학점 확인이 필요합니다. 아래 과목의 학점은 확인 전까지 합계에서 보류했습니다.</p>
      <ul>${result.credit_reviews.map(review => `<li>${esc(review.title)} (${esc(review.course_codes.join(' / '))})</li>`).join('')}</ul>`
    : '';
  const credits = [['total', '총학점'], ['major', '전공'], ['general', '교양']]
    .map(([id, label]) => ({label, rule: result.requirements.find(item => item.id === id)}))
    .filter(({rule}) => rule?.current != null && rule.target > 0);
  const met = result.requirements.filter(rule => rule.status === 'met').length;
  const total = result.requirements.length;
  const completion = total ? 100 * met / total : 0;
  const checks = `<section class="requirements-board" aria-labelledby="requirements-board-title">
    <header><h2 id="requirements-board-title">학번별 이수요건</h2><small>현재 입력 기준</small></header>
    <div class="requirements-charts">
      <figure class="viz completion-viz">
        <svg class="data-ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle cx="60" cy="60" r="48" pathLength="100"/>
          <circle class="data-ring-value" cx="60" cy="60" r="48" pathLength="100" stroke-dasharray="${completion} 100"/>
        </svg>
        <figcaption><strong>${met} / ${total}</strong><span>충족한 요건</span></figcaption>
      </figure>
      <section class="viz" aria-label="인정학점 현황">
        ${credits.map(({label, rule}) => `<div class="credit-progress">
          <div><strong>${label}</strong><span>${esc(rule.current)} / ${esc(rule.target)}학점</span></div>
          <meter min="0" max="${rule.target}" value="${Math.min(rule.current, rule.target)}" aria-label="${label} 충족도"></meter>
        </div>`).join('')}
      </section>
    </div>
    <details class="requirements-detail"><summary>이수요건 전체 보기</summary>${creditReviews}<div class="table-wrap"><table>
      <thead><tr><th>요건</th><th>상태</th><th>현재 / 기준</th></tr></thead><tbody>
      ${result.requirements.map(rule => `<tr><td>${esc(rule.title)}</td>
        <td><span class="state-pill ${rule.status === 'met' ? 'met' : 'not_met'}">${recommendationStatus[rule.status]}</span></td>
        <td>${esc(rule.current ?? '—')} / ${esc(rule.target)}</td></tr>`).join('')}
      </tbody></table></div></details>
  </section>`;
  const metrics = $('#recommendation-metrics');
  metrics.innerHTML = `<span><strong>${esc(result.target_term)}</strong>추천 학기</span>
    <span><strong>${displayedCount}</strong>추천 후보</span>
`;
  metrics.hidden = false;
  $('#recommendation-summary').textContent = '';
  const results = $('#recommendation-results');
  results.innerHTML = checks + '<div class="results-title"><h2>추천 과목</h2><button type="button" class="button secondary">모두 펼치기</button></div>'
    + sections.join('');
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
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const basketList = $('#basket-list');
if (schedulePage) {
  $('#schedule-basket-content').append(basketList);
  $('#open-basket').removeAttribute('aria-haspopup');
  $('#open-basket').setAttribute('aria-controls', 'schedule-basket');
}
const scheduleDays = [...'월화수목금토일'];
let basketSectionRequest;
let basketPreviewRevision = 0;

function readBasket() {
  try {
    const rows = JSON.parse(localStorage.getItem(basketKey));
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

function writeBasket(rows) {
  try {
    localStorage.setItem(basketKey, JSON.stringify(rows));
    if (schedulePage && $('#schedule-form').hidden) showScheduleConditions();
    else renderBasket();
  } catch {
    $('#basket-status').textContent = '브라우저에 바구니를 저장할 수 없습니다.';
    return false;
  }
  return true;
}

function renderBasket() {
  const rows = readBasket();
  const codes = new Set(rows.map(row => row.code));
  const label = row => row.sectionCode ? `${row.code} · ${row.sectionCode} 분반 고정` : row.code;
  $('#basket-count').textContent = rows.length;
  $('#schedule-basket-count').textContent = rows.length;
  const expandedCode = sectionPickerTrigger?.dataset.basketSections;
  const sectionArea = $('#schedule-section-area');
  const active = document.activeElement;
  if (expandedCode) $('#schedule-recommendation-pane').append(sectionArea);
  basketList.innerHTML = rows.length
    ? rows.map(row => `<div class="basket-row">
        <span><strong>${esc(row.name)}</strong><small>${esc(label(row))}</small></span>
        <div class="basket-actions">
          ${schedulePage ? `<button type="button" class="button secondary" data-basket-sections="${esc(row.code)}" aria-label="${esc(row.name)} 분반" aria-expanded="false" aria-controls="schedule-section-area">분반</button>` : ''}
          ${row.offeringId ? `<button type="button" class="button secondary" data-basket-unlock="${esc(row.code)}">고정 해제</button>` : ''}
          ${schedulePage ? `<select data-schedule-course="${esc(row.code)}" aria-label="${esc(row.name)} 편성 조건">
            ${row.offeringId ? '<option value="locked">분반 고정</option>' : ''}
            <option value="">자동</option><option value="required">필수 포함</option><option value="preferred">선호</option><option value="excluded">제외</option>
          </select>` : ''}
          <button type="button" class="button secondary" data-basket-remove="${esc(row.code)}" aria-label="${esc(row.name)} 바구니에서 삭제">삭제</button>
        </div>
      </div>`).join('')
    : '<p>추천 과목에서 과목을 선택해 바구니에 담으세요.</p>';
  if (schedulePage) {
    if (expandedCode) {
      const trigger = [...basketList.querySelectorAll('[data-basket-sections]')]
        .find(button => button.dataset.basketSections === expandedCode);
      if (trigger) {
        trigger.setAttribute('aria-expanded', 'true');
        if (sectionPickerTrigger.hasAttribute('aria-busy')) trigger.setAttribute('aria-busy', 'true');
        sectionPickerTrigger = trigger;
        trigger.closest('.basket-row').after(sectionArea);
        if (sectionArea.contains(active)) active.focus({preventScroll:true});
      } else closeScheduleSections(false);
    }
    for (const select of $('#basket-list').querySelectorAll('[data-schedule-course]')) {
      const row = rows.find(row => row.code === select.dataset.scheduleCourse);
      select.value = row.offeringId ? 'locked' : (row.scheduleMode ?? '');
    }
    if (!$('#schedule-form').hidden && !$('#generate-schedule').disabled) refreshBasketPreview(rows);
  }
  for (const button of document.querySelectorAll('[data-basket-add]')) {
    const added = codes.has(button.dataset.basketAdd);
    const scheduleButton = Boolean(button.closest('#schedule-recommendations'));
    button.textContent = scheduleButton ? (added ? '선택됨' : '선택') : (added ? '✓' : '+');
    button.disabled = added;
    button.setAttribute('aria-label', button.dataset.courseName + (scheduleButton ? (added ? ' 선택됨' : ' 선택') : (added ? ' 담김' : ' 바구니에 담기')));
  }
  for (const button of $('#schedule-search-results').querySelectorAll('[data-search-add]')) {
    button.disabled = codes.has(button.dataset.searchAdd);
    button.textContent = button.disabled ? '담김' : '담기';
  }
  if ($('#section-dialog').open || !$('#schedule-section-picker').hidden) updateSectionButtons(rows);
}

$('#open-basket').addEventListener('click', () => {
  if (schedulePage) {
    if ($('#schedule-form').hidden) showScheduleConditions();
    selectScheduleTab(scheduleBasketTab);
    $('#schedule-basket-title').focus();
    return;
  }
  renderBasket();
  $('#basket-dialog').showModal();
});
function removeSelection(event) {
  const button = event.target.closest('[data-basket-remove]');
  if (!button) return;
  writeBasket(readBasket().filter(row => row.code !== button.dataset.basketRemove));
}
$('#basket-list').addEventListener('click', removeSelection);

async function saveSelection(entry) {
  let rows = readBasket();
  const previous = rows.find(row => row.code === entry.code);
  if (schedulePage && entry.scheduleMode !== 'excluded' &&
      (!previous || previous.scheduleMode === 'excluded' || entry.offeringId)) {
    const groups = scheduleSelectionGroups[entry.code] || [];
    const conflictsWithEntry = row => row.code !== entry.code && row.scheduleMode !== 'excluded' &&
      (scheduleSelectionGroups[row.code] || []).some(group => groups.includes(group));
    const conflicts = rows.filter(conflictsWithEntry);
    if (conflicts.length) {
      if ($('#confirm-dialog').open) return false;
      const names = conflicts.map(row => row.name).join(', ');
      if (!await confirmHistoryChange(`${names} 대신 ${entry.name}을 선택할까요?`, '같은 요건의 과목 변경')) return false;
      const replaced = new Set(conflicts.map(row => row.code));
      rows = readBasket().filter(row => !replaced.has(row.code));
      if (rows.some(conflictsWithEntry)) return false;
    }
  }
  const index = rows.findIndex(row => row.code === entry.code);
  if (index === -1) rows.push(entry);
  else rows[index] = entry;
  return writeBasket(rows);
}

const scheduleCourseQuery = $('#schedule-course-query');
const scheduleSearchStatus = $('#schedule-search-status');
const scheduleSearchResults = $('#schedule-search-results');
let scheduleSearchRevision = 0;

function clearScheduleSearch() {
  ++scheduleSearchRevision;
  scheduleSearchStatus.textContent = '';
  scheduleSearchResults.replaceChildren();
}

async function fetchScheduleCourseResults(version, query) {
  try {
    return await api('/api/schedules/search', {version, query});
  } catch (error) {
    if (error.status !== 404) throw error;
    // An older running server can still supply the courses it recommends.
    const {target_term, candidates} = await api('/api/recommendations', {version, automatic_term:true});
    const normalize = value => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    const key = normalize(query);
    const courses = candidates.flatMap(({course_code, course_name, sections}) => {
      if (!course_code.startsWith(key) && !normalize(course_name).includes(key)) return [];
      const section = sections.find(row => row.credits > 0 && row.schedule);
      return section ? [{course_code, course_name, credits:section.credits}] : [];
    });
    return {target_term, total:courses.length, courses:courses.slice(0, 20)};
  }
}

async function searchScheduleCourses() {
  clearScheduleSearch();
  const query = scheduleCourseQuery.value.trim();
  if (!query) {
    scheduleSearchStatus.textContent = '코드나 과목명을 입력하세요.';
    scheduleCourseQuery.focus();
    return;
  }
  const revision = scheduleSearchRevision;
  scheduleSearchStatus.textContent = '검색 중…';
  try {
    if (!await save()) throw new Error('학생 정보를 저장해주세요.');
    const latest = await api('/api/input');
    if (revision !== scheduleSearchRevision) return;
    const result = await fetchScheduleCourseResults(latest.version, query);
    if (revision !== scheduleSearchRevision) return;
    const codes = new Set(readBasket().map(row => row.code));
    scheduleSearchStatus.textContent = result.total
      ? `${result.target_term} · ${result.total}과목${result.total > result.courses.length ? ' (상위 20개 표시)' : ''}`
      : `${result.target_term} · 검색 결과 없음`;
    scheduleSearchResults.innerHTML = result.courses.map(course => {
      const {course_code:code, course_name:name, credits} = course;
      const added = codes.has(code);
      return `<li><span><strong>${esc(name)}</strong><small>${esc(code)} · ${credits}학점</small></span>
        <button type="button" class="button secondary" data-search-add="${esc(code)}" data-course-name="${esc(name)}"${added ? ' disabled' : ''}>${added ? '담김' : '담기'}</button></li>`;
    }).join('');
  } catch (error) {
    if (revision === scheduleSearchRevision) {
      scheduleSearchStatus.textContent = error.status === 404 ? '검색할 수 없어요.' : error.message;
    }
  }
}

scheduleCourseQuery.addEventListener('input', clearScheduleSearch);
scheduleCourseQuery.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  searchScheduleCourses();
});
$('#search-schedule-courses').addEventListener('click', searchScheduleCourses);
scheduleSearchResults.addEventListener('click', async event => {
  const button = event.target.closest('[data-search-add]');
  if (!button) return;
  const {searchAdd:code, courseName:name} = button.dataset;
  if (readBasket().some(row => row.code === code)) return;
  if (await saveSelection({code, name, scheduleMode:'required'})) {
    $('#basket-status').textContent = `${name} 과목을 바구니에 담았어요.`;
  }
});

async function handleRecommendationClick(event) {
  const view = event.target.closest('[data-view-sections]');
  if (view) {
    const course = recommendedCourses.get(view.dataset.viewSections);
    if (schedulePage) openScheduleSections(view.dataset.viewSections, view);
    else if (course) showSections(course);
    return;
  }
  const button = event.target.closest('[data-basket-add]');
  if (!button) return;
  const rows = readBasket();
  if (rows.some(row => row.code === button.dataset.basketAdd)) return;
  const entry = {code:button.dataset.basketAdd, name:button.dataset.courseName};
  if (schedulePage) entry.scheduleMode = 'required';
  if (await saveSelection(entry)) {
    $('#basket-status').textContent = `${entry.name}${schedulePage ? ' 선택됨' : ' 과목을 바구니에 담았어요.'}`;
  }
}
$('#recommendation-results').addEventListener('click', handleRecommendationClick);
$('#schedule-recommendations').addEventListener('click', event => {
  if (event.target.closest('[data-schedule-profile]')) openProfile();
  else handleRecommendationClick(event);
});
async function selectSection(event) {
  const button = event.target.closest('[data-add-section]');
  const section = sectionCourse?.sections.find(row => row.offering_id === button?.dataset.addSection);
  if (!section) return;
  const code = sectionCourse.course_code;
  const rows = readBasket();
  const index = rows.findIndex(row => row.code === code);
  const entry = {...rows[index], code, name:sectionCourse.course_name, offeringId:section.offering_id,
    sectionCode:section.section_code};
  if (schedulePage && (entry.scheduleMode === undefined || entry.scheduleMode === 'excluded')) {
    entry.scheduleMode = 'required';
  }
  if (!await saveSelection(entry)) return;
  if (schedulePage) {
    previewSection = pinnedPreview = null;
  } else $('#section-status').textContent = `${section.section_code} 분반을 담았어요.`;
}
$('#section-list').addEventListener('click', selectSection);
$('#schedule-section-list').addEventListener('click', selectSection);
$('#close-schedule-sections').addEventListener('click', () => closeScheduleSections());
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || $('#schedule-section-picker').hidden || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  closeScheduleSections();
});
function releaseBasketLock(event) {
  const button = event.target.closest('[data-basket-unlock]');
  if (!button) return;
  writeBasket(readBasket().map(row => row.code === button.dataset.basketUnlock
    ? {code:row.code, name:row.name, scheduleMode:row.scheduleMode} : row));
}
$('#basket-list').addEventListener('click', releaseBasketLock);
window.addEventListener('storage', event => {
  if (event.key === basketKey) {
    if (schedulePage && $('#schedule-form').hidden) showScheduleConditions();
    else renderBasket();
  }
});

async function loadBasketSections(rows) {
  const courses = [...new Set(rows.map(row => row.code))].sort();
  if (!courses.length) return {};
  if (!await save()) throw new Error('학생 정보를 저장한 뒤 다시 시도해주세요.');
  const latest = await api('/api/input');
  const key = JSON.stringify([latest.version, courses]);
  if (basketSectionRequest?.key !== key) {
    const request = api('/api/schedules/sections', {version:latest.version, courses});
    basketSectionRequest = {key, request};
    request.catch(() => { if (basketSectionRequest?.request === request) basketSectionRequest = null; });
  }
  return (await basketSectionRequest.request).courses;
}

$('#basket-list').addEventListener('click', event => {
  const button = event.target.closest('[data-basket-sections]');
  if (!button) return;
  if (button === sectionPickerTrigger) closeScheduleSections();
  else openScheduleSections(button.dataset.basketSections, button);
});

$('#basket-list').addEventListener('change', async event => {
  const select = event.target.closest('[data-schedule-course]');
  if (!select) return;
  const code = select.dataset.scheduleCourse;
  const row = readBasket().find(row => row.code === code);
  if (!row) return;
  if (!await saveSelection({code, name:row.name, scheduleMode:select.value})) renderBasket();
  [...$('#basket-list').querySelectorAll('[data-schedule-course]')]
    .find(row => row.dataset.scheduleCourse === code)?.focus({preventScroll:true});
});
$('#schedule-days').innerHTML = scheduleDays.map(day =>
  `<label class="weekday-option"><input type="checkbox" name="blocked-day" value="${day}" aria-label="${day}요일">
    <span aria-hidden="true">${day}${lineIcon('check')}</span></label>`
).join('');

let scheduleCandidates = [];
let selectedSchedule = null;

const scheduleSectionList = $('#schedule-section-list');
function previewScheduleSection(row) {
  const section = sectionCourse?.sections.find(item => item.offering_id === row?.dataset.previewSection);
  previewSection = section ? {...section, course_name:sectionCourse.course_name,
    course_code:sectionCourse.course_code, temporary:true} : null;
  renderSelectedCalendar();
}
scheduleSectionList.addEventListener('pointerover', event => {
  if (event.pointerType !== 'mouse') return;
  const row = event.target.closest('[data-preview-section]');
  if (row && !row.contains(event.relatedTarget)) previewScheduleSection(row);
});
scheduleSectionList.addEventListener('pointerleave', () => previewScheduleSection(pinnedPreview));
scheduleSectionList.addEventListener('focusin', event => previewScheduleSection(event.target.closest('[data-preview-section]')));
scheduleSectionList.addEventListener('focusout', event => {
  if (!scheduleSectionList.contains(event.relatedTarget)) previewScheduleSection(pinnedPreview);
});
scheduleSectionList.addEventListener('click', event => {
  const button = event.target.closest('[data-pin-preview]');
  if (!button) return;
  pinnedPreview = button.closest('[data-preview-section]');
  previewScheduleSection(pinnedPreview);
  if (matchMedia('(max-width: 800px)').matches) {
    $('#return-to-schedule-sections').hidden = false;
    $('#schedule-preview-title').scrollIntoView({block:'start'});
    $('#return-to-schedule-sections').focus({preventScroll:true});
  }
});
$('#return-to-schedule-sections').addEventListener('click', () => $('#close-schedule-sections').focus());

function renderSelectedCalendar() {
  if ($('#schedule-form').hidden) return;
  const selected = readBasket().filter(row => row.offeringId);
  const offerings = fixedPreviewOfferings.filter(row => row.course_code !== previewSection?.course_code);
  if (previewSection?.meetings.length) offerings.push(previewSection);
  const conflicts = new Set();
  for (const [index, first] of offerings.entries()) {
    for (const second of offerings.slice(index + 1)) {
      if (first.meetings.some(a => second.meetings.some(b => a.day === b.day && a.start < b.end && b.start < a.end))) {
        conflicts.add(first.course_name);
        conflicts.add(second.course_name);
      }
    }
  }
  renderCalendar({offerings}, true);
  const missing = selected.length - fixedPreviewOfferings.length;
  $('#schedule-preview-summary').textContent = [
    selected.length ? `고정 분반 ${selected.length}개` : '',
    previewSection && `${previewSection.course_name} ${previewSection.section_code} 미리보기${previewSection.meetings.length ? '' : ' (시간 미정)'}`,
    conflicts.size && `시간 겹침 · ${[...conflicts].join(', ')}`,
    missing > 0 && `시간표에 표시할 수 없는 고정 분반 ${missing}개`,
  ].filter(Boolean).join(' · ');
}

async function refreshBasketPreview(rows = readBasket()) {
  const revision = ++basketPreviewRevision;
  const selected = rows.filter(row => row.offeringId);
  const summary = $('#schedule-preview-summary');
  const ids = new Set(selected.map(row => row.offeringId));
  fixedPreviewOfferings = fixedPreviewOfferings.filter(row => ids.has(row.offering_id));
  if (previewSection && ids.has(previewSection.offering_id)) previewSection = pinnedPreview = null;
  renderSelectedCalendar();
  if (!selected.length) {
    return;
  }
  try {
    const courses = await loadBasketSections(selected);
    if (revision !== basketPreviewRevision || $('#schedule-form').hidden) return;
    fixedPreviewOfferings = selected.flatMap(row => {
      const course = courses[row.code];
      const section = course?.sections.find(item => item.offering_id === row.offeringId);
      return section?.meetings.length ? [{...section, course_name:course.course_name, course_code:row.code}] : [];
    });
    renderSelectedCalendar();
  } catch (error) {
    if (revision !== basketPreviewRevision || $('#schedule-form').hidden) return;
    renderCalendar();
    summary.textContent = error.message;
  }
}

function scheduleClassDays(plan) {
  return scheduleDays.filter(day => plan.offerings.some(offering =>
    offering.meetings.some(meeting => meeting.day === day)));
}

function scheduleCourseMix(plan) {
  return "전공 " + plan.major_credits + "학점 · 교양 " + plan.general_credits + "학점";
}

function scheduleSpacing(plan) {
  return plan.adjacent_sessions ? "연강 " + plan.adjacent_sessions + "회" : "연강 없음";
}

function calendarLayout(plan) {
  const entries = (plan?.offerings ?? []).flatMap((offering, color) =>
    offering.meetings.map(meeting => ({...meeting, offering, color: color % 6})));
  const visibleDays = scheduleDays.filter((day, index) => index < 5 ||
    entries.some(meeting => meeting.day === day));
  const first = Math.min(2, ...entries.map(meeting => 2 * Math.floor(meeting.start / 2)));
  const end = Math.max(20, ...entries.map(meeting => 2 * Math.ceil(meeting.end / 2)));
  return {entries, visibleDays, first, end};
}

let shareableSchedule = null;
const scheduleShareButton = $('#share-schedule-image');
const scheduleShareStatus = $('#schedule-share-status');

function scheduleImageFile(plan) {
  const {entries, visibleDays, first, end} = calendarLayout(plan);
  const pad = 24, periodWidth = 48, dayWidth = 168, header = 38, half = 27;
  const gridTop = 86;
  const width = pad * 2 + periodWidth + dayWidth * visibleDays.length;
  const height = gridTop + header + half * (end - first) + pad;
  const canvas = document.createElement('canvas');
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  const palette = ['#f3ded4', '#f8ecd3', '#f0e4d4', '#efdee6', '#f7e6e2', '#eae9df'];
  const text = (value, x, y, size = 14, bold = false) => {
    ctx.fillStyle = '#2d2328';
    ctx.font = `${bold ? '700' : '400'} ${size}px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(value, x, y);
  };
  const box = (x, y, w, h, fill) => {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#ddd1c5';
    ctx.strokeRect(x, y, w, h);
  };
  ctx.fillStyle = '#fffcf7';
  ctx.fillRect(0, 0, width, height);
  text('주간 시간표', pad, 20, 25, true);
  text($('#schedule-preview-summary').textContent, pad, 55);
  box(pad, gridTop, periodWidth, header, '#f8f4ee');
  text('교시', pad + 8, gridTop + 11);
  const top = gridTop + header;
  visibleDays.forEach((day, i) => {
    const x = pad + periodWidth + i * dayWidth;
    box(x, gridTop, dayWidth, header, '#f8f4ee');
    text(day, x + 12, gridTop + 11, 14, true);
  });
  for (let tick = first; tick < end; tick += 2) {
    const y = top + (tick - first) * half;
    box(pad, y, periodWidth, half * 2, '#f8f4ee');
    text(String(tick / 2), pad + 12, y + 8);
    visibleDays.forEach((_, i) => box(pad + periodWidth + i * dayWidth, y, dayWidth, half * 2, '#fffcf7'));
  }
  for (const meeting of entries) {
    const x = pad + periodWidth + visibleDays.indexOf(meeting.day) * dayWidth;
    const y = top + (meeting.start - first) * half;
    const h = (meeting.end - meeting.start) * half;
    box(x + 1, y + 1, dayWidth - 2, h - 2, palette[meeting.color]);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 7, y + 3, dayWidth - 14, h - 6);
    ctx.clip();
    ctx.font = '700 14px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
    let line = '', lineY = y + 6;
    for (const character of meeting.offering.course_name) {
      if (ctx.measureText(line + character).width > dayWidth - 16) {
        text(line, x + 8, lineY, 14, true);
        lineY += 17;
        line = '';
      }
      line += character;
    }
    text(line, x + 8, lineY, 14, true);
    if (lineY + 32 <= y + h) {
      text([meeting.offering.section_code, meeting.offering.room].filter(Boolean).join(' · '), x + 8, lineY + 18, 12);
    }
    ctx.restore();
  }
  const binary = atob(canvas.toDataURL('image/png').split(',')[1]);
  return new File([Uint8Array.from(binary, character => character.charCodeAt(0))], '수강나침반-시간표.png', {type:'image/png'});
}

scheduleShareButton.addEventListener('click', () => {
  if (!shareableSchedule) return;
  scheduleShareStatus.hidden = true;
  try {
    const file = scheduleImageFile(shareableSchedule);
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    scheduleShareStatus.textContent = '다운로드 목록에서 시간표 PNG를 확인해주세요.';
  } catch {
    scheduleShareStatus.textContent = '시간표 이미지를 만들지 못했어요. 다시 시도해주세요.';
  }
  scheduleShareStatus.hidden = false;
});

function renderCalendar(plan = null, preview = false) {
  shareableSchedule = !preview && plan?.offerings.length ? plan : null;
  scheduleShareButton.disabled = !shareableSchedule;
  scheduleShareStatus.hidden = true;
  const {entries, visibleDays, first, end} = calendarLayout(plan);
  const rows = [];
  for (let tick = first; tick < end; tick++) {
    const cells = [];
    if (tick % 2 === 0) {
      cells.push(`<th class="schedule-period" scope="row" rowspan="2">${tick / 2}</th>`);
    }
    for (const day of visibleDays) {
      if (preview) {
        const active = entries.filter(entry => entry.day === day && entry.start <= tick && tick < entry.end);
        if (!active.length) cells.push('<td class="schedule-empty"></td>');
        else if (entries.some(entry => entry.day === day && (entry.start === tick || entry.end === tick))) {
          const next = Math.min(...active.map(entry => entry.end),
            ...entries.filter(entry => entry.day === day && entry.start > tick).map(entry => entry.start));
          cells.push(`<td class="schedule-slot${active.length > 1 ? ' schedule-conflict' : ''}" rowspan="${next - tick}">${active.map(calendarClass).join('')}</td>`);
        }
        continue;
      }
      const meeting = entries.find(entry => entry.day === day && entry.start <= tick && tick < entry.end);
      if (!meeting) {
        cells.push('<td class="schedule-empty"></td>');
      } else if (meeting.start === tick) {
        cells.push(`<td class="schedule-slot schedule-color-${meeting.color}" rowspan="${meeting.end - meeting.start}">${calendarClass(meeting)}</td>`);
      }
    }
    rows.push(`<tr class="schedule-half${tick % 2 ? ' period-end' : ''}">${cells.join('')}</tr>`);
  }
  const calendar = $('#schedule-calendar');
  const previous = new Set([...calendar.querySelectorAll('[data-calendar-offering]')]
    .map(block => block.dataset.calendarOffering));
  calendar.innerHTML = `<table class="schedule-grid" aria-label="요일과 교시별 시간표">
    <thead><tr><th scope="col">교시</th>${visibleDays.map(day => `<th scope="col">${day}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
  if (!motionPreference.matches) {
    const added = [...calendar.querySelectorAll('[data-calendar-offering]')]
      .filter(block => !previous.has(block.dataset.calendarOffering));
    added.forEach((block, index) => block.animate([
      {opacity:.4, transform:'translateY(8px) scale(.97)'},
      {opacity:1, transform:'none'},
    ], {duration:260, delay:Math.min(index, 4) * 25, easing:'cubic-bezier(.2,.75,.25,1)'}));
  }
}

function calendarClass({offering, color}) {
  return `<div class="schedule-class-block schedule-color-${color}${offering.temporary ? ' schedule-temporary' : ''}" data-calendar-offering="${esc(offering.offering_id)}" title="${esc(offering.course_name)} · ${esc(offering.schedule)}">
    <strong>${esc(offering.course_name)}</strong><small>${esc(offering.category)} · ${esc(offering.section_code)}</small></div>`;
}

function renderScheduleAnalytics(plan) {
  const widget = $('#schedule-analytics');
  widget.hidden = !plan;
  if (!plan) return;
  const other = Math.max(0, +(plan.credits - plan.major_credits - plan.general_credits).toFixed(2));
  const mix = [
    {kind:'major', label:'전공', credits:plan.major_credits},
    {kind:'general', label:'교양', credits:plan.general_credits},
    {kind:'other', label:'기타', credits:other},
  ].filter(part => part.credits > 0);
  const metrics = [['연강', `${plan.adjacent_sessions}회`], ['수업 사이 빈 시간', `${plan.gap_periods}교시`]];
  const ratings = plan.offerings.map(row => row.everytime_rating)
    .filter(rating => rating?.status === 'rated' && Number.isFinite(rating.score));
  if (ratings.length) metrics.push([
    '에타 평균 별점',
    `★ ${(ratings.reduce((sum, rating) => sum + rating.score, 0) / ratings.length).toFixed(2)} / 5`,
  ]);
  widget.innerHTML = `<div class="schedule-viz">
    <figure class="viz schedule-mix"><figcaption>학점 구성</figcaption>
      <svg class="credit-stack" viewBox="0 0 1000 12" preserveAspectRatio="none" aria-hidden="true">${mix.map(({kind, credits}, i) => {
        const start = mix.slice(0, i).reduce((sum, part) => sum + part.credits, 0);
        return `<rect class="credit-part-${kind}" x="${1000 * start / plan.credits}" width="${1000 * credits / plan.credits}" height="12"/>`;
      }).join('')}</svg>
      <ul>${mix.map(({kind, label, credits}) => `<li><i class="credit-part-${kind}" aria-hidden="true"></i>${label} <strong>${credits}학점</strong></li>`).join('')}</ul>
    </figure>
    <dl class="schedule-numbers">${metrics.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>
  </div>`;
}

function showSchedule(index) {
  const plan = scheduleCandidates[index];
  if (!plan) return;
  selectedSchedule = plan;
  $('#start-registration-practice').hidden = false;
  for (const button of document.querySelectorAll('[data-schedule-index]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.scheduleIndex) === index));
  }
  const label = plan.advisorGenerated ? `${candidateLabel(index)} (AI 선배 추천)` : `${index + 1}위`;
  $('#schedule-preview-summary').textContent = `${label} · ${plan.credits}학점 · ${scheduleClassDays(plan).join('·')} 수업${plan.provisional ? ' · 수강 자격 확인 필요' : ''}`;
  renderScheduleAnalytics(plan);
  renderCalendar(plan);
  const locked = new Set(readBasket().map(row => row.offeringId));
  $('#schedule-offering-table').innerHTML = `<table><thead><tr><th>과목·분반</th><th>교시</th><th>강의실</th><th>학점</th><th>별점</th><th>수강 자격</th></tr></thead>
    <tbody>${plan.offerings.map(row => `<tr>
      <td>${esc(row.course_name)}<small>${esc(row.course_code)}-${esc(row.section_code)}</small>
        <button type="button" class="button subtle" data-lock-offering="${esc(row.offering_id)}"
          data-course-code="${esc(row.course_code)}" data-course-name="${esc(row.course_name)}" data-section-code="${esc(row.section_code)}"${locked.has(row.offering_id) ? ' disabled' : ''}>${locked.has(row.offering_id) ? '고정됨' : '분반 고정'}</button></td>
      <td>${esc(row.schedule)}</td><td>${esc(row.room || '미정')}</td>
      <td>${esc(row.credits)}</td><td>${renderEverytimeRating(row.everytime_rating)}</td>
      <td>${renderEligibilityNote(row) || '제한 기록 없음'}</td>
    </tr>`).join('')}</tbody></table>`;
  $('#schedule-offerings').hidden = false;
}

const practiceDialog = $('#registration-practice');
const practiceStart = $('#start-registration-practice');
const practiceApply = $('#registration-practice-apply');
const practiceRetry = $('#registration-practice-retry');
const practiceClock = $('#registration-practice-clock');
const practiceClockSeconds = practiceClock.querySelector('span');
const practiceClockMillis = practiceClock.querySelector('small');
const practiceResult = $('#registration-practice-result');
const practiceScore = $('#registration-practice-score');
const practiceFeedback = $('#registration-practice-feedback');
const practiceBestKey = 'registration-practice-best-ms';
const practiceOpeningTime = 10 * 60 * 60 * 1000;
const practiceExcellentMs = 50;
let practiceDeadline = null;
let practiceFrame = null;
let practiceBest = null;

function clearSelectedSchedule() {
  selectedSchedule = null;
  practiceStart.hidden = true;
  if (advisorDialog.open) advisorDialog.close();
  if (practiceDialog.open) practiceDialog.close();
}

function syncPracticeBest() {
  try {
    const stored = localStorage.getItem(practiceBestKey);
    const value = Number(stored);
    if (stored !== null && stored.trim() && Number.isFinite(value) && value >= 0) {
      practiceBest = Math.min(practiceBest ?? Infinity, value);
    }
  } catch { /* Keep the best time in memory if storage is unavailable. */ }
  $('#registration-practice-best').textContent = practiceBest === null ? '—' : `${(practiceBest / 1000).toFixed(3)}초`;
}

function showPracticeTime(offset) {
  const time = new Date(Math.floor(practiceOpeningTime + offset)).toISOString();
  const seconds = `${time.slice(11, 13)}시 ${time.slice(14, 16)}분 ${time.slice(17, 19)}초`;
  if (practiceClockSeconds.textContent !== seconds) practiceClockSeconds.textContent = seconds;
  practiceClockMillis.textContent = time.slice(20, 23);
  practiceClock.classList.toggle('is-open', offset >= 0);
}

function tickPracticeClock() {
  if (practiceDeadline === null || !practiceDialog.open) return;
  showPracticeTime(performance.now() - practiceDeadline);
  practiceFrame = requestAnimationFrame(tickPracticeClock);
}

function startPracticeRound() {
  syncPracticeBest();
  practiceScore.hidden = true;
  practiceScore.textContent = '';
  practiceFeedback.textContent = '';
  practiceResult.classList.remove('is-excellent');
  practiceRetry.hidden = true;
  practiceApply.hidden = false;
  practiceApply.disabled = false;
  practiceApply.focus({preventScroll:true});
  const wait = 2000 + Math.floor(Math.random() * 3001);
  practiceDeadline = performance.now() + wait;
  showPracticeTime(-wait);
  practiceFrame = requestAnimationFrame(tickPracticeClock);
}

function stopPracticeRound() {
  practiceDeadline = null;
  cancelAnimationFrame(practiceFrame);
  practiceFrame = null;
}

function finishPracticeRound(message, score = '') {
  stopPracticeRound();
  practiceResult.classList.toggle('is-excellent', Boolean(score));
  practiceScore.textContent = score;
  practiceScore.hidden = !score;
  practiceFeedback.textContent = message;
  practiceApply.disabled = true;
  practiceApply.hidden = true;
  practiceRetry.hidden = false;
  practiceRetry.focus({preventScroll:true});
}

practiceStart.addEventListener('click', () => {
  if (!selectedSchedule || practiceDialog.open) return;
  const {offerings, credits} = selectedSchedule;
  $('#registration-practice-summary').textContent = `${offerings.length}과목 · 총 ${credits}학점`;
  const calendar = $('#registration-practice-calendar');
  calendar.replaceChildren($('#schedule-calendar').firstElementChild.cloneNode(true));
  practiceDialog.showModal();
  calendar.scrollTo(0, 0);
  startPracticeRound();
});

practiceApply.addEventListener('click', event => {
  if (practiceDeadline === null || !practiceDialog.open || document.hidden) return;
  const offset = event.timeStamp - practiceDeadline;
  showPracticeTime(offset);
  const seconds = (Math.abs(offset) / 1000).toFixed(3);
  const excellent = offset >= 0 && offset <= practiceExcellentMs;
  const message = offset < 0 ? `${seconds}초 일찍 눌렀어요.` : `시작 후 ${seconds}초에 눌렀어요.`;
  if (offset >= 0) syncPracticeBest();
  const newBest = offset >= 0 && (practiceBest === null || offset < practiceBest);
  if (newBest) {
    practiceBest = offset;
    try { localStorage.setItem(practiceBestKey, String(offset)); }
    catch { /* Keep the best time in memory if storage is unavailable. */ }
    syncPracticeBest();
  }
  const feedback = excellent ? '정각을 잡았어요!' : message;
  finishPracticeRound(newBest ? `${feedback} 신기록` : feedback, excellent ? `${seconds}초` : '');
});

practiceRetry.addEventListener('click', () => {
  if (practiceDialog.open && practiceDeadline === null) startPracticeRound();
});
practiceDialog.addEventListener('keydown', event => {
  if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
});
practiceDialog.addEventListener('close', () => {
  if (!practiceDialog.open) stopPracticeRound();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && practiceDialog.open && practiceDeadline !== null) {
    finishPracticeRound('다른 탭으로 이동해 이번 연습을 취소했어요.');
  }
});

const advisorDialog = $('#schedule-advisor');
const advisorOpen = $('#open-schedule-advisor');
const advisorContent = $('#advisor-content');
const advisorChat = $('#advisor-chat');
const advisorTranscript = $('#advisor-transcript');
const advisorStatusMessage = $('#advisor-status');
const advisorQuestion = $('#advisor-question');
const advisorInput = $('#advisor-question-text');
let graduationRequirements = [];
let scheduleRequest = null;
let scheduleSnapshot = null;
let advisorPrimary = 0;
let advisorIntent = null;
let advisorTopic = null;
let advisorSuggested = [];
let advisorPendingCandidate = null;
let advisorRevision = 0;
let advisorBusy = false;

const advisorCriteria = {
  required:'새로 충족할 전필',
  days:'등교일',
  eligibility:'자격 확인 필요 분반',
  gaps:'빈 교시',
};
const advisorUnits = {required:'개', days:'일', eligibility:'개', gaps:'교시'};
const advisorStatus = {met:'충족', not_met:'미충족', needs_review:'확인 필요'};
const candidateLabel = index => `${index + 1}번 후보`;
const eligibilityChecks = plan => plan.offerings.filter(row => row.eligibility === 'needs_review');
const majorRequirement = rule => ['current_major_required', 'future_major_required'].includes(rule.recommendation_group);
const projectedRequirement = (plan, rule) => plan.graduation_projection?.[rule.id];

function advisorValue(plan, topic) {
  if (topic === 'required') {
    return graduationRequirements.filter(rule => majorRequirement(rule) && rule.status !== 'met'
      && projectedRequirement(plan, rule)?.after.status === 'met').length;
  }
  if (topic === 'days') return scheduleClassDays(plan).length;
  if (topic === 'eligibility') return eligibilityChecks(plan).length;
  return plan.gap_periods;
}

function advisorPlanSummary(plan) {
  return `${plan.credits}학점 · ${scheduleClassDays(plan).join('·')} · 전필 충족 예상 ${advisorValue(plan, 'required')}개${plan.provisional ? ' · 자격 확인 필요' : ''}`;
}

function scrollAdvisorTo(element) {
  advisorTranscript.scrollTop += element.getBoundingClientRect().top
    - advisorTranscript.getBoundingClientRect().top;
}

function addAdvisorMessage(speaker, ...paragraphs) {
  const row = document.createElement('div');
  row.className = speaker === '나' ? 'advisor-user-message' : 'advisor-reply';
  const name = document.createElement('strong');
  name.textContent = speaker;
  row.append(name);
  for (const text of paragraphs.filter(Boolean)) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    row.append(paragraph);
  }
  advisorChat.append(row);
  scrollAdvisorTo(row);
  return row;
}

function matchesAdvisorConstraints(plan, intent) {
  const days = scheduleClassDays(plan);
  return intent.days_off.every(day => !days.includes(day))
    && (intent.min_credits === null || plan.credits >= intent.min_credits)
    && (intent.max_credits === null || plan.credits <= intent.max_credits);
}

function compareAdvisorPlans(a, b, intent) {
  for (const topic of intent.priorities) {
    const difference = compareAdvisorCriterion(a, b, topic);
    if (difference) return difference;
  }
  return 0;
}

function compareAdvisorCriterion(a, b, topic) {
  const difference = advisorValue(a, topic) - advisorValue(b, topic);
  return topic === 'required' ? -difference : difference;
}

function advisorMetric(plan, topic) {
  return `${advisorValue(plan, topic)}${advisorUnits[topic]}`;
}

function advisorComparison(base, alternative, intent) {
  const days = plan => scheduleClassDays(plan).join('·') || '없음';
  const requested = intent?.priorities ?? [];
  const metrics = topics => topics.map(topic => [advisorCriteria[topic], advisorMetric(base, topic), advisorMetric(alternative, topic)]);
  const credits = ['총학점', `${base.credits}학점`, `${alternative.credits}학점`];
  const hasCreditLimit = intent && (intent.min_credits !== null || intent.max_credits !== null);
  const items = [
    ...(intent?.days_off ?? []).map(day => {
      const status = plan => scheduleClassDays(plan).includes(day) ? '수업 있음' : '공강';
      return [`${day}요일`, status(base), status(alternative)];
    }),
    ...metrics(requested),
    ...(hasCreditLimit ? [credits] : []),
    ...metrics(Object.keys(advisorCriteria).filter(topic => !requested.includes(topic))),
    ...(!hasCreditLimit ? [credits] : []),
    ['수업 요일', days(base), days(alternative)],
  ];
  return items.filter(([, before, after]) => before !== after);
}

function suggestAdvisorCandidate(intent, primary) {
  const base = scheduleCandidates[primary];
  const priorities = intent.priorities.length ? intent.priorities : ['required', 'days', 'gaps', 'eligibility'];
  const ranking = {...intent, priorities};
  const matching = scheduleCandidates.map((plan, index) => ({plan, index}))
    .filter(({plan, index}) => index !== primary && matchesAdvisorConstraints(plan, intent))
    .sort((a, b) => compareAdvisorPlans(a.plan, b.plan, ranking));
  advisorSuggested = [];
  const [first, ...others] = matching;
  if (!first) {
    addAdvisorMessage('AI 선배', scheduleRequest
      ? '조건에 맞는 다른 후보가 없어. “그 조건으로 새로 만들어줘”라고 물어봐.'
      : '조건에 맞는 다른 후보가 없어.');
    return;
  }
  const second = others.find(({plan}) => priorities.some(topic => compareAdvisorCriterion(plan, first.plan, topic) < 0));
  advisorSuggested = second ? [first.index, second.index] : [first.index];
  const firstAdvantage = second && priorities.find(topic => compareAdvisorCriterion(first.plan, second.plan, topic) < 0);
  const secondAdvantage = second && priorities.find(topic => compareAdvisorCriterion(second.plan, first.plan, topic) < 0);
  const currentIsBetter = matchesAdvisorConstraints(base, intent) && compareAdvisorPlans(base, first.plan, ranking) < 0;
  const lead = currentIsBetter ? '지금 시간표가 우선순위에 더 잘 맞아. 아래는 바꿔볼 만한 후보야.'
    : second ? '우선순위에 따라 이 두 후보를 볼 만해.' : '이 후보를 먼저 봐.';
  const message = addAdvisorMessage('AI 선배', lead);
  const rows = [[candidateLabel(first.index), advisorCandidateReason(first.plan, intent, firstAdvantage || priorities[0])]];
  if (second) rows.push([candidateLabel(second.index), advisorCandidateReason(second.plan, intent, secondAdvantage)]);
  addAdvisorTable(message, '추천 시간표', ['후보', '핵심 기준'], rows);
}

function addAdvisorTable(message, label, headings, rows) {
  if (!rows.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'advisor-table';
  const table = document.createElement('table');
  table.setAttribute('aria-label', label);
  const header = table.createTHead().insertRow();
  for (const text of headings) {
    const heading = document.createElement('th');
    heading.scope = 'col';
    heading.textContent = text;
    header.append(heading);
  }
  const body = table.createTBody();
  for (const [title, ...values] of rows) {
    const row = body.insertRow();
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = title;
    row.append(heading);
    for (const value of values) row.insertCell().textContent = value;
  }
  wrap.append(table);
  message.append(wrap);
  message.classList.add('advisor-reply-with-table');
  scrollAdvisorTo(message);
  return table;
}

function advisorCandidateReason(plan, intent, advantage) {
  const criteria = [];
  if (intent.days_off.length) criteria.push(`${intent.days_off.join('·')}요일 공강`);
  if (intent.min_credits !== null || intent.max_credits !== null) criteria.push(`${plan.credits}학점`);
  const topic = advantage || intent.priorities[0];
  if (topic) criteria.push(`${advisorCriteria[topic]} ${advisorMetric(plan, topic)}`);
  return criteria.join(' · ') || `${plan.credits}학점 · ${scheduleClassDays(plan).length}일 등교`;
}

function showAdvisorCandidate(index) {
  const plan = scheduleCandidates[index];
  const message = addAdvisorMessage('AI 선배', `${candidateLabel(index)}는 ${plan.offerings.length}과목, ${plan.credits}학점이야.`);
  const courses = plan.offerings.slice(0, 3).map(row => [`${row.course_name} (${row.section_code})`, row.schedule]);
  if (courses.length < plan.offerings.length) courses.push([`외 ${plan.offerings.length - courses.length}과목`, '시간표에서 확인']);
  addAdvisorTable(message, '후보 과목 미리보기', ['과목 (분반)', '교시'], courses);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button secondary';
  button.textContent = '시간표 열기';
  button.addEventListener('click', () => {
    advisorDialog.close();
    showSchedule(index);
    advisorOpen.focus();
  });
  message.append(button);
}

function compareAdvisorCandidate(index, primary) {
  if (index === primary) {
    addAdvisorMessage('AI 선배', `${candidateLabel(index)}는 지금 보고 있는 시간표야. 다른 후보 번호를 말해줘.`);
    return;
  }
  const base = scheduleCandidates[primary];
  const plan = scheduleCandidates[index];
  const differences = advisorComparison(base, plan, advisorIntent).slice(0, 2);
  const names = rows => {
    const preview = rows.slice(0, 2).map(row => `${row.course_name} (${row.section_code})`).join(', ');
    return rows.length > 2 ? `${preview} 외 ${rows.length - 2}개` : preview || '없음';
  };
  const added = plan.offerings.filter(row => !base.offerings.some(previous => previous.offering_id === row.offering_id));
  const removed = base.offerings.filter(row => !plan.offerings.some(next => next.offering_id === row.offering_id));
  if (added.length || removed.length) differences.push(['바뀌는 과목·분반', names(removed), names(added)]);
  const label = `${candidateLabel(index)}로 바꿀 때 주요 차이야.`;
  const message = addAdvisorMessage('AI 선배', differences.length ? label : '두 후보에서 달라지는 항목은 없어.');
  addAdvisorTable(message, '시간표 차이', ['항목', '현재 시간표', candidateLabel(index)], differences);
}

const advisorGraduationStatusOrder = {not_met:0, needs_review:1, met:2};

function advisorGraduationPriority(rule) {
  if (rule.id === 'total') return 0;
  if (rule.id === 'major') return 1;
  if (rule.type === 'min_regular_terms') return 2;
  if (rule.recommendation_group === 'current_major_required') return 3;
  return 4;
}

function showAdvisorGraduation(index, detailed) {
  const plan = scheduleCandidates[index];
  const rules = graduationRequirements.map(rule => {
    const change = projectedRequirement(plan, rule);
    return {rule, after:change?.after ?? rule, conditional:change?.conditional, changed:Boolean(change)};
  });
  const pending = rules.filter(({after}) => after.status === 'not_met').length;
  const review = rules.filter(({after}) => after.status === 'needs_review').length;
  const relevant = rules.filter(({after, changed}) => after.status !== 'met' || (detailed && changed))
    .sort((a, b) => Number(a.after.status === 'met') - Number(b.after.status === 'met')
      || advisorGraduationPriority(a.rule) - advisorGraduationPriority(b.rule)
      || advisorGraduationStatusOrder[a.after.status] - advisorGraduationStatusOrder[b.after.status]);
  const assumption = eligibilityChecks(plan).length ? '자격 확인이 끝난 과목만 이수한다고 보면' : '과목을 모두 이수한다고 보면';
  const remaining = [pending && `미충족 ${pending}개`, review && `확인 필요 ${review}개`].filter(Boolean).join(', ');
  const label = `${candidateLabel(index)}에서 ${assumption}, ${remaining ? `${remaining}가 남아.` : '남는 졸업요건은 없어.'}`;
  const display = (rule, outcome) => `${advisorStatus[outcome.status]}${outcome.current === null ? '' : ` · ${outcome.current}/${rule.target}`}`;
  const visible = detailed ? relevant : relevant.slice(0, 3);
  const message = addAdvisorMessage('AI 선배', label);
  addAdvisorTable(message, detailed ? '남은 요건과 달라지는 요건' : '우선 확인할 졸업요건',
    detailed ? ['요건', '현재', '이수 후 예상'] : ['요건', '이수 후 예상'], visible.map(({rule, after, conditional}) => {
      const checked = detailed && conditional && (conditional.status !== after.status || conditional.current !== after.current);
      const outcome = display(rule, after) + (checked ? `\n분반 자격 확인 후: ${display(rule, conditional)}` : '');
      return detailed ? [rule.title, display(rule, rule), outcome] : [rule.title, outcome];
  }));
  if (!detailed && (relevant.length > visible.length || rules.some(({changed}) => changed))) {
    const hint = document.createElement('p');
    hint.className = 'advisor-note';
    hint.textContent = `전체 변화는 “${candidateLabel(index)} 졸업요건 자세히 보여줘”라고 물어봐.`;
    message.append(hint);
  }
}

function setAdvisorBusy(busy, message = '') {
  advisorBusy = busy;
  advisorQuestion.querySelector('button[type="submit"]').disabled = busy || !advisorChatAvailable || !geminiAdvisorAvailable;
  for (const button of advisorPendingCandidate?.actions.children ?? []) button.disabled = busy;
  advisorStatusMessage.textContent = message;
}

const advisorPlanKey = plan => JSON.stringify(plan.offerings.map(row => row.offering_id).sort());
const advisorCandidateDecisions = {
  accept:/^(?:추가(?:해(?:\s*줘|\s*주세요)?|하기|할게|하자)?|넣어\s*줘)$/,
  decline:/^(?:아니(?:요)?|괜찮아(?:요)?|됐어(?:요)?|추가하지\s*마(?:세요)?|건너뛰기|추가\s*안\s*할래)$/,
};

function advisorCandidateDecision(question, awaitingReply) {
  const answer = question.replace(/[.!]+$/, '');
  if (awaitingReply && /^(?:응|네|예|그래)$/.test(answer)) return true;
  const command = answer.replace(/^(?:(?:응|네|예|그래)[, ]+)?(?:후보(?:를)?\s*)?/, '');
  if (advisorCandidateDecisions.accept.test(command)) return true;
  if (advisorCandidateDecisions.decline.test(command)) return false;
  return null;
}

function clearAdvisorCandidateOffer() {
  advisorPendingCandidate?.actions.remove();
  advisorPendingCandidate = null;
}

function resolveAdvisorCandidateOffer(accepted) {
  const {plan, candidates} = advisorPendingCandidate;
  clearAdvisorCandidateOffer();
  if (!accepted) {
    addAdvisorMessage('AI 선배', '알겠어. 추가하지 않을게.');
    return;
  }
  if (candidates !== scheduleCandidates) {
    addAdvisorMessage('AI 선배', '시간표 목록이 바뀌었어. 새 후보를 다시 찾아줘.');
    return;
  }
  const key = advisorPlanKey(plan);
  const existing = scheduleCandidates.findIndex(candidate => advisorPlanKey(candidate) === key);
  if (existing >= 0) {
    advisorSuggested = [existing];
    addAdvisorMessage('AI 선배', `이미 ${candidateLabel(existing)}로 들어 있어.`);
    return;
  }
  const index = scheduleCandidates.length;
  const candidate = {...plan, advisorGenerated:true};
  scheduleCandidates.push(candidate);
  const list = $('#schedule-results');
  list.insertAdjacentHTML('beforeend', scheduleCandidateMarkup(candidate, index));
  list.scrollTop = list.scrollHeight;
  $('#schedule-candidate-count').textContent = `후보 ${scheduleCandidates.length}개`;
  advisorSuggested = [index];
  addAdvisorMessage('AI 선배', `맨 아래 ${index + 1}위에 추가했어.`);
}

function advisorWeeklyPreview(plan) {
  const meetings = plan.offerings.flatMap(course => course.meetings.map(meeting => ({
    ...meeting, name:course.course_name,
  })));
  const rows = [];
  for (const day of scheduleDays) {
    const classes = meetings.filter(meeting => meeting.day === day).sort((a, b) => a.start - b.start);
    if (!classes.length) continue;
    const courses = classes.map(({start, end, name}) => {
      const first = Math.floor(start / 2);
      const last = Math.floor((end - 1) / 2);
      let period = `${first}`;
      if (end === start + 1) period += start % 2 ? 'B' : 'A';
      else if (first !== last) period = `${first}${start % 2 ? 'B' : ''}~${last}${end % 2 ? 'A' : ''}`;
      return `${period}교시 ${name}`;
    });
    rows.push([`${day}요일`, courses.join('\n')]);
  }
  return rows;
}

function offerAdvisorCandidate(plan, intent) {
  const reason = advisorCandidateReason(plan, intent);
  const message = addAdvisorMessage('AI 선배', '새 후보를 찾았어. 목록 맨 아래에 추가할까?', reason);
  const preview = addAdvisorTable(message, '새 후보 주간 시간표', ['요일', '교시 · 과목'], advisorWeeklyPreview(plan));
  preview?.classList.add('advisor-weekly-preview');
  const actions = document.createElement('div');
  actions.className = 'advisor-candidate-actions';
  advisorPendingCandidate = {plan, candidates:scheduleCandidates, actions};
  for (const [label, accepted] of [['추가하기', true], ['건너뛰기', false]]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = accepted ? 'button primary' : 'button secondary';
    button.textContent = label;
    button.addEventListener('click', () => {
      advisorInput.focus({preventScroll:true});
      resolveAdvisorCandidateOffer(accepted);
    });
    actions.append(button);
  }
  message.append(actions);
  scrollAdvisorTo(message);
}

async function generateAdvisorCandidate(intent, revision) {
  if (!scheduleRequest || !scheduleSnapshot) {
    addAdvisorMessage('AI 선배', '시간표 화면에서 먼저 후보를 만들고 다시 요청해줘.');
    return;
  }
  clearAdvisorCandidateOffer();
  const base = scheduleRequest;
  const request = {
    ...base,
    blocked_days:[...new Set([...base.blocked_days, ...intent.days_off])],
    min_credits:intent.min_credits ?? Math.min(base.min_credits, intent.max_credits ?? 30),
    max_credits:intent.max_credits ?? Math.max(base.max_credits, intent.min_credits ?? 1),
    sort:{days:'fewest_days', gaps:'least_gap'}[intent.priorities[0]] ?? base.sort,
  };
  setAdvisorBusy(true, '새 시간표 후보를 찾고 있어…');
  advisorTranscript.scrollTop = advisorTranscript.scrollHeight;
  const result = await api('/api/schedules', request);
  if (revision !== advisorRevision) return;
  if (result.target_term !== scheduleSnapshot.term
      || result.snapshot?.snapshot_id !== scheduleSnapshot.id
      || result.snapshot?.sha256 !== scheduleSnapshot.sha256) {
    throw new Error('개설 자료가 바뀌었어. 시간표 화면에서 다시 생성해줘.');
  }
  const known = new Set(scheduleCandidates.map(advisorPlanKey));
  const alternative = result.candidates
    .filter(plan => !known.has(advisorPlanKey(plan)) && matchesAdvisorConstraints(plan, intent))
    .sort((a, b) => compareAdvisorPlans(a, b, intent))[0];
  if (!alternative) {
    const explanation = result.search_status === 'truncated' || result.outcome === 'undetermined'
      ? '찾아본 범위에서는 새 후보를 못 찾았어.' : '이 조건으로 추가할 새 후보를 못 찾았어.';
    addAdvisorMessage('AI 선배', explanation, result.issues[0]);
    return;
  }
  offerAdvisorCandidate(alternative, intent);
}

function resetAdvisorConversation() {
  advisorRevision++;
  advisorContent.classList.remove('is-chatting');
  advisorTranscript.hidden = true;
  $('#advisor-examples').hidden = false;
  $('#advisor-examples').open = false;
  advisorInput.placeholder = '이대로 들으면 졸업까지 뭐가 남아?';
  advisorQuestion.reset();
  clearAdvisorCandidateOffer();
  advisorChat.replaceChildren();
  advisorIntent = null;
  advisorTopic = null;
  advisorSuggested = [];
  setAdvisorBusy(false);
}

advisorOpen.addEventListener('click', () => {
  if (advisorDialog.open) return;
  advisorPrimary = scheduleCandidates.indexOf(selectedSchedule);
  const canCompare = advisorPrimary >= 0 && graduationRequirements.length > 0;
  $('#advisor-empty').hidden = canCompare;
  advisorContent.hidden = !canCompare;
  if (!canCompare) {
    $('#advisor-schedule-link').hidden = schedulePage;
    $('#advisor-return-form').hidden = !schedulePage;
    $('#advisor-empty-message').textContent = geminiAdvisorAvailable === null
      ? '연결된 서버가 AI 학과 선배를 지원하지 않아요. 프로젝트 폴더에서 최신 서버를 실행한 뒤, 터미널에 표시된 주소로 접속해 주세요.'
      : '시간표를 먼저 만들어 봐. 후보를 비교하거나 이번 학기를 마치면 졸업요건이 얼마나 남을지 같이 볼 수 있어.';
    advisorDialog.showModal();
    return;
  }
  const connectionNote = $('#advisor-connection-note');
  connectionNote.hidden = advisorChatAvailable && geminiAdvisorAvailable === true;
  connectionNote.textContent = !advisorChatAvailable
    ? '대화 기능을 사용하려면 최신 서버로 다시 시작하고 새로고침해 주세요.'
    : '서버에 Gemini API 키가 없어 보내기를 사용할 수 없어요. 서버를 종료하고 python -B -m intake_app.server --prompt-gemini-key로 다시 실행해 주세요.';
  $('#advisor-primary').textContent = `${candidateLabel(advisorPrimary)} · ${advisorPlanSummary(scheduleCandidates[advisorPrimary])}`;
  setAdvisorBusy(advisorBusy, advisorStatusMessage.textContent);
  advisorDialog.showModal();
  advisorInput.focus({preventScroll:true});
  advisorTranscript.scrollTop = advisorTranscript.scrollHeight;
});
advisorDialog.addEventListener('click', event => {
  const example = event.target.closest('[data-advisor-example]');
  if (example) {
    advisorInput.value = example.textContent.trim();
    advisorInput.focus();
  }
});
advisorQuestion.addEventListener('submit', async event => {
  event.preventDefault();
  const question = advisorInput.value.trim();
  if (!question || advisorBusy || !advisorChatAvailable || !geminiAdvisorAvailable) return;
  const revision = ++advisorRevision;
  const primary = advisorPrimary;
  advisorContent.classList.add('is-chatting');
  advisorTranscript.hidden = false;
  $('#advisor-examples').hidden = true;
  advisorInput.placeholder = '이어서 물어봐';
  advisorInput.value = '';
  advisorInput.focus({preventScroll:true});
  const awaitingCandidateReply = advisorPendingCandidate?.actions.parentElement === advisorChat.lastElementChild;
  addAdvisorMessage('나', question);
  if (advisorPendingCandidate) {
    const accepted = advisorCandidateDecision(question, awaitingCandidateReply);
    if (accepted !== null) {
      resolveAdvisorCandidateOffer(accepted);
      return;
    }
  }
  setAdvisorBusy(true, '질문을 읽고 있어…');
  advisorTranscript.scrollTop = advisorTranscript.scrollHeight;
  try {
    const {intent, reply} = await api('/api/advisor/chat', {
      question, previous_intent:advisorIntent, previous_topic:advisorTopic,
    });
    if (revision !== advisorRevision) return;
    const {action, target} = intent;
    if (action === 'chat' || action === 'clarify') {
      addAdvisorMessage('AI 선배', reply);
      return;
    }
    advisorTopic = action;
    if (action === 'compare' || action === 'generate') {
      advisorIntent = intent;
      if (action === 'compare') suggestAdvisorCandidate(intent, primary);
      else await generateAdvisorCandidate(intent, revision);
      return;
    }
    if (action === 'current') {
      addAdvisorMessage('AI 선배', `${candidateLabel(primary)}야. ${advisorPlanSummary(scheduleCandidates[primary])}.`);
      return;
    }
    if (target === -1 && advisorSuggested.length === 2) {
      const [first, second] = advisorSuggested.map(candidateLabel);
      const followup = action === 'difference' ? `${first}랑 비교해줘`
        : action === 'show' ? `${first} 보여줘` : `${first} 졸업요건 보여줘`;
      addAdvisorMessage('AI 선배', `${first}와 ${second} 중 어느 쪽이야? “${followup}”처럼 물어봐.`);
      return;
    }
    const index = target === -1 ? advisorSuggested[0] : target === 0 ? primary : target - 1;
    if (!scheduleCandidates[index]) {
      addAdvisorMessage('AI 선배', target === -1 ? '아직 가리킬 후보가 없어. 몇 번 후보인지 알려줘.'
        : `${target}번 후보는 목록에 없어. 지금은 ${scheduleCandidates.length}개 후보가 있어.`);
      return;
    }
    if (target > 0) advisorSuggested = [index];
    if (action === 'show') showAdvisorCandidate(index);
    else if (action === 'difference') compareAdvisorCandidate(index, primary);
    else showAdvisorGraduation(index, action === 'graduation_details');
  } catch (error) {
    if (revision === advisorRevision) {
      addAdvisorMessage('안내', error.message);
      if (!advisorInput.value) advisorInput.value = question;
    }
  } finally {
    if (revision === advisorRevision) {
      setAdvisorBusy(false);
    }
  }
});

function scheduleCandidateMarkup(plan, index) {
  return `<button type="button"
    class="schedule-candidate${!plan.advisorGenerated && index < 3 ? ' rank-' + (index + 1) : ''}" data-schedule-index="${index}" aria-pressed="false">
    <strong class="schedule-rank">${index + 1}위</strong>
    <span><strong>${plan.credits}학점 · 수업 ${scheduleClassDays(plan).join("·")} (${plan.days}일)</strong>
      <small>${scheduleCourseMix(plan)} · ${scheduleSpacing(plan)}${plan.provisional ? ' · 잠정' : ''}${plan.advisorGenerated ? ' · AI 선배 추가' : ''}</small></span>
  </button>`;
}

function renderSchedules(result) {
  scheduleCandidates = result.candidates;
  graduationRequirements = result.graduation_requirements ?? [];
  const found = scheduleCandidates.length > 0;
  const status = $('#schedule-status');
  const count = document.createElement('span');
  count.id = 'schedule-candidate-count';
  count.textContent = found ? `후보 ${scheduleCandidates.length}개`
    : result.outcome === 'undetermined' ? '편성 가능 여부 확인 필요' : '생성 가능한 시간표 없음';
  status.replaceChildren(`${result.target_term} · `, count);
  if (result.issues.length) status.append(` · ${result.issues.join(' · ')}`);
  $('#schedule-form').hidden = found;
  $('#schedule-candidates').hidden = !found;
  if (!found) {
    refreshBasketPreview();
    return;
  }
  const list = $('#schedule-results');
  list.innerHTML = scheduleCandidates.map(scheduleCandidateMarkup).join('');
  list.scrollTop = 0;
  showSchedule(0);
  list.querySelector('button').focus({preventScroll:true});
}

$('#schedule-results').addEventListener('click', event => {
  const candidate = event.target.closest('[data-schedule-index]');
  if (candidate) showSchedule(Number(candidate.dataset.scheduleIndex));
});

$('#edit-schedule-conditions').addEventListener('click', () => {
  showScheduleConditions();
  selectScheduleTab(scheduleConditionsTab);
  $('#schedule-min').focus();
});

function showScheduleConditions() {
  clearSelectedSchedule();
  renderScheduleAnalytics(null);
  $('#schedule-candidates').hidden = true;
  $('#schedule-form').hidden = false;
  $('#schedule-offerings').hidden = true;
  renderBasket();
}

$('#schedule-offering-table').addEventListener('click', async event => {
  const button = event.target.closest('[data-lock-offering]');
  if (!button) return;
  const {courseCode:code, courseName:name, sectionCode, lockOffering:offeringId} = button.dataset;
  const row = readBasket().find(row => row.code === code);
  if (await saveSelection({code, name, sectionCode, offeringId, scheduleMode:row?.scheduleMode ?? 'required'})) {
    $('#basket-status').textContent = `${name} ${sectionCode} 분반을 고정했어요.`;
    $('#generate-schedule').focus();
  }
});

const scheduleMin = $('#schedule-min');
const scheduleMax = $('#schedule-max');
const scheduleTrack = $('#schedule-credit-track');
const scheduleTrackLine = scheduleTrack.querySelector('svg');

const firstCredit = Number(scheduleMin.min);
const creditSteps = Number(scheduleMax.max) - firstCredit;
const creditPercent = value => `${100 * (value - firstCredit) / creditSteps}%`;

$('#schedule-credit-scale').innerHTML = Array.from({length:creditSteps + 1}, (_, index) => {
  const value = firstCredit + index;
  const x = creditPercent(value);
  const labeled = index === 0 || index === creditSteps || value % 5 === 0;
  return `<line x1="${x}" x2="${x}" y1="0" y2="${labeled ? 8 : 4}" class="${labeled ? 'credit-tick-major' : 'credit-tick-minor'}"/>
    ${labeled ? `<text x="${x}" y="23">${value}</text>` : ''}`;
}).join('');

function updateCreditRange(changed) {
  if (scheduleMin.valueAsNumber > scheduleMax.valueAsNumber) {
    if (changed === scheduleMin) scheduleMin.value = scheduleMax.value;
    else scheduleMax.value = scheduleMin.value;
  }
  const lower = scheduleMin.valueAsNumber;
  const upper = scheduleMax.valueAsNumber;
  const fill = $('#schedule-credit-fill');
  fill.setAttribute('x', creditPercent(lower));
  fill.setAttribute('width', creditPercent(firstCredit + upper - lower));
  $('#schedule-min-value').value = lower;
  $('#schedule-max-value').value = upper;
}

for (const handle of [scheduleMin, scheduleMax]) {
  handle.addEventListener('input', () => updateCreditRange(handle));
}

function creditAt(clientX) {
  const track = scheduleTrackLine.getBoundingClientRect();
  const start = Number(scheduleMin.min);
  const end = Number(scheduleMax.max);
  return Math.min(end, Math.max(start, start + (end - start) * (clientX - track.left) / track.width));
}

let creditDrag;

function moveCreditHandle(event) {
  const position = creditAt(event.clientX);
  const handle = creditDrag.handle ?? (event.clientX < creditDrag.startX ? scheduleMin : scheduleMax);
  creditDrag.handle = handle;
  handle.value = Math.round(position);
  updateCreditRange(handle);
}

scheduleTrack.addEventListener('pointerdown', event => {
  if (event.button !== 0 || creditDrag) return;
  const position = creditAt(event.clientX);
  const lower = scheduleMin.valueAsNumber;
  const upper = scheduleMax.valueAsNumber;
  const handle = lower === upper && Math.round(position) === lower ? null
    : position - lower <= upper - position ? scheduleMin : scheduleMax;
  creditDrag = {id:event.pointerId, startX:event.clientX, handle};
  scheduleTrack.setPointerCapture(event.pointerId);
  if (handle) {
    moveCreditHandle(event);
    handle.focus();
  }
});

scheduleTrack.addEventListener('pointermove', event => {
  if (creditDrag?.id !== event.pointerId || (!creditDrag.handle && event.clientX === creditDrag.startX)) return;
  moveCreditHandle(event);
});

scheduleTrack.addEventListener('lostpointercapture', event => {
  if (creditDrag?.id !== event.pointerId) return;
  (creditDrag.handle ?? scheduleMin).focus();
  creditDrag = null;
});

function fillScheduleDefaults() {
  const min = state.student.min_credits;
  const max = state.student.max_credits;
  scheduleMin.value = min ?? Math.min(15, max ?? 18);
  scheduleMax.value = max ?? Math.max(18, min ?? 15);
  updateCreditRange();
}

$('#schedule-form').addEventListener('invalid', () => selectScheduleTab(scheduleConditionsTab), true);
$('#schedule-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#generate-schedule');
  if (button.disabled) return;
  closeScheduleSections(false);
  button.disabled = true;
  clearSelectedSchedule();
  resetAdvisorConversation();
  $('#schedule-results').replaceChildren();
  renderScheduleAnalytics(null);
  $('#schedule-offerings').hidden = true;
  $('#schedule-offerings').open = false;
  $('#schedule-preview-summary').textContent = '';
  renderCalendar();
  $('#schedule-status').textContent = '시간표 생성 중…';
  try {
    if (!await save()) throw new Error('학생 정보를 저장한 뒤 다시 시도해주세요.');
    const latest = await api('/api/input');
    const basket = readBasket();
    const excluded = basket.filter(row => row.scheduleMode === 'excluded').map(row => row.code);
    if (excluded.length && !supportsScheduleExclusions) throw new Error('과목 제외를 적용할 수 없어요.');
    const request = {
      version:latest.version,
      min_credits:Number($('#schedule-min').value), max_credits:Number($('#schedule-max').value),
      required:basket.filter(row => !row.offeringId && row.scheduleMode === 'required').map(row => row.code),
      locked_offering_ids:basket.filter(row => row.offeringId).map(row => row.offeringId),
      preferred:basket.filter(row => !row.offeringId && row.scheduleMode === 'preferred').map(row => row.code),
      excluded,
      allow_late_classes:$('#schedule-allow-late').checked,
      blocked_days:[...document.querySelectorAll('[name="blocked-day"]:checked')].map(row => row.value),
      sort:$('#schedule-sort').value,
    };
    const result = await api('/api/schedules', request);
    scheduleRequest = request;
    scheduleSnapshot = {term:result.target_term, id:result.snapshot?.snapshot_id, sha256:result.snapshot?.sha256};
    renderSchedules(result);
  } catch (error) {
    $('#schedule-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

init();
