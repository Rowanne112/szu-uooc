import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createConsole} from '../student/console-server.mjs';
import {explainProblem,activityMessage} from '../student/user-guidance.mjs';
import {appDir,courseURL} from './console-fixtures.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const executablePath=process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();

test('the reported ambiguous AI answer preserves progress and gives quiz recovery steps in course help and logs',async t=>{
 const error='AI答案无法唯一匹配选项文本';
 const logs=['15:06:20 已暂停 已读任务 86/87（17 个目录单元待解锁） [已隐藏] — '+error,'任务 [编号已隐藏]：已暂停；'+error];
 const expected=/答案.*无法.*对应.*选项.*继续.*手动完成当前测验并提交.*继续/;
 assert.match(explainProblem(error),expected);
 for(const message of logs)assert.match(activityMessage(message),expected,message);
 const invalidIndexError='AI选项序号无效，已暂停';
 assert.match(explainProblem(invalidIndexError),expected);
 for(const message of logs)assert.match(activityMessage(message.replace(error,invalidIndexError)),expected,message);
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-quiz-guidance-ui-'));
 const app=await createConsole({appDir,dataDir,checkDependencies:async()=>true});
 const browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 t.after(async()=>{await browser.close();await app.close();await fs.rm(dataDir,{recursive:true,force:true});});
 const state=structuredClone(await app.state());state.environment={status:'ready'};state.browser={...state.browser,status:'connected',catalog:'ready',selectionRequired:false,kind:'edge',name:'Edge'};state.config={...state.config,hasKey:true,answer_mode:'ai'};state.activeIds=['123'];
 state.courses=[{id:'123',name:'测试课程',url:courseURL('123'),status:'paused',statusLabel:'已暂停',phase:'paused',phaseLabel:'已暂停',error,completed:86,total:87,lockedUnits:17,currentTitle:'[已隐藏]',costs:{spent:0,reserved:0},checkin:{enabled:false,label:'未加入签到'}}];
 state.logs=logs.map(message=>({at:'2026-10-20T07:06:20Z',message}));
 await page.route('**/api/state',route=>route.fulfill({json:state}));await page.goto(app.url);
 const row=page.locator('.course-row[data-id="123"]');await row.waitFor();
 assert.match(await row.locator('.course-help').innerText(),expected);
 assert.match(await row.innerText(),/86 \/ 87.*17 个目录单元待解锁/s);
 assert.equal(await row.getByRole('button',{name:'继续',exact:true}).count(),1);
 await row.locator('summary').click();assert.equal(await row.getByRole('button',{name:'切到课程',exact:true}).count(),1);
 const renderedLogs=await page.locator('#log-list li').allTextContents();assert.equal(renderedLogs.length,2);for(const message of renderedLogs)assert.match(message,expected);
 assert.doesNotMatch(await page.locator('body').innerText(),/重新双击|启动文件/);
 await row.locator('summary').click();const evidence=path.resolve('../dist/bugfix-2026-10-20');await fs.mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,'quiz-guidance.png'),fullPage:true});
 state.courses[0].error=invalidIndexError;state.logs=logs.map(message=>({at:'2026-10-20T07:06:20Z',message:message.replace(error,invalidIndexError)}));await page.reload();await row.waitFor();assert.match(await row.locator('.course-help').innerText(),expected);for(const message of await page.locator('#log-list li').allTextContents())assert.match(message,expected);
 state.activeIds=[];await page.reload();await row.waitFor();await row.locator('summary').click();assert.equal(await row.locator('.course-menu').getByRole('button',{name:'打开课程',exact:true}).count(),1);assert.equal(await row.locator('.course-help').getByRole('button',{name:'打开课程',exact:true}).count(),1);
});

