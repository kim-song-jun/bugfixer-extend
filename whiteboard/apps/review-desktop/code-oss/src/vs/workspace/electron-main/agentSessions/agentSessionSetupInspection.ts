/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See the LICENSE file in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionProvider } from '../../common/workspaceAgentSessionProtocol.js';
import type { WorkspaceAgentSetupCapabilitiesDTO, WorkspaceAgentSetupInspectionDTO } from '../../common/workspaceAgentSetupProtocol.js';
import { discoverAgentCliCapabilities, type AgentCliCapabilities } from './agentCliCapabilities.js';
import { AgentCliProcessError, runBoundedAgentCliProcess } from './agentCliProcess.js';

const MAX_PROBE_TIMEOUT_MS = 5_000;
const MAX_AUTH_OUTPUT_BYTES = 64 * 1024;
const profileKeys = { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR' } as const;

/** Inputs are resolved by the trusted Electron main process; none may come directly from renderer state. */
export interface InspectWorkspaceAgentSetupInput {
	readonly projectId: string;
	readonly provider: AgentSessionProvider;
	readonly executable?: string;
	readonly profileDirectory: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly guardianNodeExecutable: string;
	readonly guardianScriptPath: string;
	/** A testable shorter bound. It cannot increase the production five-second ceiling. */
	readonly probeTimeoutMs?: number;
}

/**
 * Inspects installation, safe CLI capabilities, and the selected local profile's credential status.
 * Authentication probes never start a model session and discard all provider output after parsing.
 */
export async function inspectWorkspaceAgentSetup(input: InspectWorkspaceAgentSetupInput): Promise<WorkspaceAgentSetupInspectionDTO> {
	assertInput(input);
	const checkedAt = new Date().toISOString();
	const profileRef = `local-default-${input.provider}` as const;
	const profileKey = profileKeys[input.provider];
	const executable = input.executable;
	if (!executable) {
		return result(input, checkedAt, profileRef, {
			installation: { state: 'missing', executablePath: null, version: null, reason: '지원하는 설치 위치에서 CLI를 찾지 못했습니다.' },
			authentication: { state: isMissingProfile(input.profileDirectory) ? 'signedOut' : 'unavailable', profileRef, validForExecution: false, reason: 'CLI를 찾지 못해 로그인 기록을 점검할 수 없습니다.' },
			capabilities: null,
		});
	}
	if (!existsSync(executable)) {
		return result(input, checkedAt, profileRef, {
			installation: { state: 'missing', executablePath: executable, version: null, reason: '확인한 경로에 CLI 실행 파일이 없습니다.' },
			authentication: { state: isMissingProfile(input.profileDirectory) ? 'signedOut' : 'unavailable', profileRef, validForExecution: false, reason: 'CLI를 찾지 못해 로그인 기록을 점검할 수 없습니다.' },
			capabilities: null,
		});
	}
	let canonicalExecutable: string;
	try {
		if (!isCanonicalExecutable(executable)) {
			return result(input, checkedAt, profileRef, {
				installation: { state: 'unavailable', executablePath: executable, version: null, reason: 'CLI 파일을 실행할 수 없습니다.' },
				authentication: { state: 'unavailable', profileRef, validForExecution: false, reason: 'CLI의 실행 경로와 권한을 확인해 주세요.' },
				capabilities: null,
			});
		}
		canonicalExecutable = realpathSync(executable);
	} catch {
		return result(input, checkedAt, profileRef, {
			installation: { state: 'unavailable', executablePath: executable, version: null, reason: 'CLI의 실행 경로와 권한을 확인하지 못했습니다.' },
			authentication: { state: 'unavailable', profileRef, validForExecution: false, reason: 'CLI의 실행 경로와 권한을 확인해 주세요.' },
			capabilities: null,
		});
	}

	let actualProfileDirectory: string | undefined;
	try {
		if (!lstatSync(input.profileDirectory).isDirectory()) { throw new Error('invalid profile'); }
		actualProfileDirectory = realpathSync(input.profileDirectory);
		if (actualProfileDirectory !== input.profileDirectory || statSync(actualProfileDirectory).isDirectory() !== true) { throw new Error('noncanonical profile'); }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			return result(input, checkedAt, profileRef, {
				installation: { state: 'unavailable', executablePath: canonicalExecutable, version: null, reason: '로컬 계정 프로필의 경로를 확인할 수 없습니다.' },
				authentication: { state: 'unavailable', profileRef, validForExecution: false, reason: '공급자의 기본 프로필 경로를 확인해 주세요.' },
				capabilities: null,
			});
		}
	}

	const environment = buildProfileEnvironment(input, profileKey, actualProfileDirectory);
	let capabilities: AgentCliCapabilities;
	try {
		capabilities = await discoverAgentCliCapabilities({
			provider: input.provider,
			executable: canonicalExecutable,
			env: environment,
			timeoutMs: timeout(input),
			guardianNodeExecutable: input.guardianNodeExecutable,
			guardianScriptPath: input.guardianScriptPath,
		});
	} catch (error) {
		propagateUnverifiedCleanup(error);
		return result(input, checkedAt, profileRef, {
			installation: { state: 'unavailable', executablePath: canonicalExecutable, version: null, reason: 'CLI 버전과 지원 기능 점검을 완료하지 못했습니다.' },
			authentication: { state: actualProfileDirectory ? 'unavailable' : 'signedOut', profileRef, validForExecution: false, reason: actualProfileDirectory ? '이 프로필의 로그인 기록을 확인하지 못했습니다.' : '기본 로컬 계정 프로필이 아직 없습니다.' },
			capabilities: null,
		});
	}
	const safeCapabilities = toSafeCapabilities(capabilities);
	if (!actualProfileDirectory) {
		return result(input, checkedAt, profileRef, {
			installation: { state: 'available', executablePath: canonicalExecutable, version: capabilities.version, reason: null },
			authentication: { state: 'signedOut', profileRef, validForExecution: false, reason: '기본 로컬 계정 프로필이 아직 없습니다.' },
			capabilities: safeCapabilities,
		});
	}

	const probeRoot = mkdtempSync(join(tmpdir(), 'workspace-agent-setup-'));
	const probeDirectory = join(probeRoot, 'cwd');
	const helpProfileDirectory = join(probeRoot, 'help-profile');
	try {
		mkdirSync(probeDirectory, { mode: 0o700 });
		mkdirSync(helpProfileDirectory, { mode: 0o700 });
		const helpArgs = input.provider === 'codex' ? ['login', '--help'] : ['auth', '--help'];
		let helpOutput: string;
		try {
			const help = await runBoundedAgentCliProcess(canonicalExecutable, helpArgs, processOptions(input, { ...environment, HOME: helpProfileDirectory, [profileKey]: helpProfileDirectory }, probeDirectory));
			helpOutput = `${help.stdout}\n${help.stderr}`;
		} catch (error) {
			propagateUnverifiedCleanup(error);
			return result(input, checkedAt, profileRef, {
				installation: { state: 'unavailable', executablePath: canonicalExecutable, version: capabilities.version, reason: 'CLI의 로그인 점검 명령을 확인하지 못했습니다.' },
				authentication: { state: 'unavailable', profileRef, validForExecution: false, reason: '이 프로필의 로그인 기록을 확인하지 못했습니다.' },
				capabilities: safeCapabilities,
			});
		}
		if (!/\bstatus\b/i.test(helpOutput)) {
			return result(input, checkedAt, profileRef, {
				installation: { state: 'unsupported', executablePath: canonicalExecutable, version: capabilities.version, reason: '이 CLI 버전은 로그인 상태 점검 명령을 제공하지 않습니다.' },
				authentication: { state: 'unavailable', profileRef, validForExecution: false, reason: '로그인 상태 점검을 지원하는 CLI 버전이 필요합니다.' },
				capabilities: safeCapabilities,
			});
		}
		const statusArgs = input.provider === 'codex' ? ['login', 'status'] : ['auth', 'status'];
		try {
			await runBoundedAgentCliProcess(canonicalExecutable, statusArgs, processOptions(input, environment, probeDirectory));
			return result(input, checkedAt, profileRef, {
				installation: { state: 'available', executablePath: canonicalExecutable, version: capabilities.version, reason: null },
				authentication: { state: 'credentialPresent', profileRef, validForExecution: false, reason: 'CLI에 로그인 기록이 있습니다. 실제 인증 유효성과 실행 권한까지 확인한 결과는 아닙니다.' },
				capabilities: safeCapabilities,
			});
		} catch (error) {
			propagateUnverifiedCleanup(error);
			if (error instanceof AgentCliProcessError && error.exitCode === 1) {
				return result(input, checkedAt, profileRef, {
					installation: { state: 'available', executablePath: canonicalExecutable, version: capabilities.version, reason: null },
					authentication: { state: 'signedOut', profileRef, validForExecution: false, reason: 'CLI가 이 프로필에 로그인 기록이 없다고 응답했습니다.' },
					capabilities: safeCapabilities,
				});
			}
			return result(input, checkedAt, profileRef, {
				installation: { state: 'unavailable', executablePath: canonicalExecutable, version: capabilities.version, reason: 'CLI의 로그인 기록 점검을 완료하지 못했습니다.' },
				authentication: { state: 'unavailable', profileRef, validForExecution: false, reason: '이 프로필의 로그인 기록을 확인하지 못했습니다.' },
				capabilities: safeCapabilities,
			});
		}
	} finally {
		rmSync(probeRoot, { recursive: true, force: true });
	}
}

