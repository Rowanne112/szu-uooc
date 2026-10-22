import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { diagnosticReport, diagnosticZip } from '../student/diagnostics.mjs';
import { createConsole } from '../student/console-server.mjs';
import { appDir, courseURL, fixtureWorker, session } from './console-fixtures.mjs';
const unpack = file => JSON.parse(execFileSync('python3',['-c',"import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.namelist()==['diagnostic.json']; print(z.read('diagnostic.json').decode())",file],{encoding:'utf8'}));

test('billing diagnostics distinguish acknowledged reservations from a new unresolved request without exposing IDs or prices', async t => {
 const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-billing-diagnostics-'));
 t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
 await fs.mkdir(path.join(dataDir, 'ledger'));
 const first = { id: 'private-request-A', status: 'pending', reserved_nanos: 7900000 };
 const ledger = { courseId: '123', model: 'fixture', requests: [first], recoveries: [{ id: 'private-recovery', at: '2026-10-22T08:00:00.000Z', mode: 'manual', request_ids: [first.id] }] };
 const file = path.join(dataDir, 'ledger/course-123.json');
 await fs.writeFile(file, JSON.stringify(ledger));
 const options = { appDir, dataDir, courses: [{ id: '123' }], logs: [], browser: {}, environment: {}, config: {} };
 let report = await diagnosticReport(options);
 assert.deepEqual(report.courses[0].billing, { readable: true, requests: 1, pending: 1, unresolved_requests: 0, recovery_required: false, metering_bound_exceeded: false });
 ledger.requests.push({ id: 'private-request-B', status: 'unknown', reserved_nanos: 7000000 });
 await fs.writeFile(file, JSON.stringify(ledger));
 report = await diagnosticReport(options);
 assert.equal(report.courses[0].billing.unresolved_requests, 1);
 assert.equal(report.courses[0].billing.recovery_required, true);
 for (const secret of ['private-request-A', 'private-request-B', 'private-recovery', '7900000', '7000000']) assert(!JSON.stringify(report).includes(secret));
});

test('connection diagnostics classify current safe API and storage messages using fixed enums',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-connection-diagnostic-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const options={appDir,dataDir:dir,courses:[],logs:[],browser:{},environment:{},config:{}};
 const cases=[
  ['API HTTP 200；响应流提前结束，缺少最终结果；结果或费用未知；保留预留额度，课程暂停','stream_incomplete'],
  ['API HTTP 200；响应格式无法识别；结果或费用未知；保留预留额度，课程暂停','invalid_response'],
  ['API HTTP 200；响应缺少有效用量；结果或费用未知；保留预留额度，课程暂停','invalid_usage'],
  ['API HTTP 200；服务返回错误事件；结果或费用未知；保留预留额度，课程暂停','provider_error'],
  ['API HTTP 200；响应超过大小上限；结果或费用未知；保留预留额度，课程暂停','response_limit'],
  ['检测记录无法读取，请检查本机磁盘空间和目录权限后重新检测。','cache_unreadable'],
  ['检测费用记录不可读，已停止检测。请导出诊断包并联系维护者核对扣费，不要删除费用记录。','ledger_unreadable'],
 ];
 for(const [message,reason] of cases){
  const result=await diagnosticReport({...options,connection:{status:'error',message:message+' private-error-content'}});
  assert.deepEqual(result.service.connection,{status:'error',reason});assert.equal(result.service.detection_failure,null);
  assert(!JSON.stringify(result).includes('private-error-content'));
 }
 assert.deepEqual((await diagnosticReport({...options,connection:{status:'listed',message:'private-list-content'}})).service.connection,{status:'listed'});
});

