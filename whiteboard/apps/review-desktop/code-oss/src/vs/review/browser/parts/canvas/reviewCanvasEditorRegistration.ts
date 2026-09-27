/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

// Register the Review editor in either workbench without importing the Review
// Home contribution into native project windows.
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, type IEditorFactoryRegistry } from '../../../../workbench/common/editor.js';
import { ReviewApiEditorSerializer } from './reviewApiEditorSerializer.js';
import { ReviewCanvasEditorInput } from './reviewCanvasEditorInput.js';
import { ReviewCanvasEditorPane } from './reviewCanvasPart.js';

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	ReviewCanvasEditorInput.ID,
	ReviewApiEditorSerializer,
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ReviewCanvasEditorPane, ReviewCanvasEditorPane.ID, 'Whiteboard'),
	[new SyncDescriptor(ReviewCanvasEditorInput)],
);
