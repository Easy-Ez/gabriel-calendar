import type { IncomingMessage, ServerResponse } from "node:http";
import { escape, page } from "./admin-page.js";
import { adminPassword, changeAdminPassword, samePassword, validAdminPassword, verifyAdminPassword } from "./admin-password.js";
import { ApiError, opaque, uuid } from "./core.js";
import type { CalendarService } from "./service.js";

const statusLabels = { active: "Connected", auth_required: "Reconnect needed", disconnected: "Disconnected" };

function masked(calendar: string) {
  return calendar.length > 5 ? `${calendar.slice(0, 2)}…${calendar.slice(-3)}` : "•••";
}

function timestamp(date: Date) {
  const iso = date.toISOString();
  return `<time datetime="${escape(iso)}">${escape(iso.slice(0, 16).replace("T", " "))} UTC</time>`;
}

async function form(req: IncomingMessage, keys: readonly string[]) {
  const types = req.headersDistinct["content-type"];
  if (types?.length !== 1 || types[0]!.split(";")[0]!.trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    throw new ApiError("INVALID_ARGUMENT");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > 6144) {
      req.resume();
      throw new ApiError("INVALID_ARGUMENT");
    }
    chunks.push(bytes);
  }
  let input: URLSearchParams;
  try {
    input = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ApiError("INVALID_ARGUMENT");
  }
  if (input.size !== keys.length || keys.some(key => input.getAll(key).length !== 1)) {
    throw new ApiError("INVALID_ARGUMENT");
  }
  return input;
}

function accessCode(res: ServerResponse, baseUrl: string, token: string, title = "Team access code") {
  page(res, title, "Give your team the service URL and the access code through your team’s secret manager.", `
<section class="card narrow stack">
<label class="field">Service URL<input class="mono" value="${escape(baseUrl)}" readonly></label>
<label class="field">Access code<input class="mono" id="access-code" value="${escape(token)}" readonly spellcheck="false"></label>
<div class="actions"><button class="button primary" id="copy-code" type="button">Copy access code</button>
<a class="button" href="/admin">Back to overview</a></div><div class="meta" id="copy-status" role="status"></div>
</section>`, true);
}

function passwordSettings(res: ServerResponse, message?: string) {
  if (message) res.statusCode = 400;
  page(res, "Change administrator password", "Choose the password you want to use to sign in as admin.", `
<section class="card narrow stack">
${message ? `<p class="notice" role="alert">${escape(message)}</p>` : ""}
<form method="post" action="/admin/password">
<label class="field">Username<input value="admin" autocomplete="username" readonly></label>
<label class="field">Current password<input name="current" type="password" autocomplete="current-password" required></label>
<label class="field">New password<input name="next" type="password" autocomplete="new-password" aria-describedby="password-rules" required></label>
<p id="password-rules" class="meta">Use a unique password or passphrase of 16–128 characters.</p>
<label class="field">Confirm new password<input name="confirm" type="password" autocomplete="new-password" required></label>
<div class="actions"><button class="button primary" type="submit">Save password</button>
<a class="button" href="/admin">Cancel</a></div></form></section>`);
}

async function dashboard(service: CalendarService, res: ServerResponse, after: string | null) {
  const { connections, next, rotatedAt, canReveal } = await service.administration(after ?? "");
  const rows = connections.map(connection => `<tr>
<td>${escape(masked(connection.calendar_id))}</td><td><code>${escape(connection.id)}</code></td>
<td><span class="chip ${escape(connection.status)}">${statusLabels[connection.status]}</span></td>
<td>${connection.last_sync_at ? timestamp(connection.last_sync_at) : "—"}</td>
<td>${connection.status === "disconnected" ? "—" :
  `<details><summary>Disconnect</summary><p>This revokes the connection’s SDK access.</p>
<form method="post" action="/admin/connections/${escape(connection.id)}/disconnect">
<button class="button danger" type="submit">Confirm disconnect</button></form></details>`}</td></tr>`);
  const accessActions = !rotatedAt ? `
<form method="post" action="/admin/token/rotate"><button class="button primary" type="submit">Create access code</button></form>`
    : `${canReveal ? `
<form method="post" action="/admin/token/reveal"><button class="button primary" type="submit">View and copy access code</button></form>`
    : `<a class="button primary" href="/admin/token/save">Save existing access code</a>`}
<details><summary>Replace access code</summary><p>The old code and incomplete sign-ins stop working.
Existing calendar connections stay connected.</p><form method="post" action="/admin/token/rotate">
<button class="button danger" type="submit">Confirm replacement</button></form></details>`;
  page(res, "Calendar administration", "Manage team access and connected Google calendars.", `
<div class="grid">
<section class="card"><h2>Team access</h2>
<p class="muted">Share this service URL and the access code to let colleagues link their own Google calendars.</p>
<p><code>${escape(service.config.baseUrl)}</code></p>
<p class="meta">${rotatedAt ? `Current code issued ${timestamp(rotatedAt)}.` : "No enrollment token has been created."}</p>
${accessActions}</section>
<section class="card"><h2>Administrator sign-in</h2>
<p class="muted">Manage the password for <strong>admin</strong>.</p>
<a class="button" href="/admin/password">Change password</a></section>
</div>
<section class="card connections"><h2>Calendar connections</h2>
<p class="muted small">See which calendars are linked and when each last synced.</p>
${rows.length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Calendar connections"><table>
<thead><tr><th scope="col">Calendar</th><th scope="col">Connection ID</th><th scope="col">Status</th><th scope="col">Last sync</th>
<th scope="col">Action</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : '<p class="empty">No calendar connections yet.</p>'}
${next ? `<p><a href="/admin?after=${escape(next)}">Next page</a></p>` : ""}</section>`);
}

