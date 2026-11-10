import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, digest, uuid } from "./core.js";
import type { CalendarService } from "./service.js";

function authenticated(req: IncomingMessage, expectedDigest: string) {
  const headers = req.headersDistinct.authorization;
  if (headers?.length !== 1) return false;
  const value = /^Basic ([A-Za-z0-9+/]{66}==)$/i.exec(headers[0]!);
  if (!value) return false;
  const credential = /^admin:([A-Za-z0-9_-]{43})$/.exec(Buffer.from(value[1]!, "base64").toString("latin1"));
  return credential !== null && timingSafeEqual(Buffer.from(digest(credential[1]!)), Buffer.from(expectedDigest));
}

function escape(value: string) {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, char => entities[char]!);
}

function masked(calendar: string) {
  return calendar.length > 5 ? `${calendar.slice(0, 2)}…${calendar.slice(-3)}` : "•••";
}

function page(res: ServerResponse, content: string) {
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gabriel Calendar administration</title><main><h1>Gabriel Calendar administration</h1>${content}</main></html>`);
}

export async function admin(service: CalendarService, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!authenticated(req, service.config.adminTokenDigest)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Gabriel Calendar administration", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8" });
    res.end("Administrator authentication required.");
    return;
  }

  if (req.method === "GET" && url.pathname === "/admin") {
    const after = url.searchParams.get("after");
    if ([...url.searchParams.keys()].some(key => key !== "after") ||
        url.searchParams.getAll("after").length > 1 || (after !== null && !uuid.test(after))) {
      throw new ApiError("INVALID_ARGUMENT");
    }
    const result = await service.administration(after ?? "");
    const rows = result.connections.map(connection => `<tr>
<td>${escape(masked(connection.calendar_id))}</td><td><code>${escape(connection.id)}</code></td>
<td>${escape(connection.status)}</td><td>${escape(connection.last_sync_at?.toISOString() ?? "—")}</td>
<td>${connection.status === "disconnected" ? "—" :
  `<form method="post" action="/admin/connections/${escape(connection.id)}/disconnect"><button type="submit">Disconnect</button></form>`}</td></tr>`);
    page(res, `<h2>Team enrollment token</h2>
<p>${result.rotatedAt ? `Last rotated ${escape(result.rotatedAt.toISOString())}.` : "No enrollment token has been created."}</p>
<p>Rotation invalidates the previous token and unfinished authorizations. Existing connections remain active.</p>
<form method="post" action="/admin/token/rotate"><button type="submit">${result.rotatedAt ? "Reset token" : "Create token"}</button></form>
<h2>Calendar connections</h2><table><thead><tr><th>Calendar</th><th>Connection ID</th><th>Status</th><th>Last sync</th><th>Action</th></tr></thead>
<tbody>${rows.join("") || '<tr><td colspan="5">No connections.</td></tr>'}</tbody></table>
${result.next ? `<p><a href="/admin?after=${escape(result.next)}">Next page</a></p>` : ""}`);
    return;
  }

  if (req.method !== "POST") throw new ApiError("NOT_FOUND");
  const origin = req.headersDistinct.origin;
  if (origin?.length !== 1 || origin[0] !== service.config.baseUrl) throw new ApiError("FORBIDDEN");
  if (url.search) throw new ApiError("INVALID_ARGUMENT");
  req.resume();
  if (url.pathname === "/admin/token/rotate") {
    const token = await service.rotateEnrollment();
    page(res, `<h2>New enrollment token</h2><p>Copy it to your team's secret store. This page displays it once.</p>
<p><code>${escape(token)}</code></p><p><a href="/admin">Back to administration</a></p>`);
    return;
  }
  const match = /^\/admin\/connections\/([^/]+)\/disconnect$/.exec(url.pathname);
  if (!match || !uuid.test(match[1]!)) throw new ApiError("NOT_FOUND");
  await service.disconnect(match[1]!);
  res.writeHead(303, { Location: "/admin" });
  res.end();
}
