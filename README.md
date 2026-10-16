# 深易刷

Windows 新手版。仓库名称为 `szu-uooc`，旧版界面也会显示这个名称。

## 下载与启动

1. 打开 [最新下载](https://github.com/zcx28/szu-uooc/releases/latest)，下载 `ShenYiShua-Windows.zip`。
2. 右键 ZIP，选择“全部解压”，打开解压后的文件夹。
3. 双击 `启动-Windows.cmd`，保持联网，等待自动下载组件并打开控制台。
4. 按控制台提示登录 UOOC，在 Chrome 开启远程调试并允许本次连接。
5. 读取课程，保存自己的解题服务 API Key，再点一门课旁的“开始”。

图文教程将在 `docs` 目录提供。一次只运行一门课；验证码等额外验证按页面提示手动处理。

使用解题服务前请核对服务商的接口、模型、价格与预算。Key 只保存在本机，不要上传到仓库。

## 环境

- Windows 10/11 x64 与 Google Chrome。
- 首次启动自动下载 Node.js 与浏览器连接组件，后续启动复用。
- 同时保留原有 Mac 启动入口，当前图文教程只覆盖 Windows。
- 个人配置位于本机用户目录，不包含在发布包中。

## 来源与许可

随附原项目的 [第三方许可](app/THIRD-PARTY-LICENSE.txt)，保留原作者 Liunian06 的 MIT 版权声明。
