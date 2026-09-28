import type {
  ReviewCanvasSettingsContent,
  ReviewCliInstallStatus,
  ReviewKeymapChoice,
  ReviewThemeChoice,
} from "@dev.fast/review-protocol";
import { type ReactNode, useEffect, useState } from "react";

import { ConnectCard, LegacySkillsRow } from "./connect-card";
import { DiffrConfigSection } from "./diffr-config-section";
import { TraceCaptureSection } from "./trace-capture-section";

const THEME_LABELS: Record<ReviewThemeChoice, string> = {
  light: "밝게",
  dark: "어둡게",
  system: "시스템",
};

const KEYMAP_LABELS: Record<ReviewKeymapChoice, string> = {
  none: "기본",
  vim: "Vim",
  emacs: "Emacs",
};

/**
 * The Settings page. It opens from the application menu (Preferences →
 * Settings...), the command palette, or ⌘,. Reuses the Home page shell so the
 * surfaces read as one app.
 *
 * The workbench owns every value here. Each setter resolves with the value that
 * landed, so a row shows the real state rather than an optimistic one.
 */
export function SettingsPage({
  settings,
}: {
  settings: ReviewCanvasSettingsContent;
}) {
  const [telemetryEnabled, setTelemetryEnabled] = useState(
    settings.telemetryEnabled,
  );

  const [theme, setTheme] = useState(settings.theme);
  const [keymap, setKeymap] = useState(settings.keymap);

  const [softwareMapEnabled, setSoftwareMapEnabled] = useState(
    settings.softwareMapEnabled,
  );

  const [structuralDiffEnabled, setStructuralDiffEnabled] = useState(
    settings.structuralDiffEnabled,
  );

  const [scratchpadEnabled, setScratchpadEnabled] = useState(
    settings.scratchpadEnabled,
  );

  const [installStatus, setInstallStatus] = useState<
    ReviewCliInstallStatus | undefined
  >(settings.install?.status);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => setInstallStatus(settings.install?.status),
    [settings.install?.status],
  );

  const install =
    settings.install && installStatus
      ? { ...settings.install, status: installStatus }
      : settings.install;

  const run = async <T,>(
    key: string,
    action: () => Promise<T>,
    adopt: (value: T) => void,
  ) => {
    setBusy(key);
    setError(null);

    try {
      adopt(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="review-home">
      <div className="review-home-scroll">
        <div className="review-home-content review-settings-page">
          <div className="review-home-page-header">
            <h1>설정</h1>
          </div>
          <p className="review-settings-lede">
            이 설정은 이 컴퓨터의 Whiteboard에 적용됩니다.
          </p>

          {install ? (
            <Section label="에이전트">
              <LegacySkillsRow
                install={install}
                onStatusChange={setInstallStatus}
              />
              <ConnectCard install={install} />
            </Section>
          ) : null}

          {install?.status.cli ? (
            <Section label="명령줄">
              <Row
                label="whiteboard 명령"
                description={
                  install.status.shim.installed
                    ? `설치 경로: ${install.status.shim.path}. 에이전트와 트레이스 수집이 이 명령을 사용합니다.`
                    : "셸 PATH에 whiteboard를 추가합니다. 에이전트와 트레이스 수집이 이 명령을 사용합니다."
                }
              >
                {install.status.shim.installer ? null : (
                  <button
                    type="button"
                    className="review-settings-button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        "command",
                        () =>
                          install.status.shim.installed
                            ? install.remove({ shim: true })
                            : install.apply({ shim: true }),
                        setInstallStatus,
                      )
                    }
                  >
                    {install.status.shim.installed ? "제거" : "설치"}
                  </button>
                )}
              </Row>
            </Section>
          ) : null}

          <Section label="개인정보">
            <Row
              label="익명 사용 데이터 공유"
              description="횟수와 소요 시간만 공유합니다. 코드, 파일 경로, 저장소 이름은 보내지 않습니다."
            >
              <label
                className="review-settings-toggle"
                aria-label="익명 사용 데이터 공유"
              >
                <input
                  type="checkbox"
                  checked={telemetryEnabled}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void run(
                      "telemetry",
                      () => settings.setTelemetryEnabled(enabled),
                      setTelemetryEnabled,
                    );
                  }}
                />
              </label>
            </Row>
          </Section>

          <Section label="편집기">
            <Row label="테마" description="Whiteboard의 화면 모양을 설정합니다.">
              <Choice
                label="테마"
                value={theme}
                labels={THEME_LABELS}
                disabled={busy !== null}
                onChange={(choice) =>
                  void run("theme", () => settings.setTheme(choice), setTheme)
                }
              />
            </Row>
            <Row
              label="키맵"
              description="Vim 및 Emacs 키는 포함된 확장 프로그램에서 제공합니다. 변경 사항을 적용하려면 다시 불러와야 합니다."
            >
              <Choice
                label="키맵"
                value={keymap}
                labels={KEYMAP_LABELS}
                disabled={busy !== null}
                onChange={(choice) => {
                  void run(
                    "keymap",
                    () => settings.setKeymap(choice),
                    setKeymap,
                  );
                }}
              />
            </Row>
          </Section>

          <Section label="도구">
            <Row
              label="확장 프로그램"
              description="언어 확장 프로그램을 설치하거나 켭니다."
            >
              <button
                type="button"
                className="review-settings-button"
                onClick={settings.manageExtensions}
              >
                관리…
              </button>
            </Row>
          </Section>

          <Section label="실험 기능">
            <Row
              label="구조 인식 diff"
              description="기본 diff 화면을 구문을 인식하는 diff와 연결된 접기 영역으로 바꿉니다."
            >
              <label className="review-settings-toggle">
                <input
                  type="checkbox"
                  aria-label="구조 인식 diff"
                  checked={structuralDiffEnabled}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void run(
                      "structural-diff",
                      () => settings.setStructuralDiffEnabled(enabled),
                      setStructuralDiffEnabled,
                    );
                  }}
                />
              </label>
            </Row>
            {structuralDiffEnabled ? (
              <DiffrConfigSection
                actions={settings.diffrConfig}
                reloadWindow={settings.reloadWindow}
              />
            ) : null}
            <Row
              label="소프트웨어 맵"
              description="세션에서 실험 기능인 소프트웨어 맵 화면을 표시합니다."
            >
              <label className="review-settings-toggle">
                <input
                  type="checkbox"
                  aria-label="소프트웨어 맵"
                  checked={softwareMapEnabled}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void run(
                      "software-map",
                      () => settings.setSoftwareMapEnabled(enabled),
                      setSoftwareMapEnabled,
                    );
                  }}
                />
              </label>
            </Row>
            <Row
              label="스크래치패드"
              description="홈 화면에 실험 기능인 스크래치패드를 표시합니다. 에이전트는 Whiteboard MCP 도구로 여기에 그릴 수 있습니다."
            >
              <label className="review-settings-toggle">
                <input
                  type="checkbox"
                  aria-label="스크래치패드"
                  checked={scratchpadEnabled}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void run(
                      "scratchpad",
                      () => settings.setScratchpadEnabled(enabled),
                      setScratchpadEnabled,
                    );
                  }}
                />
              </label>
            </Row>
            {install ? (
              <TraceCaptureSection
                install={install}
                onStatusChange={setInstallStatus}
              />
            ) : null}
          </Section>

          {error ? <p className="review-settings-error">{error}</p> : null}
        </div>
      </div>
    </main>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="review-settings-section" aria-label={label}>
      <h2 className="review-settings-section-label">{label}</h2>
      {children}
    </section>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="review-settings-row">
      <div className="review-settings-row-text">
        <span className="review-settings-row-label">{label}</span>
        <span className="review-settings-row-description">{description}</span>
      </div>
      <div className="review-settings-row-control">{children}</div>
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  labels,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  labels: Record<T, string>;
  disabled: boolean;
  onChange: (choice: T) => void;
}) {
  // SAFETY: `labels` is declared as Record<T, string>, so its own keys are
  // exactly the T choices this control offers.
  const choices = Object.keys(labels) as T[];

  return (
    <div className="review-segmented" role="radiogroup" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={choice}
          type="button"
          role="radio"
          aria-checked={choice === value}
          disabled={disabled}
          className={
            choice === value
              ? "review-segment review-segment--active"
              : "review-segment"
          }
          onClick={() => onChange(choice)}
        >
          {labels[choice]}
        </button>
      ))}
    </div>
  );
}
