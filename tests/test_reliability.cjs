const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/reliability.js', 'utf8');

function harness() {
  const timers = new Map(); let id = 0;
  const context = vm.createContext({
    console, AbortController, document:{hidden:false},
    setTimeout(fn, delay) { timers.set(++id, {fn, delay}); return id; },
    clearTimeout(key) { timers.delete(key); },
  });
  const run = code => vm.runInContext(code, context);
  run(source);
  return {timers, run, context};
}

async function testPolling() {
  const {timers,run} = harness();
  run('let calls=0,finish;const poller=createMusicPoller(()=>{calls++;return new Promise(resolve=>finish=resolve);});poller.start();');
  assert.equal([...timers.values()][0].delay, 3000);
  const first = run('poller.refresh()');
  await Promise.resolve();
  const second = run('poller.refresh()');
  assert.equal(first, second, 'focus/online/manual triggers share one request');
  assert.equal(run('calls'), 1);
  run('finish(false)'); await first;
  assert.equal([...timers.values()][0].delay, 6000);
  for (const expected of [12000,24000,30000,30000]) {
    const result=run('poller.refresh()');await Promise.resolve();run('finish(false)');await result;
    assert.equal([...timers.values()][0].delay,expected,'outage polling must back off');
  }
  const recovered=run('poller.refresh()');await Promise.resolve();run('finish(true)');await recovered;
  assert.equal([...timers.values()][0].delay,3000,'successful recovery resets delay');
  const before=run('calls');run('document.hidden=true');await run('poller.refresh()');
  assert.equal(run('calls'),before,'hidden display must not poll');
  run('poller.stop()');assert.equal(timers.size,0);
}

async function testRequests() {
  const {run,context,timers}=harness();
  let calls=0;
  context.fetch=async()=>{calls++;return {ok:false,status:401,json:async()=>({detail:'Bitte anmelden'})};};
  await assert.rejects(run('musicRequestJson("/test")'), error=>error.status===401);
  assert.equal(timers.size,0);
  context.fetch=async()=>({ok:true,status:200,json:async()=>{throw new Error('HTML instead of JSON');}});
  await assert.rejects(run('musicRequestJson("/test")'),/Keine gültige Antwort/);
  context.fetch=async()=>{calls++;throw new Error('Network failed');};
  const before=calls;
  await assert.rejects(run('musicRequestJson("/command",{method:"POST"})'),/Status prüfen/);
  assert.equal(calls,before+1,'never repeat a playback/voting mutation automatically');
  context.fetch=(_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))));
  const timed=run('musicRequestJson("/test",{timeoutMs:50})');
  const timer=[...timers.values()][0];assert.equal(timer.delay,50);timer.fn();
  await assert.rejects(timed,/gerade nicht erreichbar/);
  assert.equal(timers.size,0,'timeout resources must be released');
}

function testPlaybackSummaries() {
  const {run}=harness();
  run(`const connected={speaker:{connected:true},playing:true,volume:70,queue:[{title:'A'},{title:'B'}],current_index:0};`);
  assert.equal(run('musicPlaybackSummary(connected).title'),'Musik läuft');
  assert.match(run('musicPlaybackSummary(connected,true).hint'),/weiterhin laufen/);
  assert.match(run('musicPlaybackSummary({...connected,buffering:true}).title'),/puffert/);
  assert.match(run('musicPlaybackSummary({...connected,buffering:true,buffer_phase:"starting",buffer_seconds:4,buffer_start_seconds:10,buffer_target_seconds:90}).title'),/Startpuffer/);
  assert.match(run('musicBufferText({buffer_seconds:4,buffer_phase:"starting",buffer_start_seconds:10,buffer_target_seconds:90})'),/4 s im Puffer · Startreserve 10 s · Ziel 90 s/);
  assert.match(run('musicBufferText({buffer_seconds:8,buffer_phase:"refilling",buffer_refill_seconds:15,buffer_target_seconds:90})'),/Weiter ab 15 s/);
  assert.match(run('musicBufferText({buffer_seconds:80},true)'),/unbekannt/);
  assert.match(run('musicBufferText({buffer_seconds:null})'),/nicht verfügbar/);
  assert.match(run('musicBufferText({buffer_seconds:NaN})'),/nicht verfügbar/);
  assert.match(run('musicPlaybackSummary({...connected,paused:true,buffering:true}).title'),/pausiert/);
  assert.equal(run('musicCanPause({playing:false,buffering:true,paused:false})'),true);
  assert.equal(run('musicCanPause({playing:false,buffering:true,paused:true})'),false);
  assert.equal(run('musicCanPause({loading:true,paused:true})'),false);
  assert.match(run('musicPlaybackSummary({...connected,muted:true}).title'),/ausgeschaltet/);
  assert.match(run('musicPlaybackSummary({...connected,speaker:null}).title'),/Keine Box/);
  assert.match(run('musicPlaybackSummary({...connected,last_error:"Fehler"}).hint'),/Fehler/);
  assert.match(run('musicNextTrack(connected)'),/Als Nächstes: B/);
  assert.match(run('musicNextTrack({...connected,repeat:"one"})'),/Wiederholung: A/);
  assert.match(run('musicNextTrack({...connected,current_index:1})'),/Letzter Titel/);
  assert.match(run('musicNextTrack({...connected,current_index:1,repeat:"all"})'),/Als Nächstes: A/);
  assert.match(run('musicNextTrack({...connected,shuffle:true})'),/Zufallsmodus/);
  assert.match(run('musicNextTrack({...connected,source_mode:"radio"})'),/Live-Radio/);
}

(async()=>{await testPolling();await testRequests();testPlaybackSummaries();console.log('Reliability: bounded requests, no duplicate writes, serial polling/backoff and playback summaries OK');})()
  .catch(error=>{console.error(error);process.exitCode=1;});
