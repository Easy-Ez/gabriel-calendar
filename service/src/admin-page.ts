import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

const styles = `
  :root { color-scheme: light; font-family: system-ui, sans-serif; color: #20243a; background: #f4f5fa;
    --muted: #555e76; --border: #dfe3ed; --accent: #4539b8; --danger: #a22b46; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  a { color: var(--accent); }
  a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible, .table-wrap:focus-visible {
    outline: 3px solid #7466e8; outline-offset: 3px;
  }
  .frame { width: min(100% - 2rem, 69rem); margin: auto; }
  header { background: #fff; border-bottom: 1px solid var(--border); }
  header .frame { min-height: 4.25rem; display: flex; align-items: center; gap: .8rem; }
  .brand { background: #ebe8ff; color: #4436b6; width: 2.5rem; height: 2.5rem;
    border-radius: .75rem; display: grid; place-items: center; flex: none; }
  .brand-name { color: #20243a; font-weight: 700; text-decoration: none; }
  .admin-label { margin-inline-start: auto; font-size: .8rem; color: var(--muted); }
  main.frame { padding-block: clamp(2rem, 5vw, 4rem); }
  .eyebrow { margin: 0 0 .35rem; color: var(--accent); font-size: .76rem;
    font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
  h1 { font-size: clamp(1.95rem, 5vw, 2.8rem); letter-spacing: -.045em; margin: 0; line-height: 1.12; }
  h2 { font-size: 1.15rem; margin: 0; letter-spacing: -.015em; }
  p { line-height: 1.55; }
  .intro { margin: .65rem 0 1.65rem; color: var(--muted); }
  .grid { display: grid; grid-template-columns: 3fr 2fr; gap: 1rem; }
  .card { background: #fff; border: 1px solid var(--border); border-radius: 1rem;
    padding: clamp(1rem, 3vw, 1.5rem); box-shadow: 0 3px 10px #34365b08; min-width: 0; }
  .card p { margin: .45rem 0 .9rem; }
  .narrow { max-width: 37rem; }
  .stack { display: grid; gap: 1rem; }
  .stack form { display: grid; gap: .85rem; }
  .muted, .empty { color: var(--muted); }
  .small { font-size: .85rem; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; }
  .button { display: inline-flex; align-items: center; justify-content: center; min-height: 2.5rem;
    border: 1px solid var(--border); border-radius: .55rem; background: #fff; color: #262944;
    padding: .5rem .85rem; font: inherit; font-size: .875rem; font-weight: 650; cursor: pointer; text-decoration: none; }
  .button:hover { background: #f3f2fb; }
  .primary { color: #fff; background: var(--accent); border-color: var(--accent); }
  .primary:hover { background: #392ea0; }
  .danger { color: var(--danger); border-color: #eacbd4; }
  .danger:hover { background: #fff0f3; }
  .meta { font-size: .8rem; color: var(--muted); }
  .chip { display: inline-block; padding: .22rem .55rem; border-radius: 1rem;
    font-size: .75rem; font-weight: 650; color: #475369; background: #eef1f6; white-space: nowrap; }
  .chip.active { color: #126044; background: #e1f5eb; }
  .chip.auth_required { color: #80510a; background: #fff3d8; }
  details { margin-top: .85rem; }
  details p { color: var(--muted); font-size: .875rem; }
  summary { width: fit-content; cursor: pointer; color: var(--accent); font-size: .875rem; font-weight: 650; }
  .connections { margin-top: 1rem; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { border-bottom: 1px solid var(--border); padding: .75rem .55rem; font-size: .875rem; }
  th { color: var(--muted); font-size: .76rem; letter-spacing: .04em; text-transform: uppercase; }
  th:first-child, td:first-child { padding-left: 0; }
  tbody tr:last-child td { border-bottom: 0; }
  td details { margin: 0; }
  td time { white-space: nowrap; }
  code, .mono { font: .86rem ui-monospace, monospace; overflow-wrap: anywhere; }
  .field { display: grid; gap: .3rem; font-size: .875rem; font-weight: 650; }
  input { width: 100%; min-width: 0; min-height: 2.6rem; border: 1px solid #aeb6cb; border-radius: .5rem;
    padding: .55rem .65rem; background: #fff; color: inherit; font: inherit; }
  input[readonly] { background: #f5f6fc; }
  .notice { border: 1px solid #eacbd4; background: #fff2f5; color: #8c233a; padding: .65rem .8rem; border-radius: .5rem; }
  @media (max-width: 44rem) { .grid { grid-template-columns: 1fr; } }
`;

const copyScript = `
  const field = document.querySelector("#access-code");
  const status = document.querySelector("#copy-status");
  document.querySelector("#copy-code").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(field.value);
      status.textContent = "Access code copied.";
    } catch {
      field.focus();
      field.select();
      status.textContent = "Access code selected. Use your device’s copy command.";
    }
  });
`;

const hash = (value: string) => "'sha256-" + createHash("sha256").update(value).digest("base64") + "'";

export function escape(value: string) {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, char => entities[char]!);
}

export function page(res: ServerResponse, title: string, description: string, content: string, copy = false) {
  const script = copy ? `; script-src ${hash(copyScript)}` : "";
  res.setHeader("Content-Security-Policy", `default-src 'none'; frame-ancestors 'none'; form-action 'self';
    base-uri 'none'; style-src ${hash(styles)}${script}`.replace(/\s+/g, " "));
  // Chromium omits the same-origin POST's Origin with the service-wide no-referrer policy.
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Gabriel Calendar</title>
<style>${styles}</style></head><body>
<header><div class="frame"><span class="brand" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"
 stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 10h18m-13 5h2m4 0h2"/></svg></span>
<a class="brand-name" href="/admin">Gabriel Calendar</a><span class="admin-label">Administrator</span></div></header>
<main class="frame"><p class="eyebrow">Administration</p><h1>${escape(title)}</h1>
<p class="intro">${escape(description)}</p>${content}</main>${copy ? `<script>${copyScript}</script>` : ""}</body></html>`);
}
