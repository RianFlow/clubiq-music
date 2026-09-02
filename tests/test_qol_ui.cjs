const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
      checked: false, scrollTop: 0, dataset: {}, style: {}, attributes: {}, listeners: {},
      classList: { toggle() {} }, matches: () => false,
      addEventListener(name, handler) { this.listeners[name] = handler; },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelector: child => node(`${selector} ${child}`), querySelectorAll: () => [],
      replaceChildren(...children) { this.children = children; }, focus() {},
      showModal() { this.open = true; },
      close(value) { this.returnValue = value || this.returnValue; this.open = false; this.listeners.close?.(); },
    });
    return nodes.get(selector);
  }
  const context = vm.createContext({
    console, Date, Intl, setTimeout: () => 0, clearTimeout() {}, setInterval() {},
    localStorage: { getItem: () => '' }, sessionStorage: { getItem: () => '' },
    document: { querySelector: node, querySelectorAll: () => [], createElement: () => ({}) },
    window: { confirm: () => false }, navigator: {}, setMediaImage() {},
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync('static/range-control.js', 'utf8'));
  return { node, run, context };
}

async function testRange() {
  const {node, run} = harness();
  run(`let commits=[], resolveCommit, errors=[];
    const range=createRangeControl({input:document.querySelector('#range'),label:document.querySelector('#label'),
      format:value=>value+' %',onError:error=>errors.push(error.message),
      commit:value=>{commits.push(value);return new Promise(resolve=>{resolveCommit=()=>{range.update(value);resolve();};});}});
    range.update(70);`);
  const input = node('#range');
  input.listeners.pointerdown(); input.value = '42'; input.listeners.input();
  run('range.update(70)');
  assert.equal(input.value, 42, 'poll must not move a dragged handle');
  assert.equal(node('#label').textContent, '42 %');
  const saving = input.listeners.change();
  assert.equal(input.attributes['aria-busy'], 'true');
  input.value = '30'; input.listeners.input(); input.listeners.change();
  input.value = '25'; input.listeners.input(); input.listeners.change();
  assert.equal(run('commits.length'), 1, 'only one volume request in flight');
  run('range.update(70); resolveCommit();');
  await Promise.resolve();
  assert.equal(run('commits[1]'), 25, 'coalesce later changes to the newest value');
  assert.equal(input.value, 25, 'old acknowledgement must not erase a new draft');
  run('resolveCommit();'); await saving;
  assert.equal(input.attributes['aria-busy'], 'false');
  assert.equal(input.value, 25);
  run('range.update(31)'); assert.equal(input.value, 31, 'other DJs still update idle controls');
  input.listeners.pointerdown(); input.value = '80'; input.listeners.input();
  input.listeners.pointercancel(); assert.equal(input.value, 31);
  run(`const failed=createRangeControl({input:document.querySelector('#failed'),label:document.querySelector('#failedLabel'),
    format:String,commit:async()=>{throw new Error('offline');},onError:error=>errors.push(error.message)});failed.update(55);`);
  const failed = node('#failed'); failed.value = '10'; failed.listeners.input(); await failed.listeners.change();
  assert.equal(failed.value, 55); assert.equal(run('errors[0]'), 'offline');
}