function saveCode(res: ServerResponse, message?: string) {
  if (message) res.statusCode = 400;
  page(res, "Save existing access code", "Enter the code you already share with your team. The service will verify it and store an encrypted copy.", `
<section class="card narrow stack">
${message ? `<p class="notice" role="alert">${escape(message)}</p>` : ""}
<form method="post" action="/admin/token/save">
<label class="field">Current team access code<input name="token" type="password" autocomplete="off" required
 minlength="43" maxlength="43" spellcheck="false"></label>
<div class="actions"><button class="button primary" type="submit">Save access code</button>
<a class="button" href="/admin">Cancel</a></div></form></section>`);
}

export async function admin(service: CalendarService, req: IncomingMessage, res: ServerResponse, url: URL) {
  const headers = req.headersDistinct.authorization;
  const password = headers?.length === 1 ? adminPassword(headers[0]!) : undefined;
  const authorization = password && await verifyAdminPassword(service, password);
  if (!password || !authorization) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Gabriel Calendar administration", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8" });
    res.end("Administrator authentication required.");
    return;
  }

  const { pathname } = url;
  if (req.method === "GET" && pathname === "/admin") {
    const after = url.searchParams.get("after");
    if ([...url.searchParams.keys()].some(key => key !== "after") ||
        url.searchParams.getAll("after").length > 1 || (after !== null && !uuid.test(after))) {
      throw new ApiError("INVALID_ARGUMENT");
    }
    await dashboard(service, res, after);
    return;
  }
  if (url.search) throw new ApiError("INVALID_ARGUMENT");
  if (req.method === "GET" && pathname === "/admin/password") return passwordSettings(res);
  if (req.method === "GET" && pathname === "/admin/token/save") return saveCode(res);
  if (req.method !== "POST") throw new ApiError("NOT_FOUND");
  const origin = req.headersDistinct.origin;
  if (origin?.length !== 1 || origin[0] !== service.config.baseUrl) throw new ApiError("FORBIDDEN");

  if (pathname === "/admin/password") {
    const input = await form(req, ["current", "next", "confirm"]);
    const current = input.get("current")!.normalize("NFC");
    const next = input.get("next")!.normalize("NFC");
    const confirm = input.get("confirm")!.normalize("NFC");
    if (!samePassword(password, current)) return passwordSettings(res, "The current password is incorrect.");
    if (!validAdminPassword(next)) return passwordSettings(res, "Use a password of 16–128 characters.");
    if (!samePassword(next, confirm)) return passwordSettings(res, "The new passwords do not match.");
    if (samePassword(password, next)) return passwordSettings(res, "Choose a different password.");
    await changeAdminPassword(service, authorization.verifier, next);
    page(res, "Password updated", "Use your new password with the username admin when the browser prompts you.",
      '<a class="button primary" href="/admin">Sign in again</a>');
    return;
  }
  if (pathname === "/admin/token/save") {
    const token = (await form(req, ["token"])).get("token")!;
    if (token.length !== 43 || !opaque.test(token) || !await service.saveEnrollment(token)) {
      return saveCode(res, "The code could not be saved. Check the current code or return to the overview.");
    }
    accessCode(res, service.config.baseUrl, token, "Access code saved");
    return;
  }
  req.resume();
  if (pathname === "/admin/token/reveal") return accessCode(res, service.config.baseUrl, await service.revealEnrollment());
  if (pathname === "/admin/token/rotate") return accessCode(res, service.config.baseUrl, await service.rotateEnrollment());
  const match = /^\/admin\/connections\/([^/]+)\/disconnect$/.exec(pathname);
  if (!match || !uuid.test(match[1]!)) throw new ApiError("NOT_FOUND");
  await service.disconnect(match[1]!);
  res.writeHead(303, { Location: "/admin" });
  res.end();
}
