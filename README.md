# 深易刷

Windows／Mac 新手版。仓库名称为 `szu-uooc`，旧版界面也会显示这个名称。

## 下载与启动

1. 打开 [最新下载](https://github.com/zcx28/szu-uooc/releases/latest)，下载 `ShenYiShua.zip`（Windows、Mac 共用）。
2. Windows：右键 ZIP →“全部解压”；Mac：双击 ZIP 解压。打开解压后的文件夹。
3. Windows 双击 `启动-Windows.cmd`；Mac 双击 `启动-Mac.command`。保持联网，等待自动下载组件并打开控制台。
4. 按控制台提示登录 UOOC，在 Chrome 开启远程调试并允许本次连接。
5. 读取课程，保存自己的解题服务 API Key，再点一门课旁的“开始”。

[查看完整图文教程](docs/使用教程.md)。一次只运行一门课；验证码等额外验证按页面提示手动处理。

使用解题服务前请核对服务商的接口、模型、价格与预算。Key 只保存在本机，不要上传到仓库。

## 环境

- Windows 10/11 x64 或 Mac（Intel／Apple 芯片），使用 Google Chrome。
- 首次启动自动下载 Node.js 与浏览器连接组件，后续启动复用。
- 图文教程以 Windows 截图为例，已标注 Mac 操作。
- 个人配置位于本机用户目录，不包含在发布包中。

## 来源与许可

随附原项目的 [第三方许可](app/THIRD-PARTY-LICENSE.txt)，保留原作者 Liunian06 的 MIT 版权声明。
