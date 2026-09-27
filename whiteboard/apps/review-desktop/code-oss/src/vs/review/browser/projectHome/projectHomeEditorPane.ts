import { $, clearNode, type Dimension } from '../../../base/browser/dom.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { ipcRenderer } from '../../../base/parts/sandbox/electron-browser/globals.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../workbench/browser/parts/editor/editorPane.js';
import type { IEditorGroup } from '../../../workbench/services/editor/common/editorGroupsService.js';
import type { IEditorOpenContext } from '../../../workbench/common/editor.js';
import type { WorkspaceProjectDTO } from '../../../workspace/common/workspaceProjectHomeProtocol.js';
import { WORKSPACE_PROJECT_HOME_CHANNEL } from '../../../workspace/common/workspaceProjectHomeProtocol.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IReviewCanvasEditorTabsService } from '../../services/reviewCanvasEditorTabsService.js';
import { ProjectHomeEditorInput } from './projectHomeEditorInput.js';
import './projectHome.css';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
}

export class ProjectHomeEditorPane extends EditorPane {
	static readonly ID = ProjectHomeEditorInput.EDITOR_ID;
	private root: HTMLElement | undefined;
	private projects: readonly WorkspaceProjectDTO[] = [];
	private loading = false;
	private error: string | undefined;
	private actionBusy = false;
	private lastFocusKey: string | undefined;

