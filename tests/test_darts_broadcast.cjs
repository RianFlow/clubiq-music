const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { module: { exports: {} }, window: { localStorage: { getItem: () => null, setItem: () => {} } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/darts-broadcast.js'), 'utf8'), context);
const broadcast = context.module.exports;

const base = { matchId: 123, team: 'SV Barver Darts B', player: 'Robin Tiedemann' };

test('authenticity rejects opponent legs, unverified short legs, and opponent scores', () => {
  assert.equal(broadcast.authentic({ ...base, type: 'leg', gameId: 2, legCount: 1, winnerSide: 'home', barverSide: 'away' }), false);
  assert.equal(broadcast.authentic({ ...base, type: 'leg', gameId: 2, legCount: 1, winnerSide: 'away', barverSide: 'away' }), true);
  assert.equal(broadcast.authentic({ ...base, type: 'game', gameId: 2, barverWon: false }), false);
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
