import type {
  ReviewCommitScope,
  ReviewDiffLens,
  ReviewDiffProgress,
  ReviewDiffViewHandle,
} from "@dev.fast/review-protocol";
import {
  type CSSProperties,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Lens } from "../../src/review-api/diff-lenses";
import {
  type CoverageProgress,
  coverageProgress,
  coverageSources,
} from "../../src/viewed-coverage";
import { AuthoringActivityContext } from "./authoring-activity";
import { scopeLive } from "./authoring-cursor";
import { Courier, LensCursorContext, lensRowElement } from "./courier";
import { compactDiffCount } from "./diff-count";
import { withErasedBlocks } from "./draw-queue";
import { useMotionPhases } from "./draw-queue-provider";
import { useReviewSession } from "./host/review-session";
import { useReviewLenses } from "./review-lenses";
import { isKoreanReviewUi } from "./review-locale";
import {
  useBottomSheetResize,
  useRightPanelResize,
} from "./side-panel-resizer";
import { useTooltip } from "./use-tooltip";
import { ViewedButton } from "./viewed-button";

export function DiffCounts({ progress }: { progress: CoverageProgress }) {
  const { remaining, total, folded } = progress;
  const korean = isKoreanReviewUi();

  const tooltip = useTooltip<HTMLSpanElement>(
    `+${remaining.additions} −${remaining.deletions}${korean ? " 남음" : " remaining"}`,
    {
      instant: true,
      detail: korean
        ? `전체 +${total.additions} −${total.deletions}${folded.additions + folded.deletions ? ` · 접힘 +${folded.additions} −${folded.deletions}` : ""}`
        : `of +${total.additions} −${total.deletions} total${folded.additions + folded.deletions ? ` · +${folded.additions} −${folded.deletions} folded` : ""}`,
    },
  );

  return (
    <span
      ref={tooltip}
      className={`diff-counts ${progress.state === "viewed" || progress.state === "folded" ? "is-viewed" : ""}`}
    >
      {progress.state === "viewed" ? (
        korean ? (
          "확인함"
        ) : (
          "Viewed"
        )
      ) : progress.state === "folded" ? (
        korean ? (
          "접힘"
        ) : (
          "Folded"
        )
      ) : (
        <>
          <span className="diff-count-added">
            +{compactDiffCount(remaining.additions)}
          </span>
          <span className="diff-count-removed">
            −{compactDiffCount(remaining.deletions)}
          </span>
        </>
      )}
    </span>
  );
}

