// Run actual UI functions in an isolated DOM harness, without starting the app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nodes = new Map();
function node(selector) {
  if (!nodes.has(selector)) nodes.set(selector, {
    textContent: '', innerHTML: '', hidden: false, disabled: false,
    dataset: {}, style: {}, querySelectorAll: () => [],
    replaceChildren(...children) { this.children = children; },
  });
  return nodes.get(selector);
}
const context = vm.createContext({
  console, Date, Intl,
  localStorage: { getItem: () => '' }, sessionStorage: { getItem: () => '' },
  document: { querySelector: node, querySelectorAll: () => [], createElement: () => ({}) },
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
      if (path.endsWith('/previous-playlist')) return {cycle: closed, songs: []};
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
  assert.equal(run('state.playlistCycle.id'), 1, 'results default to the latest closed round');
  assert.doesNotMatch(node('#cycleSelect').innerHTML, /Morgen/, 'future votings are not playlists yet');
  // Voting follows the new round, while the independently selected archive stays.
  run(`active.status = 'closed'; cycles = [{...planned, status: 'active', starts_at: new Date(now-1000).toISOString()}, active, closed];`);
  await run('loadCycles()');
  assert.equal(run('state.displayedCycle.id'), 3);
  assert.equal(run('state.activeCycle.id'), 3);
  assert.equal(run('state.playlistCycle.id'), 1);
  assert.equal(run('canVoteInDisplayedCycle()'), true);
  assert.equal(node('#budgetCard').hidden, false);
  await run('selectCycle(1)');
  assert.equal(run('requests.at(-1)'), '/api/v1/music/cycles/1/playlist');
  assert.match(node('#resultSongs').innerHTML, /Archivsong/);
  assert.equal(node('#resultPhase').textContent, 'Abgeschlossen');
  assert.doesNotMatch(node('#resultSongs').innerHTML, /data-vote|data-login-to-vote/);
  assert.equal(run('state.displayedCycle.id'), 3, 'archive selection never moves voting');
  run('state.member = {can_control_player: true};');
  assert.doesNotMatch(run('songCard(song, false, true)'), /data-vote/);
  await run('queueRanking()');
  assert.equal(run('requests.at(-1)'), '/api/v1/music/player/queue/cycles/1');
  assert.match(run('messages.at(-1)'), /Vereinsabend/);
  // A slow response for an older selection must not overwrite the chosen list.
  run('let resolveOld; api = path => path.endsWith("/previous-playlist") ? Promise.resolve({cycle: null, songs: []}) : new Promise(resolve => {resolveOld = resolve;});');
  const pending = run('loadResults()');
  run('state.playlistCycle = active; state.resultSongs = []; resolveOld({playlist: [song]});');
  await pending;
  assert.equal(run('state.resultSongs.length'), 0);
  // No active voting: voting shows the next start, playlists default to newest archive.
  run('state.selectedPlaylistCycleId = null; cycles = [planned, active, closed]; api = async () => ({cycles});');
  await run('loadCycles()');
  assert.equal(run('state.displayedCycle.id'), 3);
  assert.equal(run('state.playlistCycle.id'), 2);
  assert.equal(node('#budgetCard').hidden, true);
  assert.equal(node('#openSuggest').disabled, true);
  // Planned cycles and users without DJ rights never submit a queue command.
  run('state.playlistCycle = planned; requests = []; api = async path => requests.push(path);');
  await run('queueRanking()');
  assert.equal(run('requests.length'), 0);
  // Preview uses only a user-started local iframe, never the shared player API.
  run('requests = []; previewVideoId = "aaaaaaaaaaa"; startPreview();');
  const frame = node('#previewFrame').children[0];
  assert.match(frame.src, /^https:\/\/www.youtube-nocookie.com\/embed\/aaaaaaaaaaa\?/);
  assert.match(frame.src, /end=30/);
  assert.equal(frame.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal(run('requests.length'), 0);
  assert.equal(run('previewButton({external_id: "bad-id", title: "Test"})'), '');
  // Previous songs are visible and can be proposed, but never carry old votes.
  run(`state.displayedCycle = {...active, status:'active'}; state.activeCycle = state.displayedCycle;
       state.playlist = []; state.previousPlaylist = {cycle: closed, songs:[{external_id:'aaaaaaaaaaa', title:'Voriger Song'}]}; renderPreviousPlaylist();`);
  assert.equal(node('#previousPlaylistPanel').hidden, false);
  assert.match(node('#previousPlaylist').innerHTML, /Voriger Song/);
  assert.match(node('#previousPlaylist').innerHTML, /Wieder vorschlagen/);
  // Reconnect addresses only a saved device, without discovery or pairing calls.
  run(`state.member.can_control_player = true; state.savedSpeakers = [{address:'02:11:22:33:44:55'}];
       api = async path => {requests.push(path); return {};}; loadPlayerState = async () => {};`);
  node('#savedSpeakerSelect').value = '02:11:22:33:44:55';
  await run('reconnectSpeaker()');
  assert.equal(run('requests.at(-1)'), '/api/v1/music/player/bluetooth/reconnect');
  assert.equal(run('requests.some(path => path.endsWith("/scan") || path.endsWith("/connect"))'), false);
  run('requests = [];');
  run('state.displayedCycle = closed; state.member.can_control_player = false;');
  await run('queueRanking()');
  assert.equal(run('requests.length'), 0);
  console.log('Archive UI: selection, expiry, read-only voting, selected queue and race guards OK');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
