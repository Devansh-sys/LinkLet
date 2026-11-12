import express, { type NextFunction, type Request, type Response } from "express";
import { accounts, type Account } from "./accounts.js";
import { devIngestEnabled, jwtSecretGenerated, maxTextLength, port } from "./config.js";
import { signToken, verifyToken } from "./jwt.js";
import { store, type LinkMessage } from "./store.js";
import {
  ingestTelegramMessage,
  sendTelegramText,
  startTelegram,
  stopTelegram,
  TelegramNotConfiguredError,
  TelegramSendError,
} from "./telegram.js";

const app = express();
app.use(express.json());

/** Long-poll ceiling. Kept under the 30s mark so proxies do not cut the request. */
const MAX_WAIT_MS = 25_000;

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function requireJwt(req: Request, res: Response, next: NextFunction): void {
  const header = req.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);

  if (!match) {
    fail(res, 401, "unauthorized", "Missing bearer token.");
    return;
  }

  const subject = verifyToken(match[1]!);
  if (!subject) {
    console.warn(
      "[auth] token rejected: bad signature or expired. " +
        "If JWT_SECRET changed or was unset, every previous token is dead.",
    );
    fail(res, 401, "unauthorized", "Invalid or expired token.");
    return;
  }

  const account = accounts.get(subject);
  if (!account) {
    console.warn(
      "[auth] token verified but its account is unknown. " +
        "Accounts are in memory, so a restart drops them: re-pair to recover.",
    );
    fail(res, 401, "unauthorized", "Invalid or expired token.");
    return;
  }

  res.locals.account = account;
  next();
}

/** Safe only behind `requireJwt`, which is the only thing that sets this. */
function currentAccount(res: Response): Account {
  return res.locals.account as Account;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "linklet", cursor: store.cursor });
});

app.post("/enroll/start", (_req: Request, res: Response) => {
  const { code, enrollToken, expiresAt } = accounts.start();
  res.status(201).json({ code, enrollToken, expiresAt });
});

app.post("/enroll/claim", (req: Request, res: Response) => {
  const raw = (req.body as { enrollToken?: unknown })?.enrollToken;
  const enrollToken = typeof raw === "string" ? raw : "";

  if (!enrollToken) {
    fail(res, 400, "invalid_request", "enrollToken is required.");
    return;
  }

  const result = accounts.claim(enrollToken);

  if (result.status === "pending") {
    res.status(202).json({ status: "pending" });
    return;
  }

  if (result.status === "expired") {
    fail(res, 410, "enroll_expired", "Pairing code expired, unknown, or already claimed.");
    return;
  }

  res.json({
    jwt: signToken(result.account.id),
    accountId: result.account.id,
  });
});

/**
 * Cursor read. The binding decides which chat is visible; there is no parameter
 * a caller could pass to read someone else's messages.
 */
app.get("/messages", requireJwt, async (req: Request, res: Response) => {
  const account = currentAccount(res);

  const since = Number(req.query.since ?? 0);
  if (!Number.isInteger(since) || since < 0) {
    fail(res, 400, "invalid_request", "since must be a non-negative integer.");
    return;
  }

  const requestedWaitMs = Number(req.query.wait ?? 0) * 1_000;
  const waitMs = Number.isFinite(requestedWaitMs)
    ? Math.min(Math.max(requestedWaitMs, 0), MAX_WAIT_MS)
    : 0;

  let messages = store.sinceForChat(account.chatId, since, "in");
  if (messages.length === 0 && waitMs > 0) {
    messages = await waitForMessages(account.chatId, since, waitMs);
  }

  // Report the last id actually delivered, not the global max: if the buffer
  // rolled over, advancing past undelivered ids would silently lose messages.
  const nextSince = messages.at(-1)?.id ?? since;

  res.json({ messages, nextSince });
});

/**
 * Outbound send. The destination is the caller's bound chat, resolved from the
 * token — a `chatId` in the body is rejected rather than ignored, so a client
 * cannot believe it chose the destination.
 */
