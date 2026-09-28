import type {
  ReviewApiSummary,
  ReviewCanvasInstallContent,
  ReviewCanvasOnboarding,
  ReviewCanvasSetupActions,
} from "@dev.fast/review-protocol";
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { fuzzyMatches, fuzzySegments } from "../../src/fuzzy-match";
import { OptionMenu } from "./option-menu";
import { ArchiveIcon } from "./review-corner-action";
import { useDismissOnOutside } from "./use-dismiss-on-outside";
import { useTopbarPopover } from "./use-topbar-popover";
import { WelcomePage } from "./welcome-page";

interface ReviewHomeProps {
  reviews: readonly ReviewApiSummary[];
  onOpen(review: ReviewApiSummary): void;
  // Deletion is permanent and requires an arming click.
  // Absent when the host does not support deletion.
  onDelete?(review: ReviewApiSummary): Promise<void>;
  // Dismissal is reversible. Absent when the host does not
  // support them.
  onDismiss?(review: ReviewApiSummary): Promise<void>;
  onRestore?(review: ReviewApiSummary): Promise<void>;
  // Present only while the list is empty: Home then renders Welcome.
  install?: ReviewCanvasInstallContent;
  setupActions?: ReviewCanvasSetupActions;
  onboarding?: ReviewCanvasOnboarding;
  onOpenTutorial?(): void;
}

interface ReviewAttentionActions {
  onDelete?(review: ReviewApiSummary): Promise<void>;
  onDismiss?(review: ReviewApiSummary): Promise<void>;
  onRestore?(review: ReviewApiSummary): Promise<void>;
}

/* Passed by context rather than through every list and card signature: the
   actions are optional and only leaf controls use them. */
const AttentionActionsContext = createContext<ReviewAttentionActions>({});

/* The search query reaches the leaves the same way, and for the same reason:
   every title and worktree label marks its own hit, and threading a prop
   through the card tree and a table column would touch far more code. */
const SearchQueryContext = createContext("");

