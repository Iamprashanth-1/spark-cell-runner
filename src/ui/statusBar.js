// Status bar item showing the active interpreter / profile / compute target while
// a Databricks notebook-source file is open.

const vscode = require('vscode');
const path = require('node:path');
const { getConfiguration } = require('../config');
const { resolveInterpreterCandidatePath } = require('../pythonEnv');

let statusBarItem;

function initStatusBar(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBarItem.name = 'Spark Cell Runner';
  statusBarItem.command = 'sparkCellRunner.openAsNotebook';
  context.subscriptions.push(statusBarItem);
  return statusBarItem;
}

function updateStatusBar(uri) {
    if (!statusBarItem) {
        return;
    }

    const activeUri = uri || getActiveDatabricksUri();

    if (!activeUri || !isDatabricksPythonNotebookUri(activeUri)) {
        statusBarItem.hide();
        return;
    }

    const configuration = getConfiguration();

    const pythonLabel = path.basename(
        resolveInterpreterCandidatePath(configuration.pythonCommand || 'python') ||
        configuration.pythonCommand ||
        'python'
    );

    const computeLabel = configuration.useServerless
        ? 'serverless'
        : (configuration.clusterId
            ? `cluster:${truncateMiddle(configuration.clusterId, 14)}`
            : 'cluster:unset');

    const profileLabel = configuration.databricksProfile || 'profile:default';

    statusBarItem.text =
        `$(database) SCR ${pythonLabel} | ${profileLabel} | ${computeLabel}`;

    statusBarItem.tooltip = [
        `Interpreter: ${configuration.pythonCommand || 'python'}`,
        `Profile: ${configuration.databricksProfile || '(default)'}`,
        `Compute: ${configuration.useServerless ? 'Serverless' : (configuration.clusterId || '(unset)')}`,
    ].join('\n');

    statusBarItem.show();
}

function getActiveDatabricksUri() {
    if (vscode.window.activeNotebookEditor) {
        return vscode.window.activeNotebookEditor.notebook.uri;
    }

    if (vscode.window.activeTextEditor) {
        return vscode.window.activeTextEditor.document.uri;
    }

    return undefined;
}

function isDatabricksPythonNotebookUri(uri) {
  return Boolean(uri && uri.scheme === 'file' && path.extname(uri.fsPath).toLowerCase() === '.py');
}

function truncateMiddle(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }
  const side = Math.max(3, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, side)}...${value.slice(-side)}`;
}

module.exports = {
  initStatusBar,
  updateStatusBar,
  getActiveDatabricksUri,
  isDatabricksPythonNotebookUri,
};