async function testApp() {
  const {node, run} = harness();
  const source = fs.readFileSync('static/app.js', 'utf8');
  run(source.slice(0, source.indexOf('\nstart();')));
  run(`let messages=[],requests=[];toast=message=>messages.push(message);
    state.member={can_control_player:true};state.token='test-session';state.budget={remaining:2,maximum:10};
    state.displayedCycle=state.activeCycle={id:2,status:'active',name:'Training',max_budget:10,starts_at:new Date(Date.now()-1000).toISOString(),closes_at:new Date(Date.now()+60000).toISOString()};
    state.playlist=[{suggestion_id:1,rank:1,external_id:'aaaaaaaaaaa',title:'Über den Wolken',channel_title:'Müller',my_points:0,total_points:7},
      {suggestion_id:2,rank:2,external_id:'bbbbbbbbbbb',title:'Achterbahn',channel_title:'Helene',my_points:2,total_points:8}];
    state.previousPlaylist={cycle:{name:'Vorwoche'},songs:[...state.playlist,{external_id:'ccccccccccc',title:'Queen & Freunde',channel_title:'Queen'}]};`);
  node('#playlistFilter').value = 'UBER muller'; run('renderPlaylist()');
  assert.match(node('#playlist').innerHTML, /Über den Wolken/);
  assert.doesNotMatch(node('#playlist').innerHTML, /Achterbahn/);
  assert.match(node('#playlistFilterCount').textContent, /1 von 2/);
  node('#playlistFilter').value = '<script>'; run('renderPlaylist()');
  assert.doesNotMatch(node('#playlist').innerHTML, /<script>/);
  assert.match(node('#playlist').innerHTML, /Kein passender/);
  node('#previousOnlyNew').checked = true; run('renderPreviousPlaylist()');
  assert.match(node('#previousPlaylist').innerHTML, /Queen &amp; Freunde/);
  assert.match(node('#previousPlaylist').innerHTML, /data-reuse-song="2"/);
  assert.doesNotMatch(node('#previousPlaylist').innerHTML, /Über den Wolken/);
  assert.equal(run('state.playlist.length'), 2, 'filter must not change voting data');
  run(`state.player={queue:[{title:'Erster',artist:'A'},{title:'Zweiter',artist:'B'}],current_index:1,volume:81};`);
  node('#queueFilter').value = 'Zweiter'; run('renderPlayerQueue()');
  assert.match(node('#playerQueue').innerHTML, /<span>2<\/span>/);
  node('#playerQueue').scrollTop = 123; const queueHtml = node('#playerQueue').innerHTML;
  run('renderPlayerQueue()'); assert.equal(node('#playerQueue').innerHTML, queueHtml);
  assert.equal(node('#playerQueue').scrollTop, 123);
  // Refuse replacement before contacting the backend, including repeat clicks.
  run('api=async path=>{requests.push(path);return {};};');
  const replacement = run('queueRanking()');
  assert.equal(node('#queueConfirmDialog').open, true);
  assert.match(node('#queueConfirmText').textContent, /2 Songs/);
  await run('queueRanking()');
  assert.equal(run('requests.length'), 0);
  node('#queueConfirmDialog').close('cancel'); await replacement;
  assert.equal(run('requests.length'), 0);
  const confirmed = run('confirmQueueReplacement(state.displayedCycle)');
  node('#queueConfirmDialog').close('replace'); assert.equal(await confirmed,true);
  // Transient failures preserve the last queue and volume, and block commands.
  run('api=async()=>{throw new Error("offline")};'); await run('loadPlayerState(true)');
  assert.equal(run('state.player.volume'), 81); assert.equal(run('state.player.queue.length'), 2);
  assert.equal(run('playerStale'), true); assert.match(node('#playerPlaybackStatus').textContent, /Letzter bekannter/);
  await run('playerCommand("play")'); assert.match(run('messages.at(-1)'), /wieder erreichbar/);
  // Ignore a slow poll arriving after a newer command acknowledgement.
  run(`playerStale=false;let resolvePoll;api=async(path,options)=>options?.method==='POST'
    ? {...state.player,volume:35}:new Promise(resolve=>{resolvePoll=resolve;});`);
  const poll = run('loadPlayerState()'); await run('playerCommand("volume",35)');
  run('resolvePoll({volume:81,queue:[]});'); await poll;
  assert.equal(run('state.player.volume'), 35); assert.equal(run('state.player.queue.length'), 2);
  // Only one voting change is submitted, even with a second click elsewhere.
  run(`let resolveVote; requests=[]; renderSession=()=>{};loadPlaylist=async()=>{};
    api=async(path,options)=>{requests.push(path);return new Promise(resolve=>{resolveVote=resolve;});};`);
  const vote = run('changeVote(1,1)'); await run('changeVote(2,1)');
  assert.equal(run('requests.length'), 1); assert.equal(run('votePending'), true);
  assert.match(run('songCard(state.playlist[0])'), /data-vote="1"[^>]*disabled/);
  run('resolveVote({budget_remaining:1});'); await vote;
  assert.equal(run('votePending'), false); assert.equal(run('state.budget.remaining'), 1);
  run('state.budget.remaining=0;'); await run('changeVote(1,1)');
  assert.equal(run('requests.length'), 1);
}

async function testRemote() {
  const {node,run}=harness();
  run(fs.readFileSync('static/remote.js','utf8'));
  run(`player={volume:67,position:30,duration:200,queue:[{title:'Song'}],current_index:0};stale=false;render();`);
  node('#remoteVolume').listeners.pointerdown(); node('#remoteVolume').value='20'; node('#remoteVolume').listeners.input();
  run('render()'); assert.equal(node('#remoteVolume').value,20);
  run('api=async()=>{throw new Error("offline")};'); await run('refresh(true)');
  assert.equal(run('player.volume'),67); assert.equal(run('player.queue.length'),1);
  assert.equal(node('#remoteVolume').disabled,true);
  assert.match(node('#remoteStatus').textContent,/letzter bekannter Stand/);
}

(async()=>{await testRange();await testApp();await testRemote();console.log('QoL UI: filters, volume drafts, serialized changes, stale state, voting and queue guard OK');})()
  .catch(error=>{console.error(error);process.exitCode=1;});