test('API diagnostic metadata is bounded and strictly allowlisted without ledger identities or provider content',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-api-diagnostic-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.mkdir(path.join(dir,'ledger'));await fs.mkdir(path.join(dir,'detection-ledger'));
 const secret='private-ledger-content',at='2026-10-21T12:55:48.753Z';
 const entry={at,status:'unknown',purpose:'course',http_status:200,response_bytes:1234,failure_stage:'decoding',failure_type:'Error',failure_code:'stream_incomplete',not_sent:false,metering_bound_exceeded:false,
  id:secret,model:secret,api_key:secret,url:'https://private.example/'+secret,request:secret,response:secret,question:secret,answer:secret,cost_nanos:99999999,usage:{input_tokens:123},provider_error:{type:secret,code:secret,reason:secret,message:secret}};
 await fs.writeFile(path.join(dir,'ledger/course-123.json'),JSON.stringify({id:secret,requests:Array.from({length:12},(_,i)=>({...entry,response_bytes:i}))}));
 await fs.writeFile(path.join(dir,'ledger/course-456.json'),'{broken');
 await fs.writeFile(path.join(dir,'outside.json'),JSON.stringify({requests:[entry]}));await fs.symlink(path.join(dir,'outside.json'),path.join(dir,'ledger/course-789.json'));
 await fs.writeFile(path.join(dir,'detection-ledger/course-1.json'),JSON.stringify({requests:[{...entry,purpose:'connection_test',response_bytes:1}]}));
 await fs.writeFile(path.join(dir,'detection-ledger/course-2.json'),JSON.stringify({requests:[{...entry,purpose:'connection_test',response_bytes:2}]}));
 await fs.writeFile(path.join(dir,'detection-ledger/course-3.json'),'{broken');
 await fs.symlink(path.join(dir,'outside.json'),path.join(dir,'detection-ledger/course-4.json'));
 const options={appDir,dataDir:dir,courses:[{id:'123'},{id:'456'},{id:'789'},{id:'987'}],logs:[],browser:{},environment:{},config:{},connection:{status:'error',message:'Responses 流缺少最终结果；'+secret,other:secret}};
 const result=await diagnosticReport(options);
 assert.equal(result.courses[0].api_requests.length,10);assert.equal(result.courses[0].api_requests[0].response_bytes,2);
 assert.deepEqual(result.courses[0].api_requests.at(-1),{at,status:'unknown',purpose:'course',http_status:200,response_bytes:11,failure_stage:'decoding',failure_type:'Error',failure_code:'stream_incomplete',not_sent:false,metering_bound_exceeded:false});
 for(const course of result.courses.slice(1)) assert.deepEqual(course.api_requests,[],'missing, corrupt and symlinked ledgers are excluded');
 assert.deepEqual(result.service.connection,{status:'error',reason:'stream_incomplete'});
 assert.equal(result.service.detection_failure.response_bytes,2);assert.equal(result.service.detection_failure.purpose,'connection_test');
 const serialized=JSON.stringify(result);for(const forbidden of [secret,'private.example','provider_error','cost_nanos','usage','input_tokens']) assert(!serialized.includes(forbidden),forbidden);
 const invalid={at:secret,status:secret,purpose:secret,failure_stage:secret,failure_type:secret,failure_code:secret,http_status:200.5,response_bytes:-1,not_sent:secret,metering_bound_exceeded:secret};
 await fs.writeFile(path.join(dir,'ledger/course-123.json'),JSON.stringify({requests:[null,secret,invalid]}));
 const invalidResult=await diagnosticReport({...options,connection:{status:secret,message:secret}});
 assert.deepEqual(invalidResult.courses[0].api_requests,[{}]);assert.deepEqual(invalidResult.service.connection,{});assert(!JSON.stringify(invalidResult).includes(secret));
 await fs.rm(path.join(dir,'detection-ledger'),{recursive:true});
 assert.equal((await diagnosticReport(options)).service.detection_failure,null);
 await fs.symlink(path.join(dir,'ledger'),path.join(dir,'detection-ledger'));
 assert.equal((await diagnosticReport(options)).service.detection_failure,null,'symlinked detection directories are excluded');
 await fs.writeFile(path.join(dir,'ledger/course-123.json'),JSON.stringify({requests:[entry],padding:'x'.repeat(131072)}));
 assert.deepEqual((await diagnosticReport(options)).courses[0].api_requests,[],'oversized ledgers are omitted rather than partially parsed');
 await fs.rm(path.join(dir,'ledger'),{recursive:true});await fs.mkdir(path.join(dir,'outside-ledger'));await fs.writeFile(path.join(dir,'outside-ledger/course-123.json'),JSON.stringify({requests:[entry]}));
 await fs.symlink(path.join(dir,'outside-ledger'),path.join(dir,'ledger'));
 assert.deepEqual((await diagnosticReport(options)).courses[0].api_requests,[],'symlinked ledger directories are excluded');
});

