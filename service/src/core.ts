import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export const callbackPath = "/v1/google/oauth/callback";
export const webhookPath = "/v1/google/webhook";
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const opaque = /^[A-Za-z0-9_-]{43}$/;
export const eventId = /^[A-Za-z0-9_-]{1,1024}$/;
export const calendarId = /^(?!\.{1,2}$)[A-Za-z0-9_@.+#-]{1,512}$/;
export const subjectId = /^[A-Za-z0-9_-]{1,128}$/;
export const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
export const nonce = () => randomBytes(32).toString("base64url");

const errors = {
  INVALID_ARGUMENT: [400, "Invalid request"],
  AUTH_REQUIRED: [401, "Authorization is required"],
  FORBIDDEN: [403, "Operation is outside the authorized scope"],
  OAUTH_CONSENT_DENIED: [403, "Google consent was declined or blocked"],
  OAUTH_SCOPE_MISSING: [403, "Google did not grant all required Calendar permissions"],
  OAUTH_OFFLINE_GRANT_MISSING: [403, "Google did not grant offline access"],
  OAUTH_PRIMARY_UNAVAILABLE: [403, "Google did not return an owned primary calendar"],
  OAUTH_PRIMARY_MISMATCH: [403, "The authorized primary calendar does not match the linked account"],
  OAUTH_PRIMARY_IN_USE: [403, "This primary calendar is linked to another project user"],
  OAUTH_GOOGLE_DENIED: [403, "Google refused Calendar access for this authorization"],
  NOT_FOUND: [404, "Resource not found"],
  CONNECTION_BUSY: [409, "Another operation is in progress"],
  READER_BUSY: [409, "A notification reader is already active for this consumer"],
  VERSION_CONFLICT: [409, "The event version changed"],
  IDEMPOTENCY_CONFLICT: [409, "The idempotency key was already used for a different request"],
  SYNC_PENDING: [409, "The initial calendar sync is pending"],
  CURSOR_EXPIRED: [410, "The notification checkpoint expired"],
  RATE_LIMITED: [429, "Rate limit reached"],
  OUTCOME_UNKNOWN: [502, "The write could not be confirmed"],
  PROVIDER_UNAVAILABLE: [503, "The calendar provider is temporarily unavailable"],
  INTERNAL: [500, "Request failed"],
} as const;

export class ApiError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof errors, readonly retryAfter?: number) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}

export interface Settings {
  baseUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  dataKey: Buffer;
  projectSessions: ReadonlyMap<string, string>; // credential digest → deployment-assigned subject
  catchupMs: number;
  tickMs: number;
  retentionMs: number;
  renewLeadMs: number;
}

export class Security {
  private readonly encryptionKey: Buffer;

  constructor(private readonly key: Buffer) {
    this.encryptionKey = Buffer.from(hkdfSync("sha256", key, "", "gabriel-calendar:refresh:v1", 32));
  }
  sign(purpose: string, value: string) {
    return createHmac("sha256", this.key).update(purpose).update("\0").update(value).digest("base64url");
  }
  cursor(consumer: string, seq: string) {
    return `${seq}.${this.sign("delivery", `${consumer}:${seq}`)}`;
  }
  readCursor(consumer: string, cursor: unknown) {
    if (typeof cursor !== "string") throw new ApiError("INVALID_ARGUMENT");
    const match = /^(0|[1-9]\d{0,18})\.([A-Za-z0-9_-]{43})$/.exec(cursor);
    if (!match || BigInt(match[1]!) > 9223372036854775807n ||
        !timingSafeEqual(Buffer.from(this.cursor(consumer, match[1]!)), Buffer.from(cursor))) {
      throw new ApiError("INVALID_ARGUMENT");
    }
    return match[1]!;
  }
  encrypt(connection: string, value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(connection));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }
  decrypt(connection: string, value: string) {
    const data = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(connection));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function text(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

export function retryAfter(value: string | null, fallback = 5) {
  const seconds = value && /^\d+$/.test(value) ? Number(value) : NaN;
  const date = value ? Date.parse(value) : NaN;
  return Math.max(1, Math.min(3600, Number.isFinite(seconds) ? seconds :
    Number.isFinite(date) ? Math.ceil((date - Date.now()) / 1000) : fallback));
}

export async function transaction<T>(client: PoolClient, fn: () => Promise<T>) {
  await client.query("BEGIN");
  try {
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Session advisory locks allow webhook enqueue and other short transactions during provider I/O.
export async function locked<T>(pool: Pool, key: string, fn: (client: PoolClient, lost: AbortSignal) => Promise<T>) {
  const client = await pool.connect();
  let acquired = false;
  let broken = false;
  const lost = new AbortController();
  const onError = () => { broken = true; lost.abort(); };
  client.on("error", onError);
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", [key]);
    acquired = result.rows[0]!.acquired;
    if (acquired) return await fn(client, lost.signal);
  } finally {
    try {
      if (acquired && !broken) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    } catch {
      broken = true;
    } finally {
      client.off("error", onError);
      client.release(broken);
    }
  }
}

export interface Connection {
  id: string;
  owner_id: string;
  calendar_id: string;
  refresh_ciphertext: string | null;
  status: "active" | "auth_required" | "disconnected";
  sync_token: string | null;
  last_sync_at: Date | null;
  last_webhook_at: Date | null;
  webhook_count: string;
  synced_webhook_count: string;
  onboarding_bound_at: Date | null;
  onboarding_oauth_ms: number | null;
  onboarding_sync_started_at: Date | null;
  onboarding_sync_completed_at: Date | null;
  onboarding_watch_started_at: Date | null;
  onboarding_watch_completed_at: Date | null;
  onboarding_webhook_at: Date | null;
  sync_due_at: Date;
  sync_retry_at: Date;
  watch_retry_at: Date;
  revision: string;
  synced_revision: string;
  pruned_through: string;
}

export const log = (metadata: Record<string, string | number>) => {
  process.stderr.write(JSON.stringify(metadata) + "\n");
};