export function ReviewDiffView({
  scope,
  revealFile,
}: {
  scope?: ReviewCommitScope;
  /** The path of a file to scroll to once the diff loads. */
  revealFile?: string;
}) {
  const korean = isKoreanReviewUi();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const cabinetsRef = useRef<HTMLDivElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
    sidebarToggleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;

    sidebarCloseRef.current?.focus();

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSidebar();
    };

    document.addEventListener("keydown", closeOnEscape);

    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [sidebarOpen, closeSidebar]);

  const sidebarResize = useRightPanelResize({
    side: "left",
    stateKey: "diff-sidebar-width",
    defaultWidth: 320,
    minWidth: 250,
    maxWidth: 800,
    minMainWidth: 320,
    label: korean ? "변경 비교 사이드바 크기 조절" : "Resize diff sidebar",
    containerRef: workspaceRef,
  });

  const cabinetsResize = useBottomSheetResize({
    stateKey: "diff-files-height",
    defaultFraction: 0.45,
    minFraction: 0.2,
    maxFraction: 0.8,
    label: korean ? "필터와 파일 목록 높이 조절" : "Resize lenses and files",
    containerRef: cabinetsRef,
  });

  const lenses = useReviewLenses();
  const lens = scope ? undefined : lenses?.active;
  const [lensList, setLensList] = useState<HTMLDivElement | null>(null);
  const rows = useLensRows(lenses?.lenses ?? []);
  const lensCursor = useContext(LensCursorContext);

  const lensesLive = scopeLive(useContext(AuthoringActivityContext), "lenses");
  const [fullTree, setFullTree] = useState<HTMLDivElement | null>(null);
  const [lensTree, setLensTree] = useState<HTMLDivElement | null>(null);

  const fullProgress = useMemo(
    () =>
      lenses?.progress
        ? {
            files: lenses.progress.files.map((file) => ({
              path: file.path,
              ...coverageProgress([file]),
              viewedRanges: coverageSources(file),
              changedRanges: coverageSources(file, file.changed),
              unfoldRanges: lenses.unfoldRanges.filter(
                (source) =>
                  source.file ===
                  (source.side === "base"
                    ? (file.previousPath ?? file.path)
                    : file.path),
              ),
            })),
            changedPaths: lenses.changedPaths,
          }
        : undefined,
    [lenses?.progress, lenses?.changedPaths, lenses?.unfoldRanges],
  );

  const lensProgress = useMemo(
    () =>
      lenses?.progress && lens
        ? {
            files: lenses.progress.files.map((file) => ({
              path: file.path,
              ...coverageProgress([file], lens.ranges),
              viewedRanges: coverageSources(file),
              changedRanges: coverageSources(file, file.changed),
              unfoldRanges: lenses.unfoldRanges.filter(
                (source) =>
                  source.file ===
                  (source.side === "base"
                    ? (file.previousPath ?? file.path)
                    : file.path),
              ),
            })),
            changedPaths: lenses.changedPaths,
          }
        : undefined,
    [lenses?.progress, lenses?.changedPaths, lenses?.unfoldRanges, lens],
  );

  const markFile = (path: string, scoped: boolean) => {
    const file = lenses?.progress?.files.find((file) => file.path === path);

    if (!file || !lenses) return;

    const sources = scoped
      ? lens?.ranges.filter(
          (source) =>
            source.file ===
            (source.side === "base"
              ? (file.previousPath ?? file.path)
              : file.path),
        )
      : coverageSources(file, file.changed);

    void lenses.mark(sources, lenses.stats(sources).state !== "viewed");
  };

  if (scope || !lenses)
    return <NativeDiffView scope={scope} revealFile={revealFile} />;
  const global = lenses.stats();
  const total = global.total.additions + global.total.deletions;
  const remaining = global.remaining.additions + global.remaining.deletions;
  const percent = total ? Math.round((100 * (total - remaining)) / total) : 0;

  return (
    <div
      className={`diff-workspace${sidebarOpen ? " diff-workspace--sidebar-open" : ""}`}
      ref={workspaceRef}
    >
      <aside
        id="review-diff-sidebar"
        className="diff-workspace-sidebar"
        style={{ width: sidebarResize.width }}
      >
        <button
          ref={sidebarCloseRef}
          type="button"
          className="diff-sidebar-close"
          onClick={closeSidebar}
        >
          파일 목록 닫기
        </button>
        <div className="diff-global-progress">
          <span>
            {lenses.error &&
            !(lenses.progress && lenses.progress.complete !== false) ? (
              korean ? (
                "변경 수를 가져올 수 없음"
              ) : (
                "Counts unavailable"
              )
            ) : (
              <>
                {korean ? "남은 변경" : "Remaining"}{" "}
                {lenses.progress && lenses.progress.complete !== false ? (
                  <DiffCounts progress={global} />
                ) : (
                  <span
                    className="diff-counts"
                    aria-label={korean ? "변경 수 계산 중" : "Counting changes"}
                  >
                    …
                  </span>
                )}
              </>
            )}
          </span>
          {lenses.progress && lenses.progress.complete !== false && (
            <span
              className="diff-progress-ring"
              role="progressbar"
              aria-label={korean ? "확인한 변경 줄" : "Changed lines viewed"}
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              title={
                korean
                  ? `전체 변경 ${total}줄 중 ${total - remaining}줄 확인 또는 접힘`
                  : `${total - remaining} of ${total} changed lines viewed or folded`
              }
            >
              <svg width="18" height="18" viewBox="0 0 20 20">
                <circle cx="10" cy="10" r="7" />
                <circle
                  cx="10"
                  cy="10"
                  r="7"
                  pathLength="100"
                  strokeDasharray={`${percent} 100`}
                />
              </svg>
              {percent}%
            </span>
          )}
        </div>
        <div className="diff-sidebar-cabinets" ref={cabinetsRef}>
          <div
            className="diff-sidebar-lenses"
            aria-label={korean ? "변경 필터" : "Lenses"}
            ref={setLensList}
            style={{ flexBasis: `${(1 - cabinetsResize.fraction) * 100}%` }}
          >
            <div className="diff-sidebar-heading">
              {korean ? "변경 필터" : "Lenses"}
            </div>
            <div className="diff-lens-hint">
              {korean
                ? "필터를 선택해 변경 내용을 좁혀 보세요"
                : "Click any lens to filter the diff"}
            </div>
            {rows.items.map((item) => {
              const selected = lens?.id === item.id,
                stats = lenses.stats(item.sources),
                phase = rows.phases.get(item.id),
                itemTitle =
                  korean && item.title === "Uncategorized changes"
                    ? "분류되지 않은 변경"
                    : item.title,
                // Nothing to filter to, so the row greys out; a lens already
                // selected can still be cleared.
                empty = !item.pending && item.fileCount === 0;

              return (
                <section
                  key={item.id}
                  className={`diff-lens-section ${selected ? "is-expanded" : ""}`}
                  data-lens-id={item.id}
                  data-motion={phase}
                >
                  <div className="diff-lens-row">
                    <button
                      className={`diff-lens-toggle ${selected ? "is-active" : ""} ${stats.state === "viewed" ? "is-viewed" : ""} ${empty ? "is-empty" : ""}`}
                      aria-pressed={selected}
                      disabled={!!item.unavailable || (empty && !selected)}
                      onClick={() =>
                        selected ? lenses.clear() : lenses.select(item.id)
                      }
                    >
                      {/* The title sits on the chip, not the toggle, so it
                          never stacks on the counts' own tooltip. */}
                      <span
                        className="diff-lens-chip"
                        title={
                          item.unavailable ??
                          (selected
                            ? korean
                              ? "필터 해제"
                              : "Clear lens filter"
                            : itemTitle)
                        }
                      >
                        <FilterIcon />
                        <span className="diff-lens-name">{itemTitle}</span>
                        {selected && (
                          <span className="diff-lens-clear" aria-hidden="true">
                            <svg width="10" height="10" viewBox="0 0 10 10">
                              <path d="M2 2l6 6M8 2L2 8" />
                            </svg>
                          </span>
                        )}
                      </span>
                      {item.pending ? (
                        <span
                          className="diff-counts"
                          aria-label={
                            korean ? "변경 수 계산 중" : "Counting changes"
                          }
                        >
                          …
                        </span>
                      ) : empty ? (
                        <span className="diff-counts">
                          {korean ? "파일 0개" : "0 files"}
                        </span>
                      ) : (
                        <DiffCounts progress={stats} />
                      )}
                    </button>
                    <ViewedButton
                      progress={stats}
                      disabled={
                        lenses.busy || !!item.unavailable || !!item.pending
                      }
                      label={itemTitle}
                      onClick={() =>
                        void lenses.mark(
                          item.sources,
                          stats.state !== "viewed",
                          selected,
                        )
                      }
                    />
                  </div>
                </section>
              );
            })}
            <Courier
              scope="lenses"
              container={lensList}
              find={lensRowElement}
            />
          </div>
          <div
            {...cabinetsResize.separatorProps}
            className={`side-panel-sheet-resizer diff-cabinets-resizer ${cabinetsResize.isResizing ? "is-resizing" : ""}`}
          />
          <div className="diff-sidebar-files">
            <div className="diff-sidebar-heading diff-files-heading">
              {korean ? "파일" : "Files"} <span aria-hidden="true">·</span>{" "}
              {lenses.progress
                ? lens
                  ? new Set(
                      lens.ranges.map(
                        (source) =>
                          lenses.progress!.files.find(
                            (file) =>
                              source.file ===
                              (source.side === "base"
                                ? (file.previousPath ?? file.path)
                                : file.path),
                          )?.path ?? source.file,
                      ),
                    ).size +
                    (korean
                      ? ` / ${lenses.progress.files.length}`
                      : ` of ${lenses.progress.files.length}`)
                  : lenses.progress.files.length
                : "…"}
            </div>
            <div
              className="diff-native-tree"
              ref={setFullTree}
              style={lens ? { display: "none" } : undefined}
              onClick={closeSidebar}
            />
            <div
              className="diff-native-tree"
              ref={setLensTree}
              style={!lens ? { display: "none" } : undefined}
              onClick={closeSidebar}
            />
          </div>
        </div>
      </aside>
      <div
        {...sidebarResize.separatorProps}
        className={`side-panel-resizer diff-sidebar-resizer ${sidebarResize.isResizing ? "is-resizing" : ""}`}
      />
      {sidebarOpen && (
        <button
          type="button"
          className="diff-workspace-backdrop"
          aria-label="파일 목록 닫기"
          onClick={closeSidebar}
        />
      )}
      <div className="diff-workspace-editor">
        <button
          ref={sidebarToggleRef}
          type="button"
          className="diff-workspace-compact-toggle"
          aria-controls="review-diff-sidebar"
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen(true)}
        >
          파일·필터 보기
        </button>
        {fullTree && (
          <NativeDiffView
            treeContainer={fullTree}
            progress={fullProgress}
            onToggleViewed={(path) => markFile(path, false)}
            hidden={!!lens}
          />
        )}
        {lens && lensTree && (
          <NativeDiffView
            lens={lens}
            treeContainer={lensTree}
            progress={lensProgress}
            onToggleViewed={(path) => markFile(path, true)}
          />
        )}
        {lenses.error && (
          <div className="diff-workspace-error" role="alert">
            {lenses.error}
          </div>
        )}
      </div>
    </div>
  );
}