test('a paused course tells beginners where to act and keeps technical diagnostics out of its page',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-guidance-ui-'));
 const app=await createConsole({appDir,dataDir,checkDependencies:async()=>true,browserOptions:{discoverBrowser:async({kind})=>({kind,available:true,installed:true,profiles:[]})}});
 const browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 t.after(async()=>{await browser.close();await app.close();await fs.rm(dataDir,{recursive:true,force:true});});
 const state=structuredClone(await app.state());state.environment={status:'ready',message:'已准备好'};state.browser={...state.browser,status:'connected',catalog:'ready',selectionRequired:false,kind:'edge',name:'Edge'};state.config={...state.config,hasKey:true,answer_mode:'ai'};state.activeIds=['123'];
 const error='解题服务响应连续中断（HTTP 200），已自动补跑 2 次；课程已暂停。费用预留已保留。';
 state.courses=[{id:'123',name:'测试课程',url:courseURL('123'),status:'paused',statusLabel:'已暂停',phase:'paused',phaseLabel:'已暂停',error,completed:1,total:2,currentTitle:'第一节',costs:{spent:.0001,reserved:.0009,unknown:true},checkin:{enabled:false,url:courseURL('123'),label:'未加入签到'}}];
 state.logs=[{at:new Date().toISOString(),message:error}];
 await page.route('**/api/state',route=>route.fulfill({json:state}));await page.goto(app.url);
 const row=page.locator('.course-row[data-id="123"]');await row.waitFor();
 await row.locator('.course-help').waitFor({timeout:2000});
 assert.match(await row.locator('.course-help').innerText(),/账单/);
 assert.match(await row.locator('.course-help').innerText(),/继续/);
 assert.equal(await row.getByRole('button',{name:'继续',exact:true}).count(),1);
 assert(!/HTTP|usage|预留|账本/.test(await page.locator('body').innerText()));
 Object.assign(state.courses[0],{error:'用户暂停',completed:6,total:7,lockedUnits:42});
 await page.reload();await row.waitFor();
 assert.match(await row.innerText(),/已读取任务/,'a partial catalog count must not be presented as total course hours');
 assert.match(await row.innerText(),/42 个目录单元待解锁/);
 assert.equal(await row.locator('progress').count(),0,'a partial catalog must not show an overall percentage');
 await page.setViewportSize({width:390,height:844});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'partial catalog explanations fit on mobile');
});

