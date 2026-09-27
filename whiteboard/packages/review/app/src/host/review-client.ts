import type { ReviewRuntimeConfig } from "@dev.fast/review-protocol";

export type ReviewClientConfig = Partial<
  Pick<ReviewRuntimeConfig, "reviewId" | "wasmUrl">
>;

export interface ReviewRequestOptions {
  version?: number;
}

export function jsonReviewApiUrl(
  _config: ReviewClientConfig,
  reviewId: string,
  endpoint: `/${string}`,
  options: ReviewRequestOptions = {},
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(reviewId))
    throw new Error("Review ID is not a valid API path segment.");

  const url = new URL(
    `/reviews-api/${encodeURIComponent(reviewId)}${endpoint}`,
    "http://review.invalid",
  );

  if (options.version !== undefined)
    url.searchParams.set("version", String(options.version));

  if (url.searchParams.has("token"))
    throw new Error("Review API URLs cannot contain credentials.");

  if (!url.pathname.startsWith(`/reviews-api/${encodeURIComponent(reviewId)}/`))
    throw new Error("Review API endpoint escaped its review path.");

  return `${url.pathname}${url.search}`;
}

export async function reviewFetchUrl(
  _config: ReviewClientConfig,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(new URL(url, browserOrigin()), init);
}

export function reviewWasmUrl(config: ReviewClientConfig): string {
  if (!config.wasmUrl) throw new Error("Review WASM asset URL is missing.");

  return config.wasmUrl;
}

export function reviewStorageKey(
  config: ReviewClientConfig | null,
  namespace: string,
  ...parts: Array<string | number | undefined>
): string {
  return [
    "progressive-review",
    namespace,
    config?.reviewId ?? "server-render",
    ...parts.map((part) => String(part ?? "")),
  ].join(":");
}

// Unlike reviewStorageKey, this omits the review identity: UI preferences
// like panel widths belong to the reader, not to one review, so they
// apply across reviews.
export function reviewPreferenceKey(
  namespace: string,
  ...parts: Array<string | number | undefined>
): string {
  return [
    "progressive-review",
    namespace,
    ...parts.map((part) => String(part ?? "")),
  ].join(":");
}

function browserOrigin(): string {
  return typeof window === "undefined"
    ? "http://127.0.0.1"
    : window.location.origin;
}
