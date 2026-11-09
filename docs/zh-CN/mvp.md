# Google Calendar MVP

一个桌面应用或本地脚本能在用户授权后收到新的会议邀请和变更，并通过同一 SDK 回复或操作日历。开发者和最终用户都无需部署公网服务器。

## 产品流程

1. **开发者配置应用。** 在 Google Cloud 启用 Calendar API，配置 OAuth 同意界面，创建 Web 类型的 OAuth 客户端。在服务控制台创建项目，把页面给出的 OAuth 回调地址填入 Google，并在服务端登记 OAuth 应用配置。公开接入时需按 Google 对所选权限的要求完成验证。
2. **最终用户连接账号。** SDK 发起浏览器授权。用户选 Google 账号并同意所需权限后，服务端建立 Connection。用户可以看到连接状态、授予的能力和当前监听的日历。每个最终用户只需授权自己的账号。
3. **应用开始收通知。** 默认监听主日历，也可选择有权读取的其他日历。每个本地应用实例可绑定一个独立 Consumer，重连后从上次确认处继续。首次打开时可以查询已有会议和待回复邀请。
4. **用户操作日历。** SDK 可以查看或修改会议、回复接受／暂定／拒绝，或在权限允许时创建次要日历和修改日历设置。写操作返回 Google 确认的结果。
5. **用户管理连接。** 用户可以查看连接状态和最近同步结果，重新授权或断开连接。断开后停止新的事件投递与写操作，并使该连接的消费凭据失效。

OAuth 回调和 Webhook 接收地址用途不同。开发者只在 Google Cloud 配置 OAuth 回调，服务端通过 Calendar API 注册 Webhook 地址并续订。 [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) · [Google Calendar 推送](https://developers.google.com/workspace/calendar/api/guides/push)

## 首版范围

| 范围 | 交付 |
| --- | --- |
| Google Calendar 连接 | 自带 OAuth 应用；用户浏览器授权；服务端持久化连接、维护离线授权 |
| 通知 | 邀请、会议新建、改期和内容变化、取消、本人回复状态变化 |
| 会议操作 | 查询、新建、编辑、取消；本人接受、暂定或拒绝邀请 |
| 日历操作 | 查询、创建次要日历、更新名称／描述／时区 |
| 消费体验 | Node.js 和 Python 同一协议；自动重连；保留期内补发；过期时报告缺口 |
| 控制台 | OAuth 配置、连接状态、监听范围、设备绑定和元数据诊断 |

首版从 Google Calendar 可读取的邀请开始。Google 的邀请设置可能使邀请先出现在邮件中，等用户操作后才进入日历。邮件接入、稍后提醒、其他日历供应商、共享权限管理，以及编辑整组重复规则列为后续范围。首版可以读取重复事件并操作已定位的单次实例。 [邀请加入日历的规则](https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events) · [重复会议](https://developers.google.com/workspace/calendar/api/guides/recurringevents)

## 实现顺序与验收

1. **先通一条真实链路。** 建立 OAuth 连接，服务端监听并同步主日历。测试账号 A 邀请测试账号 B，B 的 Node.js SDK 收到邀请并回复暂定，A 在 Google Calendar 看到 B 的回复。A 改期或取消时，B 收到相应通知。
2. **补齐操作和恢复。** 两种语言都能创建次要日历、创建和编辑会议。客户端离线后重连可补收已保存的变化。处理失败后重投同一个通知 ID。授权失效能引导用户重新连接。
3. **用同一份契约验收两端。** 用合成数据覆盖初次同步、重复推送、订阅换代、重连、游标过期、旧版本写入及跨项目访问。真实 OAuth 与 Google 调用放在独立测试项目，使用经授权的测试账号和日历。

[API 草案](../../spec/api.md) · [同步与投递行为](../../spec/behavior.md) · [公开仓库边界](../../CONTRIBUTING.md)
