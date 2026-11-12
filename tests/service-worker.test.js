"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createContext, runInContext } = require("node:vm");
const { join } = require("node:path");
const test = require("node:test");

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    listeners,
  };
}

test("the worker immediately re-polls and opens the popup for inbound messages", async () => {
  const values = {
    apiBaseUrl: "http://localhost:3000",
    jwt: "test-token",
    accountId: "test-account",
    "cursor:test-account": 0,
    "inbound:test-account": [],
  };
  const runtimeOnInstalled = createEvent();
  const runtimeOnStartup = createEvent();
  const runtimeOnMessage = createEvent();
  const alarmsOnAlarm = createEvent();
  const openedPopups = [];
  const badgeTexts = [];
  let fetchCount = 0;

  const chrome = {
    runtime: {
      onInstalled: runtimeOnInstalled,
      onStartup: runtimeOnStartup,
      onMessage: runtimeOnMessage,
    },
    alarms: {
      onAlarm: alarmsOnAlarm,
      create() {},
    },
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText(details) {
        badgeTexts.push(details.text);
      },
      async openPopup() {
        openedPopups.push(true);
      },
    },
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, values[key]]));
          }
          return { [keys]: values[keys] };
        },
        async set(changes) {
          Object.assign(values, changes);
        },
        async remove(keys) {
          for (const key of keys) {
            delete values[key];
          }
        },
      },
    },
  };

  const context = createContext({
      chrome,
      console,
      Date,
      URLSearchParams,
      AbortSignal,
      setTimeout,
      clearTimeout,
      fetch: async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                messages: [
                  {
                    id: 1,
                    text: "hello",
                    direction: "in",
                    createdAt: "2026-10-28T00:00:00.000Z",
                  },
                ],
                nextSince: 1,
              };
            },
          };
        }

        if (fetchCount === 2) {
          delete values.jwt;
          delete values.accountId;
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { messages: [], nextSince: 1 };
          },
        };
      },
    });
  const apiScript = readFileSync(join("extension", "api.js"), "utf8");
  const workerScript = readFileSync(join("extension", "service-worker.js"), "utf8");
  context.importScripts = () => runInContext(apiScript, context);
  runInContext(workerScript, context);

  await context.pollMessages();

  assert.equal(fetchCount, 2, "the next long poll starts without waiting for the alarm");
  assert.equal(openedPopups.length, 1, "inbound arrival requests the action popup");
  assert.equal(badgeTexts.at(-1), "1", "the badge indicates unread messages");
  assert.equal(values["cursor:test-account"], 1);
  assert.equal(values["inbound:test-account"][0].text, "hello");
});
