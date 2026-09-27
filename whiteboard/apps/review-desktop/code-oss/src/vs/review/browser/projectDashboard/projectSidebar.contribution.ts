/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
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

import './projectSidebar.css';

export const PROJECT_SIDEBAR_CONTAINER_ID = 'workbench.view.devfast.projectSidebar';
export type ProjectSidebarSection = 'dashboard' | 'references' | 'conventions';

const onDidRequestProjectSectionEmitter = new Emitter<ProjectSidebarSection>();
export const onDidRequestProjectSection: Event<ProjectSidebarSection> = onDidRequestProjectSectionEmitter.event;
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
		this.renderNavigation();
		void this.loadProjectName();
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

	private renderNavigation(): void {
		if (!this.content) return;
		const focusedControl = document.activeElement instanceof HTMLButtonElement
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

		const project = document.createElement('div');
		project.className = 'project-sidebar__project';
		project.textContent = this.projectName;
		project.title = this.projectName;
		this.content.appendChild(project);

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
		} else if (focusedControl) {
			this.content.querySelector<HTMLButtonElement>(`button[data-project-section="${focusedControl}"]`)?.focus();
		}
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
		files.addEventListener('click', () => void this.openExplorer());
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
	name: nls.localize2('projectSidebar.navigation', '프로젝트 탐색'),
	ctorDescriptor: new SyncDescriptor(ProjectSidebarView),
	canToggleVisibility: false,
	canMoveView: false,
};
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([descriptor], container);
