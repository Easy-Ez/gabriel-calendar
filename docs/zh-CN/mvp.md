# Google Calendar MVP

本地应用通过独立服务连接 Google 测试账号，收取主日历的邀请和变更，并使用同一 SDK 查询待回复邀请和回复。服务端承担公网 OAuth 回调、Webhook、增量同步和投递。

## 当前交付

| 范围 | 行为 |
| --- | --- |
| Google 连接 | 一个测试项目。用户在浏览器同意离线授权后，服务自动连接 Google 返回的主日历 |
| 通知 | 新邀请、新事件、改期和其他详情变化、取消、本人 RSVP 变化 |
| 查询与回复 | 查询待回复邀请，支持接受、暂定和拒绝，返回 Google 确认的结果 |
| 创建事件 | 有创建权限的消费者可在主日历创建单次定时事件，支持幂等重试。添加来宾需要额外权限 |
| 管理事件 | 有管理权限的消费者可按版本改期、改标题或取消由本人组织的单次定时事件。带来宾的写入须明确选择是否通知来宾 |
| 消费体验 | Node.js 和 Python 共用协议。消费者可独立确认、断线补收和检测缺口 |
| 连接管理 | 查看状态、重新授权、撤销连接及其消费凭据 |

Google 的邀请设置可能使邀请先出现在邮件中，等用户操作后才进入日历。重复会议的 RSVP 使用已定位的单次实例。 [邀请可见性](https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events) · [重复会议](https://developers.google.com/workspace/calendar/api/guides/recurringevents)

## 验收顺序

1. 模拟 Google 和 PostgreSQL 验证 OAuth、主日历订阅、基线、增量同步、待回复查询、RSVP 和恢复。
2. Node.js 和 Python 使用同一份夹具验证解码、投递顺序、失败重投、断线、ACK 与类型化错误。
3. 在独立 Google 测试项目完成 A/B 验收。A 邀请 B，B 收到通知并回复暂定，A 在 Google Calendar 确认回复，再改期及取消以验证 B 的更新通知。真实写入使用已确认的测试账号和主日历。

## 后续设计

创建和更新次要日历、选择其他可读日历、通用事件查询、编辑已有会议的来宾名单、托管控制台和 `gabriel-app` 接入放在当前闭环之后。未来日历管理涵盖名称、描述和时区。邮件接入、稍后提醒、其他日历供应商、共享权限管理和整组重复规则编辑属于后续范围。

[启动与验收](testing.md) · [API 契约](../../spec/api.md) · [同步与投递行为](../../spec/behavior.md) · [公开仓库边界](../../CONTRIBUTING.md)
