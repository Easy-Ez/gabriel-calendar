# Gabriel Calendar

[English](README.md)

Gabriel Calendar 提供独立的 Google Calendar 服务端及 Node.js、Python SDK。服务端负责 Google OAuth、Webhook、增量同步和投递，本地应用通过 HTTPS 收取主日历的邀请和变更、查询和回复邀请，以及创建、更新或取消单次事件，并选择是否通知来宾。

当前实现面向一个 Google 测试项目和经确认的测试账号。两套 SDK 使用同一套协议夹具。服务端已通过模拟 Google 和 PostgreSQL 测试，真实联调覆盖邀请、RSVP、改期、取消和 SSE 断线补发。

## 快速开始（使用已有服务）

如果团队已经部署了 Gabriel Calendar，同事只需安装 SDK 并连接现有服务。一个部署可在同一个 Google 测试项目中接入多个获准用户，每个人授权自己的主日历。

| SDK | 安装已发布版本 | 可运行示例 |
| --- | --- | --- |
| Node.js 22+ | `npm install gabriel-calendar` | [Node.js 快速开始](sdks/node/README.md#quick-start) |
| Python 3.11+ | `python -m pip install gabriel-calendar` | [Python 快速开始](sdks/python/README.md#quick-start) |

1. 向服务管理员获取 HTTPS 地址和分配给你个人的项目会话凭据。如果 Google OAuth 应用是 External / Testing，管理员还需把你的 Google 账号加到测试用户。地址只填服务的 origin，例如 `https://calendar.example.invalid`，不加 `/v1` 或其他路径。
2. 安装 SDK 并运行对应的监听示例。把服务地址设为 `GABRIEL_BASE_URL`，由应用的密钥存储注入 `GABRIEL_PROJECT_SESSION`。示例通过 Node.js 的 `baseUrl` 和 `getProjectCredential`，或 Python 的 `base_url` 和 `get_project_credential` 传给 SDK。
3. 首次运行 `CalendarClient.connect()` 时，在 Google 页面选择已获准的账号并授权。服务同步你的主日历，SDK 通过 SSE 监听后续变更。如果查询待回复邀请时收到 `SYNC_PENDING`，等首次同步完成后再试。
4. 要在进程重启后续接，用 `saveGrant` 或 `save_grant` 将 consumer grant 存到密钥存储。下次用客户端构造函数传入原来的连接 ID、consumer ID 和凭据，从已确认的位置继续接收通知。

服务管理员统一维护 Google OAuth、Webhook 和 PostgreSQL。团队内部使用时，可以只在内部分享地址，并为每位同事签发独立凭据。同事要能访问服务，Google Calendar 也要能访问 HTTPS Webhook。参见[服务端部署与验收](docs/zh-CN/testing.md)。

## 客户端 API 文档

- [Node.js 和 Python 方法对照](spec/api.md#sdk-surface)涵盖连接授权、`on` 订阅、`start` / `stop`、查询待回复邀请、RSVP，以及创建、更新和取消事件。
- [SDK 调用示例](spec/api.md#sdk-examples)展示查询和回复邀请。写操作需要服务端开通权限，并在 SDK 配对时申请相应能力。
- [通知类型与错误码](spec/api.md#events-and-errors)说明事件引用、通知结构和错误处理。[HTTP 接口契约](spec/api.md#http-endpoints)说明底层请求和响应。
- [MVP 范围与后续设计](docs/zh-CN/mvp.md)
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
