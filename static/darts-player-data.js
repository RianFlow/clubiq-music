/* Independent, bounded public profile and statistics recovery. */
(() => {
  'use strict';
  function create({parseProfiles,parseStats,knownPlayers,directStats,onUpdate,storage}) {
    const state={profiles:{players:{},loading:false,stale:true,error:false,updatedAt:null},stats:{players:{},loading:false,stale:true,error:false,updatedAt:null}};
    const pending={profiles:null,stats:null},next={profiles:0,stats:0},failures={profiles:0,stats:0};
    const rosterKey=()=>knownPlayers().map(p=>`${p.team}:${p.id}:${p.name}`).sort().join('|');
    const validStats=data=>data&&data.players&&typeof data.players==='object'&&!Array.isArray(data.players)&&(data.statsSchema===1||data.matchesScanned>0||data.officialLeagues?.length>0);
    const profileKey='clubiq_darts_public_profiles_v1',statsKey='clubiq_darts_public_stats_v1';
    const notify=()=>onUpdate?.(state);
    const save=(key,value)=>{try{storage?.setItem(key,JSON.stringify(value));}catch(_){} };
    try {
      const saved=JSON.parse(storage?.getItem(profileKey)||'null');
      if(saved?.players){state.profiles.players=parseProfiles(saved);state.profiles.updatedAt=saved.updatedAt;}
    }catch(_){}
    try {
      const saved=JSON.parse(storage?.getItem(statsKey)||'null');
      if(validStats(saved)){state.stats.players=parseStats({...saved,stale:true});state.stats.updatedAt=saved.updatedAt;}
    }catch(_){}
    async function read(url,timeout) {
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
      try {
        const response=await fetch(url,{headers:{Accept:'application/json'},cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error('Public player source unavailable');
        const data=await response.json();
        if(!data||typeof data.players!=='object'||Array.isArray(data.players)||data.players===null)throw new Error('Invalid public player source');
        return data;
      }finally{clearTimeout(timer);}
    }
    function failed(kind) {
      state[kind].error=true;state[kind].stale=true;
      if(kind==='stats')for(const row of Object.values(state.stats.players))row.statsStale=true;
      next[kind]=Date.now()+Math.min(300000,30000*2**failures[kind]++);
    }
    function refresh(kind,force=false) {
      if(pending[kind])return pending[kind];
      if(!force&&Date.now()<next[kind])return Promise.resolve(state[kind]);
      state[kind].loading=true;notify();
      if(kind==='stats')state.stats.rosterKey=rosterKey();
      pending[kind]=(async()=>{
        try {
          if(kind==='profiles') {
            let data,source='published';
            try{data=await read('/api/v1/darts/player-profiles',4000);}
            catch(error){
              // A static fallback must not erase cached profiles edited by the club.
              if(Object.keys(state.profiles.players).length)throw error;
              data=await read('/static/darts-players.json',2500);source='static';
            }
            state.profiles.players=parseProfiles(data);state.profiles.updatedAt=new Date().toISOString();
            state.profiles.stale=source!=='published';state.profiles.error=source!=='published';
            if(source==='published')save(profileKey,{players:state.profiles.players,updatedAt:state.profiles.updatedAt});
            next.profiles=Date.now()+(source==='published'?300000:30000);
          } else {
            let data;
            try{data=await read('/api/v1/darts/player-stats',4000);if(!validStats(data)||data.degraded)throw new Error('Unverified player statistics');}
            catch(_) { /* Continue with the independent public source. */ }
            if(!data||!validStats(data)||data.stale||data.degraded) {
              try {
                const direct=await directStats(knownPlayers());
                if(!validStats(direct)||!Object.keys(direct.players).length)throw new Error('No verified player statistics');
                data=direct;
              }catch(error){if(!validStats(data)||data.degraded)throw error;}
            }
            const incoming=parseStats(data);
            if(data.degraded||data.stale)for(const row of Object.values(state.stats.players))row.statsStale=true;
            state.stats.players=data.degraded?{...state.stats.players,...incoming}:incoming;
            state.stats.updatedAt=data.updatedAt;state.stats.stale=Boolean(data.stale||data.degraded);state.stats.error=Boolean(data.stale||data.degraded);
            // Persist only normalized public fields, retaining individual observation times.
            save(statsKey,{statsSchema:1,players:state.stats.players,updatedAt:data.updatedAt,stale:state.stats.stale});
            next.stats=Date.now()+(state.stats.error?30000:600000);
          }
          failures[kind]=0;
        }catch(_){failed(kind);}
        finally{state[kind].loading=false;pending[kind]=null;notify();}
        return state[kind];
      })();
      return pending[kind];
    }
    function load(force=false) {
      const profiles=refresh('profiles',force);
      refresh('stats',force||(!state.stats.loading&&state.stats.rosterKey!==rosterKey()));
      return profiles;
    }
    return {state,load,refresh};
  }
  const exported={create};
  if(typeof module!=='undefined'&&module.exports)module.exports=exported;
  else window.DartsPlayerData=exported;
})();
