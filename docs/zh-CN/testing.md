# 测试项目启动与验收

## Google Cloud 配置

在一个测试项目启用 Google Calendar API，配置 OAuth 同意界面，将需要授权的账号加入测试用户，再创建 Web application 类型的 OAuth 客户端。首次授权后，服务会自动绑定 Google 返回的主日历。部署时用真实 HTTPS 域名替换下表的示例域名。两处都使用同一个 `PUBLIC_BASE_URL`，且都不加尾部斜杠。

| 用途 | 使用示例域名时的完整 URL |
| --- | --- |
| Google Cloud 的 Authorized redirect URI | `https://calendar.example.invalid/v1/google/oauth/callback` |
| 服务通过 `events.watch` 向 Google 注册的 Webhook | `https://calendar.example.invalid/v1/google/webhook` |
| 服务健康检查 | `https://calendar.example.invalid/healthz` |

Google 需要能通过公开信任的 TLS 证书访问 Webhook。OAuth 请求使用 `openid`、`calendar.calendarlist.readonly` 和 `calendar.events.owned`，并请求离线授权。服务通过 Google UserInfo 取得稳定的账号 `sub`，再绑定该账号拥有的主日历。Google 对 External / Testing 应用签发的 Calendar refresh token 通常在七天后到期，届时可为同一个连接重新授权。 [Google Web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) · [OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect) · [授权有效期](https://developers.google.com/identity/protocols/oauth2#expiration) · [Google Calendar Webhook](https://developers.google.com/workspace/calendar/api/guides/push)

## 运行时配置

在部署环境由批准的密钥管理系统注入私有值。使用专用 PostgreSQL 数据库和受控访问的备份。应用加密保存 Google refresh token，使用接入码、授权会话凭据、SDK grant 和 Webhook 校验值的摘要进行验证。部署之间保持同一数据密钥，才能识别已绑定账号、解密授权并验证投递游标。

| 环境变量 | 格式或默认值 |
| --- | --- |
| `DATABASE_URL` | 专用 PostgreSQL 的连接 URL。远程连接应校验证书 |
| `PUBLIC_BASE_URL` | HTTPS origin，例如 `https://calendar.example.invalid` |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | Web OAuth 客户端配置 |
| `GABRIEL_DATA_KEY` | 32 个随机字节的无填充 base64url 编码，由密钥管理系统注入 |
| `GABRIEL_ADMIN_TOKEN_DIGEST` | 初始管理员凭据的 SHA-256 摘要，采用无填充 base64url。凭据由密钥管理系统保存，格式为 32 个随机字节的无填充 base64url 编码。首次在页面改密后，服务改用数据库中的加盐 scrypt 校验值 |
| `HOST`、`PORT` | 默认 `127.0.0.1` 和 `8080` |
| `GABRIEL_TICK_MS` | 工作循环间隔，默认 1,000 毫秒 |
| `GABRIEL_CATCHUP_MS` | 定期增量补收间隔，默认 300,000 毫秒 |
| `GABRIEL_RETENTION_MS` | 投递保留期，默认 604,800,000 毫秒 |

## 接入码与连接管理

1. 在服务的 HTTPS 地址打开 `/admin`，用用户名 `admin` 和管理员密码登录。首次使用密钥管理系统中的初始管理员凭据。点 **Change password**，输入当前密码并设置自己的 16–128 字符密码。保存后用新密码登录。
2. 当前共享码直接显示在 **Team access**，点 **Copy access code** 复制。首次使用时点 **Create access code**。只保留过校验值的旧码可通过 **Save existing access code** 录入一次原值，服务验证后会加密保存，原码继续有效。通过团队的密钥管理系统将 HTTPS 地址和接入码分发给同事。Google 项目仍处于 External / Testing 时，账号仍须加入 Google 测试用户名单。
3. 同事把地址填入 SDK 的 `baseUrl` / `base_url`，将共享码传给 `token`，在 SDK 打开的 Google 页面用自己的账号授权。SDK 拿到独立的 consumer grant，之后读写和接收 SSE 都用这份凭据。

点 **Replace access code** 并确认可轮换共享码。旧码和它发起的未完成会话立即失效，已领取的 consumer grant 继续工作。管理页显示连接 ID、脱敏日历、状态和最近同步时间。对某条连接点 **Disconnect** 并确认会解除绑定、撤销该连接的所有 consumer grant 并尝试停止 Google Watch。持有当前接入码的账号可以重新授权。若接入码泄露，先重置，再断开任何需要撤销的连接。

### 写入范围与升级

同一个 consumer 可以收通知、回复自己的邀请、创建单次会议，以及改期或取消自己组织的单次会议。创建、改期和取消带来宾的会议时，调用方须显式传 `notifyGuests` / `notify_guests`。例如，把自己组织的会议改到下午三点时，传 `true` 请求 Google 通知来宾，传 `false` 请求 Google 跳过通知。

升级时先运行数据库迁移，并同时更新服务端和 SDK。迁移保留已有日历连接及有效 consumer grant。旧流程建立的连接要改用共享码重新接入时，先在管理页解除旧绑定，再用同一个 Google 账号授权。部署可移除旧的逐人项目凭据配置。[HTTP 契约](../../spec/api.md#http-endpoints)

## 模拟验证与部署步骤

1. 安装 Node.js 22 或更新版、PostgreSQL 客户端和服务端工具。Python SDK 验证使用 Python 3.11 或更新版及 `uv`。
2. 在仓库根目录安装和验证。服务测试创建仅监听临时 Unix socket 的 PostgreSQL，Google HTTP 模拟器只绑定环回地址。

   ```bash
   npm ci
   npm test
   npm run test:python
   ```

3. 审查下方代理示例，替换域名与证书路径后将实际配置放在部署环境。为测试项目注入上表配置，再构建、迁移和启动服务。

   ```bash
   npm run build
   npm run migrate
   npm start
   ```

4. 验证公网 `GET /healthz` 返回 200。在 `/admin` 创建接入码，用已确认的测试账号完成授权后，使用该连接的 consumer grant 读取状态。确认 `lastSyncAt` 和 `watchExpiresAt` 非空，发出测试变更后确认 `lastWebhookAt` 推进。
5. 在已确认的测试账号和日历上验证 RSVP。按下方验收步骤记录结果。日志与验收记录只保留请求 ID、操作、错误码和必要时间戳。
6. 先启动 SSE，再用 SDK 创建无来宾的合成事件，比较创建响应和 `event.created` 的事件引用。用同一个幂等键重试，确认事件引用相同。
7. 用事件当前版本改期，等待 SSE 收到 `event.updated` 并确认，然后用新版本取消并等待 `event.cancelled`。
8. 验证来宾时，连接两个已确认的测试账号并先启动来宾的 SSE。组织者创建、改期和取消时均显式请求通知，逐步等待来宾日历的 `invitation.received`、`event.updated` 和 `event.cancelled`。

首次授权时，通过授权会话的 `oauth.phase` 和连接的 `onboarding.stage` 查看当前阶段。连接就绪后，`onboarding` 提供 OAuth 回调、首次全量同步、Watch 注册和首个 Webhook 的耗时。已有连接仍可检查就绪状态，历史耗时显示为空。[字段与计时起点](../../spec/api.md#connection-progress-and-timings)

### Google Calendar 推送限制

组织者写入成功后，Google 会把变更传播到来宾各自的日历副本。写入成功、来宾副本可查询和 Webhook 到达是三个独立的观测点。Google 的推送文档没有给出送达时限，并说明正常使用时也可能漏发。Gabriel 由 Webhook 触发日常增量同步，并按 `GABRIEL_CATCHUP_MS` 定期补收漏发的变更。[来宾日历传播](https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events#event-propagation) · [推送可靠性](https://developers.google.com/workspace/calendar/api/guides/push#special-considerations)

OAuth Testing 的公开限制包括测试用户范围和授权有效期。Google 未公布 Testing 与 Production 的推送时延差异，测试项目里观测到的延迟也不足以推断正式发布后的速度。[OAuth 发布状态](https://support.google.com/cloud/answer/15549945?hl=en)

### 日常投递计时

每次 SDK 写入前记录客户端时间，在来宾 SDK 回调入口记录 SSE 收件时间，并通过同一通知的入队时间对齐。数据库保存同步批次关联的 Webhook 时间和候选数量。Google 的 Webhook 不带事件 ID，只有单个候选回调且没有新回调插入同步过程时，才能在受控验收里归因。跨客户端和服务时钟的两段用校准后的区间表示，Webhook 到入队使用数据库同一时钟。

使用成功写入响应中的 `X-Gabriel-Google-Confirmed-At` 把第一段再拆成 SDK 发起到 Google 写入响应，以及该响应到 Webhook 被接受。该值取自服务时钟，需和客户端及 PostgreSQL 时钟对齐。幂等回读恢复的写入没有原始写入确认时间。

要区分 Google 日历变更的可查询时间与 Webhook 到达时间，可以同时查询来宾的 Google Calendar API。邀请通过组织者事件的 iCalendar UID 定位来宾副本，改期和取消按来宾副本的事件 ID 查询。用最后一次未见目标状态的请求起点与第一次见到目标状态的响应终点给出区间。首查已可见时只报告上界。每一步都与来宾收到的同一事件通知核对，确认后再执行下一步。[Google events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) · [Google events.get](https://developers.google.com/workspace/calendar/api/v3/reference/events/get)

## 反向代理审查示例

把下列 `server` 块放在 NGINX 的 `http` 配置中。将证书交由部署环境管理，检查配置后再由部署操作者加载。整个服务 origin 禁止记录原始请求 URI 和请求头，避免 OAuth 查询参数及日历路径进入代理日志。SSE 每约 12 秒发送一次空闲心跳。保留 `proxy_buffering off` 和较长的读取超时，让事件与心跳及时通过代理。

```nginx
server {
    listen 443 ssl;
    server_name calendar.example.invalid;

    ssl_certificate     /path/to/managed/fullchain;
    ssl_certificate_key /path/to/managed/private-key;
    ssl_protocols TLSv1.2 TLSv1.3;

    access_log off;
    error_log /dev/null crit;
    client_max_body_size 8k;
    client_body_timeout 15s;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_connect_timeout 5s;
        proxy_send_timeout 20s;
        proxy_read_timeout 40s;
    }
}
```

## 两个测试账号的真实验收

1. 用 B 完成授权并启动监听。等待首次同步完成，确认已有待回复邀请可查询，且首次同步未推送历史邀请。
2. A 在 Google Calendar 创建一场合成测试会议并邀请 B。确认 B 的主日历能看到该邀请，监听收到 `invitation.received`，待回复查询返回同一事件。
3. B 用通知中的 `ref` 调用 `events.rsvp(ref, "tentative")`。确认响应的 `myResponse` 为 `tentative`，再在 A 的 Google Calendar 界面确认 B 的 Maybe 状态。
4. A 改期并取消这场测试会议。分别确认 B 收到 `event.updated` 和 `event.cancelled`。验证离线补收时，可在改期前停止 B 的监听，改期后用同一个 consumer 恢复。
5. 结束后在 `/admin` 断开测试连接，验证对应 SDK grant 失效。

仓库的自动测试覆盖模拟 Google 与 PostgreSQL。真实 OAuth、Google 推送和 A/B 双方界面状态需单独记录验收结果。 [HTTP 契约](../../spec/api.md)
