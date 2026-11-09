# Gabriel Calendar

[English](README.md)

Gabriel Calendar 提供独立的 Google Calendar 服务端及 Node.js、Python SDK。服务端负责 Google OAuth、Webhook、增量同步和投递，本地应用通过 HTTPS 收取主日历的邀请和变更、查询和回复邀请，以及创建、更新或取消单次事件，并选择是否通知来宾。

当前实现面向一个 Google 测试项目和经确认的测试账号。两套 SDK 使用同一套协议夹具。服务端已通过模拟 Google 和 PostgreSQL 测试，真实联调覆盖邀请、RSVP、改期、取消和 SSE 断线补发。

## SDK 安装

| SDK | 安装已发布版本 | 快速开始 |
| --- | --- | --- |
| Node.js 22+ | `npm install gabriel-calendar` | [Node.js SDK](sdks/node/README.md) |
| Python 3.11+ | `python -m pip install gabriel-calendar` | [Python SDK](sdks/python/README.md) |

SDK 需要连接 Gabriel Calendar 服务。先部署服务并获取项目会话，再用 SDK 连接 Google 账号。

- [测试项目启动、OAuth URL、反向代理和真实验收](docs/zh-CN/testing.md)
- [MVP 范围与后续设计](docs/zh-CN/mvp.md)
- [SDK 与 HTTP 契约](spec/api.md)
- [同步、投递与写入行为](spec/behavior.md)
- [贡献指南与公开内容边界](CONTRIBUTING.md)

## 本地验证

本地验证使用 Node.js 22+、PostgreSQL 工具、Python 3.11+ 和 `uv`。

```bash
npm ci
npm test
npm run test:python
```

SDK 的事件与生命周期接口参考 [gabriel-slack](https://github.com/Easy-Ez/gabriel-slack)。本项目采用 [MIT 许可证](LICENSE)，与 Google 无隶属关系。
