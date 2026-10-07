import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apiUrl,publicLink,cleanPreferences,activeBoards,matchesFor,sections,roleRank,notificationTarget,liveBoardView,matchLocation,matchSide,routeUrl,calendarEvent,calendarFile} from '../src/model.js';
test('only public read endpoints and public links',()=>{
  assert.match(apiUrl('/api/v1/darts/matches/1280528'),/^https:\/\/barverdarts/);
  for(const path of ['/api/v1/darts/admin/players','/api/v1/darts/push/subscribe','https://evil.test','/api/v1/darts/season?admin=1'])assert.throws(()=>apiUrl(path));
  for(const link of ['/darts-admin','https://evil.test','https://user@barverdarts.clubiq.party/'])assert.throws(()=>publicLink(link));
  assert.equal(publicLink('/turnier?tv=1'),'https://barverdarts.clubiq.party/turnier?tv=1');
});
test('preferences whitelist and preserve opt-out',()=>{
  assert.deepEqual(cleanPreferences({favorite:'Z',teams:['A','A','Z'],eventTypes:[]}),{training:false,favorite:'',teams:['A'],players:[],eventTypes:[]});
  assert.deepEqual(cleanPreferences({players:[' Jannik ','Jannik',null,'','x'.repeat(101)]}).players,['Jannik']);
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
  const now=Date.now(),board={board:'2',currentPlayerIndex:0,lastUpdateNs:(now-1000)*1e6,home:{name:'Jannik',points:320,legs:2,average:61.5,lastScore:180},guest:{name:'Gast',points:410,legs:1,lastScore:0}};
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
test('upcoming includes today and undated games; completed games never repeat in today',()=>{
  const rows=[{id:1,kind:'upcoming',plannedAt:'2026-10-05T18:00:00Z'},{id:2,kind:'upcoming',plannedAt:null},{id:3,kind:'final',plannedAt:'2026-10-05T17:00:00Z'},{id:4,kind:'pending',plannedAt:'2026-10-05T17:00:00Z'}];
  const grouped=sections(rows,new Date('2026-10-05T12:00:00Z'));
  assert.deepEqual(grouped.next.map(m=>m.id),[1,2]);
  assert.deepEqual(grouped.today.map(m=>m.id),[1]);
  assert.deepEqual(grouped.results.map(m=>m.id),[4,3]);
});

test('venues, calendar time zones and file escaping',()=>{
  const match={id:7,home:'Barver, A',away:'Gäste; B',barverTeam:'A',barverSides:{A:'away'},plannedAt:'2026-10-05T19:30:00+02:00',homeVenue:{name:'Verein',street:'Straße 1',postalCode:'12345',city:'Teststadt'}};
  assert.equal(matchSide(match),'Auswärtsspiel');assert.equal(matchLocation(match),'Verein, Straße 1, 12345 Teststadt');
  const url=new URL(routeUrl(match));assert.equal(url.hostname,'www.google.com');assert.equal(url.searchParams.get('destination'),matchLocation(match));
  assert.equal(new Date(calendarEvent(match).begin).toISOString(),'2026-10-05T17:30:00.000Z');
  const file=calendarFile(match);assert(file.includes('DTSTART:20261005T173000Z'));assert(file.includes('SUMMARY:Barver\\, A gegen Gäste\\; B'));
  assert.equal(calendarFile({...match,plannedAt:null}),null);assert.equal(routeUrl({...match,homeVenue:{}}),null);
  assert(calendarFile({...match,home:'ä'.repeat(120)}).split('\r\n').every(line=>new TextEncoder().encode(line).length<=75));
});
test('new start notifications require explicit selection; stored filters stay intact',()=>{
  assert.equal(cleanPreferences().eventTypes.includes('player_start'),false);
  assert.deepEqual(cleanPreferences({eventTypes:['player_start']}).eventTypes,['player_start']);
});

test('an undated fixture does not hide the next scheduled match',()=>{
  const rows=matchesFor({matches:[{id:1,kind:'upcoming',plannedAt:null},{id:2,kind:'upcoming',plannedAt:'2026-10-06T18:00:00Z'}]},{groups:[]});
  assert.deepEqual(rows.map(m=>m.id),[2,1]);
});

test('training links remain public and training alerts never open a league match',async()=>{
  const {trainingNotificationTarget}=await import('../src/model.js');
  assert.equal(cleanPreferences().training,false);assert.equal(cleanPreferences({training:true}).training,true);assert.equal(cleanPreferences({training:'true'}).training,false);
  assert.equal(apiUrl('/api/v1/darts/training/live?event_id=32751'),'https://barverdarts.clubiq.party'+'/api/v1/darts/training/live?event_id=32751');
  assert.equal(trainingNotificationTarget({scope:'training',trainingId:'32751',matchId:32751}),32751);
  assert.equal(notificationTarget({scope:'training',trainingId:32751,matchId:32751}),null);
  assert.equal(trainingNotificationTarget({scope:'training',trainingId:'-1'}),null);
});
