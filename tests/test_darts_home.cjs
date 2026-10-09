const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context=vm.createContext({URL});
vm.runInContext(fs.readFileSync('static/darts.js','utf8'),context);
const {dartsPreferences,dartsHomeGroups,dartsMatchCenterItem}=vm.runInContext('({dartsPreferences,dartsHomeGroups,dartsMatchCenterItem})',context);
assert.equal(dartsPreferences().teams.length,4);
assert.equal(dartsPreferences({teams:[],eventTypes:[]}).eventTypes.length,0);
assert.deepEqual(Array.from(dartsPreferences({teams:['D','D','X']}).teams),['D']);
const day=new Date(2026,8,27,12), stamp=n=>new Date(2026,8,27+n,19).toISOString();
const matches=[
  {id:1,kind:'live',barverTeam:'A',eventId:1445,plannedAt:stamp(0)},
  {id:2,kind:'upcoming',barverTeam:'D',eventId:1460,plannedAt:stamp(1)},
  {id:3,kind:'final',barverTeam:'B',eventId:1445,plannedAt:stamp(-1)},
  {id:4,kind:'final',barverTeams:['A','C'],eventId:1445,plannedAt:stamp(0)},
  {id:5,kind:'upcoming',barverTeam:'D',isSpecial:true,eventId:99,plannedAt:stamp(3)},
];
const grouped=dartsHomeGroups(matches,{},day);
assert.equal(grouped.today.length,2);assert.equal(grouped.upcoming.length,2);assert.equal(grouped.final.length,1);
assert.equal(dartsHomeGroups(matches,{team:'C'},day).today.length,1);
assert.equal(dartsHomeGroups(matches,{league:'1460'},day).upcoming.length,1);
assert.equal(dartsHomeGroups(matches,{league:'special'},day).upcoming[0].id,5);
assert.equal(dartsHomeGroups(matches,{date:'2026-09-28'},day).upcoming[0].id,2);
const postponed=[
  {id:6,kind:'upcoming',barverTeam:'A',plannedAt:stamp(5)},
  {id:7,kind:'upcoming',barverTeam:'A',plannedAt:stamp(1),round:{name:'Spieltag 9'}},
];
assert.equal(dartsMatchCenterItem(postponed,'A').id,7,'moved fixture with the earliest real date wins');
console.log('Darts homepage groups and personal preferences OK');
const {dartsCupActive,dartsLiveGroupActive}=vm.runInContext('({dartsCupActive,dartsLiveGroupActive})',context);
const cup={specialEventsAvailable:true,matches:['A','B','C','D'].map((code,i)=>({id:i,eventId:1,competitionType:'cup',kind:'final',score:'3:9',barverTeams:[code],barverSides:{[code]:'home'},updatedAt:`2026-09-${20+i}`}))};
assert.equal(dartsCupActive(cup),false);
assert.equal(dartsCupActive({...cup,stale:true}),true);
assert.equal(dartsCupActive({...cup,matches:cup.matches.slice(0,3)}),true);
assert.equal(dartsCupActive({...cup,matches:[...cup.matches,{eventId:1,competitionType:'cup',kind:'upcoming',barverTeams:['B'],plannedAt:'2026-10-10'}]}),true);
assert.equal(dartsLiveGroupActive({matches:[]}),false);
const liveTestNow=1760000000000;
assert.equal(dartsLiveGroupActive({matches:[{active:true,finished:false,lastUpdateNs:(liveTestNow-1000)*1e6}]},liveTestNow),true);
assert.equal(dartsLiveGroupActive({retired:true,matches:[{active:true,lastUpdateNs:(liveTestNow-1000)*1e6}]},liveTestNow),false);
assert.equal(dartsLiveGroupActive({matches:[{active:true,lastUpdateNs:(liveTestNow-3600000)*1e6}]},liveTestNow),false);
assert.equal(dartsLiveGroupActive({stale:true,matches:[{active:true,lastUpdateNs:(liveTestNow-1000)*1e6}]},liveTestNow),false);
assert.equal(dartsLiveGroupActive({matches:[{finished:true,teamScoreHome:0,teamScoreGuest:1,lastUpdateNs:(liveTestNow-1000)*1e6}]},liveTestNow),true);
assert.equal(dartsLiveGroupActive({matches:[{finished:true,teamScoreHome:4,teamScoreGuest:8,lastUpdateNs:(liveTestNow-1000)*1e6}]},liveTestNow),false);
console.log('Cup elimination and empty/old live watcher safeguards OK');
const {dartsLiveMoment,dartsHighlightIdentity}=vm.runInContext('({dartsLiveMoment,dartsHighlightIdentity})',context);
const loss={type:'game',matchId:123,gameId:7,team:'SV Barver Darts B',player:'Max',barverWon:false,homeLegs:3,awayLegs:1,text:'Max verliert 1:3 gegen Gast · AVG 55,6 / 60,2',occurred_at:new Date().toISOString()};
const moment=dartsLiveMoment(loss);
assert.equal(moment.title,'Partie verloren');assert.match(moment.body,/Max verliert 1:3/);assert.match(moment.body,/AVG 55,6/);
assert.equal(dartsHighlightIdentity(moment),dartsHighlightIdentity({...moment,team:'B',id:'server-event-id'}));
assert.notEqual(dartsHighlightIdentity(moment),dartsHighlightIdentity({...moment,team:'A'}));
const {dartsLiveGameFinished,dartsCurrentLiveGames}=vm.runInContext('({dartsLiveGameFinished,dartsCurrentLiveGames})',context);
const completedBoard={active:true,finished:false,mode:'Best of 5 Legs',home:{legs:1},guest:{legs:3},lastUpdateNs:liveTestNow*1e6,teamScoreHome:2,teamScoreGuest:8};
assert.equal(dartsLiveGameFinished(completedBoard),true);
assert.equal(dartsCurrentLiveGames({matches:[completedBoard]},liveTestNow).length,0,'no completed board despite active source flag');
assert.equal(dartsLiveGroupActive({matches:[completedBoard]},liveTestNow),true,'team match continues after one board completes');
assert.equal(dartsCurrentLiveGames({matches:[{...completedBoard,active:false,guest:{legs:2}}]},liveTestNow).length,0,'inactive unfinished records are not current boards');
for(const mode of ['Best of 7 Legs','Best of 5 Sets',''])assert.equal(dartsLiveGameFinished({...completedBoard,mode}),false,mode);
assert.equal(dartsLiveGameFinished({...completedBoard,guest:{legs:2,points:0}}),false,'a checkout alone does not finish the game');
assert.equal(dartsCurrentLiveGames({retired:true,matches:[{...completedBoard,guest:{legs:2}}]},liveTestNow).length,0);
