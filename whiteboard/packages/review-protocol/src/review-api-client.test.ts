import { afterEach, expect, it, vi } from "vitest";

import { ReviewApiClient } from "./review-api-client.js";

type RequestMock = (url: string, init?: RequestInit) => Promise<Response>;

type FollowMock = <T>(
  path: string,
  signal: AbortSignal,
  accept: (value: T) => void | Promise<void>,
  disconnected: (cause: unknown) => void,
) => { dispose(): void };

afterEach(() => vi.restoreAllMocks());

it("uses only a relative path and no auth header with the desktop transport", async () => {
  const request = vi.fn<RequestMock>(async () => Response.json({ ok: true }));
  const client = new ReviewApiClient(undefined, request);

  await expect(client.read("/review-1/versions")).resolves.toEqual({
    ok: true,
  });

  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[0]).toBe("/reviews-api/review-1/versions");
  expect(
    new Headers(request.mock.calls[0]?.[1]?.headers).has("x-review-token"),
  ).toBe(false);
});

it("uses the injected main-process follow transport until the canvas aborts", async () => {
  const controller = new AbortController();
  let delivered: unknown;
  let disposed = 0;
  let followedPath: string | undefined;

  const follow: FollowMock = <T>(
    path: string,
    _signal: AbortSignal,
    accept: (value: T) => void | Promise<void>,
  ) => {
    followedPath = path;

    // SAFETY: The test client requests a snapshot object with this exact shape.
    void accept({ version: 2 } as T);

    return { dispose: () => disposed++ };
  };

  const client = new ReviewApiClient(undefined, undefined, follow);

  const pending = client.follow(
    "review-1",
    controller.signal,
    (value) => {
      delivered = value;
    },
    () => {},
  );

  expect(followedPath).toBe("/reviews-api/review-1/watch");
  expect(delivered).toEqual({ version: 2 });
  controller.abort();
  await pending;
  expect(disposed).toBe(1);
});
