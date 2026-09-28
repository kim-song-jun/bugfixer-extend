import type { ReviewDiffFileWire } from "@dev.fast/review-protocol";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import {
  ReviewDiffFilesProvider,
  useReviewDiffFiles,
} from "./review-diff-files-context";
import { testReviewSession } from "./review-session-test-utils";

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReviewDiffFilesProvider", () => {
  it("does not request diff files for the scratchpad", async () => {
    const files = vi.fn<() => Promise<ReviewDiffFileWire[]>>();

    const session = testReviewSession(
      {},
      {
        diffView: {
          create: () => {
            throw new Error("unused");
          },
          files,
        },
      },
    );

    session.review = { ...session.review!, kind: "scratchpad", pins: undefined };

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    function Probe() {
      const state = useReviewDiffFiles();

      return <span>{state.status}</span>;
    }

    await act(async () => {
      root!.render(
        <ReviewSessionProvider session={session}>
          <ReviewDiffFilesProvider documentKey="scratchpad">
            <Probe />
          </ReviewDiffFilesProvider>
        </ReviewSessionProvider>,
      );
    });

    expect(container.textContent).toBe("loaded");
    expect(files).not.toHaveBeenCalled();
  });

  it("isolates same-key snapshots when switching between review and scratchpad", async () => {
    const file: ReviewDiffFileWire = {
      path: "src/review.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
    };

    const files = vi.fn<() => Promise<ReviewDiffFileWire[]>>(async () => [file]);

    const reviewSession = testReviewSession(
      {},
      {
        diffView: {
          create: () => {
            throw new Error("unused");
          },
          files,
        },
      },
    );

    const scratchpadSession = {
      ...reviewSession,
      review: { ...reviewSession.review!, kind: "scratchpad" as const, pins: undefined },
    };

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const committedStates: string[] = [];

    function Probe() {
      const state = useReviewDiffFiles();

      const label =
        state.status === "loaded"
          ? `loaded:${state.files.map(({ path }) => path).join(",")}`
          : state.status;

      useLayoutEffect(() => {
        committedStates.push(label);
      });

      return <span>{label}</span>;
    }

    const renderSession = (session: typeof reviewSession) =>
      root!.render(
        <ReviewSessionProvider session={session}>
          <ReviewDiffFilesProvider documentKey="same-document">
            <Probe />
          </ReviewDiffFilesProvider>
        </ReviewSessionProvider>,
      );

    await act(async () => renderSession(reviewSession));
    expect(container.textContent).toBe("loaded:src/review.ts");
    expect(files).toHaveBeenCalledTimes(1);

    const beforeScratchpad = committedStates.length;
    await act(async () => renderSession(scratchpadSession));
    expect(container.textContent).toBe("loaded:");
    expect(committedStates.slice(beforeScratchpad)).not.toContain(
      "loaded:src/review.ts",
    );
    expect(files).toHaveBeenCalledTimes(1);

    const beforeReview = committedStates.length;
    await act(async () => renderSession(reviewSession));
    expect(container.textContent).toBe("loaded:src/review.ts");
    expect(committedStates.slice(beforeReview)).not.toContain("loaded:");
    expect(files).toHaveBeenCalledTimes(2);
  });

  it("reads the desktop's prefetched diff without a network request", async () => {
    const files = vi.fn<() => Promise<ReviewDiffFileWire[]>>(async () => [
      {
        path: "src/prefetched.ts",
        status: "modified" as const,
        additions: 4,
        deletions: 2,
        patch: "diff --git a/src/prefetched.ts b/src/prefetched.ts",
      },
    ]);

    const nativeSession = testReviewSession(
      {},
      {
        diffView: {
          create: () => {
            throw new Error("unused test diff view");
          },
          files,
        },
      },
    );

    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    function Probe() {
      const state = useReviewDiffFiles();

      return (
        <span>
          {state.status === "loaded" ? state.files[0]?.path : state.status}
        </span>
      );
    }

    await act(async () => {
      root!.render(
        <ReviewSessionProvider session={nativeSession}>
          <ReviewDiffFilesProvider documentKey="review-one">
            <Probe />
          </ReviewDiffFilesProvider>
        </ReviewSessionProvider>,
      );
    });

    expect(container.textContent).toBe("src/prefetched.ts");
    expect(files).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts one request after commit and shares it with every consumer", async () => {
    let committed = false;
    let resolveRequest!: (response: ReviewDiffFileWire[]) => void;

    const pendingResponse = new Promise<ReviewDiffFileWire[]>((resolve) => {
      resolveRequest = resolve;
    });

    const files = vi.fn<() => Promise<ReviewDiffFileWire[]>>(() => {
      expect(committed).toBe(true);

      return pendingResponse;
    });

    const session = testReviewSession(
      {},
      {
        diffView: {
          create: () => {
            throw new Error("unused");
          },
          files,
        },
      },
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    function Probe({ label }: { label: string }) {
      const state = useReviewDiffFiles();
      useLayoutEffect(() => {
        committed = true;
      }, []);

      return (
        <span>
          {label}:{state.status}
          {state.status === "loaded" ? `:${state.files.length}` : ""}
        </span>
      );
    }

    await act(async () => {
      root!.render(
        <ReviewSessionProvider session={session}>
          <ReviewDiffFilesProvider documentKey="review-one">
            <Probe label="one" />
            <Probe label="two" />
          </ReviewDiffFilesProvider>
        </ReviewSessionProvider>,
      );
    });
    expect(files).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRequest([
        {
          path: "src/current.ts",
          status: "modified",
          additions: 8,
          deletions: 3,
        },
      ]);
      await pendingResponse;
    });
    expect(container.textContent).toContain("one:loaded:1");
    expect(container.textContent).toContain("two:loaded:1");
    expect(files).toHaveBeenCalledTimes(1);
  });

  it("never exposes or restores files from a previous document key", async () => {
    let resolveSecondDocument!: (value: ReviewDiffFileWire[]) => void;

    const secondDocument = new Promise<ReviewDiffFileWire[]>((resolve) => {
      resolveSecondDocument = resolve;
    });

    const responses = [
      Promise.resolve([
        {
          path: "src/first.ts",
          status: "modified" as const,
          additions: 1,
          deletions: 0,
        },
      ]),
      secondDocument,
      Promise.resolve([
        {
          path: "src/third.ts",
          status: "modified" as const,
          additions: 3,
          deletions: 0,
        },
      ]),
    ];

    const files = vi.fn<() => Promise<ReviewDiffFileWire[]>>(
      async () => responses.shift()!,
    );

    const session = testReviewSession(
      {},
      {
        diffView: {
          create: () => {
            throw new Error("unused");
          },
          files,
        },
      },
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const committedStates: string[] = [];

    function Probe() {
      const state = useReviewDiffFiles();

      const label =
        state.status === "loaded"
          ? `loaded:${state.files[0]?.path}`
          : state.status;

      useLayoutEffect(() => {
        committedStates.push(label);
      });

      return <span>{label}</span>;
    }

    await act(async () => {
      root!.render(
        <ReviewSessionProvider session={session}>
          <ReviewDiffFilesProvider documentKey="review-one">
            <Probe />
          </ReviewDiffFilesProvider>
        </ReviewSessionProvider>,
      );
    });
    expect(container.textContent).toBe("loaded:src/first.ts");

    const transitionStart = committedStates.length;
    await act(async () => {
      root!.render(
        <ReviewSessionProvider session={session}>
          <ReviewDiffFilesProvider documentKey="review-two">
            <Probe />
          </ReviewDiffFilesProvider>
        </ReviewSessionProvider>,
      );
    });
    expect(committedStates.slice(transitionStart)).not.toContain(
      "loaded:src/first.ts",
    );
    expect(container.textContent).toBe("loading");

    await act(async () => {
      root!.render(
        <ReviewSessionProvider session={session}>
          <ReviewDiffFilesProvider documentKey="review-three">
            <Probe />
          </ReviewDiffFilesProvider>
        </ReviewSessionProvider>,
      );
    });
    expect(container.textContent).toBe("loaded:src/third.ts");

    await act(async () => {
      resolveSecondDocument([
        {
          path: "src/second.ts",
          status: "modified",
          additions: 2,
          deletions: 0,
        },
      ]);
      await secondDocument;
    });
    expect(container.textContent).toBe("loaded:src/third.ts");
    expect(files).toHaveBeenCalledTimes(3);
  });
});
