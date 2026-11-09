import { createHmac, timingSafeEqual } from "node:crypto";
import { BrokerError, type Subject } from "./types.js";

export interface SubjectAuthConfig { serviceToken: string; subjectKey: Buffer }
export function safeEqual(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function authenticateSubject(authorization: string | undefined, token: string | undefined, config: SubjectAuthConfig, now = Math.floor(Date.now() / 1000)): Subject {
  const reject = () => { throw new BrokerError("unauthorized"); };
  if (config.serviceToken.length < 32 || config.subjectKey.length < 32 || !authorization || !safeEqual(authorization, `Bearer ${config.serviceToken}`) || !token || token.length > 4096) return reject();
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return reject();
  const [header, payload, signature] = parts;
  if (!safeEqual(createHmac("sha256", config.subjectKey).update(`${header}.${payload}`).digest("base64url"), signature)) return reject();
  try {
    const h = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (h.alg !== "HS256" || h.typ !== "JWT" || Object.keys(h).some((k) => !["alg", "typ"].includes(k)) || p.iss !== "masterskaya-platform" || p.aud !== "meta-student-broker" || p.tenantId !== "masterskaya" || typeof p.sub !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(p.sub) || !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) || p.iat > now || p.exp <= now || p.exp <= p.iat || p.exp - p.iat > 60) return reject();
    return { tenantId: p.tenantId, sub: p.sub };
  } catch { return reject(); }
}
