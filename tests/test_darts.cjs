const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({URL});
vm.runInContext(fs.readFileSync('static/darts.js','utf8'),context);
const {dartsMatch,DARTS_TEAMS} = vm.runInContext('({dartsMatch,DARTS_TEAMS})',context);
const dartsTheme = vm.runInContext('dartsTheme',context);
assert.equal(dartsTheme('dark'), 'dark');
assert.equal(dartsTheme('light', true), 'light');
assert.equal(dartsTheme(null, true), 'dark');
assert.equal(dartsTheme('invalid', false), 'light');
const dartsSponsors = vm.runInContext('dartsSponsors',context);
const sponsorConfig = {displaySeconds:2,sponsors:[
  {id:'active',name:'Lokaler Betrieb',image:'/pics/sponsors/betrieb.png',href:'https://example.com',placements:['top','inline'],startsAt:'2026-01-01',endsAt:'2026-12-31'},
  {id:'old',name:'Abgelaufen',startsAt:'2025-01-01',endsAt:'2025-12-31'},
  {id:'unsafe',name:'Unsicher',image:'https://tracker.test/logo.png',href:'javascript:alert(1)',placements:['inline']},
]};
const sponsorResult = dartsSponsors(sponsorConfig,Date.parse('2026-09-21T12:00:00Z'));
assert.equal(sponsorResult.displaySeconds,6);
assert.equal(sponsorResult.sponsors.length,2);
assert.equal(sponsorResult.sponsors[0].href,'https://example.com/');
assert.equal(sponsorResult.sponsors[1].image,'');
assert.equal(sponsorResult.sponsors[1].href,'');
const team = DARTS_TEAMS[3];
const dartsLayout = vm.runInContext('dartsLayout',context);
for (const count of [1,2,3,4]) {
  const layout = dartsLayout({count,selected:['d','d','invalid','b'],modes:{a:'invalid',b:'live'}});
  assert.equal(layout.selected.length,count);
  assert.equal(new Set(layout.selected).size,count);
  assert.equal(layout.selected[0],'d');
  assert.equal(layout.modes.a,'team');
  assert.equal(layout.modes.b,'live');
  assert.equal(layout.auto,false);
}
assert.equal(dartsLayout({count:9,auto:'true'}).count,4);
assert.equal(dartsLayout({auto:'true'}).auto,false);
assert.equal(dartsLayout({auto:true}).auto,true);
assert.equal(dartsLayout(null).selected.length,4);
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
assert.match(html,/https:\/\/musik\.clubiq\.party\//);
assert.match(html,/id="activityPanel"/);
assert.match(html,/Teams anzeigen/);
assert.match(html,/id="matchCenterGrid"/);
assert.match(html,/id="todayPanel"/);
assert.match(html,/id="leaguePanel"/);
assert.match(html,/data-league="kl04"/);
assert.match(html,/data-league="kk11"/);
assert.match(html,/Barver A · B · C/);
assert.match(html,/Barver D/);
assert.match(html,/id="favoriteTeam"/);
assert.match(html,/id="themeToggle"/);
assert.match(html,/id="pushToggle"/);
assert.match(html,/Push aktivieren/);
assert.match(html,/role="switch"/);
assert.match(html,/id="sponsorTop"/);
assert.match(html,/id="sponsorInline"/);
assert.doesNotMatch(html,/<iframe|https:\/\/portal[^" ]+\.js/,'external content is opt-in');
const script = fs.readFileSync('static/darts.js','utf8');
assert.match(fs.readFileSync('static/darts.css','utf8'),/sv-barver-darts-tight\.png/);
assert.match(fs.readFileSync('static/darts.css','utf8'),/data-theme="dark"/);
assert.match(script,/function renderMatchCenter\(data\)/);
assert.match(script,/fetch\('\/static\/darts-sponsors\.json'/);
assert.match(script,/Notification\.requestPermission\(\)/);
assert.match(script,/\/api\/v1\/darts\/push\/subscribe/);
assert.doesNotMatch(script,/\/api\/v1\/music\/.*command/,'darts view does not control music');
assert.match(script,/fetch\('\/api\/v1\/darts\/ticker'/);
assert.match(script,/\/api\/v1\/darts\/center\?league=/);
assert.match(script,/https:\/\/portal\.3k-darts\.com\/frontend\/events\/5\/mandant\/1931/);
assert.match(fs.readFileSync('sw.js','utf8'),/"\/darts"/);
assert.match(fs.readFileSync('sw.js','utf8'),/addEventListener\("push"/);
const backend = fs.readFileSync('main.py','utf8');
assert.match(backend,/DARTS_PUBLIC_HOST = "barverdarts\.clubiq\.party"/);
assert.match(backend,/darts\.html" if is_darts_host\(request\) else "index\.html"/);
assert.match(backend,/@app\.get\("\/api\/v1\/darts\/ticker"\)/);
assert.match(backend,/@app\.get\("\/api\/v1\/darts\/center"\)/);
console.log('Darts: four verified teams, strict links, wrong-league guard, opt-in embedding and no playback writes OK.');
