/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import type { AgentSessionTranscriptStore } from './agentSessionTranscriptStore.js';
import type { AgentPtyCleanupFailureReason, AgentPtyProcessGroupInspectionErrorCode, AgentPtyProcessGroupInspectionPhase } from './agentPtyHost.js';

/** Synchronous, main-process-only journal. Its sequence is independent of the attachable PTY cursor. */
export class AgentSessionJournal {
	private sequence: number;
	private static readonly eventText: Readonly<Record<string, string>> = {
		'session.turn-starting': 'Session turn starting.',
		'session.provider-started': 'Provider process started.',
		'session.provider-exited': 'Provider process exited.',
		'session.turn-stopped': 'Session turn stopped.',
		'session.turn-stop-unverified.access-revocation': 'Session stop could not verify launch access revocation.',
		'session.turn-stop-unverified.process-group-unavailable': 'Session stop could not verify the owned process group.',
		'session.turn-stop-unverified.process-group-inspection': 'Session stop could not inspect the owned process group.',
		'session.turn-stop-unverified.process-group-live': 'The owned process group remained live after the stop request.',
		'session.turn-stop-unverified.pty-exit-unobserved': 'Session stop could not observe PTY exit and output drain.',
		'session.turn-stop-unverified.control-server-not-listening': 'Session stop could not verify the PTY control listener state.',
		'session.turn-stop-unverified.control-server-timeout': 'Session stop timed out while closing PTY control resources.',
		'session.turn-stop-unverified.control-server-close': 'Session stop could not close PTY control resources.',
		'session.turn-stop-unverified.host-stop': 'The PTY host could not verify session cleanup.',
		'session.turn-stop-unverified.private-config-unavailable': 'Session stop could not verify private launch configuration cleanup.',
		'session.turn-stop-unverified.private-config-release': 'Session stop could not release private launch configuration.',
		'session.process-group-inspection.before-stop.eacces': 'Process-group inspection before authenticated stop returned EACCES.',
		'session.process-group-inspection.before-stop.einval': 'Process-group inspection before authenticated stop returned EINVAL.',
		'session.process-group-inspection.before-stop.eperm': 'Process-group inspection before authenticated stop returned EPERM.',
		'session.process-group-inspection.before-stop.unknown': 'Process-group inspection before authenticated stop returned an unknown error.',
		'session.process-group-inspection.verifying-stop.eacces': 'Process-group inspection while verifying stop returned EACCES.',
		'session.process-group-inspection.verifying-stop.einval': 'Process-group inspection while verifying stop returned EINVAL.',
		'session.process-group-inspection.verifying-stop.eperm': 'Process-group inspection while verifying stop returned EPERM.',
		'session.process-group-inspection.verifying-stop.unknown': 'Process-group inspection while verifying stop returned an unknown error.',
		'pty.output-gap': 'Terminal output gap detected; the retained transcript is incomplete.',
		'pty.transcript-persistence-failed': 'Transcript persistence failed; further terminal output was withheld.',
	};

	constructor(
		private readonly store: AgentSessionTranscriptStore,
		private readonly snapshot: AgentSessionTurnSnapshot,
		private readonly turnId: string,
		private readonly knownSecrets: readonly string[],
	) {
		this.sequence = store.highestSequence(snapshot.projectId, snapshot.sessionId, turnId);
	}

	appendTerminal(text: string): void {
		const sequence = this.nextSequence();
		this.store.appendSanitizedTerminalChunk({
			projectId: this.snapshot.projectId, sessionId: this.snapshot.sessionId, turnId: this.turnId,
			sequence, sanitizedTextFromTrustedPtyHost: text,
		});
		this.sequence = sequence;
	}

	appendGap(): void {
		this.appendEvent('warning', 'pty', 'pty.output-gap');
	}

	appendCleanupFailure(reason: AgentPtyCleanupFailureReason): void {
		const event = cleanupFailureEvent[reason];
		if (!event) { throw new Error('Cleanup failure reason must be a trusted static event identifier.'); }
		this.appendEvent('error', 'host', event);
	}

	appendProcessGroupInspection(phase: AgentPtyProcessGroupInspectionPhase, code: AgentPtyProcessGroupInspectionErrorCode): void {
		const event = processGroupInspectionEvent[phase][code];
		this.appendEvent('warning', 'host', event);
	}

	appendEvent(severity: 'debug' | 'info' | 'warning' | 'error', source: 'pty' | 'provider' | 'host' | 'workspace', event: string): void {
		const text = AgentSessionJournal.eventText[event];
		if (!text) { throw new Error('Transcript event must be a trusted static event identifier.'); }
		const sequence = this.nextSequence();
		this.store.appendStructuredLog({
			projectId: this.snapshot.projectId, sessionId: this.snapshot.sessionId, turnId: this.turnId,
			sequence, text, severity, source, trustedKnownSecrets: this.knownSecrets,
		});
		this.sequence = sequence;
	}

	private nextSequence(): number {
		const sequence = this.sequence + 1;
		if (!Number.isSafeInteger(sequence)) { throw new Error('Transcript sequence exceeded the safe integer range.'); }
		return sequence;
	}
}

const cleanupFailureEvent: Readonly<Record<AgentPtyCleanupFailureReason, string>> = {
	accessRevocationFailed: 'session.turn-stop-unverified.access-revocation',
	processGroupUnavailable: 'session.turn-stop-unverified.process-group-unavailable',
	processGroupInspectionUnknown: 'session.turn-stop-unverified.process-group-inspection',
	processGroupStillLive: 'session.turn-stop-unverified.process-group-live',
	ptyExitUnobserved: 'session.turn-stop-unverified.pty-exit-unobserved',
	controlServerNotListening: 'session.turn-stop-unverified.control-server-not-listening',
	controlServerCloseTimedOut: 'session.turn-stop-unverified.control-server-timeout',
	controlServerCloseFailed: 'session.turn-stop-unverified.control-server-close',
	hostStopFailed: 'session.turn-stop-unverified.host-stop',
	privateConfigUnavailable: 'session.turn-stop-unverified.private-config-unavailable',
	privateConfigReleaseFailed: 'session.turn-stop-unverified.private-config-release',
};

const processGroupInspectionEvent: Readonly<Record<AgentPtyProcessGroupInspectionPhase, Readonly<Record<AgentPtyProcessGroupInspectionErrorCode, string>>>> = {
	'before-stop': {
		EACCES: 'session.process-group-inspection.before-stop.eacces',
		EINVAL: 'session.process-group-inspection.before-stop.einval',
		EPERM: 'session.process-group-inspection.before-stop.eperm',
		UNKNOWN: 'session.process-group-inspection.before-stop.unknown',
	},
	'verifying-stop': {
		EACCES: 'session.process-group-inspection.verifying-stop.eacces',
		EINVAL: 'session.process-group-inspection.verifying-stop.einval',
		EPERM: 'session.process-group-inspection.verifying-stop.eperm',
		UNKNOWN: 'session.process-group-inspection.verifying-stop.unknown',
	},
};
