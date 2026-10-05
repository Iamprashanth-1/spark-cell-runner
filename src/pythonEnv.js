// Python interpreter discovery, resolution, validation (Databricks Connect
// availability), and child-process environment setup.

const { existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const vscode = require('vscode');
const state = require('./state');
const { getConfiguration, updateWorkspaceSetting, getDocumentExecutionKey, stableStringify } = require('./config');

const DATABRICKS_AUTH_VALIDATION_SCRIPT = [
    'from databricks.connect import DatabricksSession',
    'from databricks.sdk import WorkspaceClient',
    'WorkspaceClient().current_user.me()',
    'print("DATABRICKS_AUTH_OK")',
].join('; ');

function clearResolvedPythonCommandCache() {
    state.resolvedPythonCommandCache.clear();
}

function clearResolvedPythonCommandForDocument(document) {
    state.resolvedPythonCommandCache.delete(getDocumentExecutionKey(document));
}

async function resolvePythonCommand(document) {
    const cacheKey = getDocumentExecutionKey(document);
    const cached = state.resolvedPythonCommandCache.get(cacheKey);

    if (cached) {
        return cached;
    }

    const configured = getConfiguration().pythonCommand.trim();

    if (configured && configured !== 'python') {
        state.resolvedPythonCommandCache.set(cacheKey, configured);
        return configured;
    }

    const detected = await detectPythonInterpreter(document);
    const resolved = detected || configured || 'python';

    state.resolvedPythonCommandCache.set(cacheKey, resolved);

    return resolved;
}

async function detectPythonInterpreter(document) {
    const pythonConfiguration = vscode.workspace.getConfiguration(
        'python',
        document ? document.uri : undefined
    );

    const configCandidates = [
        pythonConfiguration.get('defaultInterpreterPath'),
        pythonConfiguration.get('pythonPath'),
    ];

    for (const candidate of configCandidates) {
        const normalized = normalizeInterpreterPath(candidate);

        if (normalized) {
            return normalized;
        }
    }

    const commandIds = [
        'python.interpreterPath',
        'python.environments.getActiveEnvironmentPath',
        'python.environments.getActiveInterpreterPath',
    ];

    for (const commandId of commandIds) {
        try {
            const value = await vscode.commands.executeCommand(commandId);
            const normalized = normalizeInterpreterPath(value);

            if (normalized) {
                return normalized;
            }
        } catch {
            // Ignore missing Python extension commands.
        }
    }
    return undefined;
}

function normalizeInterpreterPath(value) {
    if (!value) {
        return undefined;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim().replace(/^[\"'`]+|[\"'`]+$/g, '');
        if (!trimmed || trimmed.startsWith('${command:')) {
            return undefined;
        }

        return resolveInterpreterCandidatePath(trimmed);
    }

    if (typeof value === 'object') {
        if (typeof value.path === 'string') {
            return normalizeInterpreterPath(value.path);
        }

        if (value.path && typeof value.path.fsPath === 'string') {
            return normalizeInterpreterPath(value.path.fsPath);
        }

        if (Array.isArray(value.path)) {
            return normalizeInterpreterPath(value.path.join(path.sep));
        }
    }

    return undefined;
}

function resolveInterpreterCandidatePath(candidate) {
    if (!candidate) {
        return undefined;
    }

    const normalized = candidate.includes(path.sep) || candidate.includes('/')
        ? path.normalize(candidate)
        : candidate;

    if (!normalized.includes(path.sep)) {
        return normalized;
    }

    if (existsSync(normalized)) {
        try {
            const stat = require('node:fs').statSync(normalized);

            if (stat.isFile()) {
                return normalized;
            }

            if (stat.isDirectory()) {
                const folderCandidates = [
                    path.join(normalized, 'Scripts', 'python.exe'),
                    path.join(normalized, 'bin', 'python'),
                    path.join(normalized, 'python.exe'),
                    path.join(normalized, 'python'),
                ];

                for (const folderCandidate of folderCandidates) {
                    if (existsSync(folderCandidate)) {
                        return folderCandidate;
                    }
                }
            }
        } catch {
            return normalized;
        }
    }

    return normalized;
}

async function updatePythonCommandSetting(document, interpreter) {
    await updateWorkspaceSetting('pythonCommand', interpreter, document);
    clearResolvedPythonCommandCache();
}

async function selectPythonEnvironment(document) {
    const candidates = await discoverPythonCandidates(document);

    if (candidates.length === 0) {
        void vscode.window.showWarningMessage(
            'No Python interpreter candidates were found.'
        );
        return undefined;
    }

    const cwd = document
        ? path.dirname(document.uri.fsPath)
        : getPrimaryWorkspacePath();

    const items = [];

    for (const candidate of candidates) {
        const validation = await validateDatabricksConnect(candidate, cwd);

        items.push({
            label: validation.ok
                ? '$(check) ' + candidate
                : '$(warning) ' + candidate,
            description: validation.ok
                ? 'Databricks Connect available'
                : 'Databricks Connect missing',
            detail: validation.ok ? 'Recommended' : validation.error,
            interpreter: candidate,
            ok: validation.ok,
        });
    }

    items.sort((left, right) => Number(right.ok) - Number(left.ok));

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Select Databricks Python Environment',
        placeHolder: 'Choose the interpreter used to run Databricks notebook cells',
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (!picked) {
        return undefined;
    }

    await updatePythonCommandSetting(document, picked.interpreter);

    void vscode.window.showInformationMessage(
        `Spark Cell Runner will use: ${picked.interpreter}`
    );

    return picked.interpreter;
}

async function promptForPythonEnvironmentPath(document) {
    const currentValue = getConfiguration().pythonCommand;

    const input = await vscode.window.showInputBox({
        title: 'Set Databricks Python Path',
        prompt: 'Paste a python.exe path or a virtual environment folder path',
        value:
            currentValue && currentValue !== 'python'
                ? currentValue
                : '',
        ignoreFocusOut: true,
        validateInput: (value) => validatePythonEnvironmentInput(value),
    });

    if (!input) {
        return undefined;
    }

    const normalized = normalizeInterpreterPath(input);

    if (!normalized) {
        void vscode.window.showErrorMessage(
            'The pasted Python path could not be resolved.'
        );
        return undefined;
    }

    await updatePythonCommandSetting(document, normalized);

    const cwd = document
        ? path.dirname(document.uri.fsPath)
        : getPrimaryWorkspacePath();

    const validation = await validateDatabricksConnect(normalized, cwd);

    if (validation.ok) {
        void vscode.window.showInformationMessage(`Spark Cell Runner will use: ${normalized}`);
    } else {
        void vscode.window.showWarningMessage(
            `Path saved, but Databricks Connect is missing: ${validation.error}`
        );
    }

    return normalized;
}

async function discoverPythonCandidates(document) {
    const candidates = new Set();

    const configured = getConfiguration().pythonCommand.trim();
    if (configured) {
        addInterpreterCandidate(candidates, configured);
    }

    const detected = await detectPythonInterpreter(document);
    if (detected) {
        addInterpreterCandidate(candidates, detected);
    }

    const pythonConfiguration = vscode.workspace.getConfiguration(
        'python',
        document ? document.uri : undefined
    );

    addInterpreterCandidate(
        candidates,
        normalizeInterpreterPath(
            pythonConfiguration.get('defaultInterpreterPath')
        )
    );

    addInterpreterCandidate(
        candidates,
        normalizeInterpreterPath(
            pythonConfiguration.get('pythonPath')
        )
    );

    for (const root of getWorkspaceSearchRoots(document)) {
        addInterpreterCandidate(
            candidates,
            path.join(root, '.venv', 'Scripts', 'python.exe')
        );
        addInterpreterCandidate(
            candidates,
            path.join(root, 'venv', 'Scripts', 'python.exe')
        );
        addInterpreterCandidate(
            candidates,
            path.join(root, 'env', 'Scripts', 'python.exe')
        );
        addInterpreterCandidate(
            candidates,
            path.join(root, '.env', 'Scripts', 'python.exe')
        );
    }

    return Array.from(candidates);
}

function addInterpreterCandidate(candidates, candidate) {
    const normalized = normalizeInterpreterPath(candidate);

    if (!normalized) {
        return;
    }

    const fullPath = normalized.includes(path.sep)
        ? path.normalize(normalized)
        : normalized;

    if (fullPath.includes(path.sep) && !existsSync(fullPath)) {
        return;
    }

    candidates.add(fullPath);
}

function validatePythonEnvironmentInput(value) {
    const normalized = normalizeInterpreterPath(value);

    if (!normalized) {
        return 'Enter a python.exe path or a virtual environment folder path.';
    }

    if (normalized.includes(path.sep) && !existsSync(normalized)) {
        return 'That path does not exist.';
    }

    return undefined;
}

function getWorkspaceSearchRoots(document) {
    const roots = new Set();
    const workspaceFolders = vscode.workspace.workspaceFolders || [];

    for (const folder of workspaceFolders) {
        roots.add(folder.uri.fsPath);
    }

    if (document) {
        let current = path.dirname(document.uri.fsPath);
        roots.add(current);

        while (true) {
            const parent = path.dirname(current);

            if (parent === current) {
                break;
            }

            roots.add(parent);
            current = parent;
        }
    }

    return Array.from(roots);
}

function getPrimaryWorkspacePath() {
    const workspaceFolders = vscode.workspace.workspaceFolders || [];

    return workspaceFolders.length > 0
        ? workspaceFolders[0].uri.fsPath
        : process.cwd();
}

function splitCommandArguments(commandText) {
    const matches = commandText.match(/(?:[^\s"]+|"[^"]*")+/g);

    if (!matches) {
        return [];
    }

    return matches.map((part) => part.replace(/^"|"$/g, ''));
}

function resolveCommandParts(commandText) {
    const trimmed = commandText.trim();

    if (!trimmed) {
        return [];
    }

    if (existsSync(trimmed)) {
        return [trimmed];
    }

    const splitParts = splitCommandArguments(trimmed);

    if (splitParts.length <= 1) {
        return splitParts;
    }

    if (trimmed.startsWith('"')) {
        for (let index = splitParts.length - 1; index > 0; index -= 1) {
            const executableCandidate = splitParts.slice(0, index + 1).join(' ');

            if (existsSync(executableCandidate)) {
                return [
                    executableCandidate,
                    ...splitParts.slice(index + 1),
                ];
            }
        }
    }

    return splitParts;
}

async function runPythonScript(pythonCommand, scriptPath, cwd) {
    const commandParts = resolveCommandParts(pythonCommand);

    if (commandParts.length === 0) {
        throw new Error('sparkCellRunner.pythonCommand is empty.');
    }

    const childEnv = createDatabricksChildEnv();

    return new Promise((resolve, reject) => {
        const child = spawn(commandParts[0], [...commandParts.slice(1), scriptPath], {
            cwd,
            shell: false,
            env: childEnv,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (error) => {
            reject(error);
        });

        child.on('close', (exitCode) => {
            resolve({
                exitCode: exitCode ?? -1,
                stdout,
                stderr,
            });
        });
    });
}

async function validateDatabricksConnect(pythonCommand, cwd) {
    const commandParts = resolveCommandParts(pythonCommand);

    if (commandParts.length === 0) {
        return { ok: false, error: 'Empty python command' };
    }

    const childEnv = createDatabricksChildEnv();

    return new Promise((resolve) => {
        const child = spawn(
            commandParts[0],
            [...commandParts.slice(1), '-c', DATABRICKS_AUTH_VALIDATION_SCRIPT],
            {
                cwd,
                shell: false,
                env: childEnv,
            }
        );

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (error) => {
            resolve({ ok: false, error: error.message });
        });

        child.on('close', (exitCode) => {
            if (exitCode === 0 && stdout.includes('DATABRICKS_AUTH_OK')) {
                resolve({ ok: true });
                return;
            }

            const error =
                [stderr.trim(), stdout.trim()]
                    .filter(Boolean)
                    .join('\n') || 'Databricks authentication validation failed';

            resolve({ ok: false, error });
        });
    });
}

async function getCachedConnectValidation(pythonCommand, cwd, configuration) {
    if (!configuration.injectDatabricksBootstrap) {
        return { ok: true };
    }

    const validationKey = stableStringify({
        pythonCommand,
        databricksProfile: configuration.databricksProfile,
        clusterId: configuration.clusterId,
        useServerless: configuration.useServerless,
    });

    let connectValidation = state.connectValidationCache.get(validationKey);

    if (!connectValidation) {
        connectValidation = await validateDatabricksConnect(pythonCommand, cwd);

        if (connectValidation.ok) {
            state.connectValidationCache.set(validationKey, connectValidation);
        }
    }

    return connectValidation;
}

function createDatabricksChildEnv() {
    const configuration = getConfiguration();
    const childEnv = { ...process.env };
    const profile = configuration.databricksProfile.trim();

    if (profile) {
        childEnv.DATABRICKS_CONFIG_PROFILE = profile;
        childEnv.DATABRICKS_AUTH_TYPE =
            childEnv.DATABRICKS_AUTH_TYPE || 'databricks-cli';

        const cliPath = resolveDatabricksCliPath();

        if (cliPath) {
            childEnv.DATABRICKS_CLI_PATH = cliPath;
        }
    }

    return childEnv;
}

function resolveDatabricksCliPath() {
    if (process.env.DATABRICKS_CLI_PATH && existsSync(process.env.DATABRICKS_CLI_PATH)) {
        return process.env.DATABRICKS_CLI_PATH;
    }

    const homeDirectory = os.homedir();
    const extensionRoot = path.join(homeDirectory, '.vscode', 'extensions');

    if (!existsSync(extensionRoot)) {
        return undefined;
    }

    const candidates = [
        path.join(
            extensionRoot,
            'databricks.databricks-2.12.0-win32-x64',
            'bin',
            'databricks.exe'
        ),
        path.join(
            extensionRoot,
            'databricks.databricks-2.10.6-win32-x64',
            'bin',
            'databricks.exe'
        ),
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

module.exports = {
    clearResolvedPythonCommandCache,
    clearResolvedPythonCommandForDocument,
    resolvePythonCommand,
    detectPythonInterpreter,
    discoverPythonCandidates,
    normalizeInterpreterPath,
    resolveInterpreterCandidatePath,
    updatePythonCommandSetting,
    selectPythonEnvironment,
    promptForPythonEnvironmentPath,
    runPythonScript,
    validateDatabricksConnect,
    getCachedConnectValidation,
    createDatabricksChildEnv,
    resolveCommandParts,
};
