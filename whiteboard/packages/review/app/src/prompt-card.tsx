import { useEffect, useRef, useState } from "react";

import { CopyIcon, copyText } from "./copy-text";

/** What the review covers. This is the only choice the reader makes. */
export type PromptKind = "change" | "architecture";

export const REVIEW_HOME_PROMPT_KIND_STORAGE_KEY =
  "dev.fast.review.homePromptKind";

const PROMPT_KINDS: ReadonlyArray<{ kind: PromptKind; label: string }> = [
  { kind: "change", label: "변경 사항 검토" },
  { kind: "architecture", label: "아키텍처 검토" },
];

/**
 * Prompts name the subject and stop there: Whiteboard's server gives the agent
 * the authoring instructions, so every agent gets the same wording.
 */
export const PROMPTS: Record<PromptKind, string> = {
  change:
    "현재 브랜치를 최신 main과 비교하는 Whiteboard를 만들고, Whiteboard에서 여세요.",
  architecture:
    "이 저장소의 주요 데이터 흐름, 접근 방식, 코드 경로를 정리한 Whiteboard를 만들어 아키텍처를 검토할 수 있게 해 주세요. 작업을 마치면 Whiteboard에서 여세요.",
};

const COPIED_RESET_MS = 2000;

/**
 * The copy-a-prompt card. Only the user's agent can write a review of their
 * own repo, so both the Welcome rail and the Home zero state end here.
 *
 * The tabs choose what the review covers.
 */
export function PromptCard() {
  const [kind, setKind] = useState<PromptKind>(readStoredPromptKind);
  const [copied, setCopied] = useState(false);

  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const selectKind = (next: PromptKind) => {
    setKind(next);
    setCopied(false);
    clearTimeout(resetTimer.current);

    try {
      globalThis.localStorage?.setItem(
        REVIEW_HOME_PROMPT_KIND_STORAGE_KEY,
        next,
      );
    } catch {
      // The desktop can disable DOM storage; the in-memory selection still works.
    }
  };

  const copyPrompt = () => {
    void copyText(PROMPTS[kind]).then((ok) => {
      if (!ok) {
        return;
      }

      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  };

  return (
    <section className="review-home-prompt-card" aria-label="Whiteboard 안내문">
      <div
        className="review-home-prompt-tabs"
        role="group"
        aria-label="검토할 내용"
      >
        {PROMPT_KINDS.map(({ kind: tab, label }) => (
          <button
            key={tab}
            type="button"
            className={kind === tab ? "is-active" : undefined}
            aria-pressed={kind === tab}
            onClick={() => selectKind(tab)}
          >
            {label}
          </button>
        ))}
      </div>
      <pre className="review-home-prompt-body">{PROMPTS[kind]}</pre>
      <div className="review-home-prompt-actions">
        <button
          type="button"
          className="review-home-prompt-copy"
          aria-live="polite"
          aria-label={copied ? "안내문 복사됨" : "안내문 복사"}
          onClick={copyPrompt}
        >
          <CopyIcon />
          {copied ? "복사됨" : "안내문 복사"}
        </button>
      </div>
    </section>
  );
}

function readStoredPromptKind(): PromptKind {
  try {
    const stored = globalThis.localStorage?.getItem(
      REVIEW_HOME_PROMPT_KIND_STORAGE_KEY,
    );

    if (stored === "change" || stored === "architecture") {
      return stored;
    }
  } catch {
    // Fall through to the default when DOM storage is unavailable.
  }

  return "change";
}
