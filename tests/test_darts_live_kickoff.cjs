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
assert.equal(context.dartsKickoffNeedsRecovery([match(-361)],now),false,'do not treat old fixtures as active');
assert.equal(context.dartsKickoffNeedsRecovery([{...match(-1),kind:'final'}],now),false,'finals do not trigger recovery');
assert.equal(context.dartsKickoffNeedsRecovery([{...match(-1),kind:'live'}],now),false,'existing live state does not need recovery');
assert.equal(context.dartsKickoffNeedsRecovery([{kind:'upcoming',plannedAt:'invalid'}],now),false);
assert.equal(context.dartsKickoffNeedsRecovery(null,now),false);
assert.equal(context.dartsFixturesFresh({fixturesUpdatedAt:new Date(now).toISOString(),fixturesStale:false},now),true,
  'fresh fixtures must not be mistaken for a fresh match score');
console.log('Live kickoff recovery rules passed');