/** A label with the characters the query hit marked. */
function MatchedText({ text }: { text: string }) {
  const query = useContext(SearchQueryContext);
  const segments = fuzzySegments(query, text);

  // One segment can also mean the query matched the whole label, so check that
  // it is the unmatched one before skipping the marks.
  if (segments.length === 1 && !segments[0].matched) return <>{text}</>;

  return (
    <>
      {segments.map((segment, index) =>
        segment.matched ? (
          // Segments are positional, so the index is the only stable key.
          // eslint-disable-next-line react/no-array-index-key
          <mark key={index}>{segment.text}</mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

export function ReviewHome({
  reviews,
  onOpen,
  onDelete,
  onDismiss,
  onRestore,
  install,
  setupActions,
  onboarding,
  onOpenTutorial,
}: ReviewHomeProps) {
  const [showDismissed, setShowDismissed] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [query, setQuery] = useState("");
  const [, setNow] = useState(Date.now);

  const [deletions, setDeletions] = useState(
    new Map<string, "pending" | "deleted">(),
  );

  const [deleteError, setDeleteError] = useState<string>();

  // Keep successful deletions hidden until the catalog acknowledges removal.
  useEffect(() => {
    setDeletions((current) => {
      const next = new Map(current);

      for (const [id, status] of current) {
        if (
          status === "deleted" &&
          !reviews.some((review) => review.reviewId === id)
        ) {
          next.delete(id);
        }
      }

      return next.size === current.size ? current : next;
    });
  }, [reviews, deletions]);

  const deleteReview = useCallback(
    async (review: ReviewApiSummary) => {
      if (!onDelete) return;
      setDeleteError(undefined);
      setDeletions((current) =>
        new Map(current).set(review.reviewId, "pending"),
      );

      try {
        await onDelete(review);
        setDeletions((current) =>
          new Map(current).set(review.reviewId, "deleted"),
        );
      } catch {
        setDeletions((current) => {
          const next = new Map(current);
          next.delete(review.reviewId);

          return next;
        });
        setDeleteError(
          `“${reviewTitle(review)}” 리뷰를 삭제하지 못했습니다. 다시 시도해 주세요.`,
        );
      }
    },
    [onDelete],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  const actions = useMemo(
    () => ({
      onDismiss,
      onRestore,
      onDelete: onDelete ? deleteReview : undefined,
    }),
    [onDismiss, onRestore, onDelete, deleteReview],
  );

  const needle = query.trim();

  // The one scratchpad is the last group on Home, outside the workspaces,
  // their chronological order and their lifecycle. The filter still finds it.
  const scratchpad = reviews.find((review) => review.kind === "scratchpad");

  const listed = useMemo(
    () => reviews.filter((review) => review.kind !== "scratchpad"),
    [reviews],
  );

  const scratchpadShown =
    scratchpad !== undefined && matchesQuery(scratchpad, needle);

  const found = useMemo(
    () =>
      listed.filter(
        (review) =>
          !deletions.has(review.reviewId) && matchesQuery(review, needle),
      ),
    [listed, needle, deletions],
  );

  /* Dismissed leaves the main list entirely: it is the one group you asked to
     stop seeing. */
  const active = found.filter((review) => !review.dismissedAt);

  const dismissed = found
    .filter((review) => review.dismissedAt)
    .sort(latestFirst);

  /* With nothing to list, Home is the Welcome rail rather than a zero state
     of its own: the same three steps, in the place the reader already is.
 */
  if (
    !onboardingDismissed &&
    listed.length === 0 &&
    scratchpad === undefined &&
    deletions.size === 0 &&
    !deleteError
  ) {
    return (
      <WelcomePage
        onDismissUpdate={() => setOnboardingDismissed(true)}
        install={install}
        setupActions={setupActions}
        onboarding={onboarding}
        onOpenTutorial={onOpenTutorial}
      />
    );
  }

  return (
    <main className="review-home">
      <div className="review-home-scroll">
        <div className="review-home-content">
          <div className="review-home-page-header">
            <h1>리뷰</h1>
            <div className="review-home-page-header-tools">
              <SearchBox query={query} onChange={setQuery} />
            </div>
          </div>
          {deleteError ? <p role="alert">{deleteError}</p> : null}
          {/* Keyed off the active list, not the whole result: a query that hits
              only dismissed reviews empties the main area, and the collapsed
              Dismissed count alone does not explain why. */}
          {needle && active.length === 0 && !scratchpadShown ? (
            <p className="review-home-search-empty">
              {dismissed.length > 0
                ? `“${needle}”와 일치하는 진행 중인 리뷰가 없습니다. 아래 보관 목록을 확인해 주세요.`
                : `“${needle}”와 일치하는 리뷰가 없습니다.`}
            </p>
          ) : null}
          <SearchQueryContext.Provider value={needle}>
            <AttentionActionsContext.Provider value={actions}>
              {scratchpadShown ? (
                <ScratchpadGroup review={scratchpad} onOpen={onOpen} />
              ) : null}
              {active.length > 0 ? (
                <ReviewTable reviews={active} onOpen={onOpen} />
              ) : null}
              {dismissed.length > 0 ? (
                <DismissedSection
                  reviews={dismissed}
                  expanded={showDismissed}
                  onToggle={() => setShowDismissed((open) => !open)}
                  onOpen={onOpen}
                  onDelete={actions.onDelete}
                />
              ) : null}
            </AttentionActionsContext.Provider>
          </SearchQueryContext.Provider>
        </div>
      </div>
    </main>
  );
}

/**
 * Filter-as-you-type over the review title and the worktree name — the two
 * labels the page already shows. Escape clears it.
 */
function SearchBox({
  query,
  onChange,
}: {
  query: string;
  onChange(query: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);

  // ⌘F (Ctrl+F off the Mac) jumps to the filter instead of the browser's
  // find bar. Ctrl+F stays forward-char on the Mac.
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);

    const keydown = (event: KeyboardEvent) => {
      if (
        (mac ? event.metaKey : event.ctrlKey) &&
        !(mac ? event.ctrlKey : event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };

    window.addEventListener("keydown", keydown);

    return () => window.removeEventListener("keydown", keydown);
  }, []);

  return (
    <div className="review-home-search">
      <SearchIcon />
      <input
        ref={input}
        type="search"
        value={query}
        placeholder="리뷰 검색"
        aria-label="리뷰 검색"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {query ? (
        <button
          type="button"
          className="review-home-search-clear"
          aria-label="리뷰 검색 지우기"
          // Clearing unmounts this button, so hand focus back to the field
          // rather than letting it fall to the body.
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
        >
          <ClearIcon />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Dismissed reviews, collapsed by default and kept out of the workspace
 * grouping. Sessions stay saved until the reader deletes them.
 */
function DismissedSection({
  reviews,
  expanded,
  onToggle,
  onOpen,
  onDelete,
}: {
  reviews: readonly ReviewApiSummary[];
  expanded: boolean;
  onToggle(): void;
  onOpen(review: ReviewApiSummary): void;
  onDelete?(review: ReviewApiSummary): Promise<void>;
}) {
  return (
    <section className="review-home-dismissed" aria-label="보관한 리뷰">
      <button
        type="button"
        className="review-home-dismissed-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span>보관한 리뷰</span>
        <span className="review-home-dismissed-count">{reviews.length}</span>
      </button>
      {expanded ? (
        <div className="review-home-dismissed-rows">
          {reviews.map((review) => (
            <div key={review.reviewId} className="review-home-dismissed-row">
              <button
                type="button"
                className="review-home-dismissed-open"
                onClick={() => onOpen(review)}
              >
                <MatchedText text={reviewTitle(review)} />
              </button>
                <span className="review-home-dismissed-clock">보관됨</span>
              <RestoreReviewButton review={review} />
              {onDelete ? (
                <DeleteReviewButton review={review} onDelete={onDelete} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Undo clears the dismissal stamp. */
function RestoreReviewButton({ review }: { review: ReviewApiSummary }) {
  const { onRestore } = useContext(AttentionActionsContext);
  const [busy, setBusy] = useState(false);

  if (!onRestore) return null;

  return (
    <button
      type="button"
      className="review-home-restore"
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        setBusy(true);
        void onRestore(review)
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      복원
    </button>
  );
}

type ReviewSort = "newest" | "oldest" | "updated" | "pr" | "title";

function ReviewTable({
  reviews,
  onOpen,
}: {
  reviews: readonly ReviewApiSummary[];
  onOpen(review: ReviewApiSummary): void;
}) {
  const [repository, setRepository] = useState("");
  const [sort, setSort] = useState<ReviewSort>("newest");
  const repositories = [...new Set(reviews.map(repositoryLabel))].sort();

  const filtered = reviews.filter(
    (review) => !repository || repositoryLabel(review) === repository,
  );

  const sorted = [...filtered].sort((left, right) => {
    const created = (review: ReviewApiSummary) =>
      Date.parse(review.firstCreatedAt ?? review.createdAt) || 0;

    switch (sort) {
      case "oldest":
        return created(left) - created(right);
      case "updated":
        return latestFirst(left, right);
      case "pr":
        return (
          (right.origin?.pullRequestNumber ?? -1) -
            (left.origin?.pullRequestNumber ?? -1) || latestFirst(left, right)
        );
      case "title":
        return reviewTitle(left).localeCompare(reviewTitle(right));
      default:
        return created(right) - created(left);
    }
  });

  return (
    <section className="review-home-table-section" aria-label="리뷰 목록">
      <div className="review-home-table-toolbar">
        <span>리뷰 {filtered.length}개</span>
        <div className="review-home-table-controls">
          <TableMenu
            label="저장소"
            ariaLabel="저장소로 필터"
            value={repository}
            options={[
              { value: "", label: "모든 저장소" },
              ...repositories.map((name) => ({ value: name, label: name })),
            ]}
            onChange={setRepository}
          />
          <TableMenu<ReviewSort>
            label="정렬"
            ariaLabel="리뷰 정렬"
            value={sort}
            options={[
              { value: "newest", label: "최신순" },
              { value: "oldest", label: "오래된 순" },
              { value: "updated", label: "최근 업데이트순" },
              { value: "pr", label: "PR 번호순" },
              { value: "title", label: "제목순" },
            ]}
            onChange={setSort}
          />
        </div>
      </div>
      <div className="review-home-table-scroll">
        <table className="review-home-table">
          <colgroup>
            <col className="review-home-col-pr" />
            <col />
            <col className="review-home-col-branch" />
            <col className="review-home-col-date" />
            <col className="review-home-col-date" />
            <col className="review-home-col-action" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">PR</th>
              <th scope="col">제목</th>
              <th scope="col">브랜치</th>
              <th scope="col">생성</th>
              <th scope="col">업데이트</th>
              <th scope="col">
                <span className="review-home-action-heading">작업</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((review) => (
              <tr key={review.reviewId} onClick={() => onOpen(review)}>
                <td>
                  {review.origin?.pullRequestNumber
                    ? `#${review.origin.pullRequestNumber}`
                    : "—"}
                </td>
                <td>
                  <button
                    className="review-home-table-open"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(review);
                    }}
                    title={reviewTitle(review)}
                  >
                    <span className="review-home-review-title">
                      <MatchedText text={reviewTitle(review)} />
                    </span>
                    <span
                      className="review-home-table-repository"
                      title={
                        review.repositoryPath ??
                        (review.shared ? "공유 리뷰" : undefined)
                      }
                    >
                      <RepositoryName review={review} />
                    </span>
                  </button>
                </td>
                <td title={review.origin?.branch}>
                  <MatchedText
                    text={readableSourceBranch(review.origin?.branch) ?? "—"}
                  />
                </td>
                <td title={review.firstCreatedAt}>
                  {formatCreatedTime(review.firstCreatedAt)}
                </td>
                <td title={reviewUpdatedAt(review)}>
                  {formatHomeRelativeTime(reviewUpdatedAt(review))}
                </td>
                <td>
                  <ReviewRowActions review={review} />
                </td>
              </tr>
            ))}
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={6}>이 저장소에 해당하는 리뷰가 없습니다.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReviewRowActions({ review }: { review: ReviewApiSummary }) {
  const { onDelete, onDismiss } = useContext(AttentionActionsContext);
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useTopbarPopover(open, control);

  useDismissOnOutside(control, open, setOpen);

  if (!onDelete) return <DismissReviewButton review={review} />;

  return (
    <div
      ref={control}
      className="review-home-row-actions"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      {onDismiss ? <DismissReviewButton review={review} /> : null}
      <button
        ref={trigger}
        type="button"
        className="review-home-row-menu-trigger"
        aria-label={`${reviewTitle(review)} 작업`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="15.5" cy="10" r="1.6" />
        </svg>
      </button>
      {open ? (
        <div
          ref={popover}
          popover="manual"
          role="menu"
          aria-label="리뷰 작업"
          className="review-home-row-menu"
        >
          <DeleteReviewButton review={review} onDelete={onDelete} menu />
        </div>
      ) : null}
    </div>
  );
}

function TableMenu<T extends string>({
  label,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  label: "저장소" | "정렬";
  ariaLabel: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
}) {
  return (
    <OptionMenu
      ariaLabel={ariaLabel}
      value={value}
      options={options}
      onChange={onChange}
      className="review-home-table-menu"
      triggerClassName="review-home-table-menu-trigger"
    >
      <svg
        className="review-home-table-menu-icon"
        viewBox="0 0 20 20"
        aria-hidden="true"
      >
        <path
          d={
            label === "저장소"
              ? "M3 5h14M6 10h8M8.5 15h3"
              : "M6 4v12m0 0-3-3m3 3 3-3M14 16V4m0 0-3 3m3-3 3 3"
          }
        />
      </svg>
      <span>{label}</span>
      <strong>
        {options.find((option) => option.value === value)?.label ?? value}
      </strong>
    </OptionMenu>
  );
}

function formatCreatedTime(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";

  return new Date(value).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * The scratchpad's own group, last on Home: a header in the workspace
 * header's grammar, then one card in the review card's grammar. No status,
 * workspace or dismissal, since it has none.
 */
function ScratchpadGroup({
  review,
  onOpen,
}: {
  review: ReviewApiSummary;
  onOpen(review: ReviewApiSummary): void;
}) {
  const contents = review.contents;

  return (
    <section className="review-home-scratchpad" aria-label="메모장">
      <div className="review-home-scratchpad-rows">
        <button
          type="button"
          className="review-home-scratchpad-row"
          onClick={() => onOpen(review)}
        >
          <span className="review-home-scratchpad-main">
            <span className="review-home-review-title">
              <PencilIcon />
              <MatchedText text={homeDisplayTitle(review)} />
            </span>
            <span className="review-home-scratchpad-meta">
              {contents ? (
                <>
                  <span>{contents.blocks}개 항목</span>
                  <span>{contents.diagrams}개 다이어그램</span>
                </>
              ) : null}
              <span>
                {formatHomeRelativeTime(reviewUpdatedAt(review))} 업데이트
              </span>
            </span>
          </span>
        </button>
      </div>
    </section>
  );
}

function PencilIcon() {
  return (
    <svg
      className="review-home-scratchpad-glyph"
      aria-hidden="true"
      viewBox="0 0 16 16"
    >
      <path d="M3 13l1-4 7-7 3 3-7 7-4 1z" />
      <path d="M10 3l3 3" />
    </svg>
  );
}

/**
 * The one action an active review offers. One click: dismissal is reversible,
 * so it needs no arming step. It stays enabled for unavailable reviews so a
 * dead review can still leave the list.
 */
function DismissReviewButton({ review }: { review: ReviewApiSummary }) {
  const { onDismiss } = useContext(AttentionActionsContext);
  const [busy, setBusy] = useState(false);

  if (!onDismiss) return null;
  const title = reviewTitle(review);

  return (
    <button
      type="button"
      className="review-home-dismiss"
      aria-label={`${title} 보관`}
      title="리뷰 보관"
      disabled={busy}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        setBusy(true);
        void onDismiss(review)
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      <ArchiveIcon />
    </button>
  );
}

/**
 * Two-step delete: the first click arms the button, the second click deletes
 * the review. Focus loss disarms it. The row menu and dismissed section share
 * this arming step.
 */
function DeleteReviewButton({
  review,
  onDelete,
  menu = false,
}: {
  review: ReviewApiSummary;
  onDelete(review: ReviewApiSummary): Promise<void>;
  menu?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = reviewTitle(review);

  return (
    <button
      type="button"
      className={
        menu
          ? "review-home-menu-delete"
          : armed
            ? "review-home-delete is-armed"
            : "review-home-delete"
      }
      role={menu ? "menuitem" : undefined}
      aria-label={armed ? `${title} 삭제 확인` : `${title} 삭제`}
      title={armed ? "삭제 확인" : "리뷰 삭제"}
      disabled={busy}
      onBlur={() => setArmed(false)}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();

        if (!armed) {
          setArmed(true);

          return;
        }

        setBusy(true);
        void onDelete(review)
          .catch(() => undefined)
          .finally(() => {
            setBusy(false);
            setArmed(false);
          });
      }}
    >
      {menu ? (
        <>
          <TrashIcon />
          <span>{armed ? "삭제 확인" : "리뷰 삭제"}</span>
        </>
      ) : armed ? (
        "삭제?"
      ) : (
        <TrashIcon />
      )}
    </button>
  );
}

function RepositoryName({ review }: { review: ReviewApiSummary }) {
  const label = repositoryLabel(review);
  const separator = label.lastIndexOf("/");

  return separator < 0 ? (
    <strong>
      <MatchedText text={label} />
    </strong>
  ) : (
    <>
      <span>
        <MatchedText text={label.slice(0, separator)} />
      </span>
      <span aria-hidden="true">/</span>
      <strong>
        <MatchedText text={label.slice(separator + 1)} />
      </strong>
    </>
  );
}

export function reviewUpdatedAt(review: ReviewApiSummary): string {
  return review.createdAt;
}

/** {@link reviewUpdatedAt} as epoch milliseconds; 0 when unknown. */
function reviewUpdatedAtMs(review: ReviewApiSummary): number {
  return Date.parse(reviewUpdatedAt(review) ?? "") || 0;
}

function latestFirst(left: ReviewApiSummary, right: ReviewApiSummary): number {
  return reviewUpdatedAtMs(right) - reviewUpdatedAtMs(left);
}

export function formatRelativeTime(
  timestamp: string | null | undefined,
  now = Date.now(),
): string {
  if (!timestamp) return "unknown";
  const then = Date.parse(timestamp);

  if (!Number.isFinite(then)) return "unknown";
  const elapsed = Math.max(0, now - then);

  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);

  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);

  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(then);
}

function formatHomeRelativeTime(timestamp: string | null | undefined): string {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "알 수 없음";

  const elapsed = Math.max(0, Date.now() - Date.parse(timestamp));
  const formatter = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });

  if (elapsed < 60_000) return formatter.format(0, "second");
  if (elapsed < 3_600_000) {
    return formatter.format(-Math.floor(elapsed / 60_000), "minute");
  }
  if (elapsed < 86_400_000) {
    return formatter.format(-Math.floor(elapsed / 3_600_000), "hour");
  }

  return formatter.format(-Math.floor(elapsed / 86_400_000), "day");
}

function reviewTitle(review: ReviewApiSummary): string {
  return review.title.trim() || "제목 없는 리뷰";
}

function homeDisplayTitle(review: ReviewApiSummary): string {
  return review.kind === "scratchpad" ? "메모장" : reviewTitle(review);
}

function matchesQuery(review: ReviewApiSummary, query: string): boolean {
  return fuzzyMatches(
    query,
    homeDisplayTitle(review),
    review.kind === "scratchpad" ? reviewTitle(review) : "",
    repositoryLabel(review),
    review.repositoryPath ?? "",
    review.origin?.branch ?? "",
  );
}

function repositoryLabel(review: ReviewApiSummary): string {
  if (review.repositoryGroup) return review.repositoryGroup.label;

  if (review.shared?.cloneUrl) {
    try {
      return new URL(review.shared.cloneUrl).pathname
        .replace(/^\//, "")
        .replace(/\.git$/, "");
    } catch {
      // Older imports may not have a valid remote URL.
    }
  }

  return (
    review.repositoryName ??
    worktreeLabel(review.repositoryPath ?? review.pins?.repositoryId ?? "")
  );
}

function readableSourceBranch(value: string | null | undefined): string | null {
  if (!value || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) return null;

  return value;
}

function worktreeLabel(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);

  return parts.at(-1) ?? value;
}

export function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2 13.5 13.5" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 5.5h13M8 5.5V4h4v1.5M5 5.5l.8 11h8.4l.8-11M8.3 8.5l.3 5M11.7 8.5l-.3 5" />
    </svg>
  );
}
