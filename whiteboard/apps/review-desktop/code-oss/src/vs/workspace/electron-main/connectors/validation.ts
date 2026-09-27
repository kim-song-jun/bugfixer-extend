/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { connectorRequestTimeoutMs, defaultConnectorTransport, readJsonResponse, requireCredential, type ConnectorTransport } from './types.js';

const slackApiOrigin = 'https://slack.com/api/';
const notionApiOrigin = 'https://api.notion.com/v1/';
const notionVersion = '2026-03-11';

export interface ConnectorAccountIdentity {
	/** Stable identity assigned by the remote provider; it contains no credential material. */
	readonly remoteId: string;
	readonly label: string;
}

export async function validateSlackToken(token: string, transport: ConnectorTransport = defaultConnectorTransport): Promise<ConnectorAccountIdentity> {
	const credential = requireCredential(token, 'slack');
	const response = await transport.fetch(new URL('auth.test', slackApiOrigin), {
		method: 'POST',
		redirect: 'error',
		headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json', 'Content-Type': 'application/json' },
		body: '{}',
		signal: AbortSignal.timeout(connectorRequestTimeoutMs),
	});
	const payload = await readJsonResponse(response);
	if (payload.ok !== true || typeof payload.team_id !== 'string' || !/^[A-Z0-9]{2,80}$/.test(payload.team_id)
		|| typeof payload.user_id !== 'string' || !/^[A-Z0-9]{2,80}$/.test(payload.user_id)) {
		throw new Error('Slack could not validate this account token.');
	}
	const team = safeLabel(payload.team, credential);
	const user = safeLabel(payload.user, credential);
	return { remoteId: `slack:${payload.team_id}:${payload.user_id}`, label: team && user ? `${user} · ${team}` : team || user || `Slack ${payload.team_id}` };
}

export async function validateNotionToken(token: string, transport: ConnectorTransport = defaultConnectorTransport): Promise<ConnectorAccountIdentity> {
	const credential = requireCredential(token, 'notion');
	const response = await transport.fetch(new URL('users/me', notionApiOrigin), {
		method: 'GET',
		redirect: 'error',
		headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json', 'Notion-Version': notionVersion },
		signal: AbortSignal.timeout(connectorRequestTimeoutMs),
	});
	if (response.status === 401) {
		throw new Error('This Notion token was rejected. It may have expired or been revoked; reconnect with a valid personal access token.');
	}
	const payload = await readJsonResponse(response);
	if (payload.object !== 'user' || typeof payload.id !== 'string' || !isUuid(payload.id)
		|| (payload.type !== 'person' && payload.type !== 'bot')) {
		throw new Error('Notion could not validate this account token.');
	}
	if (payload.id.toLowerCase().includes(credential.toLowerCase())) {
		throw new Error('Notion returned an account ID containing the personal access token; this account cannot be saved safely.');
	}
	const name = safeLabel(payload.name, credential);
	return { remoteId: `notion:${payload.id.toLowerCase()}`, label: name || `Notion ${payload.id.slice(0, 8)}` };
}

function safeLabel(value: unknown, credential: string): string {
	if (typeof value !== 'string' || value.includes(credential)) { return ''; }
	return value.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 160);
}

function isUuid(value: string): boolean {
	return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}
