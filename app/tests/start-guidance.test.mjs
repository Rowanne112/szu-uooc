import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const run=promisify(execFile);
const student=fileURLToPath(new URL('../student/',import.meta.url));

test('download failure keeps the technical cause in a local file and tells the user how to start again',{skip:process.platform!=='darwin'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'szu-download-guide-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'app/student'),{recursive:true});for(const name of ['install-mac.sh','network-mac.sh'])await fs.copyFile(path.join(student,name),path.join(root,'app/student',name));
 const stubs=path.join(root,'stubs');await fs.mkdir(stubs);await fs.writeFile(path.join(stubs,'curl'),'#!/bin/bash\necho "curl: HTTP 503 ECONNRESET" >&2\nexit 22\n',{mode:0o700});
 const result=await run('/bin/bash',[path.join(root,'app/student/install-mac.sh'),'--node-only'],{env:{...process.env,PATH:stubs+':'+process.env.PATH}}).then(()=>assert.fail('must fail'),error=>error);
 assert.equal(result.code,22);const output=result.stdout+result.stderr;assert.match(output,/确认电脑能打开网页.*启动-Mac.command/);assert(!/HTTP|ECONN|curl:/.test(output));
 assert.match(await fs.readFile(path.join(root,'runtime/install-error.log'),'utf8'),/HTTP 503/);assert.equal((await fs.stat(path.join(root,'runtime/install-error.log'))).mode&0o777,0o600);
 assert.deepEqual((await fs.readdir(path.join(root,'runtime'))).filter(name=>name.startsWith('.')),[],'failure cleans download lock and scratch directory');
});

test('Mac installer recovers from the reported DNS timeout using a verified mirror download',{skip:process.platform!=='darwin'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'szu-dns-fallback-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'app/student'),{recursive:true});for(const name of ['install-mac.sh','network-mac.sh'])await fs.copyFile(path.join(student,name),path.join(root,'app/student',name));
 const arch=process.arch==='arm64'?'arm64':'x64',folder='node-v24.21.0-darwin-'+arch,filename=folder+'.tar.gz';
 const fixture=path.join(root,'fixture'),archive=path.join(root,filename);await fs.mkdir(path.join(fixture,folder,'bin'),{recursive:true});
 await fs.writeFile(path.join(fixture,folder,'bin/node'),'#!/bin/bash\necho v24.21.0\n',{mode:0o700});
 await fs.mkdir(path.join(fixture,folder,'lib/node_modules/npm/bin'),{recursive:true});await fs.writeFile(path.join(fixture,folder,'lib/node_modules/npm/bin/npm-cli.js'),'fixture');
 await run('/usr/bin/tar',['-czf',archive,'-C',fixture,folder]);
 const checksum=createHash('sha256').update(await fs.readFile(archive)).digest('hex');await fs.writeFile(path.join(root,'依赖校验.sha256'),checksum+'  '+filename+'\n');
 const stubs=path.join(root,'stubs'),requests=path.join(root,'requests');await fs.mkdir(stubs);
 await fs.writeFile(path.join(stubs,'curl'),`#!/bin/bash
while [ "$#" -gt 0 ]; do
 case "$1" in https://*) url="$1" ;; -o) shift; output="$1" ;; esac
 shift
done
printf '%s\\n' "$url" >> "$SZU_TEST_REQUESTS"
case "$url" in
 https://nodejs.org/*) echo 'curl: (28) Resolving timed out' >&2; exit 28 ;;
 https://cdn.npmmirror.com/binaries/node/*) cp "$SZU_TEST_ARCHIVE" "$output" ;;
 *) exit 2 ;;
esac
`,{mode:0o700});
 const env={...process.env,PATH:stubs+':'+process.env.PATH,SZU_TEST_REQUESTS:requests,SZU_TEST_ARCHIVE:archive};
 const result=await run('/bin/bash',[path.join(root,'app/student/install-mac.sh'),'--node-only'],{env});
 assert.match(result.stdout,/自动.*(?:切换|换).*下载地址/);assert.match(result.stdout,/运行环境准备完成/);
 assert.deepEqual((await fs.readFile(requests,'utf8')).trim().split('\n'),['https://nodejs.org/dist/v24.21.0/'+filename,'https://cdn.npmmirror.com/binaries/node/v24.21.0/'+filename]);
 assert.match(await fs.readFile(path.join(root,'runtime/install-error.log'),'utf8'),/Resolving timed out/);
 assert.equal((await run(path.join(root,'runtime/mac-'+arch+'/bin/node'),['--version'])).stdout.trim(),'v24.21.0');
 await fs.rm(path.join(root,'runtime/mac-'+arch),{recursive:true,force:true});await fs.writeFile(archive,'corrupted archive');
 const failed=await run('/bin/bash',[path.join(root,'app/student/install-mac.sh'),'--node-only'],{env}).then(()=>assert.fail('corrupt mirror download must fail'),error=>error);
 assert.notEqual(failed.code,0);await assert.rejects(fs.stat(path.join(root,'runtime/mac-'+arch)),{code:'ENOENT'});
 assert.deepEqual((await fs.readdir(path.join(root,'runtime'))).filter(name=>name.startsWith('.')),[],'failed downloads clean the lock and scratch directory');
});

test('an incomplete package gives extraction steps instead of a Node stack trace',{skip:process.platform!=='darwin'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'szu-start-guide-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'app/student'),{recursive:true});
 for(const file of ['install-mac.sh','network-mac.sh','start.mjs'])await fs.copyFile(path.join(student,file),path.join(root,'app/student',file));
 await fs.copyFile(fileURLToPath(new URL('../../启动-Mac.command',import.meta.url)),path.join(root,'启动-Mac.command'));
 const runtime=path.join(root,'runtime/mac-'+(process.arch==='arm64'?'arm64':'x64')+'/bin');await fs.mkdir(runtime,{recursive:true});await fs.symlink(process.execPath,path.join(runtime,'node'));
 const result=await run('/bin/bash',[path.join(root,'启动-Mac.command')]).then(()=>assert.fail('must fail'),error=>error);
 assert.equal(result.code,1);assert.match(result.stdout+result.stderr,/完整解压安装包.*启动-Mac.command/);assert(!/ERR_MODULE|node:internal|Error:/.test(result.stdout+result.stderr));
 assert.match(await fs.readFile(path.join(root,'runtime/console.log'),'utf8'),/ERR_MODULE_NOT_FOUND/);
});
