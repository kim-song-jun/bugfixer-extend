import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

export const SESSION_ONBOARDING_VERSION = 1 as const;
export const SESSION_ONBOARDING_STEP_COUNT = 5 as const;
const STORAGE_KEY_PREFIX = 'devfast.aiSessions.onboarding.v1.';

export type SessionOnboardingStep = 0 | 1 | 2 | 3 | 4;
export type SessionOnboardingStatus = 'active' | 'skipped' | 'completed';

export interface SessionOnboardingState {
	readonly version: typeof SESSION_ONBOARDING_VERSION;
	readonly step: SessionOnboardingStep;
	readonly status: SessionOnboardingStatus;
}

/** The subset of IStorageService used by project-scoped onboarding state. */
export interface SessionOnboardingStorage {
	get(key: string, scope: StorageScope): string | undefined;
	store(key: string, value: string, scope: StorageScope, target: StorageTarget): void;
	remove(key: string, scope: StorageScope): void;
}

export function sessionOnboardingStorageKey(projectId: string): string {
	if (!projectId.trim() || /[\u0000-\u001f\u007f]/.test(projectId)) {
		throw new Error('A valid project ID is required for onboarding state.');
	}
	return `${STORAGE_KEY_PREFIX}${encodeURIComponent(projectId)}`;
}

export function loadSessionOnboardingState(projectId: string, storage: SessionOnboardingStorage): SessionOnboardingState {
	const serialized = storage.get(sessionOnboardingStorageKey(projectId), StorageScope.PROFILE);
	if (serialized === undefined) {
		return initialSessionOnboardingState();
	}
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new Error('Saved onboarding progress is unreadable. Reopen onboarding after repairing profile storage.');
	}
	if (!isSessionOnboardingState(value)) {
		throw new Error('Saved onboarding progress has an unsupported version or invalid state.');
	}
	return value;
}

export function saveSessionOnboardingState(projectId: string, state: SessionOnboardingState, storage: SessionOnboardingStorage): void {
	if (!isSessionOnboardingState(state)) {
		throw new Error('The onboarding progress state is invalid.');
	}
	storage.store(sessionOnboardingStorageKey(projectId), JSON.stringify(state), StorageScope.PROFILE, StorageTarget.MACHINE);
}

export function clearSessionOnboardingState(projectId: string, storage: SessionOnboardingStorage): void {
	storage.remove(sessionOnboardingStorageKey(projectId), StorageScope.PROFILE);
}

export function advanceSessionOnboarding(state: SessionOnboardingState): SessionOnboardingState {
	if (state.status !== 'active') {
		return state;
	}
	if (state.step === 4) {
		return state;
	}
	return { version: SESSION_ONBOARDING_VERSION, step: (state.step + 1) as SessionOnboardingStep, status: 'active' };
}

export function completeSessionOnboarding(state: SessionOnboardingState): SessionOnboardingState {
	if (state.status !== 'active' || state.step !== 4) {
		throw new Error('Onboarding can be completed only from the final guidance step.');
	}
	return { version: SESSION_ONBOARDING_VERSION, step: 4, status: 'completed' };
}

export function skipSessionOnboarding(state: SessionOnboardingState): SessionOnboardingState {
	return state.status === 'completed' ? state : { ...state, status: 'skipped' };
}

export function resumeSessionOnboarding(state: SessionOnboardingState): SessionOnboardingState {
	return state.status === 'completed' ? state : { ...state, status: 'active' };
}

export function reopenSessionOnboarding(state: SessionOnboardingState): SessionOnboardingState {
	return { ...state, status: 'active' };
}

export function initialSessionOnboardingState(): SessionOnboardingState {
	return { version: SESSION_ONBOARDING_VERSION, step: 0, status: 'active' };
}

function isSessionOnboardingState(value: unknown): value is SessionOnboardingState {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return Object.keys(record).length === 3
		&& Object.prototype.hasOwnProperty.call(record, 'version') && Object.prototype.hasOwnProperty.call(record, 'step') && Object.prototype.hasOwnProperty.call(record, 'status')
		&& record.version === SESSION_ONBOARDING_VERSION
		&& Number.isInteger(record.step) && (record.step as number) >= 0 && (record.step as number) < SESSION_ONBOARDING_STEP_COUNT
		&& (record.status === 'active' || record.status === 'skipped' || record.status === 'completed')
		&& (record.status !== 'completed' || record.step === 4);
}
