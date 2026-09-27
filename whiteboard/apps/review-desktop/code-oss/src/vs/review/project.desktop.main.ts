/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// Project windows use the native, editable workspace shell and add a project
// dashboard as an editor tab. The Review Home shell remains a separate entry.
import './navigator.desktop.main.js';
import './browser/parts/canvas/reviewCanvasEditorRegistration.js';
import './browser/projectDashboard/index.js';
import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { IReviewVerbsService, ReviewVerbsService } from './contrib/verbs/reviewVerbs.js';
import { IReviewApiCatalogService, ReviewApiCatalogService } from './services/reviewApiCatalogService.js';
import { IReviewApiSourceService, ReviewApiSourceService } from './services/reviewApiSourceService.js';
import { IReviewCanvasEditorTabsService, ReviewCanvasEditorTabsService } from './services/reviewCanvasEditorTabsService.js';
import { IReviewDesktopConnectionService, ReviewDesktopConnectionService } from './services/reviewDesktopConnectionService.js';
import { IReviewTelemetryService, ReviewTelemetryService } from './services/reviewTelemetryService.js';

registerSingleton(IReviewDesktopConnectionService, ReviewDesktopConnectionService, InstantiationType.Eager);
registerSingleton(IReviewCanvasEditorTabsService, ReviewCanvasEditorTabsService, InstantiationType.Delayed);
registerSingleton(IReviewApiSourceService, ReviewApiSourceService, InstantiationType.Delayed);
registerSingleton(IReviewApiCatalogService, ReviewApiCatalogService, InstantiationType.Delayed);
registerSingleton(IReviewVerbsService, ReviewVerbsService, InstantiationType.Delayed);
registerSingleton(IReviewTelemetryService, ReviewTelemetryService, InstantiationType.Delayed);

export { main } from '../workbench/electron-browser/desktop.main.js';
