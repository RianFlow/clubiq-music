import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apiUrl,publicLink,cleanPreferences,activeBoards,matchesFor,sections,roleRank,notificationTarget,liveBoardView} from '../src/model.js';
test('only public read endpoints and public links',()=>{
  assert.match(apiUrl('/api/v1/darts/matches/1280528'),/^https:\/\/barverdarts/);
  for(const path of ['/api/v1/darts/admin/players','/api/v1/darts/push/subscribe','https://evil.test','/api/v1/darts/season?admin=1'])assert.throws(()=>apiUrl(path));
  for(const link of ['/darts-admin','https://evil.test','https://user@barverdarts.clubiq.party/'])assert.throws(()=>publicLink(link));
  assert.equal(publicLink('/turnier?tv=1'),'https://barverdarts.clubiq.party/turnier?tv=1');
});
test('preferences whitelist and preserve opt-out',()=>{
  assert.deepEqual(cleanPreferences({favorite:'Z',teams:['A','A','Z'],eventTypes:[]}),{favorite:'',teams:['A'],eventTypes:[]});
});
test('every simultaneous fresh board appears, never empty/old/retired watchers',()=>{
  const now=Date.now(),board={active:true,finished:false,lastUpdateNs:now*1e6};
  assert.equal(activeBoards({matches:[board,board]},now).length,2);
  for(const group of [{retired:true,matches:[board]},{finished:true,matches:[board]},{matches:[]},{matches:[{...board,lastUpdateNs:(now-600001)*1e6}]},{matches:[{...board,lastUpdateNs:(now+1000)*1e6}]}])assert.equal(activeBoards(group,now).length,0);
});
test('fresh boards override pending, never official final',()=>{
  const now=Date.now(),live={groups:[{groupKey:'1',matches:[{active:true,lastUpdateNs:now*1e6}]}]};
  assert.equal(matchesFor({matches:[{id:1,kind:'pending'}]},live,'',now)[0].kind,'live');
  assert.equal(matchesFor({matches:[{id:1,kind:'final'}]},live,'',now)[0].kind,'final');
});
test('rearranged dates precede nominal round order and team filter',()=>{
  const season={matches:[{id:1,barverTeam:'A',kind:'upcoming',plannedAt:'2026-10-02T19:30:00+02:00'},{id:2,barverTeam:'A',kind:'upcoming',plannedAt:'2026-09-28T19:30:00+02:00'},{id:3,barverTeam:'D',kind:'final',plannedAt:'2026-09-27T19:30:00+02:00'}]};
  assert.deepEqual(matchesFor(season,{groups:[]},'A').map(m=>m.id),[2,1]);
  assert.equal(sections(matchesFor(season,{groups:[]}),'2026-09-27T12:00:00+02:00').next.length,2);
});
test('captain before deputy and player',()=>{
  assert.deepEqual(['Spieler','Stellvertretung','Kapitän'].map(role=>({role})).sort((a,b)=>roleRank(a)-roleRank(b)).map(x=>x.role),['Kapitän','Stellvertretung','Spieler']);
});
test('push navigation accepts match IDs only',()=>{
  assert.equal(notificationTarget({matchId:'1280528',url:'/darts-admin'}),1280528);
  for(const value of [-1,0,1.5,'admin',undefined])assert.equal(notificationTarget({matchId:value}),null);
});
test('live detail shows players, points, legs and current thrower, including zero',()=>{
  const now=Date.now(),board={board:'2',currentPlayerIndex:0,lastUpdateNs:now*1e6,home:{name:'Jannik',points:320,legs:2,average:61.5,lastScore:180},guest:{name:'Gast',points:410,legs:1,lastScore:0}};
  const view=liveBoardView(board,now);
  assert.equal(view.players[0].throwing,true);assert.equal(view.players[1].throwing,false);
  assert.deepEqual(view.players.map(p=>p.points),[320,410]);assert.deepEqual(view.players.map(p=>p.legs),[2,1]);
  assert.equal(view.players[0].average,61.5);assert.equal(view.players[1].lastScore,0);
  assert.equal(liveBoardView({...board,home:{points:0,legs:0}},now).players[0].points,0);
  for(const b of [{...board,stale:true},{...board,lastUpdateNs:(now-61000)*1e6}]){assert.equal(liveBoardView(b,now).stale,true);assert.equal(liveBoardView(b,now).players[0].throwing,false);}
  assert.equal(liveBoardView(board,now,true).players[0].throwing,false);
});
test('latest parallel board gives team score, never override an official final',()=>{
  const now=Date.now(),boards=[{active:true,lastUpdateNs:(now-1000)*1e6,teamScoreHome:3,teamScoreGuest:2},{active:true,lastUpdateNs:now*1e6,teamScoreHome:4,teamScoreGuest:2}];
  const season={matches:[{id:1,kind:'live',score:'2:2'}]},live={groups:[{groupKey:'1',stale:true,matches:boards}]};
  const m=matchesFor(season,live,'',now)[0];assert.equal(m.score,'4:2');assert.equal(m.boards.length,2);assert.equal(m.liveStale,true);
  const final=matchesFor({matches:[{id:1,kind:'final',score:'8:4'}]},live,'',now)[0];assert.equal(final.score,'8:4');assert.equal(final.boards.length,0);
});
