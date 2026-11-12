"use strict";

const DEFAULT_API_URL = "http://localhost:3000";
const MAX_SAVED_MESSAGES = 100;

const statusElement = document.querySelector("#status");
const serverForm = document.querySelector("#server-form");
const serverUrlInput = document.querySelector("#server-url");
const pairingSection = document.querySelector("#pairing");
const pairingCodeElement = document.querySelector("#pairing-code");
const startPairingButton = document.querySelector("#start-pairing");
const conversationSection = document.querySelector("#conversation");
const messagesElement = document.querySelector("#messages");
const sendForm = document.querySelector("#send-form");
const messageTextInput = document.querySelector("#message-text");
const characterCount = document.querySelector("#character-count");
const sendButton = document.querySelector("#send-button");
const disconnectButton = document.querySelector("#disconnect");
const clearMessagesButton = document.querySelector("#clear-messages");

let apiBaseUrl = DEFAULT_API_URL;
let accountId;
let jwt;
let pairingInProgress = false;
let active = true;

serverForm.addEventListener("submit", saveServerUrl);
startPairingButton.addEventListener("click", startPairing);
sendForm.addEventListener("submit", sendMessage);
disconnectButton.addEventListener("click", disconnect);
clearMessagesButton.addEventListener("click", clearMessages);
messageTextInput.addEventListener("input", updateCharacterCount);
chrome.storage.onChanged.addListener(onStorageChanged);
window.addEventListener("unload", () => {
  active = false;
});

void initialize();

async function initialize() {
  const saved = await chrome.storage.local.get([
    "apiBaseUrl",
    "accountId",
    "jwt",
    "pollingStatus",
  ]);
  apiBaseUrl = saved.apiBaseUrl ?? DEFAULT_API_URL;
  serverUrlInput.value = apiBaseUrl;
  accountId = saved.accountId;
  jwt = saved.jwt;

  if (typeof jwt === "string" && typeof accountId === "string") {
    showConversation();
    await renderMessages();
    setStatus(saved.pollingStatus?.message ?? "Connected. Waiting for Telegram messages…");
    chrome.runtime.sendMessage({ type: "popup-opened" });
    chrome.runtime.sendMessage({ type: "poll-now" });
  } else {
    showPairing();
    setStatus(
      saved.pollingStatus?.kind === "auth-required"
        ? saved.pollingStatus.message
        : "Connect this extension to a Telegram chat.",
    );
  }
}

async function saveServerUrl(event) {
  event.preventDefault();
  try {
    const normalized = LinkLetApi.normalizeBaseUrl(serverUrlInput.value.trim());
    const origin = new URL(normalized).origin;
    const requested = await chrome.permissions.request({
      origins: [`${origin}/*`],
    });
    if (!requested) {
      throw new Error("Permission to contact this server was not granted.");
    }

    await chrome.storage.local.set({ apiBaseUrl: normalized });
    apiBaseUrl = normalized;
    serverUrlInput.value = normalized;
    setStatus("Server URL saved.");
  } catch (error) {
    setStatus(error.message);
  }
}

async function startPairing() {
  startPairingButton.disabled = true;
  pairingInProgress = true;
  pairingCodeElement.hidden = true;
  try {
    await ensureServerPermission();
    const start = await LinkLetApi.requestJson(apiBaseUrl, "/enroll/start", {
      method: "POST",
      body: {},
    });

    if (
      typeof start.code !== "string" ||
      typeof start.enrollToken !== "string" ||
      typeof start.expiresAt !== "string"
    ) {
      throw new Error("The server returned an invalid enrollment response.");
    }

    const expiresAt = Date.parse(start.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("The server returned an expired pairing code.");
    }

    pairingCodeElement.textContent =
      `Send ${start.code} to your LinkLet bot. This code expires in 5 minutes.`;
    pairingCodeElement.hidden = false;
    setStatus("Waiting for the pairing code to arrive in Telegram…");

    while (active && pairingInProgress && Date.now() < expiresAt) {
      await delay(2_000);
      if (!active || !pairingInProgress) {
        return;
      }

      try {
        const result = await LinkLetApi.requestJson(apiBaseUrl, "/enroll/claim", {
          method: "POST",
          body: { enrollToken: start.enrollToken },
        });
        if (result.status === "pending") {
          continue;
        }
        if (typeof result.jwt !== "string" || typeof result.accountId !== "string") {
          throw new Error("The server returned an invalid pairing response.");
        }

        jwt = result.jwt;
        accountId = result.accountId;
        await chrome.storage.local.set({ jwt, accountId });
        pairingInProgress = false;
        showConversation();
        await renderMessages();
        chrome.runtime.sendMessage({ type: "poll-now" });
        setStatus("Paired. Waiting for Telegram messages…");
        return;
      } catch (error) {
        throw error;
      }
    }

    if (active && pairingInProgress) {
      setStatus("Pairing code expired. Start again to get a new code.");
      pairingCodeElement.hidden = true;
    }
  } catch (error) {
    if (active) {
      setStatus(error.message);
    }
  } finally {
    pairingInProgress = false;
    startPairingButton.disabled = false;
  }
}

