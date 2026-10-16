const test=require('node:test'),assert=require('node:assert/strict');
const {avg,outcome,teamImage}=require('../static/darts-tv-studio.js');
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
