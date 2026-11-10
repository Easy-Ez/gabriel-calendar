import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import { ApiError, digest, locked, log, nonce, Security, transaction, uuid } from "./core.js";
import type { Connection, Settings } from "./core.js";
import { classify, Google, GoogleError, providerError, watchTtl } from "./google.js";
import type { CalendarEvent, CreateEvent, GoogleWrite, Payload, Rsvp, UpdateEvent } from "./google.js";

const sessionLifetimeMs = 15 * 60_000;
const maxBatch = 25;
const heartbeatMs = 12_000;
const deliveryChannel = "gabriel_delivery";
type Delivery = Payload & {
  schemaVersion: 1; notificationId: string; cursor: string; connectionId: string; observedAt: Date;
};
type StreamOutput = { ready(): Promise<void>; send(notice: Delivery): Promise<void>; heartbeat(): Promise<void> };
const pendingWatchMs = watchTtl * 1000;
type Session = {
  id: string; owner_id: string; status: string; connection_id: string | null; expires_at: Date;
  callback_started_at: Date | null; callback_completed_at: Date | null;
};
type Consumer = { checkpoint: string };
type CreateRequest = { event_id: string; request_digest: string; confirmed: boolean };

function elapsed(start: Date | null, finish: Date | null) {
  return start && finish ? Math.max(0, finish.getTime() - start.getTime()) : null;
}

function onboarding(connection: Connection, watchExpiresAt: Date | null) {
  const stage = connection.status !== "active" ? "unavailable" :
    !connection.last_sync_at ? (connection.onboarding_sync_started_at ? "initial_sync" : "waiting_for_initial_sync") :
    !watchExpiresAt ? (connection.onboarding_watch_started_at && !connection.onboarding_watch_completed_at
      ? "watch_registration" : "waiting_for_watch") :
    !connection.last_webhook_at ? "waiting_for_webhook" : "ready";
  const { onboarding_bound_at: bound, onboarding_oauth_ms: oauth, onboarding_sync_started_at: syncStart,
    onboarding_sync_completed_at: syncEnd, onboarding_watch_started_at: watchStart,
    onboarding_watch_completed_at: watchEnd, onboarding_webhook_at: webhook } = connection;
  const ready = watchEnd && webhook ? new Date(Math.max(watchEnd.getTime(), webhook.getTime())) : null;
  const afterBinding = elapsed(bound, ready);
  return {
    stage, oauthCallbackMs: oauth, syncQueueMs: elapsed(bound, syncStart),
    initialSyncMs: elapsed(syncStart, syncEnd), watchQueueMs: elapsed(syncEnd, watchStart),
    watchRegistrationMs: elapsed(watchStart, watchEnd), firstWebhookMs: elapsed(watchStart, webhook),
    totalMs: oauth !== null && afterBinding !== null ? oauth + afterBinding : null,
  };
}

export class CalendarService {
  private readonly security: Security;
  private readonly owners: ReadonlySet<string>;
  private activeReaders = 0;
  private readonly delivery = new EventEmitter().setMaxListeners(0);
  private deliveryListener?: PoolClient;
  private readonly access = new Map<string, { ciphertext: string; value: string; expiresAt: number }>();

  constructor(readonly pool: Pool, readonly config: Settings, private readonly google = new Google(config)) {
    this.security = new Security(config.dataKey);
    this.owners = new Set(config.projectSessions.values());
  }

  project(bearer: string) {
    const owner = this.config.projectSessions.get(digest(bearer));
    if (!owner) throw new ApiError("AUTH_REQUIRED");
    return owner;
  }

  async connect(owner: string) {
    const id = randomUUID();
    const state = nonce();
    const expiresAt = new Date(Date.now() + sessionLifetimeMs);
    await this.pool.query(
      "INSERT INTO connect_sessions (id,owner_id,state_digest,status,expires_at) VALUES ($1,$2,$3,'pending',$4)",
      [id, owner, digest(state), expiresAt]);
    return { sessionId: id, authorizationUrl: this.google.authorization(state, this.security.sign("pkce", state)), expiresAt };
  }

  async consent(owner: string, id: string) {
    const { rows: [session] } = await this.pool.query<Session>(
      "SELECT * FROM connect_sessions WHERE id=$1 AND owner_id=$2 AND expires_at>now()", [id, owner]);
    if (!session) throw new ApiError("NOT_FOUND");
    return {
      status: session.status === "processing" ? "pending" : session.status,
      oauth: {
        phase: session.status === "pending" ? "waiting_for_callback" :
          session.status === "connected" ? "completed" : session.status,
        durationMs: elapsed(session.callback_started_at, session.callback_completed_at),
      },
      ...(session.connection_id ? { connectionId: session.connection_id } : {}),
    };
  }

