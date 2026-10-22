import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import timers from 'node:timers/promises';
import { createAPI } from '../api-request.mjs';
const config={base_url:'https://fixture.invalid/v1',model:'fixture-model',api_key:'fixture-private-key',budget:1,pricing:{input_per_million:.05,cached_input_per_million:.005,output_per_million:.25}};
const details={method:'POST',url:config.base_url+'/responses',data:JSON.stringify({model:config.model,reasoning:{effort:'medium'},store:false,input:'fixture question',max_output_tokens:128})};
const limited=()=>new Response(JSON.stringify({error:{type:'rate_limit_error',message:'All available accounts are currently rate-limited. Please retry later.'}}),{status:429,headers:{'Retry-After':'0'}});
const success=()=>new Response(JSON.stringify({model:config.model,status:'completed',usage:{input_tokens:1,output_tokens:1},output:[]}),{status:200});
const interrupted=(type='TimeoutError')=>{
 let sent=false;
 return new Response(new ReadableStream({pull(controller){
  if(!sent){sent=true;controller.enqueue(new TextEncoder().encode(': ok\n\n'));}
  else controller.error(new DOMException('fixture response interrupted',type));
 }}));
};
async function advanceRecovery(t,operation){
 let settled=false;
 const result=operation.then(value=>({value}),error=>({error}));result.then(()=>settled=true);
 const deadline=Date.now()+3000;
 while(!settled&&Date.now()<deadline){await new Promise(setImmediate);t.mock.timers.tick(1000);}
 assert(settled,'managed recovery must finish without user intervention');
 return result;
}
async function setup(t,fetcher){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-api-recovery-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {api:createAPI(config,dir,fetcher),ledger:async()=>JSON.parse(await fs.readFile(path.join(dir,'course-123.json'),'utf8'))};}
test('a managed rate-limited task waits and recovers within budget while retaining the unknown reservation',async t=>{
 let calls=0;const {api,ledger}=await setup(t,async()=>++calls===1?limited():success());
 assert.equal((await api('123',details,async()=>true)).status,200);
 assert.equal(calls,2);const d=await ledger();assert.equal(d.requests.length,2);assert.equal(d.requests[0].status,'unknown');assert(d.requests[0].reserved_nanos>0);assert.equal(d.requests[1].status,'known');
});
test('persistent managed rate limits stop after three attempts without erasing reservations',async t=>{
 let calls=0;const {api,ledger}=await setup(t,async()=>{calls++;return limited();});
 await assert.rejects(api('123',details,async()=>true),/HTTP 429.*已自动重试 2 次/);assert.equal(calls,3);const d=await ledger();assert.equal(d.requests.length,3);assert(d.requests.every(e=>e.status==='unknown'&&e.reserved_nanos>0));
});
test('cancelling after a rate-limited attempt sends nothing else and cannot claim the call was never sent',async t=>{
 let calls=0,active=true;const {api,ledger}=await setup(t,async()=>{calls++;active=false;return limited();});
 await assert.rejects(api('123',details,async()=>active),e=>/HTTP 429/.test(e.message)&&!e.notSent);assert.equal(calls,1);assert((await ledger()).requests[0].reserved_nanos>0);
});
test('quota errors and long Retry-After responses cannot create an automatic retry loop',async t=>{
 for(const [message,retry] of [['Insufficient quota','0'],['All accounts are rate-limited','600']]){
  let calls=0;const {api}=await setup(t,async()=>{calls++;return new Response(JSON.stringify({error:{type:'rate_limit_error',message}}),{status:429,headers:{'Retry-After':retry}});});
  await assert.rejects(api('123',details,async()=>true),/HTTP 429/);assert.equal(calls,1);
 }
});

test('a retry rechecks the remaining budget before sending another request',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-api-recovery-budget-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const local={...config};let calls=0;
 const api=createAPI(local,dir,async()=>{calls++;const d=JSON.parse(await fs.readFile(path.join(dir,'course-123.json'),'utf8'));local.budget=d.requests[0].reserved_nanos*1.5/1e9;return limited();});
 await assert.rejects(api('123',details,async()=>true),/预算不足/);assert.equal(calls,1);
 const ledger=JSON.parse(await fs.readFile(path.join(dir,'course-123.json'),'utf8'));assert.equal(ledger.requests.length,1);assert(ledger.requests[0].reserved_nanos>0);
});

