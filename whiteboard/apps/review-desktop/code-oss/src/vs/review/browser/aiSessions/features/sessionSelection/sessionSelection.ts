export function selectionStorageKey(projectId: string): string {
	return `devfast.aiSessions.selected.${projectId}`;
}

export function restoreSessionSelection(projectId: string, availableSessionIds: ReadonlySet<string>): string | undefined {
	const selected = localStorage.getItem(selectionStorageKey(projectId));
	return selected && availableSessionIds.has(selected) ? selected : undefined;
}

export function persistSessionSelection(projectId: string, sessionId: string | undefined): void {
	if (sessionId) localStorage.setItem(selectionStorageKey(projectId), sessionId);
	else localStorage.removeItem(selectionStorageKey(projectId));
}
