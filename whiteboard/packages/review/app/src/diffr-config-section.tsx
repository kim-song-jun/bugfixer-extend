import {
  type JsonValue,
  type ReviewDiffrConfig,
  type ReviewDiffrConfigActions,
  type ReviewDiffrSummarizerInput,
  isJsonObject,
} from "@dev.fast/review-protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";

const displaySettings = [
  ["context.enabled", "변경되지 않은 줄 접기"],
  ["test-bodies.enabled", "테스트 본문 접기"],
  ["deleted-bodies.enabled", "삭제된 함수 본문 접기"],
  ["removed-runs.enabled", "길게 삭제된 구간 접기"],
  ["group.enabled", "인접한 접기 영역 묶기"],
  ["hide-files.enabled", "태그로 파일 숨기기"],
  ["hide-files.deleted", "삭제된 파일 숨기기"],
] as const;

function setting(
  config: ReviewDiffrConfig,
  key: string,
): JsonValue | undefined {
  let value: JsonValue | undefined = config.values;

  for (const part of `plugins.bundled.${key}`.split("."))
    value = isJsonObject(value) ? value[part] : undefined;

  return value;
}

function summaryDraft(config: ReviewDiffrConfig): ReviewDiffrSummarizerInput {
  return {
    enabled: setting(config, "summarize.enabled") === true,
    model: String(setting(config, "summarize.model") ?? ""),
    tests: setting(config, "summarize.tests") === true,
    apiKey: "",
  };
}

