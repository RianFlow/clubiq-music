"use strict";

const $ = selector => document.querySelector(selector);
let password = sessionStorage.getItem("clubiq_music_admin") || "";
let player = {};
let refreshGeneration = 0;
let mutationVersion = 0;
let mutationsPending = 0;
let stale = true;
let refreshPending = false;

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Admin-Password", password);
  if (options.body) headers.set("Content-Type", "application/json");
  return musicRequestJson(path, {...options, headers});
}
function time(value){const n=Math.max(0,Math.floor(Number(value)||0));return `${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`;}
function esc(value=""){return String(value).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]);}
function setConnection(ok,text){$("#remoteStatus").className=`connection${ok?"":" bad"}`;$("#remoteStatus").textContent=text;}

function render() {
  const current=player.current||{};
  setMediaImage($("#remoteCover"),current.thumbnail,player.source_mode==="radio");
  $("#remoteTitle").textContent=current.title||"Noch kein Song";
  $("#remoteArtist").textContent=current.artist||"–";
  const summary=musicPlaybackSummary(player,stale);
  $("#remotePlaybackStatus").textContent=`${summary.title}. ${summary.hint}`;
  $("#remotePlaybackStatus").hidden=!$("#remotePlaybackStatus").textContent;
  remoteRanges.progress.update(player.position, {max:Math.max(1,Number(player.duration)||1), disabled:stale||player.source_mode==="radio"||!Number(player.duration)});
  $("#remoteDuration").textContent=time(player.duration);
  $("#remotePlay").textContent=musicCanPause(player)?"Pause":"Start";
  remoteRanges.volume.update(player.volume??70, {disabled:stale});
  $("#remoteMute").textContent=player.muted?"Ton an":"Stumm";
  document.querySelectorAll('[data-action]').forEach(button=>{
    button.disabled=stale||mutationsPending>0||(player.source_mode==='radio'&&['previous','next'].includes(button.dataset.action));
  });
  const queue=player.queue||[];
  $("#remoteQueue").innerHTML=queue.length?queue.map((item,index)=>`<article class="${index===player.current_index?"current":""}"><b>${index+1}</b><div><strong>${esc(item.title)}</strong><small>${esc(item.artist||"")}</small></div>${index!==player.current_index?`<button data-play-index="${index}">Start</button>`:""}</article>`).join(""):"<p>Noch keine Songs geladen.</p>";
  document.querySelectorAll("[data-play-index]").forEach(button=>button.addEventListener("click",()=>playIndex(Number(button.dataset.playIndex))));
}
async function refresh(silent=false){
  if(mutationsPending||refreshPending)return;
  refreshPending=true;
  const generation=++refreshGeneration, mutation=mutationVersion;
  try{
    const result=await api("/api/v1/music/player/state");
    if(!Array.isArray(result.queue))throw new Error("Player-Status unvollständig.");
    if(generation!==refreshGeneration||mutation!==mutationVersion)return;
    player=result;stale=false;render();setConnection(Boolean(player.speaker?.connected),player.speaker?.connected?"Box verbunden":"Box getrennt");
    return true;
  }catch(error){
    if(generation!==refreshGeneration||mutation!==mutationVersion)return;
    stale=true;render();setConnection(false,"Player nicht erreichbar · letzter bekannter Stand");if(!silent)throw error;
    return false;
  }finally{refreshPending=false;}
}
async function mutatePlayer(path,body){
  if(stale)throw new Error("Bitte warten, bis der Player wieder erreichbar ist.");
  const mutation=++mutationVersion;mutationsPending++;render();
  try{const result=await api(path,{method:"POST",...(body?{body:JSON.stringify(body)}:{})});if(mutation===mutationVersion)player=result;}
  finally{mutationsPending--;render();}
}
async function command(action,value=null){await mutatePlayer("/api/v1/music/admin/player/command",{action,value});}
async function playIndex(index){
  if(mutationsPending)return;
  try{await mutatePlayer(`/api/v1/music/admin/player/queue/${index}/play`);}
  catch(error){setConnection(false,error.message);}
}
async function login(event){event.preventDefault();password=$("#remotePassword").value;try{await api("/api/v1/music/admin/verify");sessionStorage.setItem("clubiq_music_admin",password);$("#remoteLogin").hidden=true;$("#remoteArea").hidden=false;await refresh();}catch(error){$("#remoteError").textContent=error.message;$("#remoteError").hidden=false;}}
const remoteRanges={
  progress:createRangeControl({input:$("#remoteProgress"),label:$("#remotePosition"),format:time,commit:value=>command("seek",value),onError:error=>setConnection(false,error.message)}),
  volume:createRangeControl({input:$("#remoteVolume"),label:$("#remoteVolumeValue"),format:value=>`${Math.round(value)} %`,commit:value=>command("volume",value),onError:error=>setConnection(false,error.message)}),
};
$("#remoteLoginForm").addEventListener("submit",login);
document.querySelectorAll("[data-action]").forEach(button=>button.addEventListener("click",()=>{if(mutationsPending)return;let action=button.dataset.action;let value=null;if(action==="play"&&musicCanPause(player))action="pause";if(action==="mute")value=!player.muted;command(action,value).catch(error=>setConnection(false,error.message));}));
$("#remoteRefresh").addEventListener("click",()=>refresh().catch(error=>setConnection(false,error.message)));
$("#remoteLogout").addEventListener("click",()=>{sessionStorage.removeItem("clubiq_music_admin");location.reload();});
if(password){$("#remoteLogin").hidden=true;$("#remoteArea").hidden=false;refresh().catch(error=>setConnection(false,error.message));}
const remotePoller=createMusicPoller(()=>refresh(true),{enabled:()=>Boolean(password)&&!document.hidden});
remotePoller.start();
window.addEventListener("online",remotePoller.refresh);
window.addEventListener("focus",remotePoller.refresh);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)remotePoller.refresh();});
if("serviceWorker" in navigator&&window.isSecureContext)navigator.serviceWorker.register("/sw.js").catch(()=>{});
