/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// Project windows use the native, editable workspace shell and add a project
// dashboard as an editor tab. The Review Home shell remains a separate entry.
// Register project navigation before the native Explorer so it is the first
// sidebar default on the initial layout pass.
import './browser/projectDashboard/projectSidebar.contribution.js';
import './navigator.desktop.main.js';
import './browser/parts/canvas/reviewCanvasEditorRegistration.js';
import './browser/projectDashboard/index.js';
import './contrib/extensions/reviewCuratedExtensions.contribution.js';
import './contrib/verbs/reviewControl.contribution.js';
import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { IReviewVerbsService, ReviewVerbsService } from './contrib/verbs/reviewVerbs.js';
import { IReviewApiCatalogService, ReviewApiCatalogService } from './services/reviewApiCatalogService.js';
import { IReviewApiSourceService, ReviewApiSourceService } from './services/reviewApiSourceService.js';
import { IReviewCanvasEditorTabsService, ReviewCanvasEditorTabsService } from './services/reviewCanvasEditorTabsService.js';
import { IReviewDesktopConnectionService, ReviewDesktopConnectionService } from './services/reviewDesktopConnectionService.js';
import { IReviewTelemetryService, ReviewTelemetryService } from './services/reviewTelemetryService.js';
import { IProjectInspectSnapshotService, ProjectInspectSnapshotService } from './services/projectInspectSnapshotService.js';

registerSingleton(IReviewDesktopConnectionService, ReviewDesktopConnectionService, InstantiationType.Eager);
registerSingleton(IReviewCanvasEditorTabsService, ReviewCanvasEditorTabsService, InstantiationType.Delayed);
registerSingleton(IReviewApiSourceService, ReviewApiSourceService, InstantiationType.Delayed);
registerSingleton(IReviewApiCatalogService, ReviewApiCatalogService, InstantiationType.Delayed);
registerSingleton(IReviewVerbsService, ReviewVerbsService, InstantiationType.Delayed);
registerSingleton(IReviewTelemetryService, ReviewTelemetryService, InstantiationType.Delayed);
registerSingleton(IProjectInspectSnapshotService, ProjectInspectSnapshotService, InstantiationType.Eager);

export { main } from '../workbench/electron-browser/desktop.main.js';
