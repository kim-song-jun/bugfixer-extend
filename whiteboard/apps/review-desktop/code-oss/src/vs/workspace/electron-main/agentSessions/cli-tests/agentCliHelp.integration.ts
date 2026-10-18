/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { discoverAgentCliCapabilities } from '../agentCliCapabilities.js';

describe('pinned provider CLI help and version discovery', () => {
	it('Codex 0.163.0 reports the interactive flags required by the command builder', async () => {
		const capabilities = await discoverAgentCliCapabilities({
			provider: 'codex', executable: requiredExecutable('BUGFIXER_CODEX_CLI'),
		});
		assert.equal(capabilities.version, '0.163.0');
		assert.equal(capabilities.interactive, true);
		assert.equal(capabilities.model, true);
		assert.equal(capabilities.resumeById, true);
		assert.equal(capabilities.readOnlyPolicy, true);
		assert.equal(capabilities.mutatingPolicy, true);
		assert.equal(capabilities.scopedMcpConfig, true);
	});

	it('Claude Code 2.1.302 reports the interactive flags required by the command builder', async () => {
		const capabilities = await discoverAgentCliCapabilities({
			provider: 'claude', executable: requiredExecutable('BUGFIXER_CLAUDE_CLI'),
		});
		assert.equal(capabilities.version, '2.1.302');
		assert.equal(capabilities.interactive, true);
		assert.equal(capabilities.model, true);
		assert.equal(capabilities.resumeById, true);
		assert.equal(capabilities.newSessionId, true);
		assert.equal(capabilities.readOnlyPolicy, true);
		assert.equal(capabilities.mutatingPolicy, true);
		assert.equal(capabilities.scopedMcpConfig, true);
	});
});

function requiredExecutable(key: string): string {
	const value = process.env[key];
	assert.ok(value && value.startsWith('/'), `${key} must point to the pinned public CLI installed by CI`);
	return value;
}
