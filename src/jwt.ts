import { createHmac, timingSafeEqual } from "node:crypto";
import { jwtSecret, jwtTtlSeconds } from "./config.js";

/**
 * Minimal HS256 JWT. Deliberately not a general implementation:
 * the algorithm is fixed, so `alg: "none"` and algorithm substitution are
 * rejected before any comparison happens.
 */

type Payload = {
  sub: string;
  iat: number;
  exp: number;
};

const HEADER_SEGMENT = Buffer.from(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
).toString("base64url");

function sign(signingInput: string): string {
  return createHmac("sha256", jwtSecret).update(signingInput).digest("base64url");
}

export function signToken(
  subject: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload: Payload = {
    sub: subject,
    iat: nowSeconds,
    exp: nowSeconds + jwtTtlSeconds,
  };

  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${HEADER_SEGMENT}.${body}`;

  return `${signingInput}.${sign(signingInput)}`;
}

/** Returns the subject, or null for any malformed, forged, or expired token. */
export function verifyToken(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [header, payload, signature] = parts as [string, string, string];

  // Pin the algorithm before verifying: blocks "alg: none" and HS/RS confusion.
  const decodedHeader = safeJson(header);
  if (decodedHeader === null || decodedHeader.alg !== "HS256") {
    return null;
  }

  const expected = Buffer.from(sign(`${header}.${payload}`), "base64url");
  const provided = Buffer.from(signature, "base64url");

  // timingSafeEqual throws on length mismatch, so check length first.
  if (expected.length !== provided.length) {
    return null;
  }
  if (!timingSafeEqual(expected, provided)) {
    return null;
  }

  const decoded = safeJson(payload);
  if (decoded === null) {
    return null;
  }

  const { sub, exp } = decoded;
  if (typeof sub !== "string" || sub.length === 0) {
    return null;
  }
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowSeconds) {
    return null;
  }

  return sub;
}

function safeJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
