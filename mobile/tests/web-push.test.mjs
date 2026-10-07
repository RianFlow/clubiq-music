import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWebPush,vapidKey} from '../src/web-push.js';
function fixture(){
  const requests=[],statuses=[];let subscribed=0,removed=0,fail=false;
  const subscription={endpoint:'https://example.invalid/test-only',toJSON:()=>({endpoint:'https://example.invalid/test-only',keys:{auth:'fixture',p256dh:'fixture'}}),unsubscribe:async()=>{removed++;return true;}};
  const selection={teams:['A'],players:['Test Spieler'],eventTypes:['game','player_start']};
  const api=createWebPush({registration:{pushManager:{getSubscription:async()=>subscription,subscribe:async()=>{subscribed++;return subscription;}}},request:async(method,path,payload)=>{requests.push({method,path,payload});if(fail&&method==='POST')throw Error('offline');return method==='GET'?{available:true,publicKey:'AQID',eventTypes:['game','player_start']}:{ok:true};},selection:()=>selection,onStatus:status=>statuses.push(status),notifications:{permission:'granted'}});
  return {api,requests,statuses,selection,get subscribed(){return subscribed;},get removed(){return removed;},fail:value=>{fail=value;}};
}
test('restoring a disabled app never prompts or silently subscribes',async()=>{const f=fixture();await f.api.config();await f.api.restore(false);assert.equal(f.subscribed,0);assert.equal(f.requests.filter(r=>r.method==='POST').length,0);assert.equal(f.api.enabled,false);});
test('user enable and changed filters register once, unchanged foreground checks do not post',async()=>{const f=fixture();await f.api.config();await f.api.enable();await f.api.sync();assert.equal(f.subscribed,1);assert.deepEqual(f.requests[1].payload.eventTypes,['game','player_start']);assert.equal(f.requests.length,2);f.selection.teams=['B'];await f.api.sync();assert.equal(f.requests.length,3);assert.equal(f.statuses.at(-1),'active');});
test('failed server unsubscribe retains subscription so the user can retry',async()=>{const f=fixture();await f.api.config();await f.api.enable();f.fail(true);await assert.rejects(f.api.disable(),/offline/);assert.equal(f.api.enabled,true);assert.equal(f.removed,0);f.fail(false);await f.api.disable();assert.equal(f.removed,1);assert.equal(f.api.enabled,false);assert.equal(f.requests.at(-1).path,'unsubscribe');});
test('a failed registration retries without a second permission prompt',async()=>{const f=fixture();await f.api.config();f.fail(true);await assert.rejects(f.api.enable(),/offline/);assert.equal(f.api.enabled,true);f.fail(false);await f.api.restore(true);assert.equal(f.subscribed,1);assert.equal(f.statuses.at(-1),'active');});
test('web VAPID conversion preserves bytes',()=>assert.deepEqual([...vapidKey('AQID')],[1,2,3]));
