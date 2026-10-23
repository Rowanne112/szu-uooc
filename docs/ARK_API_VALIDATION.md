# 火山方舟 API 兼容修复

## 关于项目使用的说明

本项目是我出于编程学习与技术探索开发的个人项目，仅供学习交流与经授权的安全研究。

我不鼓励任何利用脚本代替本人完成课程学习、测验、签到等违反学校及平台规定的行为，也不支持将本项目用于此类用途。

如发现平台安全问题，请通过学校及平台的正式渠道反馈；希望学校与平台持续完善安全机制、及时修复相关问题。

请大家遵守学校及课程平台的相关规定，合理使用技术。

日期：2026-10-20。

复现命令：`node --test app/tests/ark-service.test.mjs`。

修复前，方舟 `/models` 返回标准模型条目但没有自定义美元 `pricing` 字段时，检测直接返回 `blocked`，提示「价格无法核实」，付费调用为 0。原始复现与红灯输出保存在工作区 `dist/ark-fix-20261020/repro-before.log`、`ark-red.log`、`ark-fallback-red.log`。

本次只修改共享 API 协议层、错误转换及服务检测：

- 为方舟北京标准地址补充已核价的豆包 Seed 2.0/2.1 精确版本；中转站同名模型、其他路径、未知模型和自定义接入点不继承官方价格。
- 使用 Chat API，发送 `thinking.type=disabled` 和 `max_completion_tokens`，后者限制回答与思考的总输出，避免仅用 `max_tokens` 导致未预留的思考费用。
- 方舟 `/models` 返回 404/405 时使用已知官方候选；不对鉴权、欠费、网络或其他服务错误启用候选兜底。候选仍须通过真实请求才能标为已验证，未开通模型可以跳过；最多 3 个候选、6 次调用及 $0.02 预算不变。失败请求的费用预留保留。兜底候选排除官方标记即将下线的 260215 版本，但模型列表明确返回这些版本时仍可检测。
- 403 欠费、模型未开通、禁止 Model ID 调用和 429 用量上限分别显示可执行的处理方法。正式课程错误也保留这些提示，未知费用仍按原规则处理。
- 检测版本指纹更新；旧配置保留 Key，启动不自动付费检测，使用者需重新点击「检测并保存」。

定价取常规在线推理的最长上下文单价，人民币按 `6 CNY/USD` 保守折算；不是实时汇率或实际账单。2026-10-20 官方中间价为 `6.7200 CNY/USD`。价格变化或汇率低于 6 时须重新核价。价格说明在控制台的检测推荐理由中显示；未改变原有界面布局。

回归覆盖文字及图片检测、正式课程请求、缓存 token 计费、无列表兜底、跳过未开通模型、错误分类、网络错误、非官方地址不继承价格、未知费用保留及 Key 不落入检测缓存/账本。测试用模拟服务和临时目录，不接触真实课程或个人设置。

发布包基于 v0.1.14，仅替换 `app/api-protocol.mjs`、`app/api-request.mjs`、`app/student/service-detection.mjs` 并重建文件校验；工作区其他已有修改没有合入本包。解包后 API 与设置回归 **40 项通过、0 失败、0 跳过**，原始输出为工作区 `dist/release-v0.1.15/package-api-tests.log`。包内 **32 项 SHA-256 全部匹配**，验证结果为 `dist/release-v0.1.15/package-verification.json`。

对解压包实际运行控制台，使用独立浏览器完成填入方舟根网址、检测、保存及重启流程。1440px 和 390px 下模型、保守人民币折算和图片能力提示均可读，Key 不回显，重启保留验证结果且不自动请求服务。原始输出为 `dist/ark-fix-20261020/ui-acceptance.log`，截图为同目录的 `ark-settings-fixture.png`、`ark-settings-mobile-fixture.png`。服务端使用测试响应，截图不代表真实方舟账号调用成功。

两路代码复核（Standards、Spec）均无可行动问题，固定基线 `323a4c4`、实现提交 `db5f389`，记录为 `dist/ark-fix-20261020/reviews.txt`。

本地工作区完整回归：`node --test --test-concurrency=2 szu-uooc/tests/*.test.mjs szu-uooc/tests/*.test.cjs`，共 **174 项，170 通过、0 失败、4 跳过**，耗时约 365 秒。4 项为本环境未配置 PowerShell 的 Windows 安装专项；本次没有修改安装器。原始输出为 `dist/ark-fix-20261020/full-tests.log`。该回归包含工作区已有的其他未提交修改；发布包另行执行上述 40 项解包回归，没有合入那些运行文件修改。

尚未用同学的真实方舟 Key 调用；没有原始报错，不能确认该同学是否还遇到账号权限、欠费、旧模型下线或自定义接入点问题。

验收：退出旧程序，下载最新包并完整解压；设置 AI 解题，填写方舟标准地址和 Key，点击「检测并保存」，应显示实际验证的文字/图片模型；再继续一门课程核对调用与用量。若仍失败，提供报错或程序导出的脱敏诊断包，不提供 Key。

来源（2026-10-20 查阅）：

- [官方模型价格](https://www.volcengine.com/docs/82379/1544106)
- [官方 Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh)
- [官方模型列表](https://docs.volcengine.com/docs/ark/model-list?lang=zh)
- [官方错误码](https://docs.volcengine.com/docs/ark/error-codes?lang=zh)
- [官方模型下线迁移说明](https://docs.volcengine.com/docs/ark/model-deprecation-migration-guide?lang=zh)
- [国家外汇管理局汇率中间价](https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do)

## 发布包验证原始输出

- [解包 API 回归：40 通过](evidence/ark-20261020/package-api-tests.log)
- [解包界面与配置重启验证](evidence/ark-20261020/ui-acceptance.log)
- [ZIP 与 32 项文件校验](evidence/ark-20261020/package-verification.json)
- [本地工作区完整回归](evidence/ark-20261020/full-tests.log)
- [修复前失败输出](evidence/ark-20261020/ark-red.log)、[兜底与错误分类修复前输出](evidence/ark-20261020/ark-fallback-red.log)
- [Standards / Spec 双轴复核](evidence/ark-20261020/reviews.txt)
