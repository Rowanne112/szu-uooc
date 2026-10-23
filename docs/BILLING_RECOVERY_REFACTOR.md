# local.33 费用恢复重构

## 关于项目使用的说明

本项目是我出于编程学习与技术探索开发的个人项目，仅供学习交流与经授权的安全研究。

我不鼓励任何利用脚本代替本人完成课程学习、测验、签到等违反学校及平台规定的行为，也不支持将本项目用于此类用途。

如发现平台安全问题，请通过学校及平台的正式渠道反馈；希望学校与平台持续完善安全机制、及时修复相关问题。

请大家遵守学校及课程平台的相关规定，合理使用技术。

2026-10-22。修复服务检测成功、继续课程或重启后仍被历史费用记录永久拦截的问题。

## 证据与边界

现场诊断为 local.31、Windows x64、Edge、chat/deepseek-flash。15:41:35（北京时间）发生 connecting/TypeError，没有 HTTP 状态；随后六次检测完成和四次课程运行器重连仍暂停。原始附件没有该请求的实际账单、用量或响应，首次连接异常的底层原因仍不确定。

同一回归在原 local.32 中仅通过 1/5：它已特判无 HTTP 状态，但进程退出遗留 pending、恢复许可丢失及并发恢复仍有缺口。

## 结构与行为

- `api-ledger.mjs` 统一课程账本验证、金额合计、预算、串行、跨进程锁及恢复记录；`api-request.mjs` 负责协议、请求与原有有限自动重试。
- 财务状态与恢复许可分离。历史请求和未知费用完整预留不变；人工继续追加当前请求 ID 的恢复快照，重启后仍有效。新失败需要新一次继续。
- 同进程恢复等待同课程请求结算；另一进程使用 SQLite 系统排他锁。退出自动释放锁，活动请求不会被当作遗留请求重放。JSON 仍是费用记录，SQLite 仅用作锁。
- 课程控制器只有收到显式 `--resume-billing` 或人工 resume 命令时才认可历史请求。重开程序、服务检测和页面自动恢复不提供人工许可。
- 检测的协议回退只认可本次检测运行中已拒绝的候选请求，不能修改课程账本。保留已发布的 120 秒单次检测、12 秒目录检测及 $0.02/六调用限制。
- 控制台和诊断使用同一费用摘要。历史 pending 获批后仍待核对；只有当前解题中的未认可 pending 才显示处理中。鉴权、预算、账本损坏和计量超限保留各自提示。

## 回归命令

源码测试需要 Node.js 24 及 `app/package-lock.json` 固定的 Playwright。首次准备依赖与 Chromium 后，在仓库根目录运行；已有浏览器可通过 `SZU_UOOC_CHROME` 或 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定可执行文件。

```sh
npm ci --prefix app
(cd app && npx playwright install chromium)
node --test app/tests/billing-recovery.test.mjs app/tests/billing-controller-recovery.test.mjs app/tests/billing-console-recovery.test.mjs app/tests/api-ledger.test.mjs app/tests/service-detection-recovery.test.mjs
node --test --test-concurrency=2 app/tests/*.test.mjs app/tests/*.test.cjs
python3 app/tests/test_student_install.py /absolute/path/ShenYiShua.zip
```

真实进程退出、双进程活动锁、重启许可、新失败阻断、真实控制器与本机模拟课程的单次测验提交均已覆盖；不把模拟课程通过视为反馈人的真实课程已完成。

## 反馈人验收

退出旧程序，完整解压 local.33 到新文件夹，双击启动。保留原设置、进度及费用记录。核对服务商账单后点击原课程「继续」，确认课程不再被同一条历史费用记录拦住；历史待核对金额继续保留属于预期。预算不足、损坏账本或计量超限仍会阻断。

未在反馈人的 Windows 电脑和真实课程验收，未核实该未知请求的实际扣费。继续可能产生新的请求费用。正式安装包和版本信息见 GitHub Releases。
