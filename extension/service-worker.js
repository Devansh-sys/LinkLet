"use strict";

importScripts("api.js");

const POLL_ALARM = "linklet-message-poll";
const POLL_INTERVAL_MINUTES = 0.5;
const POLL_WAIT_SECONDS = 20;
const MAX_SAVED_MESSAGES = 100;
const MAX_BADGE_COUNT = 99;
let pollInProgress = false;

chrome.runtime.onInstalled.addListener(() => {
  schedulePolling();
});

chrome.runtime.onStartup.addListener(() => {
  schedulePolling();
  void pollMessages();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    void pollMessages();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "poll-now") {
    void pollMessages();
    sendResponse({ accepted: true });
  } else if (message?.type === "popup-opened") {
    void chrome.action.setBadgeText({ text: "" });
    sendResponse({ accepted: true });
  }
});

function schedulePolling() {
  chrome.alarms.create(POLL_ALARM, {
    periodInMinutes: POLL_INTERVAL_MINUTES,
  });
}

async function pollMessages() {
  if (pollInProgress) {
    return;
  }
  pollInProgress = true;

  try {
    while (true) {
      const settings = await chrome.storage.local.get([
        "apiBaseUrl",
        "jwt",
        "accountId",
      ]);
      if (
        typeof settings.apiBaseUrl !== "string" ||
        typeof settings.jwt !== "string" ||
        typeof settings.accountId !== "string"
      ) {
        return;
      }

      const cursorKey = `cursor:${settings.accountId}`;
      const messagesKey = `inbound:${settings.accountId}`;
      const saved = await chrome.storage.local.get([cursorKey, messagesKey]);
      const cursor = Number.isSafeInteger(saved[cursorKey]) && saved[cursorKey] >= 0
        ? saved[cursorKey]
        : 0;
      const query = new URLSearchParams({
        since: String(cursor),
        wait: String(POLL_WAIT_SECONDS),
      });

      try {
        const result = await LinkLetApi.requestJson(
          settings.apiBaseUrl,
          `/messages?${query}`,
          { token: settings.jwt },
        );
        if (!(await isCurrentSession(settings))) {
          continue;
        }

        if (
          !Array.isArray(result.messages) ||
          !Number.isSafeInteger(result.nextSince) ||
          result.nextSince < cursor
        ) {
          throw new Error("The API returned an invalid message cursor response.");
        }

        const previous = Array.isArray(saved[messagesKey]) ? saved[messagesKey] : [];
        const received = result.messages
          .filter(
            (message) =>
              Number.isSafeInteger(message?.id) &&
              typeof message.text === "string" &&
              message.direction === "in" &&
              typeof message.createdAt === "string",
          )
          .map((message) => ({
            id: message.id,
            text: message.text,
            direction: "in",
            createdAt: message.createdAt,
          }));

        const unique = new Map(previous.map((message) => [message.id, message]));
        for (const message of received) {
          unique.set(message.id, message);
        }

        await chrome.storage.local.set({
          [cursorKey]: result.nextSince,
          [messagesKey]: [...unique.values()]
            .sort((left, right) => left.id - right.id)
            .slice(-MAX_SAVED_MESSAGES),
          pollingStatus: { kind: "connected", updatedAt: new Date().toISOString() },
        });

        if (received.length > 0) {
          const badgeCount = Math.min(unique.size, MAX_BADGE_COUNT);
          await chrome.action.setBadgeBackgroundColor({ color: "#1769aa" });
          await chrome.action.setBadgeText({ text: String(badgeCount) });
          await openPopupForMessages();
        }
      } catch (error) {
        if (!(await isCurrentSession(settings))) {
          continue;
        }

        if (error.status === 401) {
          await chrome.storage.local.remove(["jwt", "accountId"]);
          await chrome.storage.local.set({
            pollingStatus: {
              kind: "auth-required",
              message: "Your session expired. Pair with Telegram again.",
            },
          });
          return;
        }

        await chrome.storage.local.set({
          pollingStatus: {
            kind: "error",
            message: error.message,
            updatedAt: new Date().toISOString(),
          },
        });
        await delay(1_000);
      }
    }
  } finally {
    pollInProgress = false;
  }
}

async function openPopupForMessages() {
  if (typeof chrome.action.openPopup !== "function") {
    console.warn("[extension] This Chrome version cannot open the popup automatically.");
    return;
  }

  try {
    await chrome.action.openPopup();
  } catch (error) {
    console.warn("[extension] Could not open the popup automatically:", error.message);
  }
}

async function isCurrentSession(settings) {
  const current = await chrome.storage.local.get(["jwt", "accountId"]);
  return current.jwt === settings.jwt && current.accountId === settings.accountId;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
