import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { log, opaque, text, transaction } from "./core.js";
import type { Settings } from "./core.js";
import { httpServer } from "./http.js";
import { CalendarService } from "./service.js";

const { Pool } = pg;
const migrations = ["001_initial.sql", "002_event_create.sql", "003_event_manage.sql", "004_event_guests.sql",
  "005_onboarding_timing.sql", "006_delivery_timing.sql", "007_reserved.sql", "008_consumer_write_defaults.sql",
  "009_shared_enrollment.sql"];

function required(name: string, max = 8192) {
  const value = process.env[name];
  if (!text(value, max)) throw new Error(name);
  return value;
}

function numberSetting(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(name);
  return value;
}

function settings(): Settings {
  const origin = required("PUBLIC_BASE_URL", 2048);
  if (!/^https:\/\/[^/?#\s\\]+\/?$/.test(origin) || /[\x00-\x20\x7f]/.test(origin)) {
    throw new Error("PUBLIC_BASE_URL");
  }
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash ||
      base.username || base.password) throw new Error("PUBLIC_BASE_URL");

  const rawKey = required("GABRIEL_DATA_KEY", 43);
  const dataKey = Buffer.from(rawKey, "base64url");
  if (!opaque.test(rawKey) || dataKey.toString("base64url") !== rawKey) throw new Error("GABRIEL_DATA_KEY");
  const adminTokenDigest = required("GABRIEL_ADMIN_TOKEN_DIGEST", 43);
  if (!opaque.test(adminTokenDigest)) throw new Error("GABRIEL_ADMIN_TOKEN_DIGEST");
  return {
    baseUrl: base.origin,
    googleClientId: required("GOOGLE_CLIENT_ID", 512),
    googleClientSecret: required("GOOGLE_CLIENT_SECRET", 512),
    dataKey, adminTokenDigest,
    tickMs: numberSetting("GABRIEL_TICK_MS", 1000, 250, 60_000),
    catchupMs: numberSetting("GABRIEL_CATCHUP_MS", 300_000, 10_000, 3_600_000),
    retentionMs: numberSetting("GABRIEL_RETENTION_MS", 7 * 86400_000, 60_000, 30 * 86400_000),
    renewLeadMs: 3_600_000,
  };
}

export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await transaction(client, async () => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('gabriel-calendar:migrate', 0))");
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)");
      for (const [index, filename] of migrations.entries()) {
        const version = index + 1;
        const { rowCount } = await client.query("SELECT version FROM schema_migrations WHERE version=$1", [version]);
        if (!rowCount) {
          const sql = await readFile(new URL(`../../../service/migrations/${filename}`, import.meta.url), "utf8");
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        }
      }
    });
  } finally {
    client.release();
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode && mode !== "migrate") throw new Error("command");
  const pool = new Pool({
    connectionString: required("DATABASE_URL"),
    max: 24,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15_000,
  });
  pool.on("error", () => log({ operation: "database", code: "CONNECTION_LOST" }));
  if (mode === "migrate") {
    try { await migrate(pool); } finally { await pool.end(); }
    return;
  }

  const config = settings();
  const host = process.env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "0.0.0.0" && host !== "::1") throw new Error("HOST");
  const port = numberSetting("PORT", 8080, 1, 65535);
  const { rowCount } = await pool.query("SELECT version FROM schema_migrations WHERE version=$1", [migrations.length]);
  if (!rowCount) throw new Error("migration");
  const service = new CalendarService(pool, config);
  const shutdown = new AbortController();
  const server = httpServer(service, shutdown.signal);
  process.once("SIGINT", () => shutdown.abort());
  process.once("SIGTERM", () => shutdown.abort());
  await service.startDelivery().catch(() => log({ operation: "delivery", code: "LISTEN_UNAVAILABLE" }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  log({ operation: "listen", port });
  while (!shutdown.signal.aborted) {
    await service.startDelivery().catch(() => log({ operation: "delivery", code: "LISTEN_UNAVAILABLE" }));
    await service.tick().catch(() => log({ operation: "worker", code: "INTERNAL" }));
    await delay(config.tickMs, undefined, { signal: shutdown.signal }).catch(() => {});
  }
  await new Promise<void>(resolve => server.close(() => resolve()));
  service.stopDelivery();
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    log({ operation: "startup", code: "STARTUP_FAILED" });
    process.exitCode = 1;
  });
}
