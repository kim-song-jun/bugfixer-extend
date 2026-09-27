/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import * as nls from '../../../nls.js';
import { Codicon } from '../../../base/common/codicons.js';
import { renderIcon } from '../../../base/browser/ui/iconLabel/iconLabels.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { ViewPane, IViewPaneOptions } from '../../../workbench/browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../workbench/browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../../workbench/common/views.js';
import { IViewDescriptorService } from '../../../workbench/common/views.js';
import { INativeWorkbenchEnvironmentService } from '../../../workbench/services/environment/electron-browser/environmentService.js';
import { IPaneCompositePartService } from '../../../workbench/services/panecomposite/browser/panecomposite.js';
import { VIEWLET_ID as EXPLORER_VIEWLET_ID } from '../../../workbench/contrib/files/common/files.js';
import { ipcRenderer } from '../../../base/parts/sandbox/electron-browser/globals.js';
import { WORKSPACE_DASHBOARD_CHANNEL, type WorkspaceDashboardDTO } from '../../../workspace/common/workspaceDashboardProtocol.js';
import { WORKSPACE_PROJECT_HOME_CHANNEL, type WorkspaceProjectDTO } from '../../../workspace/common/workspaceProjectHomeProtocol.js';

import './projectSidebar.css';

export const PROJECT_SIDEBAR_CONTAINER_ID = 'workbench.view.devfast.projectSidebar';
export type ProjectSidebarSection = 'dashboard' | 'references' | 'conventions';

const onDidRequestProjectSectionEmitter = new Emitter<ProjectSidebarSection>();
export const onDidRequestProjectSection: Event<ProjectSidebarSection> = onDidRequestProjectSectionEmitter.event;
const onDidRequestNewTaskEmitter = new Emitter<void>();
export const onDidRequestNewTask: Event<void> = onDidRequestNewTaskEmitter.event;
const onDidChangeProjectSectionEmitter = new Emitter<ProjectSidebarSection>();
let currentProjectSection: ProjectSidebarSection = 'dashboard';

export function setProjectSidebarSection(section: ProjectSidebarSection): void {
	if (currentProjectSection === section) return;
	currentProjectSection = section;
	onDidChangeProjectSectionEmitter.fire(section);
}

const NAV_ITEMS: readonly { readonly section: ProjectSidebarSection; readonly label: string; readonly icon: ThemeIcon }[] = [
	{ section: 'dashboard', label: '대시보드', icon: Codicon.dashboard },
	{ section: 'references', label: '레퍼런스', icon: Codicon.book },
	{ section: 'conventions', label: '프로젝트 규칙', icon: Codicon.settingsGear },
];