function assertInput(input: InspectWorkspaceAgentSetupInput): void {
	if (!input.projectId.trim() || input.projectId.length > 200 || /[\u0000-\u001f\u007f]/.test(input.projectId)) { throw new Error('The setup inspection project identifier is invalid.'); }
	if (input.provider !== 'codex' && input.provider !== 'claude') { throw new Error('The setup inspection provider is invalid.'); }
	if (!input.profileDirectory || !isAbsoluteSafePath(input.profileDirectory)) { throw new Error('The selected local profile path is invalid.'); }
	if (!input.guardianNodeExecutable || !input.guardianScriptPath) { throw new Error('Trusted CLI probe guardian paths are required.'); }
	const requestedTimeout = input.probeTimeoutMs ?? MAX_PROBE_TIMEOUT_MS;
	if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 100 || requestedTimeout > MAX_PROBE_TIMEOUT_MS) { throw new Error('The setup inspection timeout is invalid.'); }
	if (input.executable !== undefined && (!input.executable || !isAbsoluteSafePath(input.executable))) { throw new Error('The resolved provider CLI path is invalid.'); }
}

function buildProfileEnvironment(input: InspectWorkspaceAgentSetupInput, profileKey: 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR', profileDirectory?: string): NodeJS.ProcessEnv {
	const source = input.environment;
	if (profileDirectory && source[profileKey] !== input.profileDirectory) { throw new Error('The trusted provider environment does not match the selected local profile.'); }
	const env: NodeJS.ProcessEnv = { PATH: source.PATH ?? '', HOME: source.HOME ?? userInfo().homedir, LANG: source.LANG ?? 'C.UTF-8', LC_ALL: source.LC_ALL ?? 'C.UTF-8' };
	for (const key of ['TMPDIR', 'TEMP', 'SystemRoot', 'USER', 'LOGNAME']) { if (source[key] !== undefined) { env[key] = source[key]; } }
	if (source.TMPDIR !== undefined) { env.TMPDIR = source.TMPDIR; }
	if (profileDirectory) { env[profileKey] = profileDirectory; }
	return env;
}

