const path = require('node:path');
const vscode = require('vscode');
const state = require('./state');

function getConfiguration() {
    const configuration = vscode.workspace.getConfiguration('sparkCellRunner');

    return {
        pythonCommand: configuration.get('pythonCommand', 'python'),
        tempFolder: configuration.get('tempFolder', '.spark-cell-runner'),
        injectDatabricksBootstrap: configuration.get('injectDatabricksBootstrap', true),
        databricksProfile: configuration.get('databricksProfile', ''),
        clusterId: configuration.get('clusterId', ''),
        useServerless: configuration.get('useServerless', false),
        workspacePathMappings: configuration.get('workspacePathMappings', {}),
        secretValues: configuration.get('secretValues', {}),
        widgetValues: configuration.get('widgetValues', {}),
        openPyFilesAsNotebook: configuration.get('openPyFilesAsNotebook', false),
    };
}

async function updateWorkspaceSetting(key, value, document) {
    const configuration = vscode.workspace.getConfiguration(
        'sparkCellRunner',
        document ? document.uri : undefined
    );

    const preferredTarget =
        document && vscode.workspace.getWorkspaceFolder(document.uri)
            ? vscode.ConfigurationTarget.WorkspaceFolder
            : vscode.ConfigurationTarget.Workspace;

    try {
        await configuration.update(key, value, preferredTarget);
    } catch {
        await configuration.update(
            key,
            value,
            vscode.ConfigurationTarget.Workspace
        );
    }
}

function getDocumentExecutionKey(document) {
    const uri = document && document.uri ? document.uri : document;

    if (!uri) {
        return 'global';
    }

    if (uri.scheme === 'file' && uri.fsPath) {
        return path.normalize(uri.fsPath).toLowerCase();
    }

    return uri.toString();
}

function clearConnectValidationCache() {
    state.connectValidationCache.clear();
}

function stableStringify(value) {
    return JSON.stringify(sortObjectDeep(value));
}

function sortObjectDeep(value) {
    if (Array.isArray(value)) {
        return value.map(sortObjectDeep);
    }

    if (value && typeof value === 'object') {
        const sorted = {};

        for (const key of Object.keys(value).sort()) {
            sorted[key] = sortObjectDeep(value[key]);
        }

        return sorted;
    }

    return value;
}

module.exports = {
    getConfiguration,
    updateWorkspaceSetting,
    getDocumentExecutionKey,
    clearConnectValidationCache,
    stableStringify,
    sortObjectDeep,
};
