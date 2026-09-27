/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../base/common/event.js';
import { Disposable, type IDisposable } from '../../base/common/lifecycle.js';
import { ResourceMap } from '../../base/common/map.js';
import { URI } from '../../base/common/uri.js';
import { ipcRenderer } from '../../base/parts/sandbox/electron-browser/globals.js';
import {
	createFileSystemProviderError, FileSystemProviderCapabilities, FileSystemProviderErrorCode,
	FileType, IFileService, type IFileSystemProviderWithFileReadWriteCapability, type IStat,
} from '../../platform/files/common/files.js';
import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import type { IEditorGroup } from '../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { WORKSPACE_DASHBOARD_CHANNEL, type WorkspaceDashboardInspectFileDTO } from '../../workspace/common/workspaceDashboardProtocol.js';

const INSPECT_SCHEME = 'bugfixer-inspect';

export const IProjectInspectSnapshotService = createDecorator<IProjectInspectSnapshotService>('projectInspectSnapshotService');

export interface IProjectInspectSnapshotService {
	readonly _serviceBrand: undefined;
	openSnapshot(projectId: string, taskId: string, attemptId: string, relativePath: string, group: IEditorGroup): Promise<void>;
}

/** Read-only virtual files backed by the authorized, descriptor-bound report snapshot. */
export class ProjectInspectSnapshotService extends Disposable implements IProjectInspectSnapshotService, IFileSystemProviderWithFileReadWriteCapability {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeCapabilities = Event.None;
	readonly onDidChangeFile = Event.None;
	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.Readonly | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly readOnlyMessage = { value: '변경 파일 검수는 읽기 전용입니다.' };
	private readonly inFlight = new ResourceMap<Promise<Uint8Array>>();

	constructor(
		@IFileService private readonly files: IFileService,
		@IEditorService private readonly editors: IEditorService,
	) {
		super();
		this._register(this.files.registerProvider(INSPECT_SCHEME, this));
	}

	async openSnapshot(projectId: string, taskId: string, attemptId: string, relativePath: string, group: IEditorGroup): Promise<void> {
		const resource = URI.from({
			scheme: INSPECT_SCHEME,
			authority: projectId,
			path: `/${relativePath}`,
			query: new URLSearchParams({ taskId, attemptId }).toString(),
		});
		await this.readFile(resource);
		await this.editors.openEditor({ resource, options: { pinned: true, revealIfVisible: true } }, group);
	}

	async stat(resource: URI): Promise<IStat> {
		const bytes = await this.readFile(resource);
		return { type: FileType.File, ctime: 0, mtime: 0, size: bytes.byteLength };
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const pending = this.inFlight.get(resource);
		if (pending) return pending;
		const reading = this.load(resource);
		this.inFlight.set(resource, reading);
		try { return await reading; }
		finally { if (this.inFlight.get(resource) === reading) this.inFlight.delete(resource); }
	}

	private async load(resource: URI): Promise<Uint8Array> {
		if (resource.scheme !== INSPECT_SCHEME || !resource.authority) throw createFileSystemProviderError('Invalid Inspect resource.', FileSystemProviderErrorCode.FileNotFound);
		const query = new URLSearchParams(resource.query);
		const taskId = query.get('taskId');
		const attemptId = query.get('attemptId');
		const relativePath = resource.path.slice(1);
		if (!taskId || !attemptId || !relativePath) throw createFileSystemProviderError('Invalid Inspect resource.', FileSystemProviderErrorCode.FileNotFound);
		const snapshot = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'openObservedOrdinaryFolderChange', {
			projectId: resource.authority, taskId, attemptId, relativePath,
		}) as WorkspaceDashboardInspectFileDTO;
		if (snapshot.relativePath !== relativePath) throw new Error('변경 파일 경로가 일치하지 않습니다. 작업에서 다시 열어 주세요.');
		return new TextEncoder().encode(snapshot.content);
	}

	watch(): IDisposable { return Disposable.None; }
	readdir(): Promise<[string, FileType][]> { return Promise.resolve([]); }
	mkdir(): Promise<void> { throw this.readonlyError(); }
	delete(): Promise<void> { throw this.readonlyError(); }
	rename(): Promise<void> { throw this.readonlyError(); }
	writeFile(): Promise<void> { throw this.readonlyError(); }

	private readonlyError(): Error {
		return createFileSystemProviderError('Inspect snapshots are read-only.', FileSystemProviderErrorCode.NoPermissions);
	}
}