  async callback(state: string, code: string | null) {
    const { rows: [session] } = await this.pool.query<Session>(
      `UPDATE connect_sessions SET status='processing',callback_started_at=clock_timestamp()
       WHERE state_digest=$1 AND status='pending' AND expires_at>now() RETURNING *`, [digest(state)]);
    if (!session) throw new ApiError("INVALID_ARGUMENT");

    try {
      if (!this.owners.has(session.owner_id)) throw new ApiError("FORBIDDEN");
      if (!code) throw new ApiError("OAUTH_CONSENT_DENIED");
      const tokens = await this.google.exchange(code, this.security.sign("pkce", state));
      if (!tokens.refresh) throw new ApiError("OAUTH_OFFLINE_GRANT_MISSING");
      const calendar = await this.google.primary(tokens.access);
      await this.bindPrimary(session, calendar, tokens.refresh);
    } catch (error) {
      await this.pool.query(
        "UPDATE connect_sessions SET status='failed',callback_completed_at=clock_timestamp() WHERE id=$1", [session.id]);
      if (error instanceof GoogleError) {
        if (error.reason === "invalid_grant") throw new ApiError("INVALID_ARGUMENT");
        if (error.reason === "insufficient_scope" || error.reason === "insufficientPermissions") {
          throw new ApiError("OAUTH_SCOPE_MISSING");
        }
        if (error.reason === "primary_role_mismatch") throw new ApiError("OAUTH_PRIMARY_UNAVAILABLE");
        const mapped = providerError(error);
        throw mapped.code === "FORBIDDEN" ? new ApiError("OAUTH_GOOGLE_DENIED") : mapped;
      }
      throw error;
    }
  }

  private async bindPrimary(session: Session, calendar: string, refresh: string) {
    const owner = session.owner_id;
    const db = await this.pool.connect();
    try {
      await transaction(db, async () => {
        // Serialize binding by both identities so concurrent OAuth callbacks cannot claim either twice.
        for (const key of [`oauth-owner:${owner}`, `oauth-calendar:${calendar}`]) {
          await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        }
        const { rows: [conflict] } = await db.query<{ owner_id: string }>(
          `SELECT owner_id FROM connections WHERE status<>'disconnected'
           AND ((owner_id=$1 AND calendar_id<>$2) OR (owner_id<>$1 AND calendar_id=$2)) LIMIT 1`,
          [owner, calendar]);
        if (conflict) {
          throw new ApiError(conflict.owner_id === owner ? "OAUTH_PRIMARY_MISMATCH" : "OAUTH_PRIMARY_IN_USE");
        }
        const { rows: [existing] } = await db.query<{ id: string }>(
          "SELECT id FROM connections WHERE owner_id=$1 AND calendar_id=$2", [owner, calendar]);
        const id = existing?.id ?? randomUUID();
        const encrypted = this.security.encrypt(id, refresh);
        let initialize = !existing;
        if (existing) {
          // This is the same lock that protects synchronization, RSVP and disconnect.
          const deadline = Date.now() + 5000;
          while (true) {
            const { rows: [result] } = await db.query<{ acquired: boolean }>(
              "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired", [`connection:${id}`]);
            if (result?.acquired) break;
            if (Date.now() >= deadline) throw new ApiError("CONNECTION_BUSY");
            await delay(75);
          }
          const { rows: [current] } = await db.query<{ status: Connection["status"] }>(
            "SELECT status FROM connections WHERE id=$1", [id]);
          initialize = current?.status === "disconnected";
          await db.query(
            `UPDATE connections SET status='active',refresh_ciphertext=$2,revision=revision+1,
             sync_retry_at=now(),watch_retry_at=now() WHERE id=$1`, [id, encrypted]);
        } else {
          await db.query(
            `INSERT INTO connections (id,owner_id,calendar_id,refresh_ciphertext,status)
             VALUES ($1,$2,$3,$4,'active')`, [id, owner, calendar, encrypted]);
        }
        const { rows: [finished] } = await db.query<Session>(
          `UPDATE connect_sessions SET status='connected',connection_id=$2,callback_completed_at=clock_timestamp()
           WHERE id=$1 RETURNING callback_started_at,callback_completed_at`, [session.id, id]);
        if (initialize) {
          await db.query(
            `UPDATE connections SET onboarding_bound_at=$2,onboarding_oauth_ms=$3,
             onboarding_sync_started_at=NULL,onboarding_sync_completed_at=NULL,onboarding_watch_started_at=NULL,
             onboarding_watch_completed_at=NULL,onboarding_webhook_at=NULL WHERE id=$1`,
            [id, finished!.callback_completed_at, elapsed(finished!.callback_started_at, finished!.callback_completed_at)]);
        }
      });
    } finally {
      db.release();
    }
  }

