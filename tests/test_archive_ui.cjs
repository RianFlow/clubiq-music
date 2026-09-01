// Run actual UI functions in an isolated DOM harness, without starting the app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nodes = new Map();
function node(selector) {
  if (!nodes.has(selector)) nodes.set(selector, {
    textContent: '', innerHTML: '', hidden: false, disabled: false,
    dataset: {}, style: {}, querySelectorAll: () => [],
  });
  return nodes.get(selector);
}
const context = vm.createContext({
  console, Date, Intl,
  localStorage: { getItem: () => '' }, sessionStorage: { getItem: () => '' },
  document: { querySelector: node, querySelectorAll: () => [] },
});
const source = fs.readFileSync('static/app.js', 'utf8');
vm.runInContext(source.slice(0, source.indexOf('\nstart();')), context);
const run = code => vm.runInContext(code, context);

async function test() {
  run(`
    const now = Date.now();
    const closed = {id: 1, name: 'Vereinsabend <alt>', status: 'closed', starts_at: new Date(now-200000).toISOString(), closes_at: new Date(now-100000).toISOString()};
    const active = {id: 2, name: 'Aktuell', status: 'active', starts_at: new Date(now-10000).toISOString(), closes_at: new Date(now+100000).toISOString(), max_budget: 10};
    const planned = {id: 3, name: 'Morgen', status: 'planned', starts_at: new Date(now+200000).toISOString(), closes_at: new Date(now+300000).toISOString()};
    const song = {suggestion_id: 10, title: 'Archivsong', rank: 1, total_points: 7, my_points: 3};
    let cycles = [planned, active, closed];
    let requests = [];
    let messages = [];
    api = async (path, options) => {
      requests.push(path);
      if (path.endsWith('/cycles')) return {cycles};
      if (path.endsWith('/playlist')) return {playlist: [song]};
      return {queue: [song], playlist_build: {total: 1}};
    };
    toast = message => messages.push(message);
    renderPlayer = () => {};
    setTab = () => {};
  `);
  await run('loadCycles()');
  assert.equal(run('state.displayedCycle.id'), 2);
  assert.equal(run('canVoteInDisplayedCycle()'), true);
  assert.match(node('#cycleSelect').innerHTML, /Abgeschlossene Abstimmungen/);
  assert.match(node('#cycleSelect').innerHTML, /&lt;alt&gt;/);
  // Once this voting ends, stay on exactly that list, even with a new active one.
  run(`active.status = 'closed'; cycles = [{...planned, status: 'active', starts_at: new Date(now-1000).toISOString()}, active, closed];`);
  await run('loadCycles()');
  assert.equal(run('state.displayedCycle.id'), 2);
  assert.equal(run('state.activeCycle.id'), 3);
  assert.equal(run('canVoteInDisplayedCycle()'), false);
  assert.equal(node('#budgetCard').hidden, true);
  await run('selectCycle(1)');
  assert.equal(run('requests.at(-1)'), '/api/v1/music/cycles/1/playlist');
  assert.match(node('#playlist').innerHTML, /Archivsong/);
  assert.match(node('#playlistSummary').textContent, /Endergebnis/);
  assert.doesNotMatch(run('songCard(song)'), /data-vote|data-login-to-vote/);
  run('state.member = {can_control_player: true};');
  assert.doesNotMatch(run('songCard(song)'), /data-vote/);
  await run('queueRanking()');
  assert.equal(run('requests.at(-1)'), '/api/v1/music/player/queue/cycles/1');
  assert.match(run('messages.at(-1)'), /Vereinsabend/);
  // A slow response for an older selection must not overwrite the chosen list.
  run('let resolveOld; api = () => new Promise(resolve => {resolveOld = resolve;});');
  const pending = run('loadPlaylist()');
  run('state.displayedCycle = active; state.playlist = []; resolveOld({playlist: [song]});');
  await pending;
  assert.equal(run('state.playlist.length'), 0);
  // No active voting: newest archived list is the default, ahead of future events.
  run('state.selectedCycleId = null; cycles = [planned, active, closed]; api = async () => ({cycles});');
  await run('loadCycles()');
  assert.equal(run('state.displayedCycle.id'), 2);
  // Planned cycles and users without DJ rights never submit a queue command.
  run('state.displayedCycle = planned; requests = []; api = async path => requests.push(path);');
  await run('queueRanking()');
  assert.equal(run('requests.length'), 0);
  run('state.displayedCycle = closed; state.member.can_control_player = false;');
  await run('queueRanking()');
  assert.equal(run('requests.length'), 0);
  console.log('Archive UI: selection, expiry, read-only voting, selected queue and race guards OK');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
