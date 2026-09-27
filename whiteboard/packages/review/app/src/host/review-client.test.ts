import type { ReviewRuntimeConfig } from "@dev.fast/review-protocol";
import { afterEach, expect, it, vi } from "vitest";

import {
  jsonReviewApiUrl,
  reviewFetchUrl,
  reviewStorageKey,
  reviewWasmUrl,
} from "./review-client";

const injectedConfig = {
  reviewId: "desktop-session",
  wasmUrl: "vscode-file://review/libavoid.wasm",
  appVersion: "0.0.13",
  theme: "dark",
  host: "desktop",
} satisfies ReviewRuntimeConfig;

afterEach(() => vi.unstubAllGlobals());

it("uses relative desktop API paths and retains asset and storage configuration", () => {
  expect(injectedConfig.host).toBe("desktop");
  expect(reviewWasmUrl(injectedConfig)).toBe(
    "vscode-file://review/libavoid.wasm",
  );
  expect(reviewStorageKey(injectedConfig, "files", "main", "head")).toBe(
    "progressive-review:files:desktop-session:main:head",
  );
  expect(
    jsonReviewApiUrl(injectedConfig, "review-1", "/file", { version: 2 }),
  ).toBe("/reviews-api/review-1/file?version=2");
});

it("does not add credentials to API requests or URLs", async () => {
  let requestUrl: RequestInfo | URL | undefined;
  let requestInit: RequestInit | undefined;

  const fetchMock: typeof fetch = async (input, init) => {
    requestUrl = input;
    requestInit = init;

    return new Response(null, { status: 204 });
  };

  vi.stubGlobal("fetch", fetchMock);

  const path = jsonReviewApiUrl(injectedConfig, "review", "/telemetry/event");
  await reviewFetchUrl(injectedConfig, path);

  expect(new URL(String(requestUrl)).pathname).toBe(
    "/reviews-api/review/telemetry/event",
  );
  expect(new Headers(requestInit?.headers).has("x-review-token")).toBe(false);
  expect(new URL(String(requestUrl)).searchParams.has("token")).toBe(false);
});

it("rejects token query parameters when building API paths", () => {
  expect(() =>
    jsonReviewApiUrl(injectedConfig, "review", "/file?token=secret"),
  ).toThrow(/cannot contain credentials/);
});
