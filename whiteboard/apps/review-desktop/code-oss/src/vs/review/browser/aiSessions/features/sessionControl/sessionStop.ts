import type { AgentSessionTurnDTO } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';

type StopCandidate = Pick<AgentSessionTurnDTO, 'id' | 'projectId' | 'sessionId' | 'state'>;

export function assertPinnedSessionStopResponse(target: { readonly projectId: string; readonly sessionId: string; readonly turnId: string }, response: StopCandidate): void {
	if (response.projectId !== target.projectId || response.sessionId !== target.sessionId || response.id !== target.turnId) {
		throw new Error('중단 요청의 응답이 요청한 프로젝트·세션·실행과 일치하지 않습니다.');
	}
}

/** The click target is fixed before refresh; discovering a new turn never authorizes stopping it. */
export async function requestPinnedSessionStop(
	target: { readonly projectId: string; readonly sessionId: string; readonly turnId: string | undefined },
	actions: {
		readonly refresh: () => Promise<StopCandidate | undefined>;
		readonly isCurrent: () => boolean;
		/** True means the exact request was sent, not that provider cleanup completed. */
		readonly stop: (turnId: string) => Promise<boolean>;
	},
): Promise<'requested' | 'reviewRequired' | 'contextChanged' | 'notRunning' | 'notRequested'> {
	const current = await actions.refresh();
	if (!actions.isCurrent()) { return 'contextChanged'; }
	if (!target.turnId || !current || current.id !== target.turnId || current.projectId !== target.projectId || current.sessionId !== target.sessionId) { return 'reviewRequired'; }
	if (!['starting', 'running'].includes(current.state)) { return 'notRunning'; }
	return await actions.stop(target.turnId) ? 'requested' : 'notRequested';
}