function processOptions(input: InspectWorkspaceAgentSetupInput, env: NodeJS.ProcessEnv, cwd: string) {
	return {
		env,
		cwd,
		timeoutMs: timeout(input),
		maxOutputBytes: MAX_AUTH_OUTPUT_BYTES,
		guardianNodeExecutable: input.guardianNodeExecutable,
		guardianScriptPath: input.guardianScriptPath,
	};
}

function timeout(input: InspectWorkspaceAgentSetupInput): number { return Math.min(input.probeTimeoutMs ?? MAX_PROBE_TIMEOUT_MS, MAX_PROBE_TIMEOUT_MS); }

function isCanonicalExecutable(path: string): boolean {
	try { accessSync(path, constants.X_OK); return true; }
	catch { return false; }
}

function isMissingProfile(path: string): boolean {
	try { lstatSync(path); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}

function isAbsoluteSafePath(path: string): boolean { return path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(path) && path.startsWith('/'); }

function propagateUnverifiedCleanup(error: unknown): void {
	if (error instanceof AgentCliProcessError && !error.cleanupVerified) { throw error; }
	if (error instanceof Error && error.name === 'AgentSessionPreparationError' && 'cleanupVerified' in error && error.cleanupVerified === false) { throw error; }
}

function toSafeCapabilities(capabilities: AgentCliCapabilities): WorkspaceAgentSetupCapabilitiesDTO {
	return {
		provider: capabilities.provider,
		commandSpecVersion: capabilities.commandSpecVersion,
		version: capabilities.version,
		interactive: capabilities.interactive,
		model: capabilities.model,
		resumeById: capabilities.resumeById,
		newSessionId: capabilities.newSessionId,
		workingDirectory: capabilities.workingDirectory,
		readOnlyPolicy: capabilities.readOnlyPolicy,
		mutatingPolicy: capabilities.mutatingPolicy,
		invocationMcpConfig: capabilities.invocationMcpConfig,
		exclusiveMcpRoster: capabilities.exclusiveMcpRoster,
		profileSelector: capabilities.profileSelector,
		requiredPermissionModes: [...capabilities.requiredPermissionModes],
	};
}

function result(
	input: InspectWorkspaceAgentSetupInput,
	checkedAt: string,
	profileRef: 'local-default-codex' | 'local-default-claude',
	values: Omit<WorkspaceAgentSetupInspectionDTO, 'projectId' | 'provider' | 'checkedAt' | 'cleanupVerified'>,
): WorkspaceAgentSetupInspectionDTO {
	return {
		projectId: input.projectId,
		provider: input.provider,
		checkedAt,
		...values,
		authentication: { ...values.authentication, profileRef },
		cleanupVerified: true,
	};
}
