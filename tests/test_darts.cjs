const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({URL});
vm.runInContext(fs.readFileSync('static/darts.js','utf8'),context);
const {dartsMatch,DARTS_TEAMS} = vm.runInContext('({dartsMatch,DARTS_TEAMS})',context);
const team = DARTS_TEAMS[3];
const dartsTraining = vm.runInContext('dartsTraining',context);
const trainingLink = 'https://portal.3k-darts.com/frontend/events/5/event/31849/phase/53660/group/403948';
assert.equal(dartsTraining(trainingLink).games,trainingLink);
assert.equal(dartsTraining(trainingLink).performances,'https://portal.3k-darts.com/frontend/events/5/event/31849/performances');
assert.equal(dartsTraining('https://portal.3k-darts.com/frontend/events/5/event/31849/participants').games,null);
for (const bad of [trainingLink+'?x=1',trainingLink+'#x',trainingLink.replace('https:','http:'),trainingLink.replace('portal.3k-darts.com','evil.test'),trainingLink.replace('/5/','/10/'),trainingLink.replace('https://','https://user:pass@'),'javascript:alert(1)']) assert.throws(()=>dartsTraining(bad));
const report = 'https://portal.3k-darts.com/frontend/events/10/event/1460/phase/2154/group/34524?matchId=1296302';
assert.deepEqual(JSON.parse(JSON.stringify(dartsMatch(report,team))),{report,live:'https://live.3k-darts.com/event/10/1296302',match:'1296302'});
assert.equal(dartsMatch('https://live.3k-darts.com/event/10/1296302',team).report,null);
assert.throws(()=>dartsMatch(report,DARTS_TEAMS[0]),/Liga/);
for (const url of [
  'javascript:alert(1)', 'http://live.3k-darts.com/event/10/1',
  'https://live.3k-darts.com.evil.test/event/10/1',
  'https://live.3k-darts.com@evil.test/event/10/1',
  'https://user:pass@live.3k-darts.com/event/10/1',
  'https://live.3k-darts.com:444/event/10/1',
  'https://live.3k-darts.com/event/10/1?redirect=https://evil.test',
  'https://live.3k-darts.com/event/10/1#extra',
  'https://portal.3k-darts.com/frontend/events/10/event/1460/participants/174266',
  report+'&matchId=1',report+'&redirect=https://evil.test',report.replace('1296302','<script>'),
]) assert.throws(()=>dartsMatch(url,team),url);
assert.deepEqual(Array.from(DARTS_TEAMS,t=>t.participant),['174110','174111','174112','174266']);
const html = fs.readFileSync('darts.html','utf8');
assert.match(html,/id="teamGrid"/);
assert.doesNotMatch(html,/<iframe|https:\/\/portal[^" ]+\.js/,'external content is opt-in');
const script = fs.readFileSync('static/darts.js','utf8');
assert.doesNotMatch(script,/fetch\(|\/api\/v1\/music\/.*command/,'darts view does not control music');
assert.match(fs.readFileSync('sw.js','utf8'),/"\/darts"/);
console.log('Darts: four verified teams, strict links, wrong-league guard, opt-in embedding and no playback writes OK.');