test('Retry-After is respected and cancellation during that wait prevents another paid request',async t=>{
 let calls=0,active=true;const start=Date.now();
 const {api}=await setup(t,async()=>{calls++;setTimeout(()=>active=false,20);return new Response(JSON.stringify({error:{type:'rate_limit_error',message:'Too many requests'}}),{status:429,headers:{'Retry-After':'1'}});});
 await assert.rejects(api('123',details,async()=>active),e=>/HTTP 429/.test(e.message)&&!e.notSent);
 assert(Date.now()-start>=900);assert.equal(calls,1);await api.idle();
});

test('a managed HTTP 200 stream timeout recovers without pausing or erasing its unknown charge',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let calls=0;
 const {api,ledger}=await setup(t,async()=>++calls>1?success():interrupted());
 const outcome=await advanceRecovery(t,api('123',details,async()=>true));assert.ifError(outcome.error);assert.equal(outcome.value.status,200);
 assert.equal(calls,2);
 const d=await ledger();assert.equal(d.requests.length,2);assert.equal(d.requests[0].status,'unknown');assert.equal(d.requests[0].response_bytes,6);assert(d.requests[0].reserved_nanos>0);assert.equal(d.requests[1].status,'known');assert.deepEqual(d.requests[1].resumed_unknown_requests,[d.requests[0].id]);
 assert.equal((await api('123',details,async()=>true)).status,200,'the next task can continue after a successful recovery');
});

test('persistent stream interruptions exhaust two retries and do not grant another recovery cycle',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const {api,ledger}=await setup(t,async()=>{calls++;return interrupted();});
 const outcome=await advanceRecovery(t,api('123',details,async()=>true));assert.match(outcome.error.message,/HTTP 200.*已自动补跑 2 次/);assert.equal(calls,3);
 const d=await ledger();assert.equal(d.requests.length,3);assert(d.requests.every(r=>r.status==='unknown'&&r.reserved_nanos>0));assert.equal(d.requests[0].response_bytes,6);
 await assert.rejects(api('123',details,async()=>true),/上次请求费用未知/);assert.equal(calls,3);
});

test('pausing during stream recovery backoff prevents another paid dispatch',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,active=true;
 const {api,ledger}=await setup(t,async()=>{calls++;setTimeout(()=>active=false,100);return interrupted();});
 const outcome=await advanceRecovery(t,api('123',details,async()=>active));assert.match(outcome.error.message,/HTTP 200/);assert(!outcome.error.notSent);assert.equal(calls,1);assert((await ledger()).requests[0].reserved_nanos>0);
});

test('stream recovery rechecks its budget and never retries malformed or unmetered responses',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-stream-budget-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let calls=0;const local={...config};
 const api=createAPI(local,dir,async()=>{calls++;const d=JSON.parse(await fs.readFile(path.join(dir,'course-123.json'),'utf8'));local.budget=d.requests[0].reserved_nanos*1.5/1e9;return interrupted();});
 const outcome=await advanceRecovery(t,api('123',details,async()=>true));assert.match(outcome.error.message,/预算不足/);assert.equal(calls,1);
 for(const body of ['not a response',JSON.stringify({model:config.model,status:'completed',output:[]})]){
  let sent=0;const {api}=await setup(t,async()=>{sent++;return new Response(body);});await assert.rejects(api('123',details,async()=>true),/费用未知/);assert.equal(sent,1);
 }
});

test('unmanaged stream timeouts stay blocked while a live managed network interruption can recover',async t=>{
 let calls=0;const single=await setup(t,async()=>{calls++;return interrupted();});await assert.rejects(single.api('123',details),/HTTP 200/);assert.equal(calls,1);
 t.mock.timers.enable({apis:['setTimeout']});let sent=0;const managed=await setup(t,async()=>++sent===1?interrupted('TypeError'):success());
 const outcome=await advanceRecovery(t,managed.api('123',details,async()=>true));assert.ifError(outcome.error);assert.equal(outcome.value.status,200);assert.equal(sent,2);
});

test('an earlier rate limit does not skip the first ten-second stream recovery delay',async t=>{
 const waits=[];t.mock.method(timers,'setTimeout',async ms=>{waits.push(ms);});let calls=0;
 const {api}=await setup(t,async()=>++calls===1?limited():calls===2?interrupted():success());
 assert.equal((await api('123',details,async()=>true)).status,200);assert.equal(calls,3);assert.deepEqual(waits,[0,10000]);
});
