const test=require('node:test'),assert=require('node:assert/strict');
const {avg,outcome,teamImage,nextFixture,startedFixture,countdownParts,fixtureVenue,retainKickoffFixtures}=require('../static/darts-tv-studio.js');
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
test('a scheduled encounter becomes a waiting match card at kickoff, never a fabricated live score',()=>{
 const now=Date.parse('2026-10-17T19:30:00+02:00'),fixture=minutes=>({kind:'upcoming',plannedAt:new Date(now+minutes*60000).toISOString()});
 assert.equal(startedFixture(fixture(1),now),false);
 assert.equal(startedFixture(fixture(0),now),true);
 assert.equal(startedFixture(fixture(-1),now),true);
 assert.equal(startedFixture(fixture(-359),now),true);
 assert.equal(startedFixture(fixture(-361),now),false);
 assert.equal(startedFixture({...fixture(-1),kind:'final'},now),false);
 assert.equal(startedFixture({...fixture(-1),kind:'live'},now),false);
 assert.equal(startedFixture({kind:'upcoming',plannedAt:'invalid'},now),false);
});
test('TV countdown uses days, hours, minutes and seconds and never runs below zero',()=>{
 const now=Date.parse('2026-10-17T10:00:00Z');assert.deepEqual(countdownParts(new Date(now+((2*24+3)*3600+4*60+5)*1000).toISOString(),now),{days:2,hours:3,minutes:4,seconds:5,started:false});
 assert.deepEqual(countdownParts(new Date(now-1000).toISOString(),now),{days:0,hours:0,minutes:0,seconds:0,started:true});assert.equal(countdownParts('unknown',now),null);
 assert.equal(countdownParts(new Date(now+1).toISOString(),now).seconds,1);
});
test('a partial refresh at kickoff cannot replace the known encounter with the next countdown',()=>{
 const start=Date.parse('2026-10-17T16:00:00+02:00'),current={id:1280545,kind:'upcoming',barverTeam:'A',plannedAt:new Date(start).toISOString()},next={...current,id:1280533,plannedAt:new Date(start+12*86400000).toISOString()};
 const remembered=retainKickoffFixtures([],[current,next],['A'],start-60000);
 assert.deepEqual(remembered,[current]);
 const during=retainKickoffFixtures(remembered,[next],['A'],start+1000);
 assert.deepEqual(during,[current],'missing from a partial response is not a cancellation or a result');
 assert.equal(startedFixture(during[0],start+1000),true,'the known fixture becomes a waiting encounter');
 assert.equal(during[0].score,undefined,'no live points are invented');
 for(const kind of ['live','final','pending'])assert.deepEqual(retainKickoffFixtures(during,[{...current,kind}],['A'],start+1000),[],'confirmed status replaces the expectation: '+kind);
 assert.deepEqual(retainKickoffFixtures(during,[{...current,plannedAt:next.plannedAt}],['A'],start+1000),[],'an explicit changed appointment is respected');
 assert.deepEqual(retainKickoffFixtures(during,[],['B'],start+1000),[],'deselected teams do not remain on screen');
 assert.deepEqual(retainKickoffFixtures(during,[],['A'],start+6*3600000+1),[],'unconfirmed fixtures cannot remain indefinitely');
 assert.deepEqual(retainKickoffFixtures([],[next],['A'],start),[],'future games do not acquire a waiting state');
});
test('the countdown venue belongs to the home side, including away matches for Barver',()=>{
 assert.equal(fixtureVenue({home:'Mad Dogs C',away:'SV Barver Darts A',homeVenue:{name:'Dartclub Diepholz',street:'Nährweg 4',postalCode:'49356',city:'Diepholz'},awayVenue:{name:'Barver'}}),'Dartclub Diepholz, Nährweg 4, 49356 Diepholz');assert.equal(fixtureVenue({awayVenue:{name:'Barver'}}),'');
});
