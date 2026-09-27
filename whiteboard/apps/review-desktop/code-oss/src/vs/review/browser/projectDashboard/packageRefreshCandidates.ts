/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WorkspaceReferenceDTO } from '../../../workspace/common/workspaceKnowledgeProtocol.js';
import type { WorkspacePackageSourceDTO } from '../../../workspace/common/workspacePackageConnectorProtocol.js';

export interface PackageRefreshCandidate {
	readonly reference: WorkspaceReferenceDTO;
	readonly sourceId: string;
	readonly sourceKey: string;
	readonly sourceLabel: string;
}

export function getPackageRefreshCandidates(
	references: readonly WorkspaceReferenceDTO[],
	packageId: string,
	sources: readonly WorkspacePackageSourceDTO[],
	accountRef: string,
): PackageRefreshCandidate[] {
	const accountPrefix = `${packageId}:${accountRef}:`;
	const latestBySource = new Map<string, PackageRefreshCandidate>();
	for (const reference of references) {
		if (reference.connectorId !== `local:${packageId}` || reference.accountRef !== accountRef || !reference.externalId.startsWith(accountPrefix)) continue;
		const accountScopedExternalId = reference.externalId.slice(accountPrefix.length);
		const source = sources.find(item => accountScopedExternalId.startsWith(`${item.sourceId}:`));
		if (!source) continue;
		const sourceKey = accountScopedExternalId.slice(`${source.sourceId}:`.length);
		if (!sourceKey) continue;
		const candidate: PackageRefreshCandidate = { reference, sourceId: source.sourceId, sourceKey, sourceLabel: source.label };
		const current = latestBySource.get(reference.sourceId);
		if (!current || reference.version > current.reference.version
			|| (reference.version === current.reference.version && reference.retrievedAt > current.reference.retrievedAt)) {
			latestBySource.set(reference.sourceId, candidate);
		}
	}
	return [...latestBySource.values()].sort((left, right) => left.sourceLabel.localeCompare(right.sourceLabel)
		|| left.sourceKey.localeCompare(right.sourceKey));
}