function NativeDiffView({
  scope,
  revealFile,
  lens,
  treeContainer,
  progress,
  onToggleViewed,
  hidden = false,
}: {
  scope?: ReviewCommitScope;
  revealFile?: string;
  lens?: ReviewDiffLens;
  treeContainer?: HTMLElement;
  progress?: ReviewDiffProgress;
  onToggleViewed?(path: string): void;
  hidden?: boolean;
}) {
  const session = useReviewSession();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<ReviewDiffViewHandle | null>(null);

  const current = useRef({ progress, onToggleViewed });

  current.current = { progress, onToggleViewed };
  useLayoutEffect(() => {
    if (!container) return;
    setError(null);

    try {
      const view = session.bridge.diffView.create({
        container,
        scope,
        lens,
        fileTreeContainer: treeContainer,
        progress: current.current.progress,
        onToggleViewed: current.current.onToggleViewed
          ? (path) => current.current.onToggleViewed?.(path)
          : undefined,
      });

      handle.current = view;
      const subscription = view.onDidError(setError);

      return () => {
        subscription.dispose();
        view.dispose();
        handle.current = null;
      };
    } catch (error) {
      setError(String(error));
    }
  }, [
    container,
    session.bridge.diffView,
    session.config.reviewId,
    scope?.commit,
    lens,
    treeContainer,
  ]);
  useLayoutEffect(() => {
    if (progress) handle.current?.setProgress?.(progress);
  }, [progress]);
  useLayoutEffect(() => {
    if (revealFile) handle.current?.revealFile?.(revealFile);
  }, [revealFile, container, scope?.commit]);

  return (
    <>
      <div
        ref={setContainer}
        className="review-diff-view-host"
        style={hidden ? { display: "none" } : undefined}
      />
      {!hidden && error && (
        <div role="alert" className="review-diff-view-error">
          {error}
        </div>
      )}
    </>
  );
}

/** The lens rows on screen: the current lenses plus a removed one while the
 * lens draw queue erases it, and each row's phase. */
function useLensRows<Item extends { id: string }>(items: Item[]) {
  const phases = useMotionPhases("lenses");
  const previous = useRef(items);
  const shown = withErasedBlocks(items, previous.current, phases);

  useEffect(() => {
    previous.current = shown;
  });

  return { items: shown, phases };
}

function FilterIcon() {
  return (
    <svg
      className="diff-lens-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 3h11L9.25 8v4.5l-2.5 1.25V8z" />
    </svg>
  );
}