test('allowlisted diagnostics remove credentials, course identity and content, handle absent/corrupt evidence and create a real ZIP',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-diagnostic-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const evidence=path.join(dir,'evidence/course-123');await fs.mkdir(evidence,{recursive:true});
 const secret='fixture-secret-key',token='fixture-session-token',csrf='fixture-csrf-token';
 const raw=`${secret} ${token} ${csrf} 私密课名 私密课时 ${courseURL('123')} /Users/private-person/file C:\\Users\\private-person\\file Cookie: auth=private-cookie\nAuthorization: Bearer sensitive-bearer\ntoken=unusual-credential\nquestion: private-question\nanswers: private-answer\nprivate@mail.example.com`;
 await fs.writeFile(path.join(evidence,'state.json'),JSON.stringify({phase:'video',active:true,completed:6,total:7,lockedUnits:42,heartbeatAt:1234567890000,recoveryReason:raw,api_key:secret,question:'private-question',url:courseURL('123'),sourceId:'987654321'}));
 await fs.writeFile(path.join(evidence,'recovery.jsonl'),JSON.stringify({at:'2026-10-19T12:00:00Z',event:'retry',attempt:2,reason:raw,secret})+'\nbroken\n');
 await fs.mkdir(path.join(dir,'evidence/course-456'));await fs.writeFile(path.join(dir,'evidence/course-456/state.json'),'{broken');
 const options={appDir,dataDir:dir,courses:[{id:'123',name:'私密课名',currentTitle:'私密课时',url:courseURL('123'),status:'running',completed:6,total:7,error:raw},{id:'456',status:'paused'}],logs:[{at:'2026-10-19T12:00:00Z',courseId:'123',message:raw}],browser:{kind:'chrome',status:'connected',profileDirectory:'/Users/private-person'},environment:{status:'ready'},config:{api_key:secret,answer_mode:'free',fingerprint:'private-fingerprint'},secrets:[token,csrf]};
 const result=await diagnosticReport(options),s=JSON.stringify(result);
 for(const forbidden of [secret,token,csrf,'私密课名','私密课时','private-person','private-cookie','sensitive-bearer','unusual-credential','private-question','private-answer','private@mail','private-fingerprint',courseURL('123'),'987654321']) assert(!s.includes(forbidden),forbidden);
 assert.equal(result.courses[0].evidence.lockedUnits,42);assert.equal(result.courses[0].evidence.heartbeatAt,1234567890000);assert.equal(result.logs[0].course,'course-1');assert.equal(result.courses[1].evidence,null);
 await fs.unlink(path.join(evidence,'state.json'));await fs.symlink(path.join(dir,'outside-private.json'),path.join(evidence,'state.json'));await fs.writeFile(path.join(dir,'outside-private.json'),JSON.stringify({phase:'private-phase'}));
 assert.equal((await diagnosticReport(options)).courses[0].evidence,null,'symlinked evidence is excluded');
 const file=path.join(dir,'result.zip');await fs.writeFile(file,await diagnosticZip(options));assert.equal(unpack(file).format_version,1);
});

test('authenticated ZIP download works during learning and UI failures remain retryable',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-diagnostic-ui-')),children=[];
 const app=await createConsole({appDir,dataDir:dir,checkDependencies:async()=>true,spawnController:fixtureWorker(children)});
 const require=createRequire(import.meta.url),{chromium}=require('playwright');
 const browser=await chromium.launch({headless:true,executablePath:process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()});
 t.after(async()=>{await browser.close();await app.close();await fs.rm(dir,{recursive:true,force:true});});
 const client=await session(app);await client.post('/api/config',{answer_mode:'free'});await client.post('/api/courses',{url:courseURL('123')});await client.post('/api/course-action',{id:'123',action:'start'});
 assert.equal((await fetch(app.origin+'/api/diagnostics',{method:'POST'})).status,401);
 assert.equal((await fetch(app.origin+'/api/diagnostics',{method:'POST',headers:{Cookie:client.cookie,Origin:'https://evil.test','Content-Type':'application/json','X-Szu-Token':client.csrf},body:'{}'})).status,403);
 const page=await browser.newPage();await page.goto(app.url);await page.getByRole('button',{name:'设置',exact:true}).click();
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'导出诊断包',exact:true}).click();const download=await downloading;
 assert.match(download.suggestedFilename(),/^ShenYiShua-diagnostics-.*\.zip$/);const file=path.join(dir,'ui.zip');await download.saveAs(file);const report=unpack(file);assert.equal(report.courses[0].status,'running');assert.deepEqual(report.service.connection,{status:'untested'});
 assert.equal((await client.get()).activeId,'123');assert.equal(children.length,1);assert.equal(children[0].state.active,true);
 const images=path.resolve('dist/evidence/diagnostics');await fs.mkdir(images,{recursive:true});await page.screenshot({path:path.join(images,'export-button.png')});
 await page.route('**/api/diagnostics',route=>route.fulfill({status:400,json:{error:'诊断包生成失败，请重试。'}}));await page.getByRole('button',{name:'导出诊断包',exact:true}).click();await page.locator('#diagnostics-error').filter({hasText:/诊断包生成失败/}).waitFor();assert(await page.getByRole('button',{name:'导出诊断包',exact:true}).isEnabled());
 await page.unroute('**/api/diagnostics');const retry=page.waitForEvent('download');await page.getByRole('button',{name:'导出诊断包',exact:true}).click();await retry;assert.equal((await client.get()).activeId,'123');
});
