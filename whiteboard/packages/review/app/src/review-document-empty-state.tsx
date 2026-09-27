import type { ReactElement } from "react";

import { isKoreanReviewUi } from "./review-locale";

export function ReviewDocumentEmptyState({
  hasChangeRange,
  onOpenDiff,
}: {
  hasChangeRange: boolean;
  onOpenDiff: () => void;
}): ReactElement {
  const korean = isKoreanReviewUi();

  const copy = korean
    ? {
        label: "리뷰 시작하기",
        title: "아직 정리된 리뷰 내용이 없어요",
        description: hasChangeRange
          ? "변경 파일을 살펴본 뒤 필요한 근거와 결론을 이 화면에 정리해 보세요."
          : "이 리뷰에 연결된 변경 파일이 없습니다. 내용을 추가하면 여기에 표시됩니다.",
        action: "변경 파일 보기",
      }
    : {
        label: "Start reviewing",
        title: "There are no notes in this review yet",
        description: hasChangeRange
          ? "Explore the changed files, then collect the evidence and conclusions here."
          : "This review has no changed files yet. New content will appear here.",
        action: "View changed files",
      };

  return (
    <section className="review-document-empty-state" aria-label={copy.label}>
      <span className="review-document-empty-state__label">{copy.label}</span>
      <h2>{copy.title}</h2>
      <p>{copy.description}</p>
      {hasChangeRange && (
        <button type="button" onClick={onOpenDiff}>
          {copy.action}
          <span aria-hidden="true"> →</span>
        </button>
      )}
    </section>
  );
}