async function ensureServerPermission() {
  const normalized = LinkLetApi.normalizeBaseUrl(apiBaseUrl);
  const origin = new URL(normalized).origin;
  const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (!granted) {
    throw new Error("Save the server URL and grant permission before pairing.");
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = messageTextInput.value.trim();
  if (!text || text.length > 4096 || !jwt || !accountId) {
    return;
  }

  sendButton.disabled = true;
  try {
    const sentForAccount = accountId;
    const sentWithToken = jwt;
    const result = await LinkLetApi.requestJson(apiBaseUrl, "/send", {
      method: "POST",
      token: jwt,
      body: { text },
    });
    if (accountId !== sentForAccount || jwt !== sentWithToken) {
      return;
    }
    if (
      !Number.isSafeInteger(result.message?.id) ||
      typeof result.message.text !== "string" ||
      result.message.direction !== "out" ||
      typeof result.message.createdAt !== "string"
    ) {
      throw new Error("The server returned an invalid sent-message response.");
    }

    const key = `outbound:${accountId}`;
    const saved = await chrome.storage.local.get(key);
    const previous = Array.isArray(saved[key]) ? saved[key] : [];
    const next = [
      ...previous,
      {
        id: result.message.id,
        text: result.message.text,
        direction: "out",
        createdAt: result.message.createdAt,
      },
    ].slice(-MAX_SAVED_MESSAGES);
    await chrome.storage.local.set({ [key]: next });
    messageTextInput.value = "";
    updateCharacterCount();
    await renderMessages();
    setStatus("Message sent.");
  } catch (error) {
    if (error.status === 401) {
      await chrome.storage.local.remove(["jwt", "accountId"]);
      jwt = undefined;
      accountId = undefined;
      showPairing();
      setStatus("Your session expired. Pair with Telegram again.");
    } else {
      setStatus(error.message);
    }
  } finally {
    sendButton.disabled = false;
  }
}

async function disconnect() {
  const keys = ["jwt", "accountId", "pollingStatus"];
  if (accountId) {
    keys.push(`cursor:${accountId}`, `inbound:${accountId}`, `outbound:${accountId}`);
  }
  await chrome.storage.local.remove(keys);
  jwt = undefined;
  accountId = undefined;
  messagesElement.replaceChildren();
  pairingCodeElement.hidden = true;
  showPairing();
  setStatus("Disconnected. Pair with Telegram to reconnect.");
}

async function clearMessages() {
  if (!accountId) {
    return;
  }
  await chrome.storage.local.remove([
    `inbound:${accountId}`,
    `outbound:${accountId}`,
  ]);
  messagesElement.replaceChildren();
}

async function renderMessages() {
  if (!accountId) {
    return;
  }
  const keys = [`inbound:${accountId}`, `outbound:${accountId}`];
  const saved = await chrome.storage.local.get(keys);
  const messages = keys.flatMap((key) => (Array.isArray(saved[key]) ? saved[key] : []));
  messages.sort((left, right) => left.id - right.id);

  const elements = messages.map((message) => {
    const item = document.createElement("li");
    item.className = `message ${message.direction === "out" ? "out" : "in"}`;
    const text = document.createElement("div");
    text.textContent = message.text;
    const time = document.createElement("time");
    const timestamp = new Date(message.createdAt);
    time.dateTime = Number.isNaN(timestamp.getTime()) ? "" : timestamp.toISOString();
    time.textContent = Number.isNaN(timestamp.getTime())
      ? ""
      : timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    item.append(text, time);
    return item;
  });

  messagesElement.replaceChildren(...elements);
  messagesElement.scrollTop = messagesElement.scrollHeight;
}

function onStorageChanged(changes, areaName) {
  if (areaName !== "local") {
    return;
  }

  if (
    changes.accountId ||
    (accountId &&
      (changes[`inbound:${accountId}`] || changes[`outbound:${accountId}`]))
  ) {
    if (changes.accountId) {
      accountId = changes.accountId.newValue;
    }
    void renderMessages();
  }

  if (changes.jwt) {
    jwt = changes.jwt.newValue;
    if (!jwt) {
      showPairing();
    }
  }

  if (changes.pollingStatus?.newValue) {
    const status = changes.pollingStatus.newValue;
    if (status.kind === "connected") {
      setStatus("Connected. Waiting for Telegram messages…");
    } else if (status.message) {
      setStatus(status.message);
    }
  }
}

function showPairing() {
  pairingSection.hidden = false;
  conversationSection.hidden = true;
  disconnectButton.hidden = true;
}

function showConversation() {
  pairingSection.hidden = true;
  conversationSection.hidden = false;
  disconnectButton.hidden = false;
}

function updateCharacterCount() {
  characterCount.textContent = `${messageTextInput.value.length} / 4096`;
}

function setStatus(message) {
  statusElement.textContent = message;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
