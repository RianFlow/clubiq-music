const test=require('node:test'),assert=require('node:assert/strict');
const {avg,outcome,teamImage,nextFixture,countdownParts,fixtureVenue}=require('../static/darts-tv-studio.js');
test('TV averages use known current-leg darts and remaining points, without inventing missing values',()=>{
 assert.equal(avg({remaining:84,darts:18,average:55.5,totalDarts:99}),'69,5');
 assert.equal(avg({remaining:501,darts:0}),'0,0');
 for(const player of [{remaining:84},{darts:0},{remaining:null,darts:18},{remaining:800,darts:18}])assert.equal(avg(player),'–');
});
test('team wins follow the actual home or away side; draws and unknown scores are not victories',()=>{
 const match={home:'Gäste',away:'SV Barver Darts B',score:'5:7'};
 assert.equal(outcome(match,'B'),'win');assert.equal(outcome({...match,score:'7:5'},'B'),'loss');assert.equal(outcome({...match,score:'6:6'},'B'),'draw');
 assert.equal(outcome({...match,score:null},'B'),null);assert.equal(outcome(match,'A'),null);assert.equal(outcome({...match,barverSides:{B:'guest'}},'B'),'win');
});
test('pause photos belong to the requested team; missing groups use the club crest',()=>{
 assert.match(teamImage('A'),/barver-a-team/);assert.match(teamImage('B'),/barver-b-team/);assert.match(teamImage('D'),/barver-d-team/);assert.equal(teamImage('C'),'/pics/sv-barver-darts-tight-512.webp');
});
test('next TV fixture follows the selected teams and actual date, excluding completed and obsolete matches',()=>{
 const now=Date.parse('2026-10-17T10:00:00Z'),match=(id,team,hours,kind='upcoming')=>({id,barverTeam:team,kind,plannedAt:new Date(now+hours*3600000).toISOString()});
 const items=[match(1,'A',24),match(2,'B',2),match(3,'C',1),match(4,'A',.5,'final'),match(5,'A',-25),{...match(6,'A',0),plannedAt:'unknown'},match(7,'A',0,'live')];
 assert.equal(nextFixture(items,['A','B'],now).id,2);assert.equal(nextFixture(items,['A'],now).id,1);assert.equal(nextFixture(items,['D'],now),null);
 assert.equal(nextFixture([match(8,'B',-.1),match(9,'B',24)],['B'],now).id,8,'a short source delay at kickoff keeps the current fixture visible');assert.equal(items[0].id,1,'input order remains unchanged');
 assert.equal(nextFixture([{...match(10,'A',1),barverTeam:null,home:'Gäste',away:'SV Barver Darts A'}],['A'],now).id,10);
});
test('TV countdown uses days, hours, minutes and seconds and never runs below zero',()=>{
 const now=Date.parse('2026-10-17T10:00:00Z');assert.deepEqual(countdownParts(new Date(now+((2*24+3)*3600+4*60+5)*1000).toISOString(),now),{days:2,hours:3,minutes:4,seconds:5,started:false});
 assert.deepEqual(countdownParts(new Date(now-1000).toISOString(),now),{days:0,hours:0,minutes:0,seconds:0,started:true});assert.equal(countdownParts('unknown',now),null);
 assert.equal(countdownParts(new Date(now+1).toISOString(),now).seconds,1);
});
test('the countdown venue belongs to the home side, including away matches for Barver',()=>{
 assert.equal(fixtureVenue({home:'Mad Dogs C',away:'SV Barver Darts A',homeVenue:{name:'Dartclub Diepholz',street:'Nährweg 4',postalCode:'49356',city:'Diepholz'},awayVenue:{name:'Barver'}}),'Dartclub Diepholz, Nährweg 4, 49356 Diepholz');assert.equal(fixtureVenue({awayVenue:{name:'Barver'}}),'');
});
