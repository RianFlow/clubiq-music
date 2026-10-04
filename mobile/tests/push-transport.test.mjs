import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPushTransport,deviceSecret} from '../src/push-transport.js';
test('random per-device capability is 256 bits and never shared',()=>{
  const first=deviceSecret(),second=deviceSecret();assert.match(first,/^[a-f0-9]{64}$/);assert.notEqual(first,second);
});
test('registration persists identity before request and carries exact filters',async()=>{
  const calls=[],identity={secret:'a'.repeat(64)},transport=createPushTransport({identity,selection:()=>({teams:['B'],players:['Jannik'],eventTypes:['180']}),saveIdentity:async i=>calls.push(['saved',i.token]),request:async(method,url,data)=>{calls.push([method,url,data]);return method==='GET'?{available:true}:{ok:true};}});
  assert.equal(transport.configured,false);await transport.config();await transport.subscribe({platform:'android',token:'test-token'});
  assert.equal(transport.configured,true);assert.deepEqual(calls[1],['saved','test-token']);assert.deepEqual(calls[2][2],{platform:'android',token:'test-token',deviceSecret:'a'.repeat(64),teams:['B'],players:['Jannik'],eventTypes:['180']});
  await transport.test({platform:'android',token:'test-token'});await transport.unsubscribe({platform:'android',token:'test-token'});assert.equal(identity.token,null);
  assert(calls.filter(c=>c[0]==='POST').every(c=>c[1].startsWith('https://barverdarts.clubiq.party/api/v1/darts/push/native/')));
});
test('failed ownership storage never sends a registration',async()=>{
  let sent=false;const transport=createPushTransport({identity:{secret:'a'.repeat(64)},selection:()=>({}),saveIdentity:async()=>{throw Error('storage denied');},request:async()=>{sent=true;}});
  await assert.rejects(transport.subscribe({platform:'android',token:'token'}));assert.equal(sent,false);
});
