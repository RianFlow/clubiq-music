// Notices use game IDs or a specific training date, so they survive a 3K refresh.
state.notices=[];
let selectedNoticeTarget='', noticeBaseline='';
const noticeFingerprint=()=>JSON.stringify(['noticeMessage','noticeExpiresAt','noticeActive'].map(id=>[$('#'+id).value,$('#'+id).checked]));
function noticeOptions(){
  const items=new Map(),now=Date.now();
  for(const match of state.season?.matches||[]){
    if(match.kind!=='upcoming'||Date.parse(match.plannedAt)<=now)continue;
    items.set(`match-${match.id}`,{title:`${match.home} gegen ${match.away}`,start:match.plannedAt});
  }
  for(const event of state.events||[]){
    if(!event.active||!event.calendarDate)continue;
    const start=DartsExperience.berlinTime(event.calendarDate,'00:00');
    if(Date.parse(start)+86400000<now)continue;
    items.set(`event-${event.id}`,{title:event.title,start});
  }
  let cursor=now;
  for(let i=0;i<16;i++){
    const training=DartsExperience.nextTraining(cursor);if(!training)break;
    items.set(training.id,{title:training.title,start:training.start});cursor=Date.parse(training.start)+1000;
  }
  return items;
}
function renderNoticeOptions(){
  const select=$('#noticeTarget'),current=selectedNoticeTarget||select.value,items=noticeOptions();
  select.replaceChildren(new Option('Bitte Spiel oder Termin auswählen',''));
  const upcoming=document.createElement('optgroup');upcoming.label='Nächste Spiele und Termine';
  for(const [target,item] of [...items].sort((a,b)=>Date.parse(a[1].start)-Date.parse(b[1].start))){
    const date=new Date(item.start).toLocaleString('de-DE',{timeZone:'Europe/Berlin',dateStyle:'short',timeStyle:'short'});
    upcoming.append(new Option(`${date} · ${item.title}${state.notices.some(n=>n.target===target)?' · Hinweis hinterlegt':''}`,target));
  }
  select.append(upcoming);
  const previous=document.createElement('optgroup');previous.label='Weitere gespeicherte Hinweise';
  for(const item of state.notices)if(!items.has(item.target))previous.append(new Option(`${item.title} · ${Date.parse(item.expiresAt)<=Date.now()?'abgelaufen':'gespeichert'}`,item.target));
  if(previous.children.length)select.append(previous);
  if([...select.options].some(o=>o.value===current))select.value=current;
  else selectedNoticeTarget='';
}
function selectAppointmentNotice(target){
  selectedNoticeTarget=target;
  $('#noticeTarget').value=target;
  const saved=state.notices.find(item=>item.target===target),item=noticeOptions().get(target);
  $('#noticeFields').disabled=!target;
  $('#noticeMessage').value=saved?.message||'';
  $('#noticeActive').checked=saved?.active??true;
  $('#noticeExpiresAt').value=localDateTimeValue(saved?.expiresAt||(item?new Date(Date.parse(item.start)+86400000).toISOString():''));
  $('#deleteNotice').disabled=!saved;
  $('#noticeStatus').textContent=saved?(Date.parse(saved.expiresAt)<=Date.now()?'Dieser Hinweis ist abgelaufen und wird nicht angezeigt.':saved.active?'Dieser Hinweis ist veröffentlicht.':'Dieser Hinweis ist ausgeblendet.'):'Der Hinweis erscheint nach dem Speichern direkt am ausgewählten Termin.';
  updateNoticePreview();noticeBaseline=noticeFingerprint();
}
function updateNoticePreview(){
  const text=clean($('#noticeMessage').value),preview=$('#noticePreview');preview.hidden=!text;preview.textContent=text;
}
async function loadAppointmentNotices(){
  const result=await api('/api/v1/darts/admin/appointment-notices');
  state.notices=Array.isArray(result.notices)?result.notices:[];
  renderNoticeOptions();selectAppointmentNotice(selectedNoticeTarget);
}
$('#noticeTarget').addEventListener('change',()=>{
  const next=$('#noticeTarget').value;
  if(selectedNoticeTarget&&noticeBaseline!==noticeFingerprint()&&!confirm('Es gibt ungespeicherte Änderungen am Hinweis. Möchtest du sie verwerfen?')){$('#noticeTarget').value=selectedNoticeTarget;return;}
  selectAppointmentNotice(next);
});
$('#noticeMessage').addEventListener('input',updateNoticePreview);
$('#noticeQuickTexts').addEventListener('click',event=>{
  const button=event.target.closest('[data-notice-text]');if(!button)return;
  $('#noticeMessage').value=button.dataset.noticeText;updateNoticePreview();
  $('#noticeMessage').dispatchEvent(new Event('input',{bubbles:true}));$('#noticeMessage').focus();
});
$('#noticeForm').addEventListener('submit',async event=>{
  event.preventDefault();const target=selectedNoticeTarget;if(!target)return;
  const button=$('#saveNotice'),status=$('#noticeStatus');button.disabled=true;
  const item=noticeOptions().get(target),saved=state.notices.find(n=>n.target===target);
  try{
    status.textContent='Hinweis wird gespeichert …';
    await api('/api/v1/darts/admin/appointment-notices/'+encodeURIComponent(target),{method:'PUT',body:JSON.stringify({
      title:(item?.title||saved?.title||'Termin').slice(0,240),message:clean($('#noticeMessage').value),
      expires_at:new Date($('#noticeExpiresAt').value).toISOString(),active:$('#noticeActive').checked,
    })});
    await loadAppointmentNotices();status.textContent='Hinweis gespeichert. Die Startseite übernimmt ihn automatisch innerhalb einer Minute.';
  }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
});
$('#deleteNotice').addEventListener('click',async()=>{
  const target=selectedNoticeTarget;if(!target||!confirm('Diesen Hinweis entfernen?'))return;
  const button=$('#deleteNotice');button.disabled=true;
  try{await api('/api/v1/darts/admin/appointment-notices/'+encodeURIComponent(target),{method:'DELETE'});await loadAppointmentNotices();$('#noticeStatus').textContent='Hinweis entfernt.';}
  catch(error){$('#noticeStatus').textContent=error.message;button.disabled=false;}
});
