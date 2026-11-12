import { randomBytes } from "node:crypto";

export const port = Number(process.env.PORT ?? 3000);

export const telegramToken = process.env.TELEGRAM_BOT_TOKEN;

/**
 * In production this MUST be set. A generated fallback keeps local dev painless
 * but invalidates every issued JWT on restart.
 */
const configuredJwtSecret = process.env.JWT_SECRET;
export const jwtSecret = configuredJwtSecret ?? randomBytes(32).toString("hex");
export const jwtSecretGenerated = configuredJwtSecret === undefined;

export const jwtTtlSeconds = 7 * 24 * 60 * 60;

/** Enables POST /dev/ingest for local testing without a Telegram token. */
export const devIngestEnabled = process.env.DEV_INGEST === "1";

/** Telegram rejects anything longer; enforce it before it becomes a 502. */
export const maxTextLength = 4096;

/**
 * Survives a restart: account bindings and the message id counter, so ids are
 * never reissued and a previously issued JWT still resolves to its account.
 */
export const dataFile = process.env.DATA_FILE ?? "state.json";
