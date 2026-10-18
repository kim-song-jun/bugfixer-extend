/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSessionState } from '../../common/workspaceAgentSessionProtocol.js';

const transitions: Readonly<Record<AgentSessionState, ReadonlySet<AgentSessionState>>> = {
	created: new Set(['starting', 'stopped', 'failed']),
	starting: new Set(['running', 'waitingForInput', 'waitingForApproval', 'idle', 'stopping', 'stopped', 'interrupted', 'failed']),
	running: new Set(['waitingForInput', 'waitingForApproval', 'idle', 'stopping', 'stopped', 'interrupted', 'failed']),
	waitingForInput: new Set(['running', 'idle', 'stopping', 'stopped', 'interrupted', 'failed']),
	waitingForApproval: new Set(['running', 'idle', 'stopping', 'stopped', 'interrupted', 'failed']),
	idle: new Set(['starting', 'running', 'stopping', 'stopped', 'interrupted', 'failed']),
	stopping: new Set(['stopped', 'interrupted', 'failed']),
	stopped: new Set(),
	interrupted: new Set(['starting', 'stopping', 'stopped', 'failed']),
	failed: new Set(['starting', 'stopped']),
};

export function isAgentSessionState(value: string): value is AgentSessionState {
	return Object.hasOwn(transitions, value);
}

export function canTransitionAgentSessionState(from: AgentSessionState, to: AgentSessionState): boolean {
	return transitions[from].has(to);
}
