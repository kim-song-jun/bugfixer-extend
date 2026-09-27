import {
  REVIEW_DISCORD_URL,
  type ReviewCanvasInstallContent,
  type ReviewCanvasOnboarding,
  type ReviewCanvasSetupActions,
  type ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { type ReactNode, useEffect, useState } from "react";

import { cliInstallReady } from "./cli-install-status";
import { ConnectCard, LegacySkillsRow } from "./connect-card";
import { DisclosureChevron, DrawnCheckIcon } from "./icons";
import { newTabLinkProps } from "./link-props";
import { PromptCard } from "./prompt-card";

export const REVIEW_CONNECT_COPIED_STORAGE_KEY =
  "dev.fast.review.connectCopied";

/** Long enough for a finished step's check to draw before the next opens. */
export const STEP_ADVANCE_DELAY_MS = 900;

/** First-run setup and migration from legacy agent skills to MCP. */
export function WelcomePage({
  install: initialInstall,
  setupActions,
  onClose,
  onDismissUpdate,
  onboarding,
  onOpenTutorial,
}: {
  install?: ReviewCanvasInstallContent;
  setupActions?: ReviewCanvasSetupActions;
  onClose?: () => void;
  onDismissUpdate?: () => void;
  onboarding?: ReviewCanvasOnboarding;
  onOpenTutorial?: () => void;
}) {
  const [loadedInstall, setLoadedInstall] =
    useState<ReviewCanvasInstallContent>();

  const [setupError, setSetupError] = useState<string>();
  const [setupBusy, setSetupBusy] = useState(false);
  const install = loadedInstall ?? initialInstall;

  const runSetup = async (action: () => Promise<void>) => {
    setSetupBusy(true);
    setSetupError(undefined);

    try {
      await action();
    } catch (cause) {
      setSetupError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSetupBusy(false);
    }
  };

  /* The host renders this pane once per open, so an action taken while it is
     on screen has to advance the rail itself. Each action hands back the
     refreshed status; until the first one, the host's copy is correct. */
  const [cardStatus, setCardStatus] = useState<
    ReviewCliInstallStatus | undefined
  >(undefined);

  const status = cardStatus ?? install?.status;

  // The step a button just finished stays open while its check draws, then
  // hands over to the next one unless the reader opened another meanwhile.
  const [finishing, setFinishing] = useState<{ from: string; to?: string }>();

  useEffect(() => {
    if (!finishing) return;

    const timer = setTimeout(() => {
      setFinishing(undefined);
      setOpenStep((current) =>
        current === finishing.from ? finishing.to : current,
      );
    }, STEP_ADVANCE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [finishing]);

  const refreshInstall = async () => {
    if (!setupActions) return;
    const next = await setupActions.load();
    setLoadedInstall(next);

    if (cliInstallReady(next.status) && next.status.legacySkills.length === 0)
      setFinishing({
        from: "Install the whiteboard command",
        to: "Connect your agents",
      });
    setCardStatus(undefined);
  };

  const installed = cliInstallReady(status);
  const cliBuildMissing = status?.cli === null && !installed;

  const hasLegacySkills = (status?.legacySkills.length ?? 0) > 0;
  const setupReady = installed && !hasLegacySkills;
  // Once shown, the removal step stays, even if an agent following the
  // connect prompt deletes the skills first.
  const [showLegacyStep, setShowLegacyStep] = useState(hasLegacySkills);
  const updating = (status?.updateNeeded ?? false) || showLegacyStep;

  if (hasLegacySkills && !showLegacyStep) setShowLegacyStep(true);

  const [replaceInstallStep, setReplaceInstallStep] = useState(
    () => installed && hasLegacySkills,
  );

  if (installed && hasLegacySkills && !replaceInstallStep)
    setReplaceInstallStep(true);

  // Whiteboard cannot inspect agent configs, so this records copied setup
  // guidance only; it does not confirm that the agent has been connected.
  const [connectCopied, setConnectCopied] = useState(readConnectCopied);
  const [updateFinished, setUpdateFinished] = useState(false);
  const [connectOpened, setConnectOpened] = useState(false);
  const canDismiss = setupReady && connectOpened;

  const markConnectCopied = () => {
    setConnectCopied(true);
    setFinishing({
      from: "Connect your agents",
      to: updating ? "Continue shipping thoughtful code" : "Take the tour",
    });

    try {
      globalThis.localStorage?.setItem(REVIEW_CONNECT_COPIED_STORAGE_KEY, "1");
    } catch {
      // The desktop can disable DOM storage; the in-memory flag still works.
    }
  };

  const tourChecked = onboarding?.tutorialChecked ?? 0;
  const tourTotal = onboarding?.tutorialTotal ?? 0;

  const installStep: WelcomeStep = {
    title: "Install the whiteboard command",
    label: "Whiteboard 명령 설치",
    disabled: hasLegacySkills,
    done: installed,
    body: (
      <>
        <p className="review-home-zero-hint">
          {installed ? (
            `${status?.shim.path ?? "~/.local/bin/whiteboard"}에 설치되어 있습니다.`
          ) : cliBuildMissing ? (
            <>
              CLI 빌드를 찾을 수 없습니다. 소스에서 실행 중이라면 저장소 루트에서{" "}
              <code>pnpm --filter @dev.fast/review build</code> 명령을 실행한 뒤 Whiteboard를 다시 시작하세요. 소스 실행이 아니라면
              Whiteboard를 다시 설치하세요.
            </>
          ) : status?.shim.installed ? (
            pathHint(status.shim.path)
          ) : (
            <>
              <code>whiteboard</code> CLI를 설치하면 에이전트가 Whiteboard와
              연결됩니다.
            </>
          )}
        </p>
        {finishing?.from === "Install the whiteboard command" ? (
          <StepDoneButton label="설치됨" primary />
        ) : null}
        {setupActions && !installed && !cliBuildMissing ? (
          <button
            type="button"
            className="review-onboarding-primary review-onboarding-install"
            disabled={setupBusy}
            onClick={() =>
              void runSetup(async () => {
                await setupActions.installCli();
                await refreshInstall();
              })
            }
          >
            PATH에 whiteboard 설치
          </button>
        ) : null}
        {setupActions &&
        (!install ||
          cliBuildMissing ||
          (status?.shim.installed && !installed)) ? (
          <button
            type="button"
            disabled={setupBusy}
            onClick={() => void runSetup(refreshInstall)}
          >
            {setupBusy ? "새로고치는 중…" : "상태 새로고침"}
          </button>
        ) : null}
        {setupError ? (
          <p role="alert" className="review-agent-setup-error">
            {setupError}
          </p>
        ) : null}
      </>
    ),
  };

  const dismissUpdate = () => {
    if (!install || !canDismiss) return;
    void runSetup(async () => {
      setCardStatus(await install.finishUpdate());
      setUpdateFinished(true);
      (onDismissUpdate ?? onClose)?.();
    });
  };

  const steps: WelcomeStep[] = [
    ...(showLegacyStep && install && status
      ? [
          {
            title: "Remove deprecated skills",
            label: hasLegacySkills
              ? "이전 Skills 제거"
              : "이전 Skills를 제거했습니다",
            done: !hasLegacySkills,
            body:
              finishing?.from === "Remove deprecated skills" ? (
                <StepDoneButton label="제거됨" />
              ) : !hasLegacySkills ? (
                <p role="status">이전 Skills를 제거했습니다.</p>
              ) : (
                <LegacySkillsRow
                  install={{ ...install, status }}
                  onStatusChange={(next) => {
                    setCardStatus(next);

                    if (next.legacySkills.length === 0)
                      setFinishing({
                        from: "Remove deprecated skills",
                        to: cliInstallReady(next)
                          ? "Connect your agents"
                          : "Install the whiteboard command",
                      });
                  }}
                />
              ),
          },
        ]
      : []),
    ...(replaceInstallStep && installed ? [] : [installStep]),
    {
      title: "Connect your agents",
      label: connectCopied
        ? "설정 안내 복사"
        : updateFinished
          ? "업데이트"
          : "에이전트 연결",
      disabled: !setupReady,
      done: connectCopied || updateFinished,
      note: connectCopied
        ? "복사한 설정 안내를 에이전트에 붙여넣거나 설치 명령을 실행해 연결을 마무리하세요."
        : updateFinished
          ? "Whiteboard 업데이트를 완료했습니다."
          : "안내문을 복사해 에이전트에 붙여넣거나 플러그인을 설치하세요.",
      body:
        install && status ? (
          <ConnectCard
            install={{ ...install, status }}
            onCopied={markConnectCopied}
          />
        ) : (
          <p className="review-home-empty">에이전트 설정을 사용할 수 없습니다.</p>
        ),
    },
  ];

  if ((updating || showLegacyStep) && install)
    steps.push({
      title: "Continue shipping thoughtful code",
      label: "Whiteboard 계속 사용하기",
      disabled: !canDismiss,
      done: updateFinished,
      body: (
        <button
          type="button"
          className="review-welcome-dismiss review-onboarding-primary"
          disabled={setupBusy || !canDismiss}
          onClick={dismissUpdate}
        >
          닫기
        </button>
      ),
    });

  if (!updating && !showLegacyStep)
    steps.push(
      {
        title: "Take the tour",
        label: "사용법 둘러보기",
        disabled: !setupReady,
        done: tourTotal > 0 && tourChecked >= tourTotal,
        note: onboarding
          ? `${tourTotal}개 중 ${tourChecked}개 확인`
          : "3분 샘플 세션",
        body: (
          <>
            <p className="review-home-zero-hint">
              3분 동안 샘플 세션을 살펴보며 Whiteboard 사용법을 익혀 보세요.
            </p>
            {onOpenTutorial ? (
              <button type="button" onClick={onOpenTutorial}>
                {tourChecked > 0 ? "튜토리얼 다시 열기" : "튜토리얼 열기"}
              </button>
            ) : null}
          </>
        ),
      },
      {
        title: "Create your first session",
        label: "첫 세션 만들기",
        disabled: !setupReady,
        done: onboarding?.published ?? false,
        note: onboarding?.published ? "게시됨" : "에이전트가 작성합니다",
        body: <PromptCard />,
      },
    );

  // Keep step identity stable as status and completion labels change.
  const [openStep, setOpenStep] = useState(() =>
    updating && installed && !hasLegacySkills
      ? "Connect your agents"
      : steps.find((step) => !step.done)?.title,
  );

  if (openStep && !steps.some((step) => step.title === openStep))
    setOpenStep(steps.find((step) => !step.done && !step.disabled)?.title);

  if (openStep === "Connect your agents" && setupReady && !connectOpened)
    setConnectOpened(true);

  return (
    <main className="review-home">
      <div className="review-home-scroll">
        <div className="review-home-content review-welcome-page">
          <div className="review-onboarding-columns">
            <div className="review-onboarding-intro">
              <span className="review-onboarding-kicker">
                Whiteboard 시작하기
              </span>
              {updating ? (
                <>
                  <h1 className="review-onboarding-headline">
                    이제 MCP로 에이전트와 Whiteboard를 연결합니다
                  </h1>
                  <p className="review-onboarding-sub">
                    Whiteboard는 더 이상 Skills를 설치하지 않습니다. 대신 MCP로
                    에이전트를 연결하면 업데이트와 관리가 간편해집니다. 계속
                    사용하려면 기존 Skills를 제거하고 사용하는 도구에 플러그인을
                    설치하세요.
                  </p>
                </>
              ) : (
                <>
                  <h1 className="review-onboarding-headline">
                    에이전트가 설명하는 내 코드베이스
                  </h1>
                  <p className="review-onboarding-sub">
                    먼저 CLI를 설치하고 MCP를 설정하면 시작할 수 있습니다.
                  </p>
                </>
              )}
              {(updating || showLegacyStep) && install ? (
                <button
                  type="button"
                  className="review-welcome-dismiss"
                  disabled={setupBusy || !canDismiss}
                  onClick={dismissUpdate}
                >
                  닫기
                </button>
              ) : onClose ? (
                <button
                  type="button"
                  className="review-welcome-dismiss"
                  disabled={setupBusy || !canDismiss}
                  onClick={onClose}
                >
                  닫기
                </button>
              ) : null}
            </div>
            <ol className="review-onboarding-steps">
              {steps.map((step, index) => {
                const open = openStep === step.title && !step.disabled;

                return (
                  <li
                    key={step.title}
                    className="review-onboarding-step"
                    data-state={step.done ? "done" : "todo"}
                    data-open={open}
                  >
                    <button
                      type="button"
                      className="review-onboarding-step-header"
                      disabled={step.disabled}
                      aria-expanded={open}
                      aria-label={`${open ? "접기" : "펼치기"} ${step.label ?? step.title}${step.done ? " · 완료" : ""}`}
                      aria-describedby={step.note ? `review-onboarding-step-note-${index}` : undefined}
                      onClick={() => setOpenStep(open ? undefined : step.title)}
                    >
                      <StepBadge done={step.done} label={String(index + 1)} />
                      <span className="review-onboarding-step-title">
                        {step.label ?? step.title}
                      </span>
                      {step.note ? (
                        <span
                          id={`review-onboarding-step-note-${index}`}
                          className="review-onboarding-step-note"
                        >
                          {step.note}
                        </span>
                      ) : null}
                      <DisclosureChevron expanded={open} />
                    </button>
                    {open ? (
                      <div className="review-onboarding-step-body">
                        {step.body}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
          <p className="review-welcome-feedback">
            {updating || showLegacyStep
              ? "이름 변경이나 제품 방향에 대한 의견이 있나요?"
              : "시작하는 데 궁금한 점이나 제안이 있나요?"}{" "}
            의견은{" "}
            <a
              href={REVIEW_DISCORD_URL}
              {...newTabLinkProps(REVIEW_DISCORD_URL)}
            >
              Discord
            </a>{" "}
            또는 이메일{" "}
            <a href="mailto:founders@dev.fast">founders@dev.fast</a>.
          </p>
        </div>
      </div>
    </main>
  );
}

function readConnectCopied(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(REVIEW_CONNECT_COPIED_STORAGE_KEY) ===
      "1"
    );
  } catch {
    return false;
  }
}

interface WelcomeStep {
  title: string;
  label?: string;
  done: boolean;
  disabled?: boolean;
  note?: string;
  body: ReactNode;
}

/** The button that finished a step, held while its check draws. */
function StepDoneButton({
  label,
  primary,
}: {
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={`review-onboarding-step-done${primary ? " review-onboarding-primary review-onboarding-install" : ""}`}
      disabled
    >
      <DrawnCheckIcon />
      {label}
    </button>
  );
}

function StepBadge({ done, label }: { done: boolean; label: string }) {
  return (
    <span className="review-onboarding-step-badge" data-done={done}>
      {done ? (
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 5.5 4 8l4.5-6" fill="none" strokeWidth="1.6" />
        </svg>
      ) : (
        label
      )}
    </span>
  );
}

/** Windows has no shell profile to edit: its user PATH reaches new terminals. */
function pathHint(shimPath: string): string {
  if (/^[a-z]:[\\/]/i.test(shimPath) || /\.cmd$/i.test(shimPath))
    return "새 터미널을 연 뒤 상태를 새로고침하세요.";
  const directory = shimPath.replace(/[\\/][^\\/]*$/, "");

  return `${directory || "~/.local/bin"}을(를) PATH에 추가한 뒤 상태를 새로고침하세요.`;
}
