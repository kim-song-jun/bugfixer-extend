import { expect, it, vi } from "vitest";

import { testReviewBridge } from "../review-session-test-utils";
import { createReviewSession } from "./review-session";

it("sends credential-free relative JSON requests to the displayed version", async () => {
  const request = vi.fn<ReturnType<typeof testReviewBridge>["request"]>(
    async () => Response.json({ text: "copied" }),
  );

  let version = 2;

  const session = createReviewSession(testReviewBridge({}, { request }), {
    jsonReview: { id: "review-1", version: () => version },
  });

  await session.fetch("/copy-context", { method: "POST" });
  const [url, init] = request.mock.calls[0]!;
  const copyUrl = new URL(url, "http://review.invalid");
  expect(copyUrl.pathname).toBe("/reviews-api/review-1/copy-context");
  expect(copyUrl.searchParams.get("version")).toBe("2");
  expect(copyUrl.searchParams.has("document")).toBe(false);
  expect(new Headers(init?.headers).has("x-review-token")).toBe(false);

  version = 3;
  await session.fetch("/telemetry/event", { method: "POST" });
  const telemetryUrl = new URL(
    request.mock.calls[1]![0],
    "http://review.invalid",
  );
  expect(telemetryUrl.pathname).toBe("/reviews-api/review-1/telemetry/event");
  expect(telemetryUrl.searchParams.get("version")).toBe("3");
  expect(telemetryUrl.searchParams.has("token")).toBe(false);
});

it("rejects absolute or tokenized request URLs before invoking the bridge", async () => {
  const request = vi.fn<ReturnType<typeof testReviewBridge>["request"]>(
    async () => Response.json({ ok: true }),
  );
  const session = createReviewSession(testReviewBridge({}, { request }), {
    jsonReview: { id: "review-1", version: () => undefined },
  });

  await expect(
    session.fetchUrl("https://example.test/reviews-api/review-1/file"),
  ).rejects.toThrow(/relative API path/);
  await expect(
    session.fetchUrl("/reviews-api/review-1/file?token=secret"),
  ).rejects.toThrow(/relative API path/);
  expect(request).not.toHaveBeenCalled();
});
