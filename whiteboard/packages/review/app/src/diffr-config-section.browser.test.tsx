import {
  type ReviewDiffrConfig,
  type ReviewDiffrConfigActions,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { DiffrConfigSection } from "./diffr-config-section";

let root: ReturnType<typeof createRoot>;

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});

function config(): ReviewDiffrConfig {
  return {
    credentialSource: "config",
    values: {
      plugins: {
        bundled: {
          context: { enabled: true, lines: 3 },
          "test-bodies": { enabled: true },
          "deleted-bodies": { enabled: true },
          "removed-runs": { enabled: true },
          group: { enabled: true },
          "hide-files": { enabled: true, deleted: true, tags: ["test"] },
          summarize: { enabled: false, model: "test-model", tests: true },
        },
      },
    },
  };
}

async function mount() {
  const current = config();

  const actions: ReviewDiffrConfigActions = {
    read: vi.fn<ReviewDiffrConfigActions["read"]>(async () => current),
    set: vi.fn<ReviewDiffrConfigActions["set"]>(async () => ({
      ...current,
      changed: true,
    })),
    saveSummarizer: vi.fn<ReviewDiffrConfigActions["saveSummarizer"]>(
      async (input) => ({
        ...current,
        changed: true,
        values: {
          plugins: {
            bundled: {
              summarize: {
                enabled: input.enabled,
                model: input.model,
                tests: input.tests,
              },
            },
          },
        },
      }),
    ),
    testSummarizer: vi.fn<ReviewDiffrConfigActions["testSummarizer"]>(
      async () => "count positive values",
    ),
  };

  const reload = vi.fn<() => Promise<void>>(async () => {});
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(<DiffrConfigSection actions={actions} reloadWindow={reload} />),
  );

  return { actions, reload, current };
}

async function open() {
  await act(async () => {
    await page.getByText("diff 표시 및 AI 요약", { exact: true }).click();
  });
  await expect.element(page.getByLabelText("테스트 본문 접기")).toBeVisible();
}

test("starts collapsed and reads only on first expansion", async () => {
  const { actions } = await mount();
  expect(actions.read).not.toHaveBeenCalled();
  expect(document.querySelector("input")).toBeNull();
  await open();
  expect(actions.read).toHaveBeenCalledOnce();
  await act(async () => {
    await page.getByText("diff 표시 및 AI 요약", { exact: true }).click();
  });
  await open();
  expect(actions.read).toHaveBeenCalledOnce();
});

test("writes the selected key and keeps reload visible when collapsed", async () => {
  const { actions, reload } = await mount();
  await open();
  await act(async () => {
    await page.getByLabelText("테스트 본문 접기").click();
  });
  expect(actions.set).toHaveBeenCalledWith(
    "plugins.bundled.test-bodies.enabled",
    false,
  );
  await expect
    .element(
      page.getByRole("button", { name: "창 다시 불러오기", exact: true }),
    )
    .toBeVisible();
  await act(async () => {
    await page.getByText("diff 표시 및 AI 요약", { exact: true }).click();
  });
  await act(async () => {
    await page
      .getByRole("button", { name: "창 다시 불러오기", exact: true })
      .click();
  });
  expect(reload).toHaveBeenCalledOnce();
});

test("rejects invalid context lines without writing", async () => {
  const { actions } = await mount();
  await open();
  await act(async () => {
    await page.getByLabelText("주변 줄 수").fill("-1");
  });
  await act(async () => {
    await page.getByLabelText("모델", { exact: true }).click();
  });
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("0 이상의 정수");
  expect(actions.set).not.toHaveBeenCalled();
});

test("tests draft settings without saving, then saves and clears the key", async () => {
  const { actions } = await mount();
  await open();
  expect(
    (document.querySelector("input[type=password]") as HTMLInputElement).value,
  ).toBe("");
  await act(async () => {
    await page.getByLabelText("API 키", { exact: true }).fill("test-secret");
  });
  await act(async () => {
    await page
      .getByRole("button", { name: "설정 테스트", exact: true })
      .click();
  });
  await expect
    .element(page.getByLabelText("요약 예시"))
    .toHaveTextContent("count positive values");
  expect(actions.saveSummarizer).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("창을 다시 불러오세요");
  await act(async () => {
    await page.getByRole("button", { name: "요약 설정 저장" }).click();
  });
  expect(actions.saveSummarizer).toHaveBeenCalledWith({
    enabled: false,
    model: "test-model",
    tests: true,
    apiKey: "test-secret",
  });
  await expect
    .element(page.getByLabelText("API 키", { exact: true }))
    .toHaveValue("");
});

test("confirms discarding unsaved summary edits before reloading", async () => {
  const { reload } = await mount();
  await open();
  await act(async () => {
    await page.getByLabelText("테스트 본문 접기").click();
  });
  await act(async () => {
    await page.getByLabelText("모델", { exact: true }).fill("new-model");
  });
  await act(async () => {
    await page
      .getByRole("button", { name: "창 다시 불러오기", exact: true })
      .click();
  });
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  expect(reload).not.toHaveBeenCalled();
  await act(async () => {
    await page.getByRole("button", { name: "취소", exact: true }).click();
  });
  expect(reload).not.toHaveBeenCalled();
  await act(async () => {
    await page
      .getByRole("button", { name: "창 다시 불러오기", exact: true })
      .click();
  });
  await act(async () => {
    await page.getByRole("button", { name: "버리고 다시 불러오기" }).click();
  });
  expect(reload).toHaveBeenCalledOnce();
});

test("does not prompt for reload after a no-op and disables reload while testing", async () => {
  const { actions, current } = await mount();
  await open();
  vi.mocked(actions.set).mockResolvedValueOnce({ ...current, changed: false });
  await act(async () => {
    await page.getByLabelText("테스트 본문 접기").click();
  });
  expect(document.body.textContent).not.toContain("창을 다시 불러오세요");
  await act(async () => {
    await page.getByLabelText("테스트 본문 접기").click();
  });
  let finish!: (value: string) => void;
  vi.mocked(actions.testSummarizer).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    await page
      .getByRole("button", { name: "설정 테스트", exact: true })
      .click();
  });
  await expect
    .element(
      page.getByRole("button", { name: "창 다시 불러오기", exact: true }),
    )
    .toBeDisabled();
  await act(async () => finish("summary"));
});

test("shows partial save errors with authoritative values and a reload prompt", async () => {
  const { actions, current } = await mount();
  await open();
  vi.mocked(actions.saveSummarizer).mockResolvedValue({
    ...current,
    changed: true,
    error: "Some settings were saved.",
  });
  await act(async () => {
    await page.getByLabelText("모델", { exact: true }).fill("new-model");
  });
  await act(async () => {
    await page.getByRole("button", { name: "요약 설정 저장" }).click();
  });
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Some settings were saved.");
  await expect
    .element(page.getByLabelText("모델", { exact: true }))
    .toHaveValue("test-model");
  await expect
    .element(
      page.getByRole("button", { name: "창 다시 불러오기", exact: true }),
    )
    .toBeVisible();
});
