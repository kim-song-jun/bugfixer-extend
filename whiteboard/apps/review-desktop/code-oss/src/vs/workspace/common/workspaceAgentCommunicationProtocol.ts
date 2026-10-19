/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Human inspection of a mailbox does not acknowledge that the receiving AI read it. */
export interface WorkspaceAgentSessionMailboxMessage {
	readonly id: string;
	readonly senderSessionId: string;
	readonly recipientSessionId: string;
	readonly sequence: number;
	readonly body: string;
	readonly createdAt: string;
	readonly readAt: string | null;
}

export interface WorkspaceAgentSessionMailboxPage {
	readonly messages: readonly WorkspaceAgentSessionMailboxMessage[];
	readonly nextCursor: number;
	readonly hasMore: boolean;
}

export interface WorkspaceAgentSessionMailboxRequest {
	readonly projectId: string;
	readonly sessionId: string;
	readonly afterSequence?: number;
	readonly limit?: number;
}

export interface WorkspaceAgentSessionMailboxItemRequest {
	readonly projectId: string;
	readonly sessionId: string;
	readonly messageId: string;
}

export interface WorkspaceAgentSessionNotificationStatus {
	readonly unreadCount: number;
	readonly latestSequence: number;
}

/** OS support and observed delivery are reported separately from user permission, which the app cannot reliably inspect. */
export interface WorkspaceAgentSessionNativeNotificationStatus {
	readonly enabled: boolean;
	readonly availability: 'unknown' | 'supported' | 'unsupported';
	readonly lastDelivery: 'notAttempted' | 'shown' | 'failed';
}
