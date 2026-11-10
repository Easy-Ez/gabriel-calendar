# 测试项目启动与验收

## Google Cloud 配置

在一个测试项目启用 Google Calendar API，配置 OAuth 同意界面，将需要授权的账号加入测试用户，再创建 Web application 类型的 OAuth 客户端。首次授权后，服务会自动绑定 Google 返回的主日历。部署时用真实 HTTPS 域名替换下表的示例域名。两处都使用同一个 `PUBLIC_BASE_URL`，且都不加尾部斜杠。

| 用途 | 使用示例域名时的完整 URL |
| --- | --- |
| Google Cloud 的 Authorized redirect URI | `https://calendar.example.invalid/v1/google/oauth/callback` |
| 服务通过 `events.watch` 向 Google 注册的 Webhook | `https://calendar.example.invalid/v1/google/webhook` |
| 服务健康检查 | `https://calendar.example.invalid/healthz` |

Google 需要能通过公开信任的 TLS 证书访问 Webhook。OAuth 请求使用 `calendar.calendarlist.readonly` 和 `calendar.events.owned`，并请求离线授权。Google 对 External / Testing 应用签发的 Calendar refresh token 通常在七天后到期，届时可为同一个连接重新授权。 [Google Web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) · [授权有效期](https://developers.google.com/identity/protocols/oauth2#expiration) · [Google Calendar Webhook](https://developers.google.com/workspace/calendar/api/guides/push)

## 运行时配置

在部署环境由批准的密钥管理系统注入私有值。使用专用 PostgreSQL 数据库和受控访问的备份。应用把 Google refresh token 加密存入数据库，把项目会话、SDK grant 和 Webhook 校验值的摘要用于验证。部署之间保持同一数据密钥，才能解密已有授权并验证已签发的投递游标。

| 环境变量 | 格式或默认值 |
| --- | --- |
| `DATABASE_URL` | 专用 PostgreSQL 的连接 URL。远程连接应校验证书 |
| `PUBLIC_BASE_URL` | HTTPS origin，例如 `https://calendar.example.invalid` |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | Web OAuth 客户端配置 |
| `GABRIEL_DATA_KEY` | 32 个随机字节的无填充 base64url 编码，由密钥管理系统注入 |
| `GABRIEL_PROJECT_SESSIONS` | JSON 对象。键是部署分配的应用用户标识，值是该用户的独立 bearer，会话值采用 32 个随机字节的无填充 base64url 编码 |
| `GABRIEL_PROJECT_SESSION_DIGESTS` | 可选 JSON 对象，为额外的项目用户提供其 bearer 的 SHA-256 摘要，采用无填充 base64url。原始 bearer 由用户的密钥存储保管 |
| `HOST`、`PORT` | 默认 `127.0.0.1` 和 `8080` |
| `GABRIEL_TICK_MS` | 工作循环间隔，默认 1,000 毫秒 |
| `GABRIEL_CATCHUP_MS` | 定期增量补收间隔，默认 300,000 毫秒 |
| `GABRIEL_RETENTION_MS` | 投递保留期，默认 604,800,000 毫秒 |

## 人员与权限管理

当前由部署管理员通过启动配置登记人员和项目凭据。获准用户授权主日历后，配对的客户端即可读写该日历，写入范围由事件归属和 Google 授权约束。

### 开通一个同事

1. 为同事分配一个稳定的项目用户 ID，例如 `pilot_01`。它是 Gabriel 用来绑定主日历的内部标识。项目仍处于 External / Testing 时，也要在 Google OAuth 的测试用户名单加入该同事的 Google 账号。
2. 在批准的密钥管理系统中为该用户发放独立的项目凭据。服务端在 `GABRIEL_PROJECT_SESSION_DIGESTS` 中登记从项目用户 ID 到凭据摘要的映射。摘要是对**凭据字符串**计算 SHA-256 后得到的无填充 base64url 值。保留其他用户的配置，重启 Gabriel 服务后生效。
3. 通过密钥管理系统将原始凭据注入同事的客户端。他调用 SDK `connect()` 并在 Google 页面授权，服务将他的主日历绑定到 `pilot_01`。SDK 配对后获得自己的 consumer grant，日常读写和 SSE 使用这份 grant。

轮换项目凭据时保留用户 ID 并替换摘要。需要解除日历绑定并撤销已有 consumer grant 时，先由该用户的项目凭据调用[断开连接接口](../../spec/api.md#http-endpoints)，再从启动配置中移除该用户。

### 写入范围与升级

同一个 consumer 可以收通知、回复自己的邀请、创建单次会议，以及改期或取消自己组织的单次会议。创建、改期和取消带来宾的会议时，调用方须显式传 `notifyGuests` / `notify_guests`。例如，把自己组织的会议改到下午三点时，传 `true` 请求 Google 通知来宾，传 `false` 请求 Google 跳过通知。

升级服务后，有效的旧 consumer grant 也能写入。上线前核对已登记用户和分发出去的凭据，尤其是此前只用于监听的客户端。旧的 RSVP 开关、截止时间和各操作名单配置可以从部署中移除。配对接口现在接收空 JSON 对象 `{}`，客户端与服务端应一起升级。[配对与写入契约](../../spec/api.md#http-endpoints)

## 模拟验证与部署步骤

1. 安装 Node.js 22 或更新版、PostgreSQL 客户端和服务端工具。Python SDK 验证使用 Python 3.11 或更新版及 `uv`。
2. 在仓库根目录安装和验证。服务测试创建仅监听临时 Unix socket 的 PostgreSQL，Google HTTP 模拟器只绑定环回地址。

   ```bash
   npm ci
   npm test
   npm run test:python
   ```

3. 审查下方代理示例，替换域名与证书路径后将实际配置放在部署环境。只登记已确认的测试用户，为测试项目注入上表配置，再构建、迁移和启动服务。

   ```bash
   npm run build
   npm run migrate
   npm start
   ```

4. 验证公网 `GET /healthz` 返回 200。完成测试账号授权后，使用相应项目会话读取连接状态。确认 `lastSyncAt` 和 `watchExpiresAt` 非空，发出测试变更后确认 `lastWebhookAt` 推进。
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
5. 结束后用项目会话断开测试连接，验证对应 SDK grant 失效。

仓库的自动测试覆盖模拟 Google 与 PostgreSQL。真实 OAuth、Google 推送和 A/B 双方界面状态需单独记录验收结果。 [HTTP 契约](../../spec/api.md)
