'use strict';
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const days = {MON:'월',TUE:'화',WED:'수',THU:'목',FRI:'금',SAT:'토',SUN:'일'};
const statuses = {unconfirmed:'이수 여부 미확인',completed:'이수 완료',in_progress:'수강 중',not_completed:'미이수 / 취소 / F'};
const initial = () => ({schema_version:1,student:{department_id:'DEPT_CS',admission_year:null,grade:null,admission_type:'freshman',target_term:null,min_credits:null,max_credits:null,interests:[],recognition_notes:'',transfer_recognized_credits:null},history_complete:false,course_attempts:[]});
let state=initial(), version=0, csrf='', step=1, dirty=false, edits=0, saving=false;
const fields={'admission-year':'admission_year',grade:'grade',department:'department_id','admission-type':'admission_type','target-term':'target_term','min-credits':'min_credits','max-credits':'max_credits','recognition-notes':'recognition_notes','transfer-credits':'transfer_recognized_credits'};
const numeric = new Set(['admission_year','grade','min_credits','max_credits','transfer_recognized_credits']);
const tags=['인공지능','경제·금융','심리','예술·문화','사회·정치','역사','과학기술','철학·윤리','창업','글쓰기'];
function message(text,type='info'){$('#message').textContent=text;$('#message').className='message '+type;$('#message').hidden=false;}
function touch(){dirty=true;edits++;$('#save-state').textContent='저장하지 않은 변경사항이 있어요';}
async function api(path,payload){const options=payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':csrf},body:JSON.stringify(payload)};const response=await fetch(path,options);let data;try{data=await response.json();}catch{throw new Error('서버 응답을 읽을 수 없습니다. 서버 실행 상태를 확인해주세요.');}if(!response.ok)throw new Error(data.error||'요청에 실패했습니다.');return data;}
function fillProfile(){for(const [id,key] of Object.entries(fields))$('#'+id).value=state.student[key]??'';$('#history-complete').checked=state.history_complete;$('#transfer-box').hidden=state.student.admission_type!=='transfer';renderTags();}
function renderTags(){const all=[...new Set([...tags,...state.student.interests])];$('#tags').innerHTML=all.map(tag=>`<button class="tag ${state.student.interests.includes(tag)?'selected':''}" aria-pressed="${state.student.interests.includes(tag)}" data-tag="${esc(tag)}">${esc(tag)}</button>`).join('');}
function switchStep(value){step=value;for(let i=1;i<=3;i++){$('#step-'+i).hidden=i!==step;document.querySelector(`[data-step="${i}"]`).classList.toggle('active',i===step);}$('#next').textContent=step===1?'이수 내역 입력 →':step===2?'입력 내용 확인 →':'확인 완료 및 저장';if(step===3)renderSummary();window.scrollTo({top:0,behavior:'smooth'});}
const options=(mapping,current,empty)=>`<option value="">${empty}</option>`+Object.entries(mapping).map(([key,label])=>`<option value="${key}" ${key===current?'selected':''}>${label}</option>`).join('');
function renderCourses(){
 $('#course-count').textContent=state.course_attempts.length;
 if(!state.course_attempts.length){$('#course-list').innerHTML='<div class="empty"><strong>아직 등록한 과목이 없어요</strong>과목을 직접 추가할 수 있어요. 이수 내역이 없으면 비워두세요.</div>';return;}
 $('#course-list').innerHTML=state.course_attempts.map((c,index)=>`<article class="course-card" data-id="${esc(c.id)}">
 <div class="course-head"><span class="origin">${String(index+1).padStart(2,'0')} · ${{manual:'직접 입력',ai:'이전 입력',sample:'예시 데이터'}[c.source]}</span><button class="delete" data-action="delete">삭제</button></div>
 <div class="course-fields"><label>과목명<input data-field="course_name" maxlength="200" value="${esc(c.course_name)}" placeholder="과목명 입력"></label><label>수강 학기<input data-field="term" value="${esc(c.term)}" placeholder="예: 2026-2" list="terms"></label><label>실제 이수 상태<select data-field="completion_status">${Object.entries(statuses).map(([key,label])=>`<option value="${key}" ${key===c.completion_status?'selected':''}>${label}</option>`).join('')}</select></label></div>
 <div class="meetings">${c.meetings.map((m,i)=>`<div class="meeting" data-meeting="${i}"><label>요일<select data-meeting-field="day">${options(days,m.day,'미확인')}</select></label><label>시작<input type="time" data-meeting-field="start_time" value="${esc(m.start_time)}"></label><label>종료<input type="time" data-meeting-field="end_time" value="${esc(m.end_time)}"></label><label>장소 (여러 곳은 쉼표로 구분)<input data-meeting-field="locations" value="${esc(m.locations.join(', '))}" placeholder="예: 미래관-310"></label><button class="meeting-remove" data-action="remove-meeting" aria-label="수업 시간 삭제">×</button></div>`).join('')}</div>
 ${c.extraction_warnings.length?`<div class="course-warning">${c.extraction_warnings.map(esc).join('<br>')}</div>`:''}
 ${c.course_name_raw?`<details class="raw"><summary>과목명 원문 보기</summary>${esc(c.course_name_raw)}</details>`:''}
 <label class="raw">확인 메모<textarea data-field="review_notes" maxlength="2000" placeholder="불확실한 시간이나 과목에 대한 메모">${esc(c.review_notes)}</textarea></label>
 <div class="course-controls"><button class="button subtle add-meeting" data-action="add-meeting">＋ 수업 시간</button><label class="confirm-label"><input type="checkbox" data-field="user_confirmed" ${c.user_confirmed?'checked':''}>과목 정보와 이수 상태를 확인했어요</label></div></article>`).join('');
}
function renderSummary(){
 const courses=state.course_attempts, done=courses.filter(c=>c.user_confirmed&&c.completion_status!=='unconfirmed'&&c.course_name&&c.term);
 $('#summary-stats').innerHTML=[['입력한 과목',courses.length],['확인한 과목',done.length],['이수 완료',courses.filter(c=>c.completion_status==='completed').length]].map(([label,count])=>`<div class="stat">${label}<strong>${count}<small> 과목</small></strong></div>`).join('');
 const p=state.student;$('#summary-profile').textContent=`컴퓨터공학과 · ${p.admission_year||'입학연도 미입력'} · ${p.grade? p.grade+'학년':'학년 미입력'} · ${p.admission_type==='transfer'?'편입학':'신입학'} / 추천 학기: ${p.target_term||'미입력'} / 관심 주제: ${p.interests.join(', ')||'미선택'}`;
 $('#summary-table').innerHTML=`<table><thead><tr><th>과목</th><th>수강 학기</th><th>요일·시간</th><th>이수 상태</th><th>확인</th></tr></thead><tbody>${courses.map(c=>`<tr><td>${esc(c.course_name)||'미입력'}${c.source==='sample'?'<small>예시 데이터</small>':''}</td><td>${esc(c.term)||'미확인'}</td><td>${c.meetings.map(m=>`${days[m.day]||'?'} ${esc(m.start_time)||'?'}–${esc(m.end_time)||'?'}`).join('<br>')||'미입력'}</td><td>${statuses[c.completion_status]}</td><td>${c.user_confirmed?'확인함':'확인 필요'}</td></tr>`).join('')}</tbody></table>`;
 const warnings=[];if(!state.history_complete)warnings.push('일부 수강 내역만 입력한 상태입니다.');if(done.length<courses.length)warnings.push(`${courses.length-done.length}개 과목의 이름·학기·이수 상태·확인 체크를 검토해주세요.`);if(courses.some(c=>c.source==='sample'))warnings.push('예시 과목이 포함되어 있습니다. 본인의 이수 내역인지 확인해주세요.');
 $('#review-warnings').innerHTML=warnings.map(w=>`<p class="notice">${esc(w)}</p>`).join('');
}
async function save(reviewed=false){if(saving)return;saving=true;$('#save').disabled=true;$('#next').disabled=true;const start=edits;try{const result=await api('/api/input',{document:state,version,reviewed});version=result.version;if(edits===start){state=result.document;dirty=false;fillProfile();renderCourses();if(step===3)renderSummary();$('#save-state').textContent=(reviewed?'확인 완료 · ':'임시 저장 · ')+new Date(result.updated_at).toLocaleTimeString('ko-KR');}else $('#save-state').textContent='저장 중 추가 변경이 있어요. 한 번 더 저장해주세요.';message((reviewed?'입력 확인을 완료하고 저장했습니다.':'임시 저장했습니다.')+(result.warnings.length?' '+result.warnings.join(' '):''),'success');}catch(error){message(error.message,'error');}finally{saving=false;$('#save').disabled=false;$('#next').disabled=false;}}
function addManual() {
  state.course_attempts.push({
    id: crypto.randomUUID(),
    course_id: null,
    course_name: '',
    course_name_raw: '',
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
}
function mergeCourses(){const grouped=new Map(),merged=[];let count=0;for(const c of state.course_attempts){const key=c.term&&c.course_name.trim()?c.term+'|'+c.course_name.replace(/\s+/g,'').toLowerCase():c.id;if(!grouped.has(key)){grouped.set(key,c);merged.push(c);continue;}const first=grouped.get(key);for(const m of c.meetings)if(!first.meetings.some(existing=>JSON.stringify(existing)===JSON.stringify(m)))first.meetings.push(m);first.extraction_ids=[...new Set([...first.extraction_ids,...c.extraction_ids])];first.extraction_warnings=[...new Set([...first.extraction_warnings,...c.extraction_warnings,'사용자가 동명 과목을 묶었습니다. 같은 과목인지 다시 확인해주세요.'])];first.course_name_raw=[...new Set([first.course_name_raw,c.course_name_raw])].filter(Boolean).join(' / ');first.review_notes=[first.review_notes,c.review_notes].filter(Boolean).join('\n');if(first.completion_status!==c.completion_status)first.completion_status='unconfirmed';if(c.source==='sample')first.source='sample';first.user_confirmed=false;count++;}state.course_attempts=merged;if(count)touch();renderCourses();message(count?`${count}개 중복 항목을 묶었습니다. 수업 시간과 이수 상태를 다시 확인해주세요.`:'묶을 동명 과목이 없습니다. 학기가 같은 항목만 묶습니다.');}
document.querySelectorAll('[data-step]').forEach(button=>button.addEventListener('click',()=>switchStep(Number(button.dataset.step))));
for(const [id,key] of Object.entries(fields))$('#'+id).addEventListener('input',event=>{let value=event.target.value;state.student[key]=numeric.has(key)?(value===''?null:Number(value)):value;if(key==='target_term'&&!value)state.student[key]=null;if(key==='admission_type')$('#transfer-box').hidden=value!=='transfer';touch();});
$('#tags').addEventListener('click',event=>{const tag=event.target.closest('[data-tag]')?.dataset.tag;if(!tag)return;if(state.student.interests.includes(tag))state.student.interests=state.student.interests.filter(t=>t!==tag);else if(state.student.interests.length<20)state.student.interests.push(tag);else return message('관심 태그는 최대 20개입니다.','error');touch();renderTags();});
$('#add-tag').addEventListener('click',()=>{const tag=$('#custom-tag').value.trim();if(!tag)return;if(!state.student.interests.includes(tag)){if(state.student.interests.length>=20)return message('관심 태그는 최대 20개입니다.','error');state.student.interests.push(tag);touch();}$('#custom-tag').value='';renderTags();});
$('#custom-tag').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('#add-tag').click();}});
$('#course-list').addEventListener('input',event=>{const card=event.target.closest('[data-id]');if(!card)return;const c=state.course_attempts.find(row=>row.id===card.dataset.id),field=event.target.dataset.field,mfield=event.target.dataset.meetingField;if(field)c[field]=field==='user_confirmed'?event.target.checked:(field==='term'?event.target.value||null:event.target.value);if(mfield){const m=c.meetings[Number(event.target.closest('[data-meeting]').dataset.meeting)];m[mfield]=mfield==='locations'?event.target.value.split(',').map(v=>v.trim()).filter(Boolean):(event.target.value||null);}if(field!=='user_confirmed'){c.user_confirmed=false;card.querySelector('[data-field="user_confirmed"]').checked=false;}touch();});
$('#course-list').addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;const card=button.closest('[data-id]'),c=state.course_attempts.find(row=>row.id===card.dataset.id);if(button.dataset.action==='delete')state.course_attempts=state.course_attempts.filter(row=>row.id!==c.id);if(button.dataset.action==='add-meeting'){c.meetings.push({day:null,start_time:null,end_time:null,locations:[]});c.user_confirmed=false;}if(button.dataset.action==='remove-meeting'){c.meetings.splice(Number(button.closest('[data-meeting]').dataset.meeting),1);c.user_confirmed=false;}touch();renderCourses();});
$('#add-course').addEventListener('click', addManual);
$('#merge').addEventListener('click', mergeCourses);
$('#apply-term').addEventListener('click',()=>{const value=$('#bulk-term').value.trim();if(!/^(19|20)\d{2}-(1|2|summer|winter)$/.test(value))return message('학기 형식을 확인해주세요. 예: 2026-2','error');let count=0;for(const c of state.course_attempts)if(!c.term){c.term=value;c.user_confirmed=false;count++;}if(count)touch();renderCourses();message(`${count}개 과목에 학기를 적용했습니다.`);});
$('#history-complete').addEventListener('change',event=>{state.history_complete=event.target.checked;touch();renderSummary();});$('#save').addEventListener('click',()=>save());$('#next').addEventListener('click',()=>step<3?switchStep(step+1):save(true));
$('#export').addEventListener('click',()=>{const payload={...state,export_metadata:{saved_version:version,unsaved_changes:dirty,official_course_matching:'pending'},completed_courses:state.course_attempts.filter(c=>c.user_confirmed&&c.completion_status==='completed')};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='student-input.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
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
init();
