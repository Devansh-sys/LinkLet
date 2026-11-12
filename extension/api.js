"use strict";

globalThis.LinkLetApi = {
  normalizeBaseUrl(value) {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("The API URL must use HTTP or HTTPS.");
    }

    const isLoopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (url.protocol !== "https:" && !isLoopback) {
      throw new Error("Use HTTPS for any API server outside this computer.");
    }

    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  },

  async requestJson(baseUrl, path, options = {}) {
    const headers = {};
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`The API returned an unreadable response (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const message =
        typeof result?.error?.message === "string"
          ? result.error.message
          : `The API request failed (HTTP ${response.status}).`;
      const error = new Error(message);
      error.status = response.status;
      error.code = result?.error?.code;
      throw error;
    }

    return result;
  },
};
