import type { ReviewApiSummary } from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewHome, formatRelativeTime } from "./review-home-view";

describe("ReviewHome", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(navigator, "clipboard");
    vi.restoreAllMocks();
  });

  it("sorts reviews chronologically across repositories and shows origins", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-22T12:00:00Z"));

    const reviews = [
      summary({
        reviewId: uuid(1),
        title: "Week",
        createdAt: "2026-09-20T12:00:00Z",
      }),
      summary({
        reviewId: uuid(2),
        title: "Recent local",
        createdAt: "2026-09-22T10:00:00Z",
        repositoryPath: "/worktrees/feature-a",
      }),
      summary({
        reviewId: uuid(3),
        title: "Old",
        createdAt: "2026-09-01T12:00:00Z",
      }),
      summary({
        reviewId: uuid(4),
        title: "Newest shared",
        createdAt: "2026-09-22T11:00:00Z",
        repositoryPath: undefined,
        shared: { cloneUrl: "https://github.com/team/other.git" },
      }),
    ];

    await act(async () =>
      root.render(<ReviewHome reviews={reviews} onOpen={() => {}} />),
    );
    expect(
      [...container.querySelectorAll(".review-home-review-title")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["Newest shared", "Recent local", "Week", "Old"]);
    expect(container.textContent).toContain("team/other");
    expect(
      container.querySelector('[title^="/worktrees/feature-a"]'),
    ).not.toBeNull();
  });

  it("filters repositories and changes sort order without losing review actions", async () => {
    const reviews = [
      summary({
        reviewId: uuid(1),
        title: "Zulu",
        repositoryName: "alpha",
        firstCreatedAt: "2026-01-01T00:00:00Z",
        createdAt: "2026-03-01T00:00:00Z",
        origin: { pullRequestNumber: 10 },
      }),
      summary({
        reviewId: uuid(2),
        title: "Alpha",
        repositoryName: "beta",
        firstCreatedAt: "2026-02-01T00:00:00Z",
        createdAt: "2026-02-01T00:00:00Z",
        origin: { pullRequestNumber: 20 },
      }),
    ];

    const onOpen = vi.fn<(review: ReviewApiSummary) => void>();

    const onDismiss = vi.fn<(review: ReviewApiSummary) => Promise<void>>(
      async () => undefined,
    );

    await act(async () =>
      root.render(
        <ReviewHome reviews={reviews} onOpen={onOpen} onDismiss={onDismiss} />,
      ),
    );

    const titles = () =>
      [
        ...container.querySelectorAll(
          ".review-home-table-open .review-home-review-title",
        ),
      ].map((element) => element.textContent);

    const select = async (label: string, value: string) => {
      const names = new Map([
        ["updated", "최근 업데이트순"],
        ["oldest", "오래된 순"],
        ["pr", "PR 번호순"],
        ["title", "제목순"],
      ]);

      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
          .click(),
      );

      const option = [
        ...container.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemradio"]',
        ),
      ].find((element) => element.textContent === (names.get(value) ?? value));

      await act(async () => option!.click());
    };

    expect(titles()).toEqual(["Alpha", "Zulu"]);
    await select("리뷰 정렬", "updated");
    expect(titles()).toEqual(["Zulu", "Alpha"]);
    await select("리뷰 정렬", "oldest");
    expect(titles()).toEqual(["Zulu", "Alpha"]);
    await select("리뷰 정렬", "pr");
    expect(titles()).toEqual(["Alpha", "Zulu"]);
    await select("리뷰 정렬", "title");
    expect(titles()).toEqual(["Alpha", "Zulu"]);
    await select("저장소로 필터", "alpha");
    expect(titles()).toEqual(["Zulu"]);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Zulu 보관"]')!
        .click(),
    );
    expect(onDismiss).toHaveBeenCalledWith(reviews[0]);
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".review-home-table-open")!
        .click(),
    );
    expect(onOpen).toHaveBeenCalledWith(reviews[0]);
  });

  it("puts the scratchpad first, above the reviews and out of their workspaces", async () => {
    const {
      pins: _pins,
      repositoryPath: _path,
      ...base
    } = summary({
      reviewId: "scratchpad",
      title: "Scratchpad",
      repositoryName: "",
    });

    const pad: ReviewApiSummary = {
      ...base,
      kind: "scratchpad",
      contents: { blocks: 6, diagrams: 2 },
    };

    const ordinaryScratchpadTitle = summary({
      reviewId: uuid(1),
      title: "Scratchpad",
    });
    const review = summary({ reviewId: uuid(2), title: "A review" });
    const onOpen = vi.fn<(review: ReviewApiSummary) => void>();
    await act(async () =>
      root.render(
        <ReviewHome
          reviews={[ordinaryScratchpadTitle, review, pad]}
          onOpen={onOpen}
        />,
      ),
    );

    const labels = Array.from(container.querySelectorAll("button")).map(
      (button) => button.textContent ?? "",
    );

    const padIndex = labels.findIndex((text) => text.includes("메모장"));
    expect(padIndex).toBeGreaterThanOrEqual(0);
    expect(padIndex).toBeLessThan(
      labels.findIndex((text) => text.includes("A review")),
    );
    expect(container.querySelectorAll(".review-home-table")).toHaveLength(1);
    expect(container.querySelector(".review-home-dismiss")).toBeNull();
    expect(container.textContent).toContain("6개 항목");
    expect(container.textContent).toContain("2개 다이어그램");

    expect(
      [...container.querySelectorAll(
        ".review-home-table .review-home-review-title",
      )].map((title) => title.textContent),
    ).toContain("Scratchpad");
    const button = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("메모장"),
    )!;

    await act(async () => button.click());
    expect(onOpen).toHaveBeenCalledWith(pad);
  });

  it("shows the scratchpad instead of the Welcome rail when it is the only item", async () => {
    const { pins: _pins, repositoryPath: _path, ...base } = summary({
      reviewId: "scratchpad",
      title: "Scratchpad",
      repositoryName: "",
    });
    const pad: ReviewApiSummary = {
      ...base,
      kind: "scratchpad",
      contents: { blocks: 1, diagrams: 0 },
    };

    await act(async () =>
      root.render(<ReviewHome reviews={[pad]} onOpen={() => {}} />),
    );

    expect(container.querySelector(".review-home-scratchpad")).not.toBeNull();
    expect(container.querySelector(".review-home")).not.toBeNull();
    expect(
      container
        .querySelector(".review-home-scratchpad")
        ?.getAttribute("aria-label"),
    ).toBe("메모장");
    expect(container.textContent).toContain("메모장");
    expect(container.textContent).toContain("1개 항목");
  });

  it("finds the scratchpad by its Korean display name", async () => {
    const { pins: _pins, repositoryPath: _path, ...base } = summary({
      reviewId: "scratchpad",
      title: "Scratchpad",
      repositoryName: "",
    });
    const pad: ReviewApiSummary = { ...base, kind: "scratchpad" };
    const other = summary({ reviewId: uuid(1), title: "Other review" });

    await act(async () =>
      root.render(<ReviewHome reviews={[pad, other]} onOpen={() => {}} />),
    );
    expect(container.querySelector(".review-home-table")).not.toBeNull();

    const search = container.querySelector<HTMLInputElement>(
      '[aria-label="리뷰 검색"]',
    )!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setValue!.call(search, "메모장");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".review-home-scratchpad")).not.toBeNull();
    expect(container.querySelector(".review-home-table")).toBeNull();
  });

  it("opens API reviews without a checkout path", async () => {
    const { repositoryPath: _, ...review } = summary({ title: "API review" });
    const item = { ...review, repositoryName: "Review repository" };
    const onOpen = vi.fn<(review: typeof item) => void>();
    await act(async () =>
      root.render(<ReviewHome reviews={[item]} onOpen={onOpen} />),
    );
    expect(container.textContent).toContain("Review repository");

    const button = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("API review"),
    );

    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(onOpen).toHaveBeenCalledWith(item);
  });

  it("shows reviews from different repositories in one table", async () => {
    const reviews = [
      summary({ reviewId: uuid(1), title: "First dev review" }),
      summary({ reviewId: uuid(2), title: "Second dev review" }),
      summary({
        reviewId: uuid(3),
        title: "Other workspace review",
        repositoryPath: "/repo/other",
      }),
    ];

    await act(async () =>
      root.render(<ReviewHome reviews={reviews} onOpen={() => {}} />),
    );

    expect(container.querySelectorAll(".review-home-table")).toHaveLength(1);
    expect(
      container.querySelectorAll(".review-home-table tbody tr"),
    ).toHaveLength(3);
    expect(container.querySelector('[title^="/repo/dev"]')).not.toBeNull();
    expect(container.querySelector('[title^="/repo/other"]')).not.toBeNull();
  });

  it("keeps archive beside the delete menu without opening the review", async () => {
    const review = summary({ title: "Menu review" });
    const onOpen = vi.fn<(review: ReviewApiSummary) => void>();
    const onDismiss = vi.fn<(review: ReviewApiSummary) => Promise<void>>(
      async () => undefined,
    );

    const onDelete = vi.fn<(review: ReviewApiSummary) => Promise<void>>(
      async () => undefined,
    );

    await act(async () =>
      root.render(
        <ReviewHome
          reviews={[review]}
          onOpen={onOpen}
          onDismiss={onDismiss}
          onDelete={onDelete}
        />,
      ),
    );
    const archive = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Menu review 보관"]',
    );
    expect(archive).not.toBeNull();
    expect(archive?.closest('[role="menu"]')).toBeNull();
    await act(async () => archive!.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(review);
    expect(onDelete).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Menu review 작업"]',
        )!
        .click(),
    );
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Menu review 작업"]',
    )!;
    const actions = trigger.parentElement!;
    await act(async () => {
      actions.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());

    const remove =
      container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;

    await act(async () => remove.click());
    expect(onDelete).not.toHaveBeenCalled();
    expect(remove.textContent).toContain("삭제 확인");
    await act(async () => remove.click());
    expect(onDelete).toHaveBeenCalledWith(review);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("deletes a review after an arming click without opening it", async () => {
    const onOpen = vi.fn<(review: ReviewApiSummary) => void>();

    const onDelete = vi.fn<(review: ReviewApiSummary) => Promise<void>>(
      async () => undefined,
    );

    const reviews = [
      summary({
        reviewId: uuid(1),
        title: "Removable",
        dismissedAt: "2026-08-13T20:00:00.000Z",
      }),
    ];

    await act(async () =>
      root.render(
        <ReviewHome reviews={reviews} onOpen={onOpen} onDelete={onDelete} />,
      ),
    );

    const dismissed = container.querySelector<HTMLButtonElement>(
      ".review-home-dismissed-toggle",
    );

    expect(dismissed).not.toBeNull();
    await act(async () => dismissed!.click());

    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Removable 삭제"]',
    );

    expect(remove).not.toBeNull();
    await act(async () => remove!.click());
    expect(onDelete).not.toHaveBeenCalled();

    const confirm = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Removable 삭제 확인"]',
    );

    await act(async () => confirm!.click());
    expect(onDelete).toHaveBeenCalledWith(reviews[0]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "optimistically deletes and restores failed deletions (dismissed: %s)",
    async (isDismissed) => {
      const review = summary({
        title: "Pending review",
        dismissedAt: isDismissed ? "2026-08-13T20:00:00.000Z" : null,
      });

      const deletion = Promise.withResolvers<void>();

      const onDelete = vi.fn<(review: ReviewApiSummary) => Promise<void>>(
        () => deletion.promise,
      );

      await act(async () =>
        root.render(
          <ReviewHome
            reviews={[review]}
            onOpen={() => {}}
            onDelete={onDelete}
          />,
        ),
      );
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            isDismissed
              ? ".review-home-dismissed-toggle"
              : '[aria-label="Pending review 작업"]',
          )!
          .click(),
      );

      const remove = container.querySelector<HTMLButtonElement>(
        '[aria-label="Pending review 삭제"]',
      )!;

      await act(async () => remove.click());
      expect(container.textContent).toContain("Pending review");
      await act(async () => remove.click());
      expect(onDelete).toHaveBeenCalledWith(review);
      expect(container.textContent).not.toContain("Pending review");
      expect(container.querySelector('[role="menu"]')).toBeNull();

      await act(async () => deletion.reject(new Error("Offline")));
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain("삭제하지 못했습니다");
      expect(
        container.querySelector(
          isDismissed
            ? '[aria-label="Pending review 삭제"]'
            : '[aria-label="Pending review 작업"]',
        ),
      ).not.toBeNull();
    },
  );

  it("keeps a successful deletion hidden until the catalog catches up, and allows reimport", async () => {
    const review = summary({ title: "Pending review" });
    const deletion = Promise.withResolvers<void>();

    const onDelete = vi.fn<(review: ReviewApiSummary) => Promise<void>>(
      () => deletion.promise,
    );

    const render = async (reviews: ReviewApiSummary[]) =>
      act(async () =>
        root.render(
          <ReviewHome
            reviews={reviews}
            onOpen={() => {}}
            onDelete={onDelete}
          />,
        ),
      );

    await render([review]);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Pending review 작업"]',
        )!
        .click(),
    );

    const remove =
      container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;

    await act(async () => remove.click());
    await act(async () => remove.click());
    expect(container.textContent).not.toContain("Pending review");
    await act(async () => deletion.resolve());
    await render([review]);
    expect(container.textContent).not.toContain("Pending review");
    await render([]);
    await render([review]);
    expect(container.textContent).toContain("Pending review");
  });

  it("keeps attention actions on native summaries", async () => {
    const review = summary({
      title: "Native review",
      version: 0,
      origin: { pullRequestNumber: 320 },
    });

    const onOpen = vi.fn<(review: ReviewApiSummary) => void>();

    const onDismiss = vi.fn<(review: ReviewApiSummary) => Promise<void>>(
      async () => {},
    );

    const onRestore = vi.fn<(review: ReviewApiSummary) => Promise<void>>(
      async () => {},
    );

    const render = async (item: ReviewApiSummary) =>
      act(async () =>
        root.render(
          <ReviewHome
            reviews={[item]}
            onOpen={onOpen}
            onDismiss={onDismiss}
            onRestore={onRestore}
          />,
        ),
      );

    await render(review);
    expect(container.textContent).toContain("#320");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Native review 보관"]',
        )!
        .click(),
    );
    expect(onDismiss).toHaveBeenCalledWith(review);
    expect(onOpen).not.toHaveBeenCalled();

    const dismissed = {
      ...review,
      viewedAt: "2026-09-01T00:00:00Z",
      dismissedAt: "2026-09-02T00:00:00Z",
    };

    await render(dismissed);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".review-home-dismissed-toggle")!
        .click(),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".review-home-restore")!
        .click(),
    );
    expect(onRestore).toHaveBeenCalledWith(dismissed);
    await render({ ...dismissed, dismissedAt: null });
    const reviewButton = container.querySelector(".review-home-table-open");
    expect(reviewButton).not.toBeNull();
    expect(reviewButton!.textContent).toContain("Native review");
  });

  it("reports failed archive and restore actions and allows retry", async () => {
    const review = summary({ title: "Retryable review" });
    const dismissed = {
      ...review,
      dismissedAt: "2026-09-02T00:00:00Z",
    };
    const onDismiss = vi
      .fn<(item: ReviewApiSummary) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue(undefined);
    const onRestore = vi
      .fn<(item: ReviewApiSummary) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue(undefined);

    const render = async (item: ReviewApiSummary) =>
      act(async () =>
        root.render(
          <ReviewHome
            reviews={[item]}
            onOpen={() => {}}
            onDismiss={onDismiss}
            onRestore={onRestore}
          />,
        ),
      );

    await render(review);
    const archive = () =>
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Retryable review 보관"]',
      )!;
    await act(async () => archive().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "보관하지 못했습니다",
    );
    expect(archive().disabled).toBe(false);

    await act(async () => archive().click());
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await render(dismissed);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".review-home-dismissed-toggle")!
        .click(),
    );
    const restore = container.querySelector<HTMLButtonElement>(
      ".review-home-restore",
    )!;
    await act(async () => restore.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "복원하지 못했습니다",
    );
    expect(restore.disabled).toBe(false);

    await act(async () => restore.click());
    expect(onRestore).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("clears action feedback when catalog state reconciles or the review disappears", async () => {
    const review = summary({ title: "Reconciled review" });
    const dismissed = {
      ...review,
      dismissedAt: "2026-09-02T00:00:00Z",
    };
    const onDismiss = vi.fn<(item: ReviewApiSummary) => Promise<void>>(
      async () => {
        throw new Error("Offline");
      },
    );
    const onRestore = vi.fn<(item: ReviewApiSummary) => Promise<void>>(
      async () => {
        throw new Error("Offline");
      },
    );

    const render = async (reviews: ReviewApiSummary[]) =>
      act(async () =>
        root.render(
          <ReviewHome
            reviews={reviews}
            onOpen={() => {}}
            onDismiss={onDismiss}
            onRestore={onRestore}
          />,
        ),
      );

    await render([review]);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Reconciled review 보관"]',
        )!
        .click(),
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await render([dismissed]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".review-home-dismissed-toggle")!
        .click(),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".review-home-restore")!
        .click(),
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await render([]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".review-welcome-page")).not.toBeNull();
  });

  it.each([
    { platform: "MacIntel", find: { metaKey: true }, other: { ctrlKey: true } },
    { platform: "Win32", find: { ctrlKey: true }, other: { metaKey: true } },
    {
      platform: "Linux x86_64",
      find: { ctrlKey: true },
      other: { metaKey: true },
    },
  ])(
    "focuses the search box on the $platform find shortcut",
    async ({ platform, find, other }) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      await act(async () =>
        root.render(<ReviewHome reviews={[summary()]} onOpen={() => {}} />),
      );

      const press = async (modifiers: KeyboardEventInit) => {
        const event = new KeyboardEvent("keydown", {
          key: "f",
          ...modifiers,
          bubbles: true,
          cancelable: true,
        });

        await act(async () => document.body.dispatchEvent(event));

        return event;
      };

      const search = container.querySelector('[aria-label="리뷰 검색"]');
      expect(search).not.toBeNull();

      expect((await press(other)).defaultPrevented).toBe(false);
      expect(document.activeElement).not.toBe(search);
      expect((await press(find)).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(search);
    },
  );

  it("hides the delete action when the host does not support deletion", async () => {
    await act(async () =>
      root.render(<ReviewHome reviews={[summary()]} onOpen={() => {}} />),
    );
    expect(container.querySelector(".review-home-delete")).toBeNull();
  });

  it("shows the native snapshot update time in the table", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-07-29T12:00:00.000Z"),
    );

    const review = summary({
      createdAt: "2026-07-29T11:54:00.000Z",
    });

    await act(async () =>
      root.render(<ReviewHome reviews={[review]} onOpen={() => {}} />),
    );
    expect(container.textContent).toContain("6분 전");
    expect(container.textContent).not.toContain("updated not published");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-07-29T12:00:00.000Z");

  it("formats compact relative times", () => {
    expect(formatRelativeTime("2026-07-29T11:54:00.000Z", now)).toBe(
      "6 min ago",
    );
    expect(formatRelativeTime("2026-07-28T12:00:00.000Z", now)).toBe(
      "1 day ago",
    );
    expect(formatRelativeTime(null, now)).toBe("unknown");
  });
});

function summary(overrides: Partial<ReviewApiSummary> = {}): ReviewApiSummary {
  return {
    reviewId: uuid(9),
    version: 0,
    title: "Progressive Review",
    repositoryPath: "/repo/dev",
    repositoryName: (overrides.repositoryPath ?? "/repo/dev")
      .split("/")
      .at(-1)!,
    pins: {
      repositoryId: overrides.repositoryPath ?? "/repo/dev",
      base: "base",
      head: "head",
    },
    origin: { branch: "feature/home" },
    diffStats: null,
    createdAt: "2026-07-29T11:54:00.000Z",
    viewedAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

function uuid(suffix: number): string {
  return `11111111-1111-4111-8111-${String(suffix).padStart(12, "0")}`;
}
