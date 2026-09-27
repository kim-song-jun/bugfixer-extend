import { decodeReviewStructuralDiffEvent, reviewSourceQuery, type ReviewSourceView } from "../common/reviewProtocol.js";
import type { StructuralEvent } from "../common/reviewStructuralDiff.js";
import type { IReviewDesktopConnectionService } from "./reviewDesktopConnectionService.js";

/** The transport seam: callers consume records, never Response objects or byte chunks. */
export interface StructuralDiffStream {
	streamComparison(signal: AbortSignal): AsyncIterable<StructuralEvent>;
}

export class StructuralDiffClient implements StructuralDiffStream {
	constructor(private readonly connection: IReviewDesktopConnectionService, private readonly comparison: ReviewSourceView) { }

	async *streamComparison(signal: AbortSignal): AsyncGenerator<StructuralEvent> {
		signal.throwIfAborted();
		const query = new URLSearchParams(Object.entries(reviewSourceQuery(this.comparison)).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
		const values: StructuralEvent[] = [];
		let failure: unknown;
		let completed = false;
		let wake: (() => void) | undefined;
		const notify = () => { const current = wake; wake = undefined; current?.(); };
		const onAbort = () => { completed = true; notify(); };
		signal.addEventListener("abort", onAbort, { once: true });
		const subscription = this.connection.follow<unknown>(
			`/reviews-api/${encodeURIComponent(this.comparison.reviewId)}/structural-diff?${query}`,
			signal,
			value => {
				const event = decodeReviewStructuralDiffEvent(JSON.stringify(value));
				if (event.type === "error") throw new Error(event.message);
				values.push(event);
				notify();
			},
			error => { failure = error; completed = true; notify(); },
			{ reconnect: false, onComplete: () => { completed = true; notify(); } },
		);
		try {
			while (true) {
				const value = values.shift();
				if (value) { yield value; continue; }
				if (failure) throw failure;
				if (completed || signal.aborted) return;
				await new Promise<void>(resolve => { wake = resolve; });
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
			subscription.dispose();
		}
	}
}