  private async exclusive<T>(id: string, fn: (client: PoolClient) => Promise<T>) {
    const until = Date.now() + 5000;
    do {
      const value = await locked(this.pool, `connection:${id}`, fn);
      if (value !== undefined) return value;
      await delay(75);
    } while (Date.now() < until);
  }

  private async connection(id: string, db: Pool | PoolClient = this.pool) {
    const { rows: [connection] } = await db.query<Connection>("SELECT * FROM connections WHERE id=$1", [id]);
    if (!connection) throw new ApiError("NOT_FOUND");
    return connection;
  }

  private active(connection: Connection) {
    if (connection.status !== "active") throw new ApiError("AUTH_REQUIRED");
    if (!this.owners.has(connection.owner_id)) throw new ApiError("FORBIDDEN");
  }

  private async grant(bearer: string, connection: string, consumer?: string, db: Pool | PoolClient = this.pool) {
    const { rowCount } = await db.query(
      `SELECT 1 FROM consumers WHERE connection_id=$1 AND grant_digest=$2 AND NOT revoked
       AND ($3::uuid IS NULL OR id=$3)`, [connection, digest(bearer), consumer ?? null]);
    if (!rowCount) throw new ApiError("AUTH_REQUIRED");
  }

  async status(bearer: string, id: string) {
    const owner = this.config.projectSessions.get(digest(bearer));
    if (!owner) await this.grant(bearer, id);
    const connection = await this.connection(id);
    if (owner && owner !== connection.owner_id) throw new ApiError("NOT_FOUND");
    const { rows: [watch] } = await this.pool.query<{ expires: Date | null }>(
      "SELECT max(expires_at) AS expires FROM channels WHERE connection_id=$1 AND resource_id IS NOT NULL AND expires_at>now()",
      [id]);
    const watchExpiresAt = watch?.expires ?? null;
    return {
      connectionId: id,
      status: connection.status,
      watchedCalendars: connection.status === "disconnected" ? [] : [connection.calendar_id],
      lastSyncAt: connection.last_sync_at,
      lastWebhookAt: connection.last_webhook_at,
      watchExpiresAt,
      onboarding: onboarding(connection, watchExpiresAt),
      capabilities: connection.status === "active" && this.owners.has(connection.owner_id)
        ? ["events.read", "events.rsvp", "events.create", "events.update", "events.cancel"] : [],
    };
  }

  async pair(owner: string, id: string) {
    const consumer = randomUUID();
    const credential = nonce();
    const db = await this.pool.connect();
    try {
      return await transaction(db, async () => {
        const { rows: [connection] } = await db.query<Connection>(
          "SELECT * FROM connections WHERE id=$1 AND owner_id=$2 FOR UPDATE", [id, owner]);
        if (!connection) throw new ApiError("NOT_FOUND");
        this.active(connection);
        const expired = await this.expiredThrough(db, id, connection.pruned_through);
        await db.query(
          `INSERT INTO consumers (id,connection_id,grant_digest,checkpoint) VALUES ($1,$2,$3,$4)`,
          [consumer, id, digest(credential), expired]);
        return { connectionId: id, consumerId: consumer, credential };
      });
    } finally {
      db.release();
    }
  }

  private async expiredThrough(db: Pool | PoolClient, id: string, pruned: string) {
    const { rows: [boundary] } = await db.query<{ seq: string }>(
      `SELECT greatest($2::bigint,coalesce(max(seq),0)) AS seq FROM notifications
       WHERE connection_id=$1 AND observed_at<=now()-$3::bigint*interval '1 millisecond'`,
      [id, pruned, this.config.retentionMs]);
    return boundary!.seq;
  }

  async startDelivery() {
    if (this.deliveryListener) return;
    const client = await this.pool.connect();
    this.deliveryListener = client;
    client.on("notification", message => {
      if (message.channel === deliveryChannel && message.payload?.length === 36 && uuid.test(message.payload)) {
        this.delivery.emit(message.payload);
      }
    });
    client.on("error", () => this.releaseDelivery(client));
    try {
      await client.query("LISTEN gabriel_delivery");
    } catch (error) {
      this.releaseDelivery(client);
      throw error;
    }
  }

  private releaseDelivery(client: PoolClient) {
    if (this.deliveryListener !== client) return;
    this.deliveryListener = undefined;
    client.release(true);
  }

  stopDelivery() {
    if (this.deliveryListener) this.releaseDelivery(this.deliveryListener);
  }

  private async wakeDelivery(db: PoolClient, id: string) {
    await db.query("SELECT pg_notify($1,$2)", [deliveryChannel, id]);
  }

  private async withReader<T>(bearer: string, id: string, consumer: string, run: (db: PoolClient, lost: AbortSignal) => Promise<T>) {
    await this.grant(bearer, id, consumer);
    if (this.activeReaders >= Math.max(1, this.pool.options.max - 8)) throw new ApiError("RATE_LIMITED", 1);
    this.activeReaders++;
    try {
      const result = await locked(this.pool, `consumer:${consumer}`, run);
      if (result === undefined) throw new ApiError("READER_BUSY", 1);
      return result;
    } finally {
      this.activeReaders--;
    }
  }

