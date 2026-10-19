import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import {
	advanceSessionOnboarding,
	clearSessionOnboardingState,
	completeSessionOnboarding,
	initialSessionOnboardingState,
	loadSessionOnboardingState,
	reopenSessionOnboarding,
	resumeSessionOnboarding,
	saveSessionOnboardingState,
	sessionOnboardingStorageKey,
	skipSessionOnboarding,
	type SessionOnboardingStorage,
} from './onboardingState.js';

describe('session onboarding state', () => {
	it('persists independent per-project progress in profile machine storage', () => {
		const storage = new MemoryOnboardingStorage();
		const projectA = advanceSessionOnboarding(initialSessionOnboardingState());
		saveSessionOnboardingState('project-a', projectA, storage);

		assert.deepEqual(loadSessionOnboardingState('project-a', storage), projectA);
		assert.deepEqual(loadSessionOnboardingState('project-b', storage), initialSessionOnboardingState());
		assert.equal(storage.lastScope, StorageScope.PROFILE);
		assert.equal(storage.lastTarget, StorageTarget.MACHINE);
	});

	it('skip and resume retain the current step; reopen reactivates completed guidance', () => {
		const stepTwo = advanceSessionOnboarding(advanceSessionOnboarding(initialSessionOnboardingState()));
		assert.deepEqual(skipSessionOnboarding(stepTwo), { ...stepTwo, status: 'skipped' });
		assert.deepEqual(resumeSessionOnboarding(skipSessionOnboarding(stepTwo)), stepTwo);
		const stepFour = advanceSessionOnboarding({ version: 1, step: 4, status: 'active' });
		assert.deepEqual(stepFour, { version: 1, step: 4, status: 'active' });
		const complete = completeSessionOnboarding(stepFour);
		assert.equal(complete.status, 'completed');
		assert.deepEqual(reopenSessionOnboarding(complete), { version: 1, step: 4, status: 'active' });
	});

	it('rejects corrupt, unsupported, or extra persisted data instead of restarting silently', () => {
		const storage = new MemoryOnboardingStorage();
		storage.values.set(sessionOnboardingStorageKey('project-a'), '{broken');
		assert.throws(() => loadSessionOnboardingState('project-a', storage), { message: /unreadable/ });
		storage.values.set(sessionOnboardingStorageKey('project-a'), JSON.stringify({ version: 2, step: 0, status: 'active' }));
		assert.throws(() => loadSessionOnboardingState('project-a', storage), { message: /unsupported version/ });
		storage.values.set(sessionOnboardingStorageKey('project-a'), JSON.stringify({ version: 1, step: 0, status: 'active', extra: 'ignored' }));
		assert.throws(() => loadSessionOnboardingState('project-a', storage), { message: /unsupported version/ });
		clearSessionOnboardingState('project-a', storage);
		assert.deepEqual(loadSessionOnboardingState('project-a', storage), initialSessionOnboardingState());
	});
});

class MemoryOnboardingStorage implements SessionOnboardingStorage {
	readonly values = new Map<string, string>();
	lastScope: StorageScope | undefined;
	lastTarget: StorageTarget | undefined;

	get(key: string, scope: StorageScope): string | undefined {
		this.lastScope = scope;
		return this.values.get(key);
	}

	store(key: string, value: string, scope: StorageScope, target: StorageTarget): void {
		this.lastScope = scope;
		this.lastTarget = target;
		this.values.set(key, value);
	}

	remove(key: string, scope: StorageScope): void {
		this.lastScope = scope;
		this.values.delete(key);
	}
}
