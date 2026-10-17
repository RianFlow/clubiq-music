// Regression for the stale ticker + current fixtures condition at kickoff.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../static/darts.js'),'utf8');
const context=vm.createContext({});
vm.runInContext(source,context,{filename:'darts.js'});
const now=Date.parse('2026-10-17T19:30:00+02:00');
const match=offset=>({kind:'upcoming',plannedAt:new Date(now+offset*60000).toISOString()});
assert.equal(context.dartsKickoffNeedsRecovery([match(30)],now),false,'do not poll direct 3K all day');
assert.equal(context.dartsKickoffNeedsRecovery([match(14)],now),true,'check before kickoff');
assert.equal(context.dartsKickoffNeedsRecovery([match(0)],now),true,'check at kickoff');
assert.equal(context.dartsKickoffNeedsRecovery([match(-90)],now),true,'check after scheduled start');
assert.equal(context.dartsKickoffNeedsRecovery([{...match(-90),id:1280545,roundId:34275}],now),true,'moved fixture triggers a live recovery regardless of the original 3K round date');
assert.equal(context.dartsKickoffNeedsRecovery([match(-361)],now),false,'do not treat old fixtures as active');
assert.equal(context.dartsKickoffNeedsRecovery([{...match(-1),kind:'final'}],now),false,'finals do not trigger recovery');
assert.equal(context.dartsKickoffNeedsRecovery([{...match(-1),kind:'live'}],now),false,'existing live state does not need recovery');
assert.equal(context.dartsKickoffNeedsRecovery([{kind:'upcoming',plannedAt:'invalid'}],now),false);
assert.equal(context.dartsKickoffNeedsRecovery(null,now),false);
const saved={source:'browser-3k',stale:false,updatedAt:new Date(now-60000).toISOString(),
  items:[{id:1280545,kind:'live',home:"Mad Dog's C",away:'SV Barver Darts A',
    liveVerifiedAt:new Date(now-60000).toISOString(),score:'3:2'}],
  centers:[{barverMatches:[{id:1280545}],pushEvents:[]}]};
const staleTicker={source:'last-known',stale:true,updatedAt:new Date(now-86400000).toISOString(),
  items:[{id:345,kind:'upcoming'}]};
const retained=context.dartsHoldVerifiedLive(staleTicker,saved,now);
assert.equal(retained.items[0].id,1280545,'temporary 3K outage must not reset an active match to countdown');
assert.equal(retained.items[0].liveFeedDelayed,true,'carried scores are explicitly marked delayed');
assert.equal(retained.items[0].score,'3:2');
assert.equal(retained.stale,true);
assert.equal(retained.source,'browser-3k');
assert.equal(retained.centers.length,1,'keep verified board state during fallback interruption');
const recovered={source:'browser-3k',stale:false,updatedAt:new Date(now).toISOString(),
  items:[{id:1280545,kind:'live',score:'5:3',liveVerifiedAt:new Date(now).toISOString()}]};
assert.equal(context.dartsHoldVerifiedLive(recovered,saved,now),recovered,
  'new verified 3K scores immediately replace buffered data');
assert.equal(context.dartsHoldVerifiedLive(staleTicker,saved,now+21*60000),staleTicker,'verification expires after a bounded window');
const officialFinal={...staleTicker,items:[{id:1280545,kind:'final',score:'8:4'}]};
assert.equal(context.dartsHoldVerifiedLive(officialFinal,saved,now),officialFinal,'confirmed finals always win');
const pendingFinal={...staleTicker,items:[{id:1280545,kind:'pending'}]};
assert.equal(context.dartsHoldVerifiedLive(pendingFinal,saved,now),pendingFinal,'do not promote a pending final');

assert.equal(context.dartsFixturesFresh({fixturesUpdatedAt:new Date(now).toISOString(),fixturesStale:false},now),true,
  'fresh fixtures must not be mistaken for a fresh match score');
console.log('Live kickoff recovery rules passed');
