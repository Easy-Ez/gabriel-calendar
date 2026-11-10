import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { ApiError, digest, opaque } from "./core.js";
import type { CalendarService } from "./service.js";

const maxLength = 128;
const controls = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const verifierFormat = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const work = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
let pending = 0;

export function validAdminPassword(value: string) {
  const size = [...value].length;
  return size >= 16 && size <= maxLength && !controls.test(value) && value.trim().length > 0;
}

export function adminPassword(header: string) {
  const encoded = /^Basic ([A-Za-z0-9+/]{4,692}={0,2})$/i.exec(header)?.[1];
  if (!encoded) return;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return;
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!value.startsWith("admin:")) return;
    const password = value.slice(6).normalize("NFC");
    if (validAdminPassword(password)) return password;
  } catch { /* Invalid UTF-8 cannot be a password. */ }
}

export function samePassword(left: string, right: string) {
  return timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
}

async function derive(password: string, salt: Buffer) {
  if (pending >= 2) throw new ApiError("RATE_LIMITED", 1);
  pending++;
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, work, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    }));
  } finally {
    pending--;
  }
}

export async function verifyAdminPassword(service: CalendarService, password: string) {
  const { rows: [stored] } = await service.pool.query<{ verifier: string }>(
    "SELECT verifier FROM admin_password WHERE singleton");
  if (!stored) {
    if (opaque.test(password) && timingSafeEqual(Buffer.from(digest(password)), Buffer.from(service.config.adminTokenDigest))) {
      return { verifier: null };
    }
    return;
  }
  const match = verifierFormat.exec(stored.verifier);
  if (!match) throw new ApiError("INTERNAL");
  const key = await derive(password, Buffer.from(match[1]!, "base64url"));
  if (timingSafeEqual(key, Buffer.from(match[2]!, "base64url"))) return stored;
}

export async function changeAdminPassword(service: CalendarService, previous: string | null, password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  const verifier = salt.toString("base64url") + "." + key.toString("base64url");
  const result = previous === null
    ? await service.pool.query(
      "INSERT INTO admin_password (singleton,verifier) VALUES (true,$1) ON CONFLICT (singleton) DO NOTHING", [verifier])
    : await service.pool.query("UPDATE admin_password SET verifier=$1 WHERE singleton AND verifier=$2", [verifier, previous]);
  if (!result.rowCount) throw new ApiError("FORBIDDEN");
}
