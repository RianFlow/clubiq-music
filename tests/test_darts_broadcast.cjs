const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { module: { exports: {} }, window: { localStorage: { getItem: () => null, setItem: () => {} } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/darts-broadcast.js'), 'utf8'), context);
const broadcast = context.module.exports;

const base = { matchId: 123, team: 'SV Barver Darts B', player: 'Robin Tiedemann' };
const profiles = [
  {name:'Robin Tiedemann',team:'B',image:'/pics/players/robin-tiedemann-cutout.webp'},
  {name:'Jörg Renzelmann',team:'B',image:'/pics/players/joerg-renzelmann-cutout.webp'},
  {name:'Max Lowak',team:'B',image:'/pics/players/max-lowak-cutout.webp'},
];

test('victories use existing single and double portraits, including unambiguous 3K initials', () => {
  const win = {...base,type:'game',gameId:2,barverWon:true};
  assert.equal(broadcast.winnerPortraits(win,profiles).map(p=>p.name).join('|'),'Robin Tiedemann');
  assert.equal(broadcast.winnerPortraits({...win,player:'R. Tiedemann & J. Renzelmann'},profiles).map(p=>p.name).join('|'),'Robin Tiedemann|Jörg Renzelmann');
  assert.equal(broadcast.winnerPortraits({...win,player:'Jorg Renzelmann'},profiles)[0].image,profiles[1].image);
  assert.equal(broadcast.winnerPortraits({...base,type:'leg',gameId:2,legCount:1,winnerSide:'away',barverSide:'away'},profiles).length,1);
});

test('missing photos, ambiguous initials, opponents and losses do not show an incorrect portrait', () => {
  const win = {...base,type:'game',gameId:2,barverWon:true};
  const ambiguous = [...profiles,{name:'Ralf Tiedemann',team:'B',image:'/pics/players/ralf.webp'}];
  assert.equal(broadcast.winnerPortraits({...win,player:'R. Tiedemann'},ambiguous).length,0);
  assert.equal(broadcast.winnerPortraits({...win,player:'Unbekannt & Max Lowak'},profiles).map(p=>p.name).join('|'),'Max Lowak');
  assert.equal(broadcast.winnerPortraits({...win,barverWon:false},profiles).length,0);
  assert.equal(broadcast.winnerPortraits({...win,team:'Gäste'},profiles).length,0);
  assert.equal(broadcast.winnerPortraits(win,[{...profiles[0],team:'A'}]).length,0);
  for (const image of ['', 'https://example.org/portrait.png', '/pics/players/../other.png']) {
    assert.equal(broadcast.winnerPortraits(win,[{...profiles[0],image}]).length,0);
  }
  broadcast.configure({profiles});
  assert.equal(broadcast.winnerPortraits(win).length,1);
});

test('authenticity accepts verified losses but rejects unverified events and unrelated teams', () => {
  assert.equal(broadcast.authentic({ ...base, type: 'leg', gameId: 2, legCount: 1, winnerSide: 'home', barverSide: 'away' }), false);
  assert.equal(broadcast.authentic({ ...base, type: 'leg', gameId: 2, legCount: 1, winnerSide: 'away', barverSide: 'away' }), true);
  assert.equal(broadcast.authentic({ ...base, type: 'game', gameId: 2, barverWon: false }), true);
  assert.equal(broadcast.authentic({ ...base, type: 'leg', gameId: 2, legCount: 1, winnerSide: 'home', barverSide: 'away', barverWon: false }), true);
  assert.equal(broadcast.graphic({ ...base, type: 'game', gameId: 2, barverWon: false }).label, 'PARTIE VERLOREN');
  assert.equal(broadcast.authentic({ ...base, type: 'short_leg', gameId: 2, legCount: 1, darts: 15 }), false);
  assert.equal(broadcast.authentic({ ...base, type: 'short_leg', gameId: 2, legCount: 1, darts: 15, barverWon: true }), true);
  assert.equal(broadcast.authentic({ ...base, team: 'Gastverein', type: '180', value: 180, count: 1 }), false);
});

test('SSE and center performance identities deduplicate on verified public facts', () => {
  const sse = { ...base, type: '180', value: 180, count: 2, performanceId: 'board-1:180:2', event_id: 'a' };
  const report = { ...base, type: '180', value: 180, count: 2, performanceId: 4521 };
  assert.equal(broadcast.eventKey(sse), broadcast.eventKey(report));
  assert.notEqual(broadcast.eventKey(sse), broadcast.eventKey({ ...report, count: 3 }));
});

test('roster presents captain, deputy, then remaining players by name', () => {
  const players = broadcast.orderedPlayers([
    { name: 'Zed', role: 'Spieler' },
    { name: 'Deputy', role: 'Stellvertretender Kapitän' },
    { name: 'Captain', role: 'Kapitän' },
    { name: 'Adam', role: 'Spieler' },
  ]);
  assert.deepEqual(players.map(player => player.name), ['Captain', 'Deputy', 'Adam', 'Zed']);
});

test('first feed is a quiet baseline and subsequent new events enqueue once', () => {
  const event = { ...base, type: 'high_finish', value: 121, count: 1 };
  assert.equal(broadcast.ingest([event], { baseline: true }), 0);
  assert.equal(broadcast.ingest([event], { baseline: false }), 0);
  assert.equal(broadcast.ingest([{ ...event, value: 135 }], { baseline: false }), 1);
  assert.equal(broadcast.ingest([{ ...event, value: 135 }], { baseline: false }), 0);
});
