"use strict";

const $ = selector => document.querySelector(selector);
let password = sessionStorage.getItem("clubiq_music_admin") || "";
let player = {};

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Admin-Password", password);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {...options, headers});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.error || `Fehler ${response.status}`);
  return data;
}
function time(value){const n=Math.max(0,Math.floor(Number(value)||0));return `${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`;}
function esc(value=""){return String(value).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]);}
function setConnection(ok,text){$("#remoteStatus").className=`connection${ok?"":" bad"}`;$("#remoteStatus").textContent=text;}

function render() {
  const current=player.current||{};
  setMediaImage($("#remoteCover"),current.thumbnail,player.source_mode==="radio");
  $("#remoteTitle").textContent=current.title||"Noch kein Song";
  $("#remoteArtist").textContent=current.artist||"–";
  $("#remoteProgress").max=Math.max(1,Number(player.duration)||1);
  $("#remoteProgress").value=Number(player.position)||0;
  $("#remotePosition").textContent=time(player.position);
  $("#remoteDuration").textContent=time(player.duration);
  $("#remotePlay").textContent=player.playing?"Pause":"Start";
  $("#remoteVolume").value=Number(player.volume??70);
  $("#remoteVolumeValue").textContent=`${Number(player.volume??70)} %`;
  $("#remoteMute").textContent=player.muted?"Ton an":"Stumm";
  const queue=player.queue||[];
  $("#remoteQueue").innerHTML=queue.length?queue.map((item,index)=>`<article class="${index===player.current_index?"current":""}"><b>${index+1}</b><div><strong>${esc(item.title)}</strong><small>${esc(item.artist||"")}</small></div>${index!==player.current_index?`<button data-play-index="${index}">Start</button>`:""}</article>`).join(""):"<p>Noch keine Songs geladen.</p>";
  document.querySelectorAll("[data-play-index]").forEach(button=>button.addEventListener("click",()=>playIndex(Number(button.dataset.playIndex))));
}
async function refresh(silent=false){try{player=await api("/api/v1/music/player/state");render();setConnection(Boolean(player.speaker?.connected),player.speaker?.connected?"Box verbunden":"Box getrennt");}catch(error){setConnection(false,error.message);if(!silent)throw error;}}
async function command(action,value=null){player=await api("/api/v1/music/admin/player/command",{method:"POST",body:JSON.stringify({action,value})});render();}
async function playIndex(index){player=await api(`/api/v1/music/admin/player/queue/${index}/play`,{method:"POST"});render();}
async function login(event){event.preventDefault();password=$("#remotePassword").value;try{await api("/api/v1/music/admin/verify");sessionStorage.setItem("clubiq_music_admin",password);$("#remoteLogin").hidden=true;$("#remoteArea").hidden=false;await refresh();}catch(error){$("#remoteError").textContent=error.message;$("#remoteError").hidden=false;}}
$("#remoteLoginForm").addEventListener("submit",login);
document.querySelectorAll("[data-action]").forEach(button=>button.addEventListener("click",()=>{let action=button.dataset.action;let value=null;if(action==="play"&&player.playing)action="pause";if(action==="mute")value=!player.muted;command(action,value).catch(error=>setConnection(false,error.message));}));
$("#remoteProgress").addEventListener("change",event=>command("seek",Number(event.target.value)));
$("#remoteVolume").addEventListener("change",event=>command("volume",Number(event.target.value)));
$("#remoteRefresh").addEventListener("click",()=>refresh());
$("#remoteLogout").addEventListener("click",()=>{sessionStorage.removeItem("clubiq_music_admin");location.reload();});
if(password){$("#remoteLogin").hidden=true;$("#remoteArea").hidden=false;refresh().catch(()=>{sessionStorage.removeItem("clubiq_music_admin");location.reload();});}
setInterval(()=>{if(password&&!document.hidden)refresh(true);},2500);
if("serviceWorker" in navigator&&window.isSecureContext)navigator.serviceWorker.register("/sw.js").catch(()=>{});
