const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context=vm.createContext({URL});
vm.runInContext(fs.readFileSync('static/darts.js','utf8'),context);
const {dartsPreferences,dartsHomeGroups}=vm.runInContext('({dartsPreferences,dartsHomeGroups})',context);
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
console.log('Darts homepage groups and personal preferences OK');
