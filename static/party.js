"use strict";
const $=selector=>document.querySelector(selector);
const time=value=>{const n=Math.max(0,Math.floor(Number(value)||0));return `${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`;};
const esc=(value="")=>String(value).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]);
let cycle=null;
async function refresh(){
  try{
    const [player,cycles]=await Promise.all([
      musicRequestJson("/api/v1/music/player/state"), musicRequestJson("/api/v1/music/cycles")
    ]);
    if(!Array.isArray(player.queue)||!Array.isArray(cycles.cycles))throw new Error("Unvollständiger Status");
    const current=player.current||{};
    setMediaImage($("#partyCover"),current.thumbnail,player.source_mode==="radio");
    $("#partyTitle").textContent=current.title||"Die Playlist wird vorbereitet";
    $("#partyArtist").textContent=current.artist||"ClubIQ Music";
    $("#partyBar").style.width=`${player.duration?Math.min(100,(player.position/player.duration)*100):0}%`;
    $("#partyTime").textContent=`${time(player.position)} / ${time(player.duration)}`;
    const queue=player.queue.slice(Math.max(0,player.current_index+1),Math.max(0,player.current_index+4));
    $("#partyQueue").innerHTML=player.source_mode==="radio"||player.shuffle||player.repeat==="one"||(player.repeat==="all"&&!queue.length)
      ? `<p>${esc(musicNextTrack(player))}</p>`
      : queue.length?queue.map((item,index)=>`<article><b>${index+1}</b><div><strong>${esc(item.title)}</strong><small>${esc(item.artist||"")}</small></div></article>`).join(""):"<p>Noch keine weiteren Titel.</p>";
    cycle=cycles.cycles.find(item=>item.status==="active")||cycles.cycles.find(item=>item.status==="planned")||null;
    $("#partyCycle").textContent=cycle?.name||"Gemeinsam die Playlist bestimmen.";
    $("#partyConnection").textContent=musicPlaybackSummary(player).title;
    return true;
  }catch(_){$("#partyConnection").textContent="Verbindung unterbrochen · letzter bekannter Stand";return false;}
}
function countdown(){if(!cycle){$("#partyCountdown").textContent="";return;}const start=new Date(cycle.starts_at).getTime(),end=new Date(cycle.closes_at).getTime(),now=Date.now(),target=now<start?start:end,total=Math.max(0,Math.floor((target-now)/1000)),h=Math.floor(total/3600),m=Math.floor((total%3600)/60),s=total%60;$("#partyCountdown").textContent=`${now<start?"Voting startet":"Voting endet"} in ${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;}
$("#partyFullscreen").addEventListener("click",()=>document.documentElement.requestFullscreen?.());
const partyPoller=createMusicPoller(refresh);
partyPoller.refresh();partyPoller.start();countdown();setInterval(countdown,1000);
window.addEventListener("online",partyPoller.refresh);
window.addEventListener("focus",partyPoller.refresh);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)partyPoller.refresh();});
if("serviceWorker" in navigator&&window.isSecureContext)navigator.serviceWorker.register("/sw.js").catch(()=>{});
