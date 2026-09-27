import type { ReviewView } from "@dev.fast/review-protocol";

import { isKoreanReviewUi } from "./review-locale";

export type { ReviewView } from "@dev.fast/review-protocol";

export function normalizeReviewView(
  view: ReviewView,
  softwareMapEnabled: boolean,
  hasChangeRange = true,
  hasTraceSessions = true,
): ReviewView {
  if (view === "map" && !softwareMapEnabled) return "review";

  if (view === "trace" && !hasTraceSessions) return "review";

  if (!hasChangeRange && (view === "commits" || view === "diff")) {
    return "review";
  }

  return view;
}

export function reviewViewLabel(view: ReviewView): string {
  if (isKoreanReviewUi()) {
    if (view === "map") return "지도";

    if (view === "diff") return "변경 비교";

    if (view === "commits") return "커밋";

    if (view === "trace") return "실행 기록";

    return "리뷰";
  }

  if (view === "map") return "Map";

  if (view === "diff") return "Diff";

  if (view === "commits") return "Commits";

  if (view === "trace") return "Trace";

  return "Whiteboard";
}

export function shouldCloseSidePeekForReviewView(view: ReviewView): boolean {
  return view !== "review";
}