class ProjectSidebarView extends ViewPane {
	private projectName = '프로젝트';
	private errorMessage: string | undefined;
	private content: HTMLElement | undefined;
	private selectedSection: ProjectSidebarSection = currentProjectSection;
	private switcherOpen = false;
	private switcherLoading = false;
	private switcherError: string | undefined;
	private switcherProjects: readonly WorkspaceProjectDTO[] = [];
	private switcherBusy = false;
	private switcherLoadToken = 0;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@INativeWorkbenchEnvironmentService private readonly environment: INativeWorkbenchEnvironmentService,
		@IPaneCompositePartService private readonly paneCompositePartService: IPaneCompositePartService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(onDidChangeProjectSectionEmitter.event(section => {
			this.selectedSection = section;
			this.renderNavigation();
		}));
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this.content = document.createElement('nav');
		this.content.className = 'project-sidebar';
		this.content.setAttribute('aria-label', '프로젝트 탐색');
		parent.appendChild(this.content);
		const onOutsidePointerDown = (event: PointerEvent): void => {
			if (this.switcherOpen && event.target instanceof Node && !this.content?.contains(event.target)) {
				this.closeSwitcher(false);
			}
		};
		document.addEventListener('pointerdown', onOutsidePointerDown);
		this._register(toDisposable(() => document.removeEventListener('pointerdown', onOutsidePointerDown)));
		this.content.addEventListener('keydown', event => {
			if (event.key === 'Escape' && this.switcherOpen) {
				event.preventDefault();
				this.closeSwitcher(true);
			}
		});
		this.renderNavigation();
		void this.loadProjectName();
	}

	private closeSwitcher(restoreFocus: boolean): void {
		this.switcherOpen = false;
		this.switcherLoadToken++;
		this.renderNavigation(restoreFocus);
		if (restoreFocus) this.content?.querySelector<HTMLButtonElement>('button[data-project-control="switcher"]')?.focus();
	}

	private dismissSwitcherKeepingFocus(): void {
		if (!this.switcherOpen) return;
		this.switcherOpen = false;
		this.switcherLoadToken++;
		this.renderNavigation();
	}

	private async loadProjects(): Promise<void> {
		const requestToken = ++this.switcherLoadToken;
		this.switcherLoading = true;
		this.switcherError = undefined;
		this.renderNavigation();
		try {
			const projects = await ipcRenderer.invoke(WORKSPACE_PROJECT_HOME_CHANNEL, 'listProjects') as WorkspaceProjectDTO[];
			if (requestToken !== this.switcherLoadToken || !this.switcherOpen) return;
			this.switcherProjects = projects;
		} catch (error) {
			if (requestToken !== this.switcherLoadToken || !this.switcherOpen) return;
			console.error('Could not load projects for project navigation.', error);
			this.switcherProjects = [];
			this.switcherError = '프로젝트 목록을 불러오지 못했습니다.';
		} finally {
			if (requestToken === this.switcherLoadToken && this.switcherOpen) {
				this.switcherLoading = false;
				this.renderNavigation();
			}
		}
	}

	private async openProject(projectId: string): Promise<void> {
		if (this.switcherBusy) return;
		if (this.environment.reviewWindowLaunch.kind === 'project' && projectId === this.environment.reviewWindowLaunch.projectId) {
			this.closeSwitcher(true);
			return;
		}
		this.switcherBusy = true;
		this.switcherError = undefined;
		const interactionToken = this.switcherLoadToken;
		this.renderNavigation();
		try {
			await ipcRenderer.invoke(WORKSPACE_PROJECT_HOME_CHANNEL, 'openProject', projectId);
			if (this.switcherOpen && interactionToken === this.switcherLoadToken) this.closeSwitcher(true);
		} catch (error) {
			console.error('Could not open the selected project from project navigation.', error);
			if (this.switcherOpen && interactionToken === this.switcherLoadToken) {
				this.switcherError = '프로젝트를 열지 못했습니다. 다시 시도해 주세요.';
			}
		} finally {
			this.switcherBusy = false;
			this.renderNavigation();
		}
	}

	private async loadProjectName(): Promise<void> {
		const launch = this.environment.reviewWindowLaunch;
		if (launch.kind !== 'project' || !this.content) return;
		this.errorMessage = undefined;
		this.renderNavigation();
		try {
			const dashboard = await ipcRenderer.invoke(WORKSPACE_DASHBOARD_CHANNEL, 'getDashboard', launch.projectId) as WorkspaceDashboardDTO;
			this.projectName = dashboard.project.name;
		} catch (error) {
			console.error('Could not load the project name for project navigation.', error);
			this.errorMessage = '프로젝트 이름을 불러오지 못했습니다.';
		}
		this.renderNavigation();
	}

	private renderNavigation(restoreFocus = true): void {
		if (!this.content) return;
		const focusedControl = restoreFocus && document.activeElement instanceof HTMLButtonElement
			? document.activeElement.dataset.projectSection ?? document.activeElement.dataset.projectControl
			: undefined;
		this.content.replaceChildren();
		const brand = document.createElement('div');
		brand.className = 'project-sidebar__brand';
		const mark = document.createElement('span');
		mark.className = 'project-sidebar__mark';
		mark.setAttribute('aria-hidden', 'true');
		mark.textContent = 'B';
		const brandName = document.createElement('span');
		brandName.textContent = 'Bugfixer Extend';
		brand.append(mark, brandName);
		this.content.appendChild(brand);

		const label = document.createElement('div');
		label.className = 'project-sidebar__label';
		label.textContent = '프로젝트';
		this.content.appendChild(label);

		if (this.errorMessage) {
			const error = document.createElement('div');
			error.className = 'project-sidebar__error';
			error.id = 'project-sidebar-load-error';
			error.setAttribute('role', 'alert');
			error.textContent = this.errorMessage;
			const retry = document.createElement('button');
			retry.className = 'project-sidebar__retry';
			retry.type = 'button';
			retry.dataset.projectControl = 'retry';
			retry.setAttribute('aria-describedby', error.id);
			retry.setAttribute('aria-label', '프로젝트 이름 불러오기 다시 시도');
			retry.textContent = '다시 시도';
			retry.addEventListener('click', () => void this.loadProjectName());
			this.content.append(error, retry);
		}

		const project = document.createElement('button');
		project.type = 'button';
		project.className = 'project-sidebar__project';
		project.dataset.projectControl = 'switcher';
		project.setAttribute('aria-expanded', String(this.switcherOpen));
		project.setAttribute('aria-label', `프로젝트 전환, 현재 프로젝트 ${this.projectName}`);
		project.title = this.projectName;
		const projectName = document.createElement('span');
		projectName.className = 'project-sidebar__project-name';
		projectName.textContent = this.projectName;
		const chevron = renderIcon(Codicon.chevronDown);
		chevron.classList.add('project-sidebar__chevron');
		chevron.setAttribute('aria-hidden', 'true');
		project.append(projectName, chevron);
		project.addEventListener('click', () => {
			if (this.switcherOpen) this.closeSwitcher(true);
			else {
				this.switcherOpen = true;
				void this.loadProjects();
			}
		});
		this.content.appendChild(project);
		if (this.switcherOpen) this.renderSwitcher();

		const createTask = document.createElement('button');
		createTask.type = 'button';
		createTask.className = 'project-sidebar__create';
		createTask.dataset.projectControl = 'create-task';
		const createIcon = renderIcon(Codicon.add);
		createIcon.setAttribute('aria-hidden', 'true');
		const createText = document.createElement('span');
		createText.textContent = '새 작업';
		createTask.append(createIcon, createText);
		createTask.addEventListener('click', () => {
			this.dismissSwitcherKeepingFocus();
			onDidRequestNewTaskEmitter.fire();
		});
		this.content.appendChild(createTask);

		const projectLabel = document.createElement('div');
		projectLabel.className = 'project-sidebar__label project-sidebar__label--project';
		projectLabel.textContent = '작업 공간';
		this.content.appendChild(projectLabel);

		for (const item of NAV_ITEMS) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'project-sidebar__item';
			button.dataset.projectSection = item.section;
			button.setAttribute('aria-current', item.section === this.selectedSection ? 'page' : 'false');
			button.title = item.label;
			const icon = renderIcon(item.icon);
			icon.classList.add('project-sidebar__icon');
			icon.setAttribute('aria-hidden', 'true');
			const text = document.createElement('span');
			text.textContent = item.label;
			button.append(icon, text);
			button.addEventListener('click', () => {
				this.dismissSwitcherKeepingFocus();
				setProjectSidebarSection(item.section);
				onDidRequestProjectSectionEmitter.fire(item.section);
			});
			this.content.appendChild(button);
			if (item.section === 'dashboard') this.content.appendChild(this.createFilesButton());
		}
		if (focusedControl === 'retry') {
			const retry = this.content.querySelector<HTMLButtonElement>('button[data-project-control="retry"]');
			(retry ?? this.content.querySelector<HTMLButtonElement>(`button[data-project-section="${this.selectedSection}"]`))?.focus();
		} else if (focusedControl === 'files') {
			this.content.querySelector<HTMLButtonElement>('button[data-project-control="files"]')?.focus();
		} else if (focusedControl?.startsWith('switcher-project-')) {
			(this.content.querySelector<HTMLButtonElement>(`button[data-project-control="${focusedControl}"]`)
				?? this.content.querySelector<HTMLButtonElement>('button[data-project-control="switcher"]'))?.focus();
		} else if (focusedControl === 'switcher' || focusedControl === 'switcher-retry' || focusedControl === 'create-task') {
			(this.content.querySelector<HTMLButtonElement>(`button[data-project-control="${focusedControl}"]`)
				?? this.content.querySelector<HTMLButtonElement>('button[data-project-control="switcher"]'))?.focus();
		} else if (focusedControl) {
			this.content.querySelector<HTMLButtonElement>(`button[data-project-section="${focusedControl}"]`)?.focus();
		}
	}

	private renderSwitcher(): void {
		if (!this.content) return;
		const group = document.createElement('div');
		group.className = 'project-sidebar__switcher';
		group.id = 'project-sidebar-project-list';
		group.setAttribute('role', 'group');
		group.setAttribute('aria-label', '프로젝트 전환');
		this.content.querySelector<HTMLButtonElement>('button[data-project-control="switcher"]')?.setAttribute('aria-controls', group.id);
		if (this.switcherLoading) {
			const status = document.createElement('p');
			status.className = 'project-sidebar__switcher-status';
			status.setAttribute('role', 'status');
			status.textContent = '프로젝트를 불러오는 중입니다.';
			group.appendChild(status);
		} else if (this.switcherProjects.length === 0 && !this.switcherError) {
			const empty = document.createElement('p');
			empty.className = 'project-sidebar__switcher-status';
			empty.textContent = '다른 프로젝트가 없습니다.';
			group.appendChild(empty);
		} else {
			const currentId = this.environment.reviewWindowLaunch.kind === 'project' ? this.environment.reviewWindowLaunch.projectId : undefined;
			for (const item of this.switcherProjects) {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'project-sidebar__switcher-item';
				button.dataset.projectControl = `switcher-project-${item.id}`;
				button.title = item.folderPath;
				button.setAttribute('aria-label', `${item.name}, ${item.folderPath}${item.id === currentId ? ', 현재 프로젝트' : ''}`);
				button.setAttribute('aria-current', item.id === currentId ? 'true' : 'false');
				button.setAttribute('aria-disabled', String(this.switcherBusy));
				const details = document.createElement('span');
				details.className = 'project-sidebar__switcher-details';
				const name = document.createElement('span');
				name.className = 'project-sidebar__switcher-name';
				name.textContent = item.name;
				const path = document.createElement('span');
				path.className = 'project-sidebar__switcher-path';
				path.textContent = item.folderPath;
				details.append(name, path);
				button.appendChild(details);
				if (item.id === currentId) {
					const current = document.createElement('span');
					current.className = 'project-sidebar__switcher-current';
					current.textContent = '현재';
					button.appendChild(current);
				}
				button.addEventListener('click', () => void this.openProject(item.id));
				group.appendChild(button);
			}
		}
		if (this.switcherBusy) {
			const status = document.createElement('p');
			status.className = 'project-sidebar__switcher-status';
			status.setAttribute('role', 'status');
			status.textContent = '프로젝트 창을 여는 중입니다.';
			group.appendChild(status);
		}
		if (this.switcherError) {
			const error = document.createElement('p');
			error.className = 'project-sidebar__switcher-error';
			error.setAttribute('role', 'alert');
			error.textContent = this.switcherError;
			group.appendChild(error);
			if (this.switcherProjects.length === 0) {
				const retry = document.createElement('button');
				retry.type = 'button';
				retry.className = 'project-sidebar__switcher-retry';
				retry.dataset.projectControl = 'switcher-retry';
				retry.textContent = '다시 시도';
				retry.addEventListener('click', () => void this.loadProjects());
				group.appendChild(retry);
			}
		}
		this.content.appendChild(group);
	}

	private createFilesButton(): HTMLButtonElement {
		const files = document.createElement('button');
		files.type = 'button';
		files.className = 'project-sidebar__item';
		files.dataset.projectControl = 'files';
		files.title = '프로젝트 파일 보기';
		files.setAttribute('aria-label', '프로젝트 파일 보기');
		const filesIcon = renderIcon(Codicon.files);
		filesIcon.classList.add('project-sidebar__icon');
		filesIcon.setAttribute('aria-hidden', 'true');
		const filesText = document.createElement('span');
		filesText.textContent = '파일';
		files.append(filesIcon, filesText);
		files.addEventListener('click', () => {
			this.dismissSwitcherKeepingFocus();
			void this.openExplorer();
		});
		return files;
	}

	private async openExplorer(): Promise<void> {
		try {
			const explorer = await this.paneCompositePartService.openPaneComposite(EXPLORER_VIEWLET_ID, ViewContainerLocation.Sidebar, true);
			if (!explorer) throw new Error('파일 탐색기를 열 수 없습니다.');
		} catch (error) {
			console.error('Could not open the Explorer from project navigation.', error);
			this.notificationService.error('파일 탐색기를 열지 못했습니다.');
		}
	}
}

const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: PROJECT_SIDEBAR_CONTAINER_ID,
	title: nls.localize2('projectSidebar.container', '프로젝트'),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [PROJECT_SIDEBAR_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: Codicon.dashboard,
	order: 0,
}, ViewContainerLocation.Sidebar, { isDefault: true, doNotRegisterOpenCommand: true });

const descriptor: IViewDescriptor = {
	id: 'workbench.view.devfast.projectSidebar.navigation',
	containerIcon: Codicon.dashboard,
	name: nls.localize2('projectSidebar.navigation', '탐색'),
	ctorDescriptor: new SyncDescriptor(ProjectSidebarView),
	canToggleVisibility: false,
	canMoveView: false,
};
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([descriptor], container);
