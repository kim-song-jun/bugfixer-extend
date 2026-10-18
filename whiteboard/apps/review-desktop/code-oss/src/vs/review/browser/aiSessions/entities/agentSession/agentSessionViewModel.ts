import type { AgentSessionDTO, AgentSessionState } from '../../../../../workspace/common/workspaceAgentSessionProtocol.js';

export const agentSessionStateLabel: Readonly<Record<AgentSessionState, string>> = {
	created: '준비', starting: '시작 중', running: '실행 중', waitingForInput: '입력 대기',
	waitingForApproval: '승인 대기', idle: '유휴', stopping: '중단 중', stopped: '종료',
	interrupted: '중단됨', failed: '실패',
};

export function agentSessionSummary(session: AgentSessionDTO): string {
	return `${session.provider === 'codex' ? 'Codex' : 'Claude'} · ${session.model}`;
}
