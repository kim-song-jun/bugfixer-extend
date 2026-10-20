/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getFontSnippets } from '../../../../base/browser/fonts.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ITerminalLogService } from '../../../../platform/terminal/common/terminal.js';
import { TerminalLogService } from '../../../../platform/terminal/common/terminalLogService.js';
import { registerTerminalPlatformConfiguration } from '../../../../platform/terminal/common/terminalPlatformConfiguration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../../workbench/common/contributions.js';
import { ITerminalConfigurationService, ITerminalEditingService, ITerminalEditorService, ITerminalGroupService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalConfigurationService } from '../../../../workbench/contrib/terminal/browser/terminalConfigurationService.js';
import { TerminalEditingService } from '../../../../workbench/contrib/terminal/browser/terminalEditingService.js';
import { TerminalEditorService } from '../../../../workbench/contrib/terminal/browser/terminalEditorService.js';
import { TerminalGroupService } from '../../../../workbench/contrib/terminal/browser/terminalGroupService.js';
import '../../../../workbench/contrib/terminal/browser/terminalInstanceService.js';
import { TerminalProfileService } from '../../../../workbench/contrib/terminal/browser/terminalProfileService.js';
import { TerminalService } from '../../../../workbench/contrib/terminal/browser/terminalService.js';
import { registerColors } from '../../../../workbench/contrib/terminal/common/terminalColorRegistry.js';
import { registerTerminalConfiguration } from '../../../../workbench/contrib/terminal/common/terminalConfiguration.js';
import { ITerminalContributionService, TerminalContributionService } from '../../../../workbench/contrib/terminal/common/terminalExtensionPoints.js';
import { ITerminalProfileService, ITerminalProfileResolverService } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { IEnvironmentVariableService } from '../../../../workbench/contrib/terminal/common/environmentVariable.js';
import { EnvironmentVariableService } from '../../../../workbench/contrib/terminal/common/environmentVariableService.js';
import { TerminalNativeContribution } from '../../../../workbench/contrib/terminal/electron-browser/terminalNativeContribution.js';
import { ElectronTerminalProfileResolverService } from '../../../../workbench/contrib/terminal/electron-browser/terminalProfileResolverService.js';
import '../../../../workbench/contrib/terminal/browser/media/terminal.css';
import '../../../../workbench/contrib/terminal/browser/media/widgets.css';
import '../../../../workbench/contrib/terminal/browser/media/xterm.css';

// Agent sessions create real TerminalInstances with custom PTY output attached to their pane.
// Register those primitives without the generic local PTY backend, terminal view, commands, menus,
// or AgentHostTerminalService, whose dependency closure includes chat services.
registerSingleton(ITerminalLogService, TerminalLogService, InstantiationType.Delayed);
registerSingleton(ITerminalConfigurationService, TerminalConfigurationService, InstantiationType.Delayed);
registerSingleton(ITerminalService, TerminalService, InstantiationType.Delayed);
registerSingleton(ITerminalEditorService, TerminalEditorService, InstantiationType.Delayed);
registerSingleton(ITerminalEditingService, TerminalEditingService, InstantiationType.Delayed);
registerSingleton(ITerminalGroupService, TerminalGroupService, InstantiationType.Delayed);
// TerminalInstanceService registers itself when its real implementation module is imported.
registerSingleton(ITerminalProfileService, TerminalProfileService, InstantiationType.Delayed);
registerSingleton(ITerminalContributionService, TerminalContributionService, InstantiationType.Delayed);
registerSingleton(IEnvironmentVariableService, EnvironmentVariableService, InstantiationType.Delayed);
registerSingleton(ITerminalProfileResolverService, ElectronTerminalProfileResolverService, InstantiationType.Delayed);

registerTerminalPlatformConfiguration();
registerTerminalConfiguration(getFontSnippets);
registerColors();
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(TerminalNativeContribution, LifecyclePhase.Restored);
