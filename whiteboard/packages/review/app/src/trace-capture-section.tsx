import type {
  ReviewCanvasInstallContent,
  ReviewCliInstallStatus,
} from "@dev.fast/review-protocol";
import { useEffect, useState } from "react";

type InstallApplyRequest = Parameters<ReviewCanvasInstallContent["apply"]>[0];

type TraceCredentials = Exclude<InstallApplyRequest["trace"], true | undefined>;

/** One line naming the selected trace store and where its setup lives. */
function traceStorageSummary(trace: ReviewCliInstallStatus["trace"]): string {
  if (trace.storageMode === "hosted") {
    return "저장소: 호스팅 트레이스 저장소를 선택했습니다. 터미널에서 `review login`, `review trace allow`, `review trace storage use` 명령으로 관리할 수 있습니다.";
  }

  if (trace.storageMode === "none" || !trace.configured) {
    return "저장소: 선택된 저장소가 없습니다. 아래에 S3/R2 인증 정보를 입력하거나 `review trace storage use hosted` 명령으로 호스팅 저장소를 선택하세요.";
  }

  const source =
    trace.credentialsSource === "profile"
      ? "config.json"
      : trace.credentialsSource === "process-env"
        ? "환경 변수"
        : "기존 환경 변수 파일";

  return `저장소: S3/R2 버킷 "${trace.bucket ?? ""}" (인증 정보 출처: ${source}).`;
}

/** What capture records and where, for the selected store. */
function traceDestinationCopy(trace: ReviewCliInstallStatus["trace"]): string {
  if (trace.storageMode === "hosted") {
    return "허용된 저장소의 에이전트 세션을 호스팅 /dev/fast 트레이스 저장소에 기록해 Whiteboard 세션에서 인용할 수 있게 합니다. 에이전트 세션이 시작될 때 세션 훅이 각 Git 또는 Jujutsu 저장소에서 트레이스 수집을 시작합니다.";
  }

  return "에이전트 세션을 개인 S3/R2 버킷에 기록해 Whiteboard 세션에서 인용할 수 있게 합니다. 에이전트 세션이 시작될 때 세션 훅이 각 Git 또는 Jujutsu 저장소에서 트레이스 수집을 시작합니다.";
}

/**
 * Experimental trace capture controls. Lives under Settings ▸ Experimental
 * Features. The tutorial demonstrates a bundled trace without requiring
 * capture to be enabled.
 *
 * The on/off state is the machine-level trace setting the review server owns,
 * read back through the install status.
 */
export function TraceCaptureSection({
  install,
  onStatusChange,
}: {
  install: ReviewCanvasInstallContent;
  onStatusChange?: (status: ReviewCliInstallStatus) => void;
}) {
  const [status, setStatus] = useState<ReviewCliInstallStatus>(install.status);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [traceEndpoint, setTraceEndpoint] = useState(
    install.status.trace.endpoint ?? "",
  );

  const [traceBucket, setTraceBucket] = useState(
    install.status.trace.bucket ?? "",
  );

  const [traceRegion, setTraceRegion] = useState(
    install.status.trace.region ?? "",
  );

  const [traceKey, setTraceKey] = useState("");
  const [traceSecret, setTraceSecret] = useState("");

  useEffect(() => setStatus(install.status), [install.status]);
  const hosted = status.trace.storageMode === "hosted";

  const run = async (
    key: string,
    action: () => Promise<ReviewCliInstallStatus>,
    onSuccess?: () => void,
  ) => {
    setBusy(key);
    setError(null);

    try {
      const next = await action();
      setStatus(next);
      onStatusChange?.(next);
      onSuccess?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="review-agent-setup-terminal review-agent-setup-trace">
      <div className="review-agent-setup-terminal-info">
        <span className="review-agent-setup-name">트레이스 수집</span>
        <span
          className="review-agent-setup-state"
          data-installed={status.trace.enabled}
          title={status.trace.envPath}
        >
          {status.trace.enabled
            ? status.trace.error
              ? "켜짐, 저장소 확인 실패"
              : status.trace.storageMode === "hosted"
                ? "켜짐 (호스팅)"
                : "켜짐"
            : status.trace.configured
              ? "켜기 준비됨"
              : "꺼짐"}
        </span>
        <span className="review-agent-setup-cli">
          {traceDestinationCopy(status.trace)}
        </span>
        <span className="review-agent-setup-cli" data-testid="trace-storage">
          {traceStorageSummary(status.trace)}
        </span>
      </div>
      {hosted ? null : (
        <div className="review-agent-setup-trace-fields">
          <input
            aria-label="S3/R2 엔드포인트 URL"
            placeholder="S3/R2 엔드포인트 URL"
            value={traceEndpoint}
            onChange={(event) => setTraceEndpoint(event.currentTarget.value)}
          />
          <input
            aria-label="S3/R2 버킷"
            placeholder="S3/R2 버킷"
            value={traceBucket}
            onChange={(event) => setTraceBucket(event.currentTarget.value)}
          />
          <input
            aria-label="S3/R2 리전"
            placeholder="리전 (R2는 자동)"
            value={traceRegion}
            onChange={(event) => setTraceRegion(event.currentTarget.value)}
          />
          <input
            aria-label="S3/R2 액세스 키 ID"
            placeholder={
              status.trace.accessKeyIdPrefix
                ? `액세스 키 (${status.trace.accessKeyIdPrefix}…)`
                : "S3/R2 액세스 키 ID"
            }
            value={traceKey}
            onChange={(event) => setTraceKey(event.currentTarget.value)}
          />
          <input
            aria-label="S3/R2 비밀 액세스 키"
            type="password"
            placeholder={
              status.trace.configured
                ? "비밀 키 (변경하지 않음)"
                : "S3/R2 비밀 액세스 키"
            }
            value={traceSecret}
            onChange={(event) => setTraceSecret(event.currentTarget.value)}
          />
        </div>
      )}
      {status.trace.enabled ? (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            void run("trace-remove", () => install.remove({ trace: true }))
          }
        >
          {busy === "trace-remove" ? "끄는 중…" : "끄기"}
        </button>
      ) : null}
      {hosted ? null : (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            void run(
              "trace",
              () => {
                const trace: TraceCredentials = {};

                if (traceEndpoint) trace.endpoint = traceEndpoint;

                if (traceBucket) trace.bucket = traceBucket;

                if (traceRegion) trace.region = traceRegion;

                if (traceKey) trace.key = traceKey;

                if (traceSecret) trace.secret = traceSecret;

                return install.apply({ trace });
              },
              () => {
                setTraceKey("");
                setTraceSecret("");
              },
            )
          }
        >
          {busy === "trace"
            ? "확인 중…"
            : status.trace.enabled
              ? "복구"
              : "켜기"}
        </button>
      )}
      {error ? <p className="review-agent-setup-error">{error}</p> : null}
    </div>
  );
}
