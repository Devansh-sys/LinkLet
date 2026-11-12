import { accounts } from "./accounts.js";
import { maxTextLength, telegramToken } from "./config.js";
import { store } from "./store.js";

const POLL_TIMEOUT_SECONDS = 30;

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id: number; type?: string };
    from?: { username?: string; first_name?: string };
  };
};

export type IngestResult =
  | { kind: "enrolled"; accountId: string }
  | { kind: "command"; command: string }
  | { kind: "stored"; id: number }
  | { kind: "ignored"; reason: string };

let stopping = false;

/**
 * Telegram command syntax: `/name`, optionally `/name@BotName`, optionally with a
 * payload. `/start PAYLOAD` is how deep links (t.me/bot?start=PAYLOAD) arrive.
 */
function parseCommand(text: string): { name: string; payload: string } | null {
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) {
    return null;
  }

  return {
    name: match[1]!.toLowerCase(),
    payload: (match[2] ?? "").trim(),
  };
}

/**
 * The single entry point for inbound Telegram text. The poll loop and the dev
 * ingest route both go through here, so their behaviour cannot drift apart.
 */
export function ingestTelegramMessage(input: {
  chatId: string;
  text: string;
  chatType?: string;
}): IngestResult {
  const chatType = input.chatType ?? "private";
  if (chatType !== "private") {
    return { kind: "ignored", reason: `chat type ${chatType}` };
  }

  const text = input.text.trim();
  if (text.length === 0) {
    return { kind: "ignored", reason: "empty text" };
  }

  if (text.length > maxTextLength) {
    return { kind: "ignored", reason: `text exceeds ${maxTextLength} characters` };
  }

  const command = parseCommand(text);
  if (command) {
    // A deep link (/start CODE) is a pairing path; anything else is bot traffic.
    if (command.name === "start" && command.payload) {
      const linked = accounts.complete(command.payload, input.chatId);
      if (linked) {
        console.log(`[telegram] enrolled account ${linked.id} via /start payload`);
        return { kind: "enrolled", accountId: linked.id };
      }
    }

    const account = accounts.forChat(input.chatId);
    console.log(
      `[telegram] command /${command.name} from ${account?.id ?? "unpaired"} handled locally, not forwarded`,
    );
    return { kind: "command", command: command.name };
  }

  const account = accounts.complete(text, input.chatId);
  if (account) {
    // Never log chatId: it is PII.
    console.log(`[telegram] enrolled account ${account.id}`);
    return { kind: "enrolled", accountId: account.id };
  }

  const message = store.add({ text, direction: "in", chatId: input.chatId });
  console.log(`[telegram] #${message.id} received`);
  return { kind: "stored", id: message.id };
}

export function startTelegram(): void {
  if (!telegramToken) {
    console.log(
      "[telegram] TELEGRAM_BOT_TOKEN is not set, so polling is off.\n" +
        "           Set it to receive real messages, or run with DEV_INGEST=1.",
    );
    return;
  }

  void pollLoop();
}

export function stopTelegram(): void {
  stopping = true;
}

export class TelegramNotConfiguredError extends Error {
  constructor() {
    super("TELEGRAM_BOT_TOKEN is not set.");
  }
}

export class TelegramSendError extends Error {}

/**
 * Sends text to one chat. The caller supplies the destination from its own
 * binding; nothing in this function accepts a destination from a request body.
 */
export async function sendTelegramText(chatId: string, text: string): Promise<void> {
  if (!telegramToken) {
    throw new TelegramNotConfiguredError();
  }

  const response = await fetch(
    `https://api.telegram.org/bot${telegramToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  let description = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { ok?: boolean; description?: string };
    if (response.ok && body.ok) {
      return;
    }
    description = body.description ?? description;
  } catch {
    // A proxy or network fault can return HTML; keep the status as the reason.
  }

  throw new TelegramSendError(description);
}

async function pollLoop(): Promise<void> {
  let offset = 0;
  let backoffMs = 1_000;

  while (!stopping) {
    try {
      const updates = await getUpdates(offset);
      backoffMs = 1_000;

      for (const update of updates) {
        // Advance first: a malformed update must not be fetched forever.
        offset = update.update_id + 1;
        handleUpdate(update);
      }
    } catch (error) {
      // 409 means another process is polling this bot; 401 means the token is
      // wrong. Backing off keeps a transient network blip from killing the server.
      console.error("[telegram] getUpdates failed:", (error as Error).message);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  console.log("[telegram] polling stopped");
}

async function getUpdates(offset: number): Promise<Array<TelegramUpdate>> {
  const url =
    `https://api.telegram.org/bot${telegramToken}/getUpdates` +
    `?timeout=${POLL_TIMEOUT_SECONDS}&offset=${offset}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(40_000) });

  const body = (await response.json()) as {
    ok: boolean;
    result?: Array<TelegramUpdate>;
    description?: string;
  };

  if (!response.ok || !body.ok) {
    throw new Error(body.description ?? `HTTP ${response.status}`);
  }

  return body.result ?? [];
}

function handleUpdate(update: TelegramUpdate): void {
  const message = update.message;
  const chat = message?.chat;

  if (!message?.text || chat?.id === undefined) {
    return;
  }

  const result = ingestTelegramMessage({
    chatId: String(chat.id),
    text: message.text,
    chatType: chat.type,
  });

  if (result.kind === "ignored") {
    console.log(`[telegram] dropped update: ${result.reason}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