  private async deliveryBatch(db: PoolClient, bearer: string, id: string, consumer: string, sent?: string) {
    return transaction(db, async () => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await this.grant(bearer, id, consumer, db);
      const connection = await this.connection(id, db);
      this.active(connection);
      const { rows: [position] } = await db.query<Consumer>(
        "SELECT checkpoint FROM consumers WHERE id=$1", [consumer]);
      const checkpoint = BigInt(position!.checkpoint);
      const expired = await this.expiredThrough(db, id, connection.pruned_through);
      if (checkpoint < BigInt(expired)) throw new ApiError("CURSOR_EXPIRED");
      // Keep at most one unacknowledged batch in flight.
      if (sent && checkpoint < BigInt(sent)) return [];
      const { rows } = await db.query<{ seq: string; payload: Payload; observed_at: Date }>(
        `SELECT seq,payload,observed_at FROM notifications WHERE connection_id=$1 AND seq>$2
         ORDER BY seq LIMIT $3`, [id, position!.checkpoint, maxBatch]);
      return rows.map(row => ({
        seq: row.seq,
        notice: {
          ...row.payload, schemaVersion: 1 as const, notificationId: `${id}:${row.seq}`,
          cursor: this.security.cursor(consumer, row.seq), connectionId: id, observedAt: row.observed_at,
        },
      }));
    });
  }

  async poll(bearer: string, id: string, consumer: string, wait: number, signal: AbortSignal) {
    const until = Date.now() + wait * 1000;
    return this.withReader(bearer, id, consumer, async (db, lost) => {
      const abort = AbortSignal.any([signal, lost]);
      while (!abort.aborted) {
        const batch = await this.deliveryBatch(db, bearer, id, consumer);
        if (batch.length || Date.now() >= until) return { notifications: batch.map(item => item.notice) };
        await delay(Math.min(250, Math.max(0, until - Date.now())), undefined, { signal: abort }).catch(() => {});
      }
      return { notifications: [] };
    });
  }

  async stream(bearer: string, id: string, consumer: string, signal: AbortSignal, output: StreamOutput) {
    await this.withReader(bearer, id, consumer, async (db, lost) => {
      const abort = AbortSignal.any([signal, lost]);
      let sent: string | undefined;
      let ready = false;
      let heartbeatAt = Date.now() + heartbeatMs;
      while (!abort.aborted) {
        // Register before reading the outbox so a commit cannot be missed between the read and wait.
        const changed = new AbortController();
        const wake = () => changed.abort();
        this.delivery.on(id, wake);
        try {
          const batch = await this.deliveryBatch(db, bearer, id, consumer, sent);
          if (abort.aborted) break;
          if (!ready) {
            await output.ready();
            ready = true;
          }
          for (const { seq, notice } of batch) {
            if (abort.aborted) break;
            await output.send(notice);
            sent = seq;
          }
          if (batch.length) continue;
          if (Date.now() >= heartbeatAt) {
            await output.heartbeat();
            heartbeatAt = Date.now() + heartbeatMs;
          }
          await delay(Math.max(0, heartbeatAt - Date.now()), undefined, {
            signal: AbortSignal.any([abort, changed.signal]),
          }).catch(() => {});
        } finally {
          this.delivery.off(id, wake);
        }
      }
      return true;
    });
  }

  async ack(bearer: string, id: string, consumer: string, cursor: unknown) {
    await this.grant(bearer, id, consumer);
    const seq = this.security.readCursor(consumer, cursor);
    const db = await this.pool.connect();
    try {
      await transaction(db, async () => {
        const { rows: [connection] } = await db.query<Connection>(
          "SELECT * FROM connections WHERE id=$1 FOR SHARE", [id]);
        if (!connection) throw new ApiError("NOT_FOUND");
        this.active(connection);
        const { rows: [reader] } = await db.query<Consumer>(
          `SELECT checkpoint FROM consumers WHERE id=$1 AND connection_id=$2 AND grant_digest=$3
           AND NOT revoked FOR UPDATE`, [consumer, id, digest(bearer)]);
        if (!reader) throw new ApiError("AUTH_REQUIRED");
        if (BigInt(seq) <= BigInt(reader.checkpoint)) return;
        const expired = await this.expiredThrough(db, id, connection.pruned_through);
        if (BigInt(reader.checkpoint) < BigInt(expired)) throw new ApiError("CURSOR_EXPIRED");
        await db.query("UPDATE consumers SET checkpoint=$2 WHERE id=$1", [consumer, seq]);
        await this.wakeDelivery(db, id);
      });
    } finally {
      db.release();
    }
  }

  async invitations(bearer: string, id: string, calendar: string, after: string, limit: number) {
    await this.grant(bearer, id);
    const connection = await this.connection(id);
    this.active(connection);
    if (calendar !== "primary" && calendar !== connection.calendar_id) throw new ApiError("NOT_FOUND");
    if (!connection.last_sync_at) throw new ApiError("SYNC_PENDING", 2);
    const { rows } = await this.pool.query<{ snapshot: CalendarEvent }>(
      `SELECT snapshot FROM events WHERE connection_id=$1 AND pending AND event_id>$2
       ORDER BY event_id LIMIT $3`, [id, after, limit + 1]);
    const events = rows.slice(0, limit).map(row => row.snapshot);
    return { events, ...(rows.length > limit ? { nextPageCursor: events.at(-1)!.ref.eventId } : {}) };
  }

  async rsvp(bearer: string, id: string, calendar: string, event: string, status: Rsvp, version?: string) {
    await this.grant(bearer, id);
    const result = await this.exclusive(id, async db => {
      await this.grant(bearer, id, undefined, db);
      const connection = await this.connection(id, db);
      this.active(connection);
      if (calendar !== connection.calendar_id) throw new ApiError("NOT_FOUND");
      try {
        return await this.withAccess(db, connection,
          access => this.google.rsvp(access, calendar, event, status, version));
      } catch (error) {
        if (error instanceof GoogleError) throw providerError(error);
        throw error;
      } finally {
        await db.query("UPDATE connections SET revision=revision+1 WHERE id=$1", [id]);
      }
    });
    if (!result) throw new ApiError("CONNECTION_BUSY", 1);
    return result;
  }

  async create(bearer: string, id: string, calendar: string, key: string, input: CreateEvent) {
    await this.grant(bearer, id);
    const result = await this.exclusive(id, async db => {
      await this.grant(bearer, id, undefined, db);
      const connection = await this.connection(id, db);
      this.active(connection);
      if (calendar !== "primary" && calendar !== connection.calendar_id) throw new ApiError("NOT_FOUND");
      if (input.invitation?.guests.some(email => email.toLowerCase() === connection.calendar_id.toLowerCase())) {
        throw new ApiError("INVALID_ARGUMENT");
      }
      if (!connection.last_sync_at) throw new ApiError("SYNC_PENDING", 2);

      const keyDigest = digest(key);
      const marker = digest(JSON.stringify(input));
      const { rows: [inserted] } = await db.query<CreateRequest>(
        `INSERT INTO event_creates (connection_id,key_digest,request_digest,event_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (connection_id,key_digest) DO NOTHING
         RETURNING event_id,request_digest,confirmed`, [id, keyDigest, marker, randomUUID().replaceAll("-", "")]);
      const saved = inserted ?? (await db.query<CreateRequest>(
        "SELECT event_id,request_digest,confirmed FROM event_creates WHERE connection_id=$1 AND key_digest=$2",
        [id, keyDigest])).rows[0]!;
      if (saved.request_digest !== marker) throw new ApiError("IDEMPOTENCY_CONFLICT");

      let write: GoogleWrite;
      try {
        write = await this.withAccess(db, connection, access =>
          this.google.create(access, connection.calendar_id, saved.event_id, marker, input, !inserted, saved.confirmed));
      } catch (error) {
        if (error instanceof GoogleError) throw providerError(error);
        throw error;
      }
      if (!saved.confirmed) {
        await db.query("UPDATE event_creates SET confirmed=true WHERE connection_id=$1 AND key_digest=$2", [id, keyDigest]);
      }
      return write;
    });
    if (!result) throw new ApiError("CONNECTION_BUSY", 1);
    return result;
  }

  async manage(bearer: string, id: string, calendar: string, event: string, version: string, notify?: boolean, patch?: UpdateEvent) {
    await this.grant(bearer, id);
    const result = await this.exclusive(id, async db => {
      await this.grant(bearer, id, undefined, db);
      const connection = await this.connection(id, db);
      this.active(connection);
      if (calendar !== connection.calendar_id) throw new ApiError("NOT_FOUND");
      if (!connection.last_sync_at) throw new ApiError("SYNC_PENDING", 2);
      try {
        return await this.withAccess(db, connection,
          access => this.google.manage(access, calendar, event, version, { notify, patch }));
      } catch (error) {
        if (error instanceof GoogleError) throw providerError(error);
        throw error;
      }
    });
    if (!result) throw new ApiError("CONNECTION_BUSY", 1);
    return result;
  }

  async disconnect(owner: string, id: string) {
    const result = await this.exclusive(id, async db => {
      const connection = await this.connection(id, db);
      if (connection.owner_id !== owner) throw new ApiError("NOT_FOUND");
      const { rows: watches } = await db.query<{ id: string; resource_id: string }>(
        `SELECT id,resource_id FROM channels WHERE connection_id=$1 AND resource_id IS NOT NULL AND expires_at>now()`,
        [id]);
      await transaction(db, async () => {
        await db.query(
          `UPDATE connections SET status='disconnected',refresh_ciphertext=NULL,sync_token=NULL,last_sync_at=NULL,last_webhook_at=NULL,
           webhook_count=0,synced_webhook_count=0,
           pruned_through=greatest(pruned_through,coalesce((SELECT max(seq) FROM notifications WHERE connection_id=$1),0))
           WHERE id=$1`, [id]);
        await db.query("UPDATE consumers SET revoked=true WHERE connection_id=$1", [id]);
        await db.query("DELETE FROM events WHERE connection_id=$1", [id]);
        await db.query("DELETE FROM notifications WHERE connection_id=$1", [id]);
        await db.query("DELETE FROM channels WHERE connection_id=$1", [id]);
        await this.wakeDelivery(db, id);
      });
      if (watches.length && connection.status === "active") {
        // Local revocation commits even if Google is unreachable.
        try {
          const access = await this.accessFor(db, connection, false);
          await Promise.allSettled(watches.map(watch => this.google.stop(access, watch.id, watch.resource_id)));
        } catch { /* Google expires any remaining channels. */ }
      }
      this.access.delete(id);
      return true;
    });
    if (!result) throw new ApiError("CONNECTION_BUSY", 1);
  }

  async webhook(id: string, token: string, resource: string, state: string, message: string) {
    const { rowCount } = await this.pool.query(
      `WITH eligible AS MATERIALIZED (
        SELECT c.id FROM connections c JOIN channels w ON w.connection_id=c.id
          WHERE w.id=$1 AND w.token_digest=$2 AND w.expires_at>now() AND c.status='active'
            AND (w.resource_id=$3 OR (w.resource_id IS NULL AND $4='sync')) AND w.last_message<$5
          FOR UPDATE OF c
      ), claimed AS (
        UPDATE channels SET last_message=$5 FROM eligible
          WHERE channels.id=$1 AND channels.connection_id=eligible.id AND last_message<$5
            AND (resource_id=$3 OR (resource_id IS NULL AND $4='sync'))
        RETURNING connection_id,clock_timestamp() AS received_at
      )
      UPDATE connections SET revision=revision+1,webhook_count=webhook_count+1,last_webhook_at=claimed.received_at,
       onboarding_webhook_at=CASE WHEN onboarding_watch_started_at IS NOT NULL
         THEN coalesce(onboarding_webhook_at,claimed.received_at) ELSE onboarding_webhook_at END FROM claimed
       WHERE connections.id=claimed.connection_id AND connections.status='active'`,
      [id, digest(token), resource, state, message]);
    return Boolean(rowCount);
  }

  private async accessFor(db: PoolClient, connection: Connection, saveRotation = true) {
    const { id, refresh_ciphertext: ciphertext } = connection;
    if (!ciphertext) throw new ApiError("AUTH_REQUIRED");
    const cached = this.access.get(id);
    if (cached?.ciphertext === ciphertext && cached.expiresAt > Date.now() + 30_000) return cached.value;
    const refresh = this.security.decrypt(id, ciphertext);
    const token = await this.google.refresh(refresh);
    let current = ciphertext;
    if (saveRotation && token.refresh && token.refresh !== refresh) {
      current = this.security.encrypt(id, token.refresh);
      await db.query("UPDATE connections SET refresh_ciphertext=$2 WHERE id=$1", [id, current]);
      connection.refresh_ciphertext = current;
    }
    this.access.set(id, { ciphertext: current, value: token.access, expiresAt: token.expiresAt });
    return token.access;
  }

  private async withAccess<T>(db: PoolClient, connection: Connection, fn: (access: string) => Promise<T>) {
    try {
      const access = await this.accessFor(db, connection);
      try {
        return await fn(access);
      } catch (error) {
        if (!(error instanceof GoogleError) || error.status !== 401) throw error;
        this.access.delete(connection.id);
        return await fn(await this.accessFor(db, connection));
      }
    } catch (error) {
      if (error instanceof GoogleError && (error.status === 401 || error.reason === "invalid_grant" ||
          error.reason === "insufficient_scope")) {
        this.access.delete(connection.id);
        await db.query("UPDATE connections SET status='auth_required' WHERE id=$1", [connection.id]);
        throw new ApiError("AUTH_REQUIRED");
      }
      throw error;
    }
  }

  private async sync(db: PoolClient, connection: Connection) {
    const { id, calendar_id: calendar, sync_token: cursor, revision } = connection;
    if (!cursor && connection.onboarding_bound_at && !connection.onboarding_sync_started_at) {
      await db.query("UPDATE connections SET onboarding_sync_started_at=clock_timestamp() WHERE id=$1", [id]);
    }
    const result = await this.withAccess(db, connection, async access => {
      try {
        const delta = await this.google.list(access, calendar, cursor);
        return { ...delta, gap: false };
      } catch (error) {
        if (!cursor || !(error instanceof GoogleError) || error.status !== 410) throw error;
        const snapshot = await this.google.list(access, calendar, null);
        return { ...snapshot, gap: true };
      }
    });

    await transaction(db, async () => {
      const ids = [...result.observed.keys()];
      const { rows } = cursor ? await db.query<{ event_id: string; snapshot: CalendarEvent }>(
        "SELECT event_id,snapshot FROM events WHERE connection_id=$1 AND event_id=ANY($2::text[])", [id, ids])
        : { rows: [] };
      const before = new Map(rows.map(row => [row.event_id, row.snapshot]));
      const notices: Payload[] = result.gap ? [{ type: "connection.gap", reason: "provider_cursor_expired", changedFields: [] }] : [];
      const live: { event_id: string; pending: boolean; snapshot: CalendarEvent }[] = [];
      const cancelled: string[] = [];
      for (const [eventId, after] of result.observed) {
        const notice = cursor && classify(before.get(eventId), after);
        if (notice) notices.push(notice);
        if (after.event.status === "cancelled") cancelled.push(eventId);
        else live.push({ event_id: eventId, pending: after.pending, snapshot: after.event });
      }
      if (result.gap) {
        await db.query("DELETE FROM events WHERE connection_id=$1 AND NOT (event_id=ANY($2::text[]))", [id, ids]);
      }
      await db.query("DELETE FROM events WHERE connection_id=$1 AND event_id=ANY($2::text[])", [id, cancelled]);
      await db.query(
        `INSERT INTO events (connection_id,event_id,pending,snapshot)
         SELECT $1,event_id,pending,snapshot FROM jsonb_to_recordset($2::jsonb)
           AS input(event_id text,pending boolean,snapshot jsonb)
         ON CONFLICT (connection_id,event_id) DO UPDATE SET pending=excluded.pending,snapshot=excluded.snapshot`,
        [id, JSON.stringify(live)]);
      const { rows: [position] } = await db.query<{ webhook_count: string }>(
        `UPDATE connections SET sync_token=$2,last_sync_at=now(),synced_revision=$3,
         sync_due_at=now()+$4::bigint*interval '1 millisecond',sync_retry_at=now(),synced_webhook_count=$5,
         onboarding_sync_completed_at=CASE WHEN onboarding_sync_started_at IS NOT NULL
           THEN coalesce(onboarding_sync_completed_at,clock_timestamp()) ELSE onboarding_sync_completed_at END
         WHERE id=$1 RETURNING webhook_count`,
        [id, result.syncToken, revision, this.config.catchupMs, connection.webhook_count]);
      if (notices.length) {
        // Only a single pending webhook with no later callback is a usable timing sample.
        const beforeSync = BigInt(connection.webhook_count) - BigInt(connection.synced_webhook_count);
        const duringSync = BigInt(position!.webhook_count) - BigInt(connection.webhook_count);
        const webhookAt = !result.gap && beforeSync === 1n && duringSync === 0n ? connection.last_webhook_at : null;
        await db.query(
          `INSERT INTO notifications
             (connection_id,payload,source_webhook_at,webhooks_before_sync,webhooks_during_sync,sync_notice_count)
           SELECT $1,value,$3,$4,$5,$6 FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS input(value,position)
           ORDER BY position`, [id, JSON.stringify(notices), webhookAt, beforeSync.toString(), duringSync.toString(), notices.length]);
        await this.wakeDelivery(db, id);
      }
    });
  }

  private async watch(db: PoolClient, connection: Connection) {
    const { id, calendar_id: calendar } = connection;
    const channel = randomUUID();
    const token = nonce();
    if (connection.onboarding_bound_at && !connection.onboarding_watch_started_at) {
      await db.query("UPDATE connections SET onboarding_watch_started_at=clock_timestamp() WHERE id=$1", [id]);
    }
    await db.query("INSERT INTO channels (id,connection_id,token_digest,expires_at) VALUES ($1,$2,$3,$4)",
      [channel, id, digest(token), new Date(Date.now() + pendingWatchMs)]);
    const result = await this.withAccess(db, connection, access => this.google.watch(access, calendar, channel, token));
    await transaction(db, async () => {
      // Catch changes between the baseline and the watch, including during renewal.
      await db.query(
        `UPDATE connections SET revision=revision+1,watch_retry_at=now()+interval '1 minute',
         onboarding_watch_completed_at=CASE WHEN onboarding_watch_started_at IS NOT NULL
           THEN coalesce(onboarding_watch_completed_at,clock_timestamp()) ELSE onboarding_watch_completed_at END WHERE id=$1`, [id]);
      await db.query("UPDATE channels SET resource_id=$2,expires_at=$3 WHERE id=$1",
        [channel, result.resourceId, result.expiresAt]);
    });
  }

  private async retry(db: PoolClient, connection: string, phase: "sync" | "watch", error: unknown) {
    const known = error instanceof GoogleError ? providerError(error) : error;
    const code = known instanceof ApiError ? known.code : "INTERNAL";
    const wait = known instanceof ApiError ? (known.retryAfter ?? 30) : 30;
    log({ operation: phase, code });
    if (phase === "sync") {
      await db.query("UPDATE connections SET sync_retry_at=now()+$2*interval '1 second' WHERE id=$1", [connection, wait]);
    } else {
      await db.query("UPDATE connections SET watch_retry_at=now()+$2*interval '1 second' WHERE id=$1", [connection, wait]);
    }
  }

  private async needsWatch(db: PoolClient, id: string) {
    const { rowCount } = await db.query(
      `SELECT id FROM channels WHERE connection_id=$1 AND resource_id IS NOT NULL
        AND expires_at>now()+$2::bigint*interval '1 millisecond' LIMIT 1`, [id, this.config.renewLeadMs]);
    return !rowCount;
  }

  private async maintain(id: string) {
    await locked(this.pool, `connection:${id}`, async db => {
      const connection = await this.connection(id, db);
      if (connection.status !== "active") return;
      if (!this.owners.has(connection.owner_id)) {
        this.access.delete(id);
        await db.query("UPDATE connections SET status='auth_required' WHERE id=$1", [id]);
        return;
      }
      const now = Date.now();
      if (connection.sync_retry_at.getTime() <= now &&
          (connection.revision !== connection.synced_revision || connection.sync_due_at.getTime() <= now)) {
        try {
          await this.sync(db, connection);
        } catch (error) {
          if (error instanceof GoogleError && (error.status === 403 || error.status === 404) &&
              providerError(error).code !== "RATE_LIMITED") {
            this.access.delete(id);
            await db.query("UPDATE connections SET status='auth_required' WHERE id=$1", [id]);
            error = new ApiError("AUTH_REQUIRED");
          }
          await this.retry(db, id, "sync", error);
          if (error instanceof ApiError && error.code === "AUTH_REQUIRED") return;
        }
      }
      const current = await this.connection(id, db);
      if (current.last_sync_at && current.watch_retry_at.getTime() <= now && await this.needsWatch(db, id)) {
        try {
          await this.watch(db, current);
        } catch (error) {
          await this.retry(db, id, "watch", error);
        }
      }
    });
  }

  private async prune() {
    const db = await this.pool.connect();
    try {
      await transaction(db, async () => {
        const { rows } = await db.query<{ id: string }>(
          `SELECT id FROM connections WHERE id IN (
             SELECT connection_id FROM notifications
             WHERE observed_at<=now()-$1::bigint*interval '1 millisecond'
           ) ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED`, [this.config.retentionMs]);
        for (const { id } of rows) {
          const { rows: [deleted] } = await db.query<{ seq: string | null }>(
            `WITH expired AS (
               DELETE FROM notifications WHERE connection_id=$1
                 AND observed_at<=now()-$2::bigint*interval '1 millisecond' RETURNING seq
             ) SELECT max(seq) AS seq FROM expired`, [id, this.config.retentionMs]);
          if (deleted?.seq) {
            await db.query("UPDATE connections SET pruned_through=greatest(pruned_through,$2) WHERE id=$1", [id, deleted.seq]);
          }
        }
        await db.query("DELETE FROM channels WHERE expires_at<=now()");
        await db.query("DELETE FROM connect_sessions WHERE expires_at<=now()-interval '15 minutes'");
      });
    } finally {
      db.release();
    }
  }

  async tick() {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT c.id FROM connections c WHERE c.status='active' AND (
        (c.sync_retry_at<=now() AND (c.sync_due_at<=now() OR c.revision<>c.synced_revision))
        OR (c.last_sync_at IS NOT NULL AND c.watch_retry_at<=now() AND NOT EXISTS (
          SELECT 1 FROM channels w WHERE w.connection_id=c.id AND w.resource_id IS NOT NULL
            AND w.expires_at>now()+$1::bigint*interval '1 millisecond'
        ))) ORDER BY greatest(c.sync_retry_at,least(c.sync_due_at,now())) LIMIT 20`, [this.config.renewLeadMs]);
    // Bound provider concurrency while leaving the request pool available to webhook ingress.
    for (let i = 0; i < rows.length; i += 4) {
      const results = await Promise.allSettled(rows.slice(i, i + 4).map(row => this.maintain(row.id)));
      for (const result of results) {
        if (result.status === "rejected") log({ operation: "worker", code: "INTERNAL" });
      }
    }
    await this.prune();
  }
}
