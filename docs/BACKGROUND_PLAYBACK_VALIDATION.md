# 熄屏与后台播放修复验收

日期：2026-10-23，北京时间。程序构建：`0.10.0-local.34`。

## 原因与修改

原浏览器连接在 `chrome-connection.mjs` 中使用 `connectOverCDP(..., { noDefaults: true })`，因此跳过了 Playwright 通常自动开启的前台模拟。普通测试通过 `chromium.launch()` 启动，既带前台模拟，又带关闭后台限速的启动参数，未覆盖用户原浏览器的行为。

本次在共享入口 `browser-bridge.mjs:installCourseScript()` 内，为受控课程标签页建立独立 CDP 会话并启用 `Emulation.setFocusEmulationEnabled`。脚本安装失败或控制结束时释放会话，恢复该标签页的实际可见性。控制器的启动、暂停、继续、停止和重装仍复用原有生命周期。

没有更改全局浏览器连接默认值、系统电源设置、课程完成判定或费用控制。脚本版本更新为 local.34，用于识别修复包。沿用 v0.1.21 的其他运行文件与项目使用说明。

Chrome [官方文档](https://developer.chrome.com/docs/devtools/rendering/apply-effects#emulate_a_focused_page)说明该功能会保持页面可见状态；Chromium 的 [EmulationHandler 实现](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/emulation_handler.cc)负责跨导航恢复与会话清理。这是浏览器页面保活，不能阻止电脑进入系统睡眠。

## 可复查的验证

原始输出目录：`docs/evidence/background-20261023/`。

- `background-red.log`：直接启动无 Playwright 保活参数的隔离 Chrome，以 `noDefaults: true` 连接，使用修改前的桥接代码。安装后 5 秒仍为 `hidden / focused=false`，测试失败。
- `background-green.log`：同一测试使用修复后的桥接代码通过。后台定时器运行、真实 MP4 自然 ended、显式暂停仍有效、清理恢复 hidden、原标签保留。
- `display-powerd.log`、`display-sleep-proof.json`、`display-verified.json`：实际有窗口的 Chrome 配合修复后的桥接。系统日志确认 13:59:52.904 熄屏，13:59:56.600 因输入活动点亮，实际熄屏约 3.696 秒；其间采样渲染帧数由 39 增至 106，并有一次 MP4 自然结束。原计划采样 14 秒，不能将剩余采样时间当作持续熄屏。
- `full-regression.log`：全量 239 项中 221 项通过，4 项 Windows 安装测试跳过，14 项因测试默认 Chromium 路径不存在而启动失败；不是运行中的业务断言失败。
- `remaining-regression.log`：指定本机已有 Chromium 后，补跑上述 14 项及新后台回归，共 15 项全部通过。合并计为 240 项，236 项通过、4 项跳过，无尚未解决的业务测试失败。
- `package-verification.json`：最终发布包 ZIP 完整性、34 项文件摘要、local.34 标识与原版本运行文件差异核对通过；已保留 v0.1.21 的项目使用说明及面板滚动修复。
- 最终发布包的后台专项和隔离控制台启动结果见 `release-targeted.log` 与 `package-smoke.json`。未启动真实课程或使用个人设置。
- `node --check`、`git diff --check` 通过。独立代码审查未发现本轮必须修改的缺陷。

后台回归命令（从仓库根目录执行）：

```sh
node --test app/tests/course-background.test.mjs
SZU_UOOC_TEST_BRIDGE=docs/evidence/background-20261023/before-browser-bridge.mjs node --test app/tests/course-background.test.mjs
```

第二条使用修改前快照，预期失败。实机熄屏检查使用独立有窗口的 Chromium，不在默认测试中关闭用户屏幕。

## 交付与验收

修复包：[v0.1.22 的 ShenYiShua.zip](https://github.com/zcx28/szu-uooc/releases/download/v0.1.22/ShenYiShua.zip)。

SHA-256：`9a6f2a7d5f577941300d38ff8247730b010fdbb4d9b1ffe32cbec8154328f9a2`。

1. 在旧控制台选择「设置 → 退出程序」。
2. 完整解压新包，双击对应系统的启动文件。现有课程、设置和费用账本继续由原用户数据目录读取。
3. 开始一门课程，记下视频位置和目录进度，熄屏至少 5 分钟后点亮，检查视频位置或课程任务是否继续推进；再检查暂停与继续。

本次没有执行真实课程、付费请求、Windows/Intel Mac 实机或长时间熄屏验收。电脑关机、合盖或进入系统睡眠后无法继续运行；需要人工处理的网站验证仍按原有规则处理。