	constructor(group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IReviewCanvasEditorTabsService private readonly reviewTabs: IReviewCanvasEditorTabsService) {
		super(ProjectHomeEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = $('.project-home');
		this.root.tabIndex = -1;
		parent.appendChild(this.root);
	}

	override focus(): void {
		(this.root?.querySelector<HTMLElement>('.project-home__primary') ?? this.root)?.focus({ preventScroll: true });
	}

	layout(dimension: Dimension): void {
		if (this.root) { this.root.style.width = `${dimension.width}px`; this.root.style.height = `${dimension.height}px`; }
	}

	override async setInput(input: ProjectHomeEditorInput, options: unknown, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options as never, context, token);
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		this.loading = true;
		this.error = undefined;
		this.render();
		try {
			this.projects = await ipcRenderer.invoke(WORKSPACE_PROJECT_HOME_CHANNEL, 'listProjects') as WorkspaceProjectDTO[];
		} catch (error) {
			this.error = error instanceof Error ? error.message : '프로젝트 목록을 불러오지 못했습니다.';
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private async chooseFolder(): Promise<void> {
		if (this.actionBusy) return;
		this.actionBusy = true;
		this.render();
		try {
			const project = await ipcRenderer.invoke(WORKSPACE_PROJECT_HOME_CHANNEL, 'chooseFolder') as WorkspaceProjectDTO | null;
			if (project) {
				await ipcRenderer.invoke(WORKSPACE_PROJECT_HOME_CHANNEL, 'openProject', project.id);
				await this.refresh();
			}
		} catch (error) {
			this.notificationService.error(error);
		} finally {
			this.actionBusy = false;
			this.render();
		}
	}

	private async openProject(projectId: string): Promise<void> {
		if (this.actionBusy) return;
		this.actionBusy = true;
		this.render();
		try {
			await ipcRenderer.invoke(WORKSPACE_PROJECT_HOME_CHANNEL, 'openProject', projectId);
			await this.refresh();
		} catch (error) {
			this.notificationService.error(error);
		} finally {
			this.actionBusy = false;
			this.render();
		}
	}

	private async openReviews(): Promise<void> {
		try { await this.reviewTabs.openHome(true); }
		catch (error) { this.notificationService.error(error); }
	}

	private render(): void {
		if (!this.root) return;
		const active = document.activeElement;
		const hadFocus = active === this.root || (active !== null && this.root.contains(active));
		if (active instanceof HTMLElement && active.dataset.projectHomeFocus) this.lastFocusKey = active.dataset.projectHomeFocus;
		clearNode(this.root);
		const shell = element('main', 'project-home__shell');
		const header = element('header', 'project-home__header');
		const brand = element('div', 'project-home__brand');
		const mark = element('span', 'project-home__mark');
		mark.setAttribute('aria-hidden', 'true');
		brand.append(mark);
		const brandText = element('div');
		const brandName = element('div', 'project-home__brand-name');
		brandName.textContent = 'Bugfixer Extend';
		const brandCaption = element('div', 'project-home__brand-caption');
		brandCaption.textContent = '프로젝트 작업 공간';
		brandText.append(brandName, brandCaption);
		brand.append(brandText);
		header.append(brand);
		shell.append(header);

		const content = element('section', 'project-home__content');
		const intro = element('div', 'project-home__intro');
		const eyebrow = element('p', 'project-home__eyebrow');
		eyebrow.textContent = '시작하기';
		const title = element('h1');
		title.textContent = '어떤 프로젝트를 열까요?';
		const description = element('p', 'project-home__description');
		description.textContent = '폴더를 선택해 작업을 시작하거나, 최근 프로젝트를 다시 여세요.';
		intro.append(eyebrow, title, description);
		content.append(intro);

		const actions = element('div', 'project-home__actions');
		const choose = element('button', 'project-home__primary');
		choose.type = 'button';
		choose.dataset.projectHomeFocus = 'choose';
		choose.disabled = this.actionBusy;
		choose.setAttribute('aria-label', '폴더를 선택해 프로젝트 열기');
		choose.textContent = this.actionBusy ? '여는 중…' : '폴더 열기';
		choose.addEventListener('click', () => void this.chooseFolder());
		actions.append(choose);
		const reviews = element('button', 'project-home__secondary');
		reviews.type = 'button';
		reviews.dataset.projectHomeFocus = 'reviews';
		reviews.textContent = 'Whiteboard 리뷰 세션';
		reviews.setAttribute('aria-label', 'Whiteboard 리뷰 세션 열기');
		reviews.addEventListener('click', () => void this.openReviews());
		actions.append(reviews);
		content.append(actions);

		const recent = element('section', 'project-home__recent');
		recent.setAttribute('aria-labelledby', 'project-home-recent-title');
		const recentHead = element('div', 'project-home__recent-head');
		const recentTitle = element('h2');
		recentTitle.id = 'project-home-recent-title';
		recentTitle.textContent = '최근 프로젝트';
		recentHead.append(recentTitle);
		recent.append(recentHead);
		if (this.loading) {
			const status = element('p', 'project-home__status');
			status.setAttribute('role', 'status');
			status.textContent = '프로젝트를 불러오는 중입니다.';
			recent.append(status);
		} else if (this.error) {
			const error = element('div', 'project-home__error');
			error.setAttribute('role', 'alert');
			const message = element('p');
			message.textContent = this.error;
			const retry = element('button', 'project-home__text-button');
			retry.type = 'button';
			retry.dataset.projectHomeFocus = 'retry';
			retry.textContent = '다시 불러오기';
			retry.addEventListener('click', () => void this.refresh());
			error.append(message, retry);
			recent.append(error);
		} else if (!this.projects.length) {
			const empty = element('div', 'project-home__empty');
			const emptyTitle = element('p', 'project-home__empty-title');
			emptyTitle.textContent = '아직 등록된 프로젝트가 없습니다';
			const emptyCopy = element('p');
			emptyCopy.textContent = '폴더 열기를 눌러 첫 프로젝트를 추가하세요.';
			empty.append(emptyTitle, emptyCopy);
			recent.append(empty);
		} else {
			const list = element('ul', 'project-home__list');
			for (const project of this.projects) {
				const item = element('li', 'project-home__list-item');
				const row = element('button', 'project-home__row');
				row.type = 'button';
				row.dataset.projectHomeFocus = `project:${project.id}`;
				row.disabled = this.actionBusy;
				row.setAttribute('aria-label', `${project.name} 프로젝트 열기, ${project.folderPath}`);
				const icon = element('span', 'project-home__folder-icon');
				icon.setAttribute('aria-hidden', 'true');
				const details = element('span', 'project-home__row-details');
				const name = element('span', 'project-home__row-name');
				name.textContent = project.name;
				const path = element('span', 'project-home__row-path');
				path.textContent = project.folderPath;
				details.append(name, path);
				const arrow = element('span', 'project-home__row-arrow');
				arrow.setAttribute('aria-hidden', 'true');
				arrow.textContent = '열기';
				row.append(icon, details, arrow);
				row.addEventListener('click', () => void this.openProject(project.id));
				item.append(row);
				list.append(item);
			}
			recent.append(list);
		}
		content.append(recent);
		shell.append(content);
		this.root.replaceChildren(shell);
		if (document.hasFocus() && (hadFocus || active === document.body)) {
			const target = [...this.root.querySelectorAll<HTMLButtonElement>('[data-project-home-focus]')]
				.find(button => button.dataset.projectHomeFocus === this.lastFocusKey && !button.disabled);
			(target ?? this.root).focus({ preventScroll: true });
		}
	}

	override clearInput(): void { if (this.root) clearNode(this.root); super.clearInput(); }
}
