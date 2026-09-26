/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export { importNotionPage, type NotionPageImportRequest } from './notion.js';
export { importSlackConversation, type SlackConversationImportRequest } from './slack.js';
export type { ConnectorCredentialResolver, ConnectorId, ConnectorTransport, ImportedReferenceInput } from './types.js';
export { validateNotionToken, validateSlackToken, type ConnectorAccountIdentity } from './validation.js';
export { defaultConnectorTransport } from './types.js';
export {
	approveDeclarativePackage,
	validateDeclarativePackage,
	type ApprovedDeclarativePackage,
	type DeclarativePackageApproval,
	type DeclarativePackageManifest,
	type DeclarativePackageReview,
	type DeclarativePackageTrustContext,
	type DeclarativePackageTrustStatus,
	type SignedDeclarativePackageEnvelope,
	type ValidatedDeclarativePackage,
} from './declarativePackage.js';
export {
	importDeclarativePackageSource,
	type DeclarativeImportedReferenceInput,
	type DeclarativePackageImportRequest,
} from './declarativePackageRuntime.js';
export {
	isPublicAddress,
	PinnedDeclarativePackageTransport,
	type DeclarativePackageTransport,
	type DeclarativePackageTransportTestHooks,
	type PinnedHttpsRequest,
	type PinnedHttpsResponse,
	type ResolvedNetworkAddress,
} from './declarativePackageTransport.js';
