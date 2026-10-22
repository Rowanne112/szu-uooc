const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('playwright');
const script = fs.readFileSync(__dirname+'/../szu-uooc.user.js','utf8');
const clip = fs.readFileSync(__dirname+'/fixtures/three-seconds.mp4');
const chrome=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:chrome});
 try {
  for(const mode of ['healthy','recover','stalled','inline-single','inline-multi','inline-retained','inline-delayed','inline-wrong-source','inline-missing-answer']) {
   const page=await browser.newPage();const requests=[];
   await page.route('**/*',route=>{const url=new URL(route.request().url());requests.push(url.href);return route.fulfill(url.pathname.endsWith('.mp4')?{contentType:'video/mp4',body:clip}:{contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><video id="player"></video>'});});
   await page.goto('https://www.uooc.net.cn/home/learn/#/123/1/2/500/section');
   await page.evaluate(mode=>{
    const video=document.querySelector('video');const originalNow=Date.now;window.advanceClock=()=>{Date.now=()=>originalNow()+31000};
    const sources=[{id:'500',type:10,finished:'0',name:'第一个视频'}];if(mode==='healthy')sources.push({id:'501',type:10,finished:'0',name:'第二个视频'});
    if(mode==='recover')sources[0].video_url={type:'video/mp4',label:'原画',src:'https://www.uooc.net.cn/fixtures/good.mp4?signature=keep%2Fme'};
    const root={chapterList:[{id:'1',children:[{id:'2',unitSource:sources}]}]},service={getUnitLearn:async()=>sources.map(s=>({...s}))};
    const stateService={params:{courseId:'123',chapterId:'1',sectionId:'2',sourceId:'500'},go:async(_name,params)=>{Object.assign(stateService.params,params);history.replaceState(null,'','/home/learn/#/123/1/2/'+params.sourceId+'/section');video.src='https://www.uooc.net.cn/fixtures/'+params.sourceId+'.mp4';}};
    const injector={get:name=>name==='$rootScope'?root:name==='courseService'?service:name==='$state'?stateService:null};window.angular={element:()=>({injector:()=>injector,scope:()=>root})};window.GM_getValue=(_key,fallback)=>fallback;window.GM_setValue=()=>{};
    video.addEventListener('ended',()=>{sources.find(s=>s.id===stateService.params.sourceId).finished='1'});
    if(mode.startsWith('inline-')) {
     if(['inline-retained','inline-delayed'].includes(mode))Object.defineProperty(video,'playbackRate',{get:()=>1,set:()=>{}});
     const answer=mode==='inline-multi'?['A','C']:['B'];const q={id:'q1',type:mode==='inline-multi'?11:10,answer:JSON.stringify(answer),answered:false};
     if(mode==='inline-missing-answer')delete q.answer;
     sources[0].quiz=[q];root.curSource=mode==='inline-wrong-source'?{id:'999',quiz:[q]}:sources[0];root.curQsource=q;
     const layer=document.createElement('div');layer.id='quizLayer';layer.style.display='none';layer.innerHTML=['A','B','C'].map(v=>`<input type="${mode==='inline-multi'?'checkbox':'radio'}" name="inline" value="${v}">`).join('')+'<button ng-click="sureAnswer(curQsource)">确定</button>';document.body.append(layer);
     const modal=document.createElement('div');modal.className='layui-layer';modal.style.display='none';document.body.append(modal);modal.append(layer);
     let shown=false;window.inlineConfirmations=0;window.inlinePremature=0;
     for(const input of layer.querySelectorAll('input'))input.addEventListener('change',()=>{q.canswer=input.type==='radio'?input.value:Object.fromEntries([...layer.querySelectorAll('input')].map(n=>[n.value,n.checked]));});
     layer.querySelector('button').onclick=()=>{if(!layer.closest('.layui-layer')){window.inlinePremature++;return;}window.inlineConfirmations++;const chosen=[...layer.querySelectorAll('input:checked')].map(n=>n.value);if(JSON.stringify(chosen)===JSON.stringify(answer)){q.answered=true;if(mode==='inline-retained'){document.body.append(layer);modal.remove();}else modal.style.display='none';video.play();}};
     video.addEventListener('timeupdate',()=>{if(!shown&&video.currentTime>=0.5){shown=true;layer.style.display='block';video.pause();if(mode==='inline-delayed'){document.body.append(layer);setTimeout(()=>{modal.append(layer);modal.style.display='block';video.pause();},1200);}else modal.style.display='block';}});
    }
    if(mode==='healthy'||mode.startsWith('inline-'))video.src='https://www.uooc.net.cn/fixtures/500.mp4';
   },mode);
   await page.addScriptTag({content:script});await page.locator('[data-action="course-start"]').click();
   await page.waitForFunction(()=>JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase==='video');
   if(['recover','stalled'].includes(mode))await page.evaluate(()=>window.advanceClock());
   if(mode==='stalled'||['inline-wrong-source','inline-missing-answer'].includes(mode)) {
    await page.waitForFunction(()=>JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase==='paused',{},{timeout:5000});
    const state=JSON.parse(await page.locator('#szu-uooc-course-state').textContent());assert.equal(state.completed,0);assert.match(state.error,mode==='stalled'?/停滞/:/小测/);if(mode.startsWith('inline-'))assert.equal(await page.evaluate(()=>window.inlineConfirmations),0,'an unbound or unanswered inline quiz must not submit');
   } else {
    await page.waitForFunction(()=>{const video=document.querySelector('video');return video.readyState>=2&&video.currentTime>0.1&&Number.isFinite(video.duration)},null,{timeout:5000});
    await page.waitForFunction(()=>JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase==='complete',null,{timeout:10000});
    const state=JSON.parse(await page.locator('#szu-uooc-course-state').textContent());assert.equal(state.completed,mode==='healthy'?2:1);
    if(mode.startsWith('inline-')){assert.equal(await page.evaluate(()=>window.inlineConfirmations),1,'native inline quiz must confirm once before natural video completion');assert.equal(await page.evaluate(()=>window.inlinePremature),0,'do not confirm a template before its actual modal opens');}
    if(mode==='recover'){assert(requests.some(url=>url.includes('signature=keep%2Fme')));assert(!requests.some(url=>url.includes('/video/mp4')||url.includes('%E5%8E%9F%E7%94%BB')),'MIME and labels must never become media requests');}
   }
   await page.close();
  }
  console.log('原生 MP4 真实播放验收：两段视频自然 ended 并目录确认、停滞切换当前任务的签名线路、无线路时暂停而不假完成、视频内单选/多选原生确认后续播、错误题目/缺少答案不提交。无真实平台或付费请求。');
 } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
