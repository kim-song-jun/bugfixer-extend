import type {
  ReviewCanvasBridge,
  ReviewCanvasDiagnostic,
  ReviewRuntimeConfig,
} from "@dev.fast/review-protocol";
import { type ReactNode, createContext, useContext } from "react";

import type { NormalizedSoftwareModel } from "../software-map/model";
import type { PinnedSoftwareMapData } from "../software-map/SoftwareMap";
import { createReviewAppSessionId } from "../tab-dwell-telemetry";
import {
  type ReviewRequestOptions,
  jsonReviewApiUrl,
  reviewStorageKey,
  reviewWasmUrl,
} from "./review-client";
import { type ReviewSurface, createReviewSurface } from "./review-host";
import type { ReviewSessionData } from "./review-session-data";

export interface ReviewSession {
  review?: ReviewSessionData;
  appSessionId: string;
  bridge: ReviewCanvasBridge;
  config: ReviewRuntimeConfig;
  surface: ReviewSurface;
  softwareMapData?(
    model: NormalizedSoftwareModel,
  ): PinnedSoftwareMapData | undefined;
  apiUrl(endpoint: `/${string}`, options?: ReviewRequestOptions): string;
  fetch: (
    endpoint: `/${string}`,
    init?: RequestInit,
    options?: ReviewRequestOptions,
  ) => Promise<Response>;
  fetchUrl(url: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  wasmUrl(): string;
  storageKey(
    namespace: string,
    ...parts: Array<string | number | undefined>
  ): string;
  theme(): ReviewRuntimeConfig["theme"];
  signalReady(): void;
  reportDiagnostic(diagnostic: ReviewCanvasDiagnostic): void;
}

export function createReviewSession(
  bridge: ReviewCanvasBridge,
  options: { jsonReview: { id: string; version(): number | undefined } },
): ReviewSession {
  const config = bridge.config;
  const appSessionId = bridge.appSessionId ?? createReviewAppSessionId();

  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestInput = input instanceof Request ? input : undefined;
    const target = new URL(
      requestInput ? requestInput.url : String(input),
      "http://review.invalid",
    );
    if (
      target.origin !== "http://review.invalid" ||
      !target.pathname.startsWith("/reviews-api/") ||
      target.hash ||
      target.searchParams.has("token")
    ) {
      throw new Error(
        "Review requests must use an allowlisted relative API path.",
      );
    }
    return bridge.request(
      `${target.pathname}${target.search}`,
      init ?? requestInput,
    );
  };

  const apiUrl = (
    endpoint: `/${string}`,
    requestOptions?: ReviewRequestOptions,
  ) =>
    jsonReviewApiUrl(config, options.jsonReview.id, endpoint, {
      version: requestOptions?.version ?? options.jsonReview.version(),
    });

  return {
    appSessionId,
    bridge,
    config,
    surface: createReviewSurface(bridge),
    apiUrl,
    fetch: (endpoint, init, options) =>
      request(apiUrl(endpoint, options), init),
    fetchUrl: request,
    wasmUrl: () => reviewWasmUrl(config),
    storageKey: (namespace, ...parts) =>
      reviewStorageKey(config, namespace, ...parts),
    theme: () => bridge.currentTheme(),
    signalReady: () => bridge.ready(),
    reportDiagnostic: (diagnostic) => bridge.reportDiagnostic?.(diagnostic),
  };
}

const ReviewSessionContext = createContext<ReviewSession | null>(null);

export function ReviewSessionProvider({
  session,
  children,
}: {
  session: ReviewSession;
  children: ReactNode;
}) {
  return (
    <ReviewSessionContext.Provider value={session}>
      {children}
    </ReviewSessionContext.Provider>
  );
}

export function useOptionalReviewSession(): ReviewSession | null {
  return useContext(ReviewSessionContext);
}

export function useReviewSession(): ReviewSession {
  const session = useOptionalReviewSession();

  if (!session) {
    throw new Error(
      "useReviewSession must be used within ReviewSessionProvider",
    );
  }

  return session;
}
