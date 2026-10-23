# 控制台精简验收 · 2026-10-20

## 关于项目使用的说明

本项目是我出于编程学习与技术探索开发的个人项目，仅供学习交流与经授权的安全研究。

我不鼓励任何利用脚本代替本人完成课程学习、测验、签到等违反学校及平台规定的行为，也不支持将本项目用于此类用途。

如发现平台安全问题，请通过学校及平台的正式渠道反馈；希望学校与平台持续完善安全机制、及时修复相关问题。

请大家遵守学校及课程平台的相关规定，合理使用技术。

对应用户要求：删除非必要解释，精简前端并打磨整体体验。保留既有中文系统字体、浅底白面与蓝色动作，一次运行一门课程。

## 交付范围

- 首页合并浏览器状态和操作，移除重复副标题；错误缩短为问题与下一步，人工处理可直接打开课程。
- 解题设置直接选择答题方式，模型和报价明细按需展开。检测上限、每课预算、检测预估金额及未知费用状态保持可见，重开设置不隐藏待核对金额。
- 六个原生弹窗使用可滚动正文和固定操作区。保留账号、脚本及交卷确认，修复签到长错误溢出、复选框操作后焦点和学习中切换浏览器的禁用状态。
- 无新依赖、产品图片或运行策略修改。安装包基于 v0.1.15，仅替换 `console.html`、`console.css`、`console.js`、`user-guidance.mjs` 四个前端文件及文件校验；其余运行文件逐字节保持一致。

恢复文案由 52 条、2939 字，调整为 57 条、约 1630 字，总字数减少约 45%；新增精确问题分类，未删除费用记录和人工交卷的保护提醒。

## 验证方法

在独立临时用户目录运行真实本地控制台与 Chromium，通过模拟课程和模拟服务商响应验证。没有使用真实 Key、用户浏览器资料或真实课程写入。

```sh
node --test --test-concurrency=2 tests/*.test.mjs tests/*.test.cjs
node --test --test-concurrency=1 tests/console-polish.test.mjs tests/console-ui.test.mjs tests/console-recovery.test.mjs tests/user-guidance-ui.test.mjs tests/student-start.test.mjs
node --test --test-concurrency=2 tests/api*.test.mjs tests/ark-service.test.mjs tests/service-detection.test.mjs tests/console-detection.test.mjs
```

后两条在最终 ZIP 解包目录运行，测试夹具另行复制，不加入分发 ZIP。覆盖 1440、768、390、320px，六个弹窗底部、内部无横向溢出、原生键盘/Escape、200% 缩放、密码显隐、检测与保存、导入、整课控制和恢复、费用跨次展示、签到焦点及浏览器禁用条件。

## 界面与代码复核

- 独立 finish 首轮四项问题同批修复；限定确认发现的未知检测费重开遗漏已修复并增加重开断言。后续 Spec 复核的预留金额缺口已用统一费用格式修复，复核确认已解决。未开启第三轮审美搜寻。
- Standards：0 项违规。Spec：1 项 P2 费用金额缺口，已修复并限定确认，剩余 0 项。
- 设计检测只运行一次。5 条 dialog 外壳 padding 为 0 的提示是分区滚动布局造成：标题、正文、操作区各自提供 26px／20px 内边距。保留该布局，未添加忽略规则。
- `DESIGN.md` 和 surface brief 记录实际材料；截图仅为示例测试证据，无产品栅格素材。

## 原始证据

- [解包前端与启动验收](evidence/frontend-20261020/package-ui-tests.log)
- [解包 API 回归](evidence/frontend-20261020/package-api-tests.log)
- [ZIP 与 32 项文件校验](evidence/frontend-20261020/package-verification.json)
- [完整工作区首次输出](evidence/frontend-20261020/full-tests.log)
- [控制器失败项单独复测](evidence/frontend-20261020/controller-retry-tests.log)
- [桌面示例](evidence/frontend-20261020/desktop.png)、[手机示例](evidence/frontend-20261020/mobile.png)、[手机设置](evidence/frontend-20261020/settings-mobile.png)

最终解包前端与启动验收 15 项通过，API 回归 40 项通过，32 项文件校验通过。

完整工作区首次结果为 169 通过、4 失败、4 跳过：两项文案期望已对齐并由解包验收复测；另两项为独立控制器测试的导航上下文销毁和浏览器清理重复释放，相关用例单独串行复测 33 项通过、0 失败。保留首次失败输出，没有通过修改控制器或放宽其断言规避失败。

Windows 专用检查在 macOS 跳过。真实 Windows、真实网站验证提交、真实方舟账号余额/权限及付费答题准确率不在本次模拟验收结论内。

## 发布验证

[v0.1.16](https://github.com/zcx28/szu-uooc/releases/tag/v0.1.16) 已发布。从公开 `releases/latest/download/` 实际回下载 ZIP 和 SHA256SUMS，确认均为本次文件；32 项包内校验通过，四个前端文件与源码一致，其余运行文件与 v0.1.15 一致。

SHA-256：`3d3687de71313f893d928b35df217e8aaf292c788c9c35dc50df0f961f3a6a9b`。原始记录见 [最新版回下载验证](evidence/frontend-20261020/latest-verification.json)。
