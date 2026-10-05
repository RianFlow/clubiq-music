'use strict';
(function(root){
  const nameKey=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLocaleLowerCase('de-DE');
  function outcome(match,code){
    if(match?.kind!=='final'||!code)return null;
    const sides=match.barverSides||{};
    let side=sides[code];
    if(!side){const names=[['home',match.home],['away',match.away]];side=names.find(([,name])=>nameKey(name)===nameKey(`SV Barver Darts ${code}`))?.[0];}
    const score=/^(\d+)\s*:\s*(\d+)$/.exec(String(match.score||''));
    if(!['home','away'].includes(side)||!score)return null;
    const [home,away]=score.slice(1).map(Number),own=side==='home'?home:away,other=side==='home'?away:home;
    return own===other?{kind:'draw',label:'Unentschieden',symbol:'='}:own>other?{kind:'win',label:'Sieg',symbol:'✓'}:{kind:'loss',label:'Niederlage',symbol:'−'};
  }
  function rankingPage(rows,{search='',ours=false,names=[],page=0,size=12}={}){
    const query=nameKey(search),members=new Set(names.map(nameKey));
    const filtered=(rows||[]).filter(row=>(!query||nameKey(row.name).includes(query))&&(!ours||members.has(nameKey(row.name))));
    size=Math.max(1,Math.min(100,Math.trunc(size)||12));
    const pages=Math.max(1,Math.ceil(filtered.length/size)),current=Math.max(0,Math.min(pages-1,Math.trunc(page)||0));
    return {rows:filtered.slice(current*size,(current+1)*size),total:filtered.length,page:current,pages,from:filtered.length?current*size+1:0,to:Math.min((current+1)*size,filtered.length)};
  }
  const api={nameKey,outcome,rankingPage};root.DartsUsability=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
