# Gabriel Calendar

[English](README.md)

Gabriel Calendar 计划为 Node.js 和 Python 提供 Google Calendar SDK。本地应用可以持续接收会议邀请、改期和取消，也可以在用户授权后回复邀请、编辑会议和创建日历。托管服务负责 Google 授权回调、Webhook、同步和投递，客户端只需主动发起 HTTPS 连接。

**项目处于设计阶段。** 本仓库提供 MVP 规划和 API 草案，服务端及 SDK 尚未实现或发布。

- [MVP 范围、用户接入与验收](docs/zh-CN/mvp.md)
- [SDK 与服务端 API 草案](spec/api.md)
- [同步、投递与写入行为](spec/behavior.md)
- [贡献指南与公开内容边界](CONTRIBUTING.md)

SDK 的事件与生命周期接口参考 [gabriel-slack](https://github.com/Easy-Ez/gabriel-slack)。Node.js 和 Python 使用同一份协议与行为规范。

这是独立项目，与 Google 无隶属关系。项目采用 [MIT 许可证](LICENSE)。
