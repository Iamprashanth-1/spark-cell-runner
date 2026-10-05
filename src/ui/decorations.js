// Run-state tracking and editor decorations showing per-cell run results in the
// plain text editor view of a notebook-source file.

const vscode = require('vscode');
const state = require('../state');

let runDecorations;

function createRunDecorations() {
    runDecorations = {
        running: vscode.window.createTextEditorDecorationType({
            after: {
                color: new vscode.ThemeColor('charts.yellow'),
                margin: '0 0 0 1.5rem',
            },
            isWholeLine: false,
        }),

        runningBlock: vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
            isWholeLine: true,
        }),

        success: vscode.window.createTextEditorDecorationType({
            after: {
                color: new vscode.ThemeColor('terminal.ansiGreen'),
                margin: '0 0 0 1.5rem',
            },
            isWholeLine: false,
        }),

        successBlock: vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
            isWholeLine: true,
        }),

        failure: vscode.window.createTextEditorDecorationType({
            after: {
                color: new vscode.ThemeColor('errorForeground'),
                margin: '0 0 0 1.5rem',
            },
            isWholeLine: false,
        }),

        failureBlock: vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
            isWholeLine: true,
        }),
    };

    return runDecorations;
}

function getRunDecorations() {
    return runDecorations;
}

function updateRunState(document, cellIndex, line, endLine, status, message, payload) {
  const key = document.uri.toString();
  const stateMap = state.runStateByDocument.get(key) || new Map();
  const preview = payload ? buildOutputPreview(payload.result) : undefined;
  stateMap.set(cellIndex, {
    line,
    endLine,
    status,
    message,
    payload,
    preview,
  });
  state.runStateByDocument.set(key, stateMap);
  refreshAllRunDecorations();
  state.codeLensChangeEmitter.fire();
}

function clearRunStateForDocument(document) {
  state.runStateByDocument.delete(document.uri.toString());
}

function refreshAllRunDecorations() {
  if (!runDecorations) {
    return;
  }

  for (const editor of vscode.window.visibleTextEditors) {
    refreshEditorRunDecorations(editor);
  }
}

function refreshEditorRunDecorations(editor) {
  const empty = [];
  editor.setDecorations(runDecorations.running, empty);
  editor.setDecorations(runDecorations.success, empty);
  editor.setDecorations(runDecorations.failure, empty);
  editor.setDecorations(runDecorations.runningBlock, empty);
  editor.setDecorations(runDecorations.successBlock, empty);
  editor.setDecorations(runDecorations.failureBlock, empty);

  const stateMap = state.runStateByDocument.get(editor.document.uri.toString());
  if (!stateMap || stateMap.size === 0) {
    return;
  }

  const statusDecorations = {
    running: [],
    success: [],
    failure: [],
  };
  const blockDecorations = {
    running: [],
    success: [],
    failure: [],
  };

  for (const runState of stateMap.values()) {
    const line = Math.min(runState.line, Math.max(editor.document.lineCount - 1, 0));
    statusDecorations[runState.status].push({
      range: new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER),
      renderOptions: {
        after: {
          contentText: `Databricks: ${runState.message}`,
        },
      },
    });

    const blockStart = Math.min(runState.line, Math.max(editor.document.lineCount - 1, 0));
    const blockEnd = Math.min(runState.endLine, Math.max(editor.document.lineCount - 1, 0));
    blockDecorations[runState.status].push(new vscode.Range(blockStart, 0, blockEnd, 0));
  }

  editor.setDecorations(runDecorations.running, statusDecorations.running);
  editor.setDecorations(runDecorations.success, statusDecorations.success);
  editor.setDecorations(runDecorations.failure, statusDecorations.failure);
  editor.setDecorations(runDecorations.runningBlock, blockDecorations.running);
  editor.setDecorations(runDecorations.successBlock, blockDecorations.success);
  editor.setDecorations(runDecorations.failureBlock, blockDecorations.failure);
}

function getCellRunState(uri, cellIndex) {
  const stateMap = state.runStateByDocument.get(uri.toString());
  return stateMap ? stateMap.get(cellIndex) : undefined;
}

function buildOutputPreview(result) {
  const source = [result.stdout, result.stderr].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!source) {
    return 'No output';
  }
  return source.length > 72 ? `${source.slice(0, 69)}...` : source;
}

module.exports = {
  createRunDecorations,
  getRunDecorations,
  updateRunState,
  clearRunStateForDocument,
  refreshAllRunDecorations,
  getCellRunState,
  buildOutputPreview,
};