test('settings, browser, costs, quizzes, check-in and unfamiliar failures all give persistent next steps',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'szu-guidance-ui-'));
 const app=await createConsole({appDir,dataDir,checkDependencies:async()=>true});
 const browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 t.after(async()=>{await browser.close();await app.close();await fs.rm(dataDir,{recursive:true,force:true});});
 const state=structuredClone(await app.state());state.environment={status:'ready'};state.browser={...state.browser,status:'connected',catalog:'ready',selectionRequired:false,kind:'edge',name:'Edge'};state.config={...state.config,hasKey:true};state.activeIds=[];
 const course={id:'123',name:'测试课程',url:courseURL('123'),status:'error',statusLabel:'需要处理',currentTitle:'第一节',costs:{spent:0,reserved:0},checkin:{enabled:false,label:'未加入签到'}};state.courses=[course];state.logs=[];
 await page.route('**/api/state',route=>route.fulfill({json:state}));
 const cases=[
 ['连接已中断，请检查 Edge 登录、调试开关和授权后重试。',/设置.*重新连接 Edge.*开启调试.*允许/],
 ['请在 Edge 登录并打开「我的课程」，再读取。',/登录.*刷新课程/],
 ['Key 不可用，请检查后重新保存。',/重新复制完整 Key.*设置 → 解题服务.*检测并保存/],
 ['每门课预算应大于 0 且不超过 $1.00。',/最多 1 美元.*检测并保存/],
 ['课程预算不足',/查看.*费用.*免费答题.*可能答错/],
 ['费用账本结构异常',/不要删除.*导出诊断包/],
 ['API 费用未知，缺少 usage',/查看账单.*继续/],
 ['交卷结果尚未确认 pendingSubmit',/查看上次测验是否已经提交.*不要重复交卷/],
 ['请填写支持 Responses 接口和 medium 推理的模型名称。',/更换模型.*检测并保存/],
 ['API HTTP 503',/暂不可用.*检测并保存/],
 ['答案与原生选项 ID 不匹配',/手动完成当前测验并提交.*继续/],
 ['试卷尚未加载',/题目显示完整.*继续/],
 ['需要网站验证',/去验证.*保持页面打开/],
 ['后续章节尚未发布',/等老师开放.*继续/],
 ['闯关任务锁定',/上一节视频和测验.*任课老师/],
 ['视频停滞，未确认完成',/视频能否正常播放.*继续/],
 ['签到配置或记录不可读 JSON',/手动签到.*不要删除记录/],
 ['请选择浏览器资料 Profile 2',/Edge.*头像.*同名资料/],
 ['下载组件失败 ECONNRESET',/重新下载.*完整解压/],
 ['请先保存签到设置并确认浏览器资料和脚本。',/选择资料.*测试账号.*更新脚本.*停用旧版.*保存/],
 ['请确认浏览器中是同一个课程账号。',/每日签到.*测试打开.*核对账号.*勾选确认.*保存/],
 ['请先选择浏览器资料，并确认已更新或暂停旧版自动学习脚本。',/选择资料.*测试账号.*更新脚本.*停用旧版.*保存/],
 ['请确认两个浏览器使用同一个课程账号。',/两个浏览器.*同一课程账号.*勾选确认/],
 ['签到打开失败：上次打开过程被中断，请查看浏览器后手动补开。',/核对签到页.*未打开.*补开.*避免重复/],
 ['签到打开失败：当前无法连接课程网站，5 分钟后重试。',/检查网络.*保持程序运行.*补开签到页面/],
 ['Unhandled ENOENT /Users/private/start.mjs',/重试.*导出诊断包/],
 ];
 for(const [error,expected] of cases){course.error=error;state.logs=[{at:new Date().toISOString(),message:error}];await page.goto(app.url);const help=page.locator('.course-help');await help.waitFor();assert.match(await help.innerText(),expected,error);assert(!/HTTP|usage|JSON|ECONN|ENOENT|\/Users\/|原生选项|Responses|medium/.test(await page.locator('body').innerText()),error);}
 await page.route('**/api/course-action',route=>route.fulfill({status:400,json:{error:'Unhandled ENOENT /Users/private/start.mjs'}}));
 await page.getByRole('button',{name:'继续',exact:true}).click();await page.locator('#action-error').waitFor({state:'visible'});assert.match(await page.locator('#action-error').innerText(),/重试.*导出诊断包/);
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:/^解题服务/}).click();
 await page.route('**/api/detect-save',route=>route.fulfill({json:{connection:{status:'error',message:'Key 无效，请重新复制完整 Key，再点击「检测并保存」。'}}}));
 await page.getByRole('button',{name:'检测并保存',exact:true}).click();await page.locator('#test-result').filter({hasText:'重新复制'}).waitFor();assert.match(await page.locator('#test-result').innerText(),/检测并保存/);
 await page.route('**/api/detect-save',route=>route.fulfill({json:{connection:{status:'error',message:'文字答案格式不符合要求。'},detection:{model:'',profile:null,models:[{id:'fixture-model',pricing:{input_per_million:.1},status:'failed'}],testCosts:{calls:1,estimated_usd:.000001,unknown:false},message:'文字答案格式不符合要求。'}}}));
 await page.getByRole('button',{name:'检测并保存',exact:true}).click();await page.locator('#test-result').filter({hasText:'预估'}).waitFor();
 assert.match(await page.locator('#test-result').innerText(),/模型未通过检测.*本次预估/);assert.equal(await page.locator('[data-service-action="model"]').count(),1);
 assert.match(await page.locator('#detection-cost-note').innerText(),/检测≤\$0\.02.*每课≤\$/);await page.locator('#model-options summary').click();
 assert.match(await page.locator('#price-summary').innerText(),/模型未通过检测.*< \$0.0001/);
 assert(!/付费检测与正式解题均已阻止/.test(await page.locator('#price-summary').innerText()),'failed paid tests must still disclose their cost');
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 course.error=cases[6][0];await page.reload();await page.locator('.course-help').waitFor();
 const evidence=path.resolve('dist/evidence/user-guidance');await fs.mkdir(evidence,{recursive:true});
 await page.screenshot({path:path.join(evidence,'desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(evidence,'mobile.png'),fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile content fits');
 await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.body.style.zoom='2');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'200% zoom content fits');
});