export function DiffrConfigSection({
  actions,
  reloadWindow,
}: {
  actions: ReviewDiffrConfigActions;
  reloadWindow(): Promise<void>;
}) {
  const [opened, setOpened] = useState(false);
  const [config, setConfig] = useState<ReviewDiffrConfig>();
  const [draft, setDraft] = useState<ReviewDiffrSummarizerInput>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  const [summary, setSummary] = useState<string>();
  const [changed, setChanged] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    actions.read().then(
      (result) => {
        if (cancelled) return;
        setConfig(result);
        setDraft(summaryDraft(result));
      },
      () => {
        if (!cancelled)
          setError(
            "diffr 설정을 읽지 못했습니다. 다시 설정을 열어 시도해 주세요.",
          );
      },
    );

    return () => {
      cancelled = true;
    };
  }, [actions, opened]);

  async function run(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);

    try {
      await operation();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "diffr 설정을 업데이트하지 못했습니다.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function saved(result: ReviewDiffrConfig) {
    setConfig(result);

    if (result.changed) setChanged(true);
    setError(result.error);
  }

  const dirty =
    config &&
    draft &&
    JSON.stringify(draft) !== JSON.stringify(summaryDraft(config));

  const unavailable =
    !config || setting(config, "summarize.enabled") === undefined;

  const summaryValid = !!draft?.model.trim();
  const hiddenTags = config ? setting(config, "hide-files.tags") : undefined;

  return (
    <div className="review-settings-diffr">
      <details>
        <summary onClick={() => setOpened(true)}>
          diff 표시 및 AI 요약
        </summary>
        {opened && (
          <>
            <p className="review-settings-row-description">
              diffr CLI와 설정을 공유하며 모든 저장소에 적용됩니다.
            </p>
            {!config && !error && <p role="status">diffr 설정을 읽는 중…</p>}
            {config && (
              <>
                <h3>표시</h3>
                {displaySettings.map(([key, label]) => (
                  <div key={key}>
                    <SettingRow label={label}>
                      <input
                        type="checkbox"
                        aria-label={label}
                        checked={setting(config, key) === true}
                        disabled={busy || setting(config, key) === undefined}
                        onChange={(event) => {
                          const value = event.target.checked;
                          void run(async () =>
                            saved(
                              await actions.set(
                                `plugins.bundled.${key}`,
                                value,
                              ),
                            ),
                          );
                        }}
                      />
                    </SettingRow>
                    {setting(config, key) === undefined && (
                      <p className="review-settings-unavailable">
                        현재 설정에서는 사용할 수 없습니다.
                      </p>
                    )}
                    {key === "context.enabled" && (
                      <SettingRow label="주변 줄 수">
                        <ContextLines
                          value={setting(config, "context.lines")}
                          disabled={busy || setting(config, key) !== true}
                          commit={(value) =>
                            void run(async () =>
                              saved(
                                await actions.set(
                                  "plugins.bundled.context.lines",
                                  value,
                                ),
                              ),
                            )
                          }
                        />
                      </SettingRow>
                    )}
                    {key === "hide-files.enabled" &&
                      Array.isArray(hiddenTags) && (
                        <p className="review-settings-row-description">
                          태그: {hiddenTags.join(", ")}
                        </p>
                      )}
                  </div>
                ))}
                <h3>AI 요약</h3>
                <p className="review-settings-row-description">
                  소스 파일 내용을 Gemini에 보내 새 함수와 테스트가 긴 경우 요약합니다.
                </p>
                {unavailable && (
                  <p className="review-settings-unavailable">
                    현재 설정에서는 요약 기능을 사용할 수 없습니다.
                  </p>
                )}
                {draft && (
                  <fieldset
                    disabled={busy || unavailable}
                    className="review-settings-summary-fields"
                  >
                    <SettingRow label="요약 사용">
                      <input
                        aria-label="요약 사용"
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(event) =>
                          setDraft({ ...draft, enabled: event.target.checked })
                        }
                      />
                    </SettingRow>
                    <SettingRow label="API 키">
                      <input
                        className="review-settings-input"
                        aria-label="API 키"
                        type="password"
                        autoComplete="off"
                        placeholder="새 API 키 입력"
                        value={draft.apiKey}
                        onChange={(event) =>
                          setDraft({ ...draft, apiKey: event.target.value })
                        }
                      />
                    </SettingRow>
                    <p className="review-settings-row-description">
                      {config.credentialSource === "config"
                        ? "저장된 키"
                        : config.credentialSource === "environment"
                          ? "환경 변수에 키가 있습니다"
                          : "설정되지 않음"}
                      . 새 키는 diffr 설정 파일에 저장됩니다. 현재 키를 유지하려면 비워 두세요.
                    </p>
                    <SettingRow label="모델">
                      <input
                        className="review-settings-input"
                        aria-label="모델"
                        value={draft.model}
                        onChange={(event) =>
                          setDraft({ ...draft, model: event.target.value })
                        }
                      />
                    </SettingRow>
                    <SettingRow label="테스트 포함">
                      <input
                        type="checkbox"
                        aria-label="테스트 포함"
                        checked={draft.tests}
                        onChange={(event) =>
                          setDraft({ ...draft, tests: event.target.checked })
                        }
                      />
                    </SettingRow>
                    <div className="review-settings-summary-actions">
                      <button
                        type="button"
                        className="review-settings-button"
                        disabled={!summaryValid}
                        onClick={() =>
                          void run(async () => {
                            setSummary(undefined);
                            setSummary(await actions.testSummarizer(draft));
                          })
                        }
                      >
                        설정 테스트
                      </button>
                      <button
                        type="button"
                        className="review-settings-button"
                        disabled={!summaryValid || !dirty}
                        onClick={() =>
                          void run(async () => {
                            const result = await actions.saveSummarizer(draft);
                            saved(result);

                            if (!result.error || result.changed)
                              setDraft(summaryDraft(result));
                          })
                        }
                      >
                        요약 설정 저장
                      </button>
                    </div>
                    <p className="review-settings-row-description">
                      설정 테스트는 예시 코드를 보내며 현재 설정을 저장하지 않습니다.
                    </p>
                  </fieldset>
                )}
                {summary && (
                  <pre
                    className="review-settings-summary-result"
                    aria-label="요약 예시"
                  >
                    {summary}
                  </pre>
                )}
              </>
            )}
          </>
        )}
      </details>
      {busy && <p role="status">처리 중…</p>}
      {error && (
        <p role="alert" className="review-settings-error">
          {error}
        </p>
      )}
      {changed && (
        <p role="status">
          변경 사항을 적용하려면 창을 다시 불러오세요.{" "}
          <button
            className="review-settings-button"
            disabled={busy}
            onClick={() => {
              if (dirty) setConfirmReload(true);
              else void run(reloadWindow);
            }}
          >
            창 다시 불러오기
          </button>
        </p>
      )}
      {confirmReload && (
        <div role="alertdialog" aria-label="저장하지 않은 요약 설정을 버릴까요?">
          <p>저장하지 않은 요약 설정을 버리고 다시 불러올까요?</p>
          <button
            className="review-settings-button"
            disabled={busy}
            onClick={() => void run(reloadWindow)}
          >
            버리고 다시 불러오기
          </button>{" "}
          <button
            className="review-settings-button"
            onClick={() => setConfirmReload(false)}
          >
            취소
          </button>
        </div>
      )}
    </div>
  );
}

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="review-settings-row">
      <span className="review-settings-row-label">{label}</span>
      {children}
    </div>
  );
}

function ContextLines({
  value,
  disabled,
  commit,
}: {
  value: JsonValue | undefined;
  disabled: boolean;
  commit(value: number): void;
}) {
  const [text, setText] = useState(String(value ?? ""));
  const [error, setError] = useState(false);
  useEffect(() => {
    setText(String(value ?? ""));
  }, [value]);

  function save() {
    if (text === String(value ?? "")) return;
    const number = Number(text);

    if (
      !text.trim() ||
      !Number.isInteger(number) ||
      number < 0 ||
      number > 0xffff_ffff
    ) {
      setError(true);

      return;
    }

    setError(false);
    commit(number);
  }

  return (
    <div>
      <input
        className="review-settings-input"
        aria-label="주변 줄 수"
        type="number"
        min={0}
        max={0xffff_ffff}
        step={1}
        value={text}
        disabled={disabled || value === undefined}
        aria-invalid={error}
        onChange={(event) => setText(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
        }}
      />
      {error && <p role="alert">0 이상의 정수를 입력하세요.</p>}
    </div>
  );
}