app.post("/send", requireJwt, async (req: Request, res: Response) => {
  const account = currentAccount(res);
  const body = req.body as { text?: unknown; chatId?: unknown } | undefined;

  if (body?.chatId !== undefined) {
    fail(
      res,
      400,
      "chat_id_not_allowed",
      "The destination comes from your token. Do not send chatId.",
    );
    return;
  }

  if (typeof body?.text !== "string") {
    fail(res, 400, "invalid_request", "text is required.");
    return;
  }

  const text = body.text.trim();
  if (text.length === 0) {
    fail(res, 400, "invalid_request", "text must not be empty.");
    return;
  }

  if (text.length > maxTextLength) {
    fail(res, 400, "text_too_long", `text must be at most ${maxTextLength} characters.`);
    return;
  }

  try {
    await sendTelegramText(account.chatId, text);
  } catch (error) {
    if (error instanceof TelegramNotConfiguredError) {
      fail(res, 503, "telegram_not_configured", "No bot token is configured, so nothing can be sent.");
      return;
    }

    if (error instanceof TelegramSendError) {
      console.warn(`[send] Telegram rejected a message for account ${account.id}: ${error.message}`);
      fail(res, 502, "telegram_rejected", error.message);
      return;
    }

    throw error;
  }

  // Stored only after Telegram accepted it: no phantom messages on failure.
  const message = store.add({ text, direction: "out", chatId: account.chatId });
  console.log(`[send] #${message.id} sent to account ${account.id}`);

  res.json({ message });
});

/**
 * Dev-only: simulate an inbound Telegram update so enrollment and delivery can be
 * exercised without a bot token. Registered only when DEV_INGEST=1.
 */
if (devIngestEnabled) {
  app.post("/dev/ingest", (req: Request, res: Response) => {
    const body = req.body as { chatId?: unknown; text?: unknown; chatType?: unknown };
    const chatId = typeof body.chatId === "string" ? body.chatId : "";
    const text = typeof body.text === "string" ? body.text : "";
    const chatType = typeof body.chatType === "string" ? body.chatType : undefined;

    if (!chatId || !text) {
      fail(res, 400, "invalid_request", "chatId and text are required.");
      return;
    }

    res.json(ingestTelegramMessage({ chatId, text, chatType }));
  });
}

function waitForMessages(
  chatId: string,
  since: number,
  timeoutMs: number,
): Promise<Array<LinkMessage>> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;

    const finish = (messages: Array<LinkMessage>): void => {
      clearTimeout(timer);
      store.off("add", onAdd);
      resolve(messages);
    };

    const onAdd = (): void => {
      // Same filter as the initial read, so an outbound send cannot wake the
      // poller and then deliver an empty batch.
      const messages = store.sinceForChat(chatId, since, "in");
      if (messages.length > 0) {
        finish(messages);
      }
    };

    timer = setTimeout(() => finish([]), timeoutMs);
    store.on("add", onAdd);

    // A message can land between the caller's read and this registration.
    onAdd();
  });
}

/**
 * Terminal error handler. Keeps the protocol's error envelope for bad request
 * bodies and stops body-parser stack traces from reaching the console.
 */
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (error as { status?: unknown }).status;

  if (status === 400) {
    fail(res, 400, "invalid_json", "Request body is not valid JSON.");
    return;
  }

  console.error("[server] unhandled request error:", (error as Error).message);
  fail(res, 500, "internal_error", "Unexpected server error.");
});

const server = app.listen(port, () => {
  console.log(`LinkLet listening on http://localhost:${port}`);

  if (jwtSecretGenerated) {
    console.log("\n  JWT_SECRET is not set, so a temporary secret was generated.");
    console.log("  Every session is invalidated when this process restarts.\n");
  }

  if (devIngestEnabled) {
    console.log("  DEV_INGEST=1: POST /dev/ingest is open. Local development only.\n");
  }

  console.log(`  health  : GET  /health`);
  console.log(`  enroll  : POST /enroll/start`);
  console.log(`  claim   : POST /enroll/claim  { "enrollToken": "..." }`);
  console.log(`  read    : GET  /messages?since=0&wait=20   (Authorization: Bearer <jwt>)`);
  console.log(`  send    : POST /send  { "text": "..." }    (Authorization: Bearer <jwt>)\n`);

  startTelegram();
});

function shutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down`);
  stopTelegram();
  server.close(() => process.exit(0));

  // Long-poll requests can hold the socket open, so do not wait forever.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
