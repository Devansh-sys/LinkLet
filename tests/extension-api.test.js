"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const test = require("node:test");

require("../extension/api.js");
const { LinkLetApi } = globalThis;

test("Manifest V3 declares the popup, service worker, and required permissions", () => {
  const manifest = JSON.parse(
    readFileSync("extension/manifest.json", "utf8"),
  );
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "127");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.background.service_worker, "service-worker.js");
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("alarms"));

  for (const file of [
    manifest.action.default_popup,
    manifest.background.service_worker,
  ]) {
    assert.equal(existsSync(`extension/${file}`), true);
  }
});

test("normalizes the server URL and removes query, fragment, and trailing slash", () => {
  assert.equal(
    LinkLetApi.normalizeBaseUrl("https://example.test/api/?discard=yes#fragment"),
    "https://example.test/api",
  );
});

test("allows HTTP only for loopback development servers", () => {
  assert.equal(LinkLetApi.normalizeBaseUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(LinkLetApi.normalizeBaseUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.throws(
    () => LinkLetApi.normalizeBaseUrl("http://example.test"),
    /Use HTTPS/,
  );
});

test("rejects unsupported URL schemes", () => {
  assert.throws(
    () => LinkLetApi.normalizeBaseUrl("ftp://example.test"),
    /must use HTTP or HTTPS/,
  );
});

test("sends bearer authorization and reports API error details", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(
      JSON.stringify({
        error: { code: "unauthorized", message: "Invalid or expired token." },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    await assert.rejects(
      LinkLetApi.requestJson("https://example.test", "/messages", {
        token: "test-token",
      }),
      (error) => error.status === 401 && error.code === "unauthorized",
    );
    assert.equal(request.url, "https://example.test/messages");
    assert.equal(request.options.headers.Authorization, "Bearer test-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
