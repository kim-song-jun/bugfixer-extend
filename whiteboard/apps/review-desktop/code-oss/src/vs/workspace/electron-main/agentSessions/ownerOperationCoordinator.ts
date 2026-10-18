/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Serializes async inspect/mutate workflows for one durable owner while allowing other owners through. */
export class OwnerOperationCoordinator {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(ownerId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(ownerId);
		let release!: () => void;
		const tail = new Promise<void>(resolve => { release = resolve; });
		this.tails.set(ownerId, tail);
		if (previous) { await previous; }
		try { return await operation(); }
		finally {
			release();
			if (this.tails.get(ownerId) === tail) { this.tails.delete(ownerId); }
		}
	}
}
