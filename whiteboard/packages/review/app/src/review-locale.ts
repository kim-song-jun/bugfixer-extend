export function isKoreanReviewUi(): boolean {
  return typeof navigator !== "undefined" &&
    navigator.language.toLowerCase().startsWith("ko");
}
