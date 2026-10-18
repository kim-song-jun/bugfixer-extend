/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSessionTurnSnapshot } from '../../common/workspaceAgentSessionProtocol.js';
import type { AgentSessionTranscriptStore } from './agentSessionTranscriptStore.js';

/** Synchronous, main-process-only journal. Its sequence is independent of the attachable PTY cursor. */
export class AgentSessionJournal {
	private sequence: number;
	private static readonly eventText: Readonly<Record<string, string>> = {
		'session.turn-starting': 'Session turn starting.',
		'session.provider-started': 'Provider process started.',
		'session.provider-exited': 'Provider process exited.',
		'session.turn-stopped': 'Session turn stopped.',
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
