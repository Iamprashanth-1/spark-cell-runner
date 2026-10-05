// Notebook navigation: Go to Definition / Find References inside Databricks
// notebook cells, remapping Pylance's virtual "<file>.py.py" locations back to
// notebook cells, plus the .py editor-association behavior.

const vscode = require('vscode');
const path = require('node:path');
const { NOTEBOOK_TYPE } = require('./constants');
const { serializeNotebookCellForSource } = require('./parser');
const { getConfiguration } = require('./config');
const state = require('./state');

let notebookNavigationRemapInProgress = false;
let concatRedirectInProgress = false;
let pendingCellDefinition;

// Go to Definition / Find References inside a Databricks notebook cell can resolve to
// the backing .py file (scheme "file"). Because that file is owned by the notebook
// editor, VS Code cannot open a plain text editor for it and fails with
// "The editor could not be opened because the file was not found." This provider
// re-runs the underlying providers and remaps any result that lands on the backing
// file back to the matching notebook cell, so navigation reveals the cell instead.
class DatabricksNotebookNavigationProvider {
  provideDefinition(document, position) {
    // Resolve notebook-local definitions directly from the cells by symbol name. This
    // avoids relying on Pylance's virtual "<file>.py.py" concatenated document (which
    // VS Code cannot open) and its unknown line layout.
    const notebook = findDatabricksNotebookForCellUri(document.uri);
    if (notebook) {
      const wordRange = document.getWordRangeAtPosition(position);
      const name = wordRange ? document.getText(wordRange) : '';
      if (/^[A-Za-z_]\w*$/.test(name)) {
        const cellDefinitions = findSymbolDefinitionInCells(notebook, name);
        if (cellDefinitions.length > 0) {
          // Remember the resolved cell so that, if VS Code still navigates to Pylance's
          // virtual "<file>.py.py" document, the Tabs listener can redirect to this cell.
          pendingCellDefinition = {
            uri: cellDefinitions[0].uri,
            position: cellDefinitions[0].range.start,
            at: Date.now(),
          };
          return cellDefinitions;
        }
      }
    }
    return remapNotebookNavigation('vscode.executeDefinitionProvider', document, position);
  }

  provideReferences(document, position) {
    // Resolve references directly from the notebook cells by symbol name so we never
    // emit Pylance's virtual "<file>.py.py" locations ourselves.
    const notebook = findDatabricksNotebookForCellUri(document.uri);
    if (notebook) {
      const wordRange = document.getWordRangeAtPosition(position);
      const name = wordRange ? document.getText(wordRange) : '';
      if (/^[A-Za-z_]\w*$/.test(name)) {
        const cellReferences = findSymbolReferencesInCells(notebook, name);
        if (cellReferences.length > 0) {
          return cellReferences;
        }
      }
    }
    return remapNotebookNavigation('vscode.executeReferenceProvider', document, position);
  }
}

async function remapNotebookNavigation(command, document, position) {
  if (notebookNavigationRemapInProgress) {
    return undefined;
  }
  const notebook = findDatabricksNotebookForCellUri(document.uri);
  if (!notebook) {
    if (state.output) {
      state.output.appendLine(`[nav] no Databricks notebook found for cell scheme=${document.uri.scheme} fsPath=${document.uri.fsPath}`);
    }
    return undefined;
  }

  notebookNavigationRemapInProgress = true;
  let raw;
  try {
    raw = await vscode.commands.executeCommand(command, document.uri, position);
  } finally {
    notebookNavigationRemapInProgress = false;
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    if (state.output) {
      state.output.appendLine(`[nav] ${command}: language server returned no results.`);
    }
    return undefined;
  }

  const cellOnDiskMap = buildCellOnDiskMap(notebook);
  const cellConcatMap = buildCellConcatMap(notebook);
  const backingPath = notebook.uri.fsPath;
  const concatPath = `${backingPath}.py`; // Pylance's virtual concatenated notebook document
  if (state.output) {
    state.output.appendLine(`[nav] ${command} backing=${backingPath}`);
    for (const item of raw) {
      const u = item.targetUri || item.uri;
      const r = item.targetSelectionRange || item.targetRange || item.range;
      state.output.appendLine(`[nav]   raw target scheme=${u && u.scheme} fsPath=${u && u.fsPath} line=${r && r.start.line}`);
    }
  }
  const results = [];
  let remappedAny = false;

  for (const item of raw) {
    const targetUri = item.targetUri || item.uri;
    const targetRange = item.targetSelectionRange || item.targetRange || item.range;
    if (!targetUri || !targetRange) {
      continue;
    }

    let remapped;
    if (samePath(targetUri.fsPath, concatPath) || samePath(targetUri.path, concatPath)) {
      remapped = remapConcatRangeToCell(cellConcatMap, targetRange);
    } else if (samePath(targetUri.fsPath, backingPath) || samePath(targetUri.path, backingPath)) {
      remapped = remapOnDiskRangeToCell(cellOnDiskMap, targetRange);
    }

    if (remapped) {
      results.push(remapped);
      remappedAny = true;
      if (state.output) {
        state.output.appendLine(`[nav]   -> remapped to cell line ${remapped.range.start.line}`);
      }
    } else {
      results.push(new vscode.Location(targetUri, targetRange));
    }
  }

  // Only contribute results when we actually fixed a broken backing-file location;
  // otherwise let the language server's own (already working) results stand.
  return remappedAny ? results : undefined;
}

// Case-insensitive, separator-normalized path comparison (Windows drive-letter case
// and forward/back slashes can otherwise cause an exact === match to fail).
function samePath(a, b) {
  if (!a || !b) {
    return false;
  }
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Find where a symbol is defined within the notebook's own cells. Prefers function/
// class definitions, then falls back to top-level assignments/annotations. Returns
// notebook-cell Locations so navigation reveals the defining cell.
function findSymbolDefinitionInCells(notebook, name) {
  const escaped = escapeRegExp(name);
  const declarationRegex = new RegExp(`^(\\s*)(?:async\\s+def|def|class)\\s+${escaped}\\b`);
  const assignmentRegex = new RegExp(`^(\\s*)${escaped}\\s*(?::[^=]+)?=`);

  const declarations = [];
  const assignments = [];

  for (const cell of notebook.getCells()) {
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      continue;
    }
    const lines = cell.document.getText().split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const target = declarationRegex.test(line)
        ? declarations
        : assignmentRegex.test(line)
          ? assignments
          : undefined;
      if (target) {
        const column = Math.max(0, line.indexOf(name));
        target.push(new vscode.Location(cell.document.uri, new vscode.Position(index, column)));
      }
    }
  }

  return declarations.length > 0 ? declarations : assignments;
}

// Find every whole-word occurrence of a symbol across the notebook's code cells and
// return them as notebook-cell Locations (never the backing "<file>.py.py" document).
function findSymbolReferencesInCells(notebook, name) {
  const wordRegex = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
  const locations = [];
  for (const cell of notebook.getCells()) {
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      continue;
    }
    const lines = cell.document.getText().split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      wordRegex.lastIndex = 0;
      let match;
      while ((match = wordRegex.exec(lines[index])) !== null) {
        const start = new vscode.Position(index, match.index);
        const end = new vscode.Position(index, match.index + name.length);
        locations.push(new vscode.Location(cell.document.uri, new vscode.Range(start, end)));
      }
    }
  }
  return locations;
}

// If a Go to Definition lands on Pylance's virtual "<file>.py.py" concatenated
// document, read the line it landed on, find that exact line in the notebook's
// cells, reveal the cell, and close the .py.py editor. This works no matter which
// provider VS Code picked or how it ordered results.
async function redirectConcatEditorToCell(editor) {
  if (concatRedirectInProgress || !editor) {
    return;
  }
  const uri = editor.document.uri;
  if (!/\.py\.py$/i.test(uri.path)) {
    return;
  }

  const notebookPath = uri.fsPath.replace(/\.py$/i, ''); // "../temp.py.py" -> "../temp.py"
  const notebook = vscode.workspace.notebookDocuments.find(
    (candidate) => candidate.notebookType === NOTEBOOK_TYPE && samePath(candidate.uri.fsPath, notebookPath),
  );
  if (!notebook) {
    return;
  }

  const activeLine = editor.selection ? editor.selection.active.line : 0;
  let lineText = '';
  try {
    lineText = editor.document.lineAt(activeLine).text;
  } catch (error) {
    lineText = '';
  }

  const target = findCellPositionByLineText(notebook, lineText);
  if (!target) {
    return;
  }

  concatRedirectInProgress = true;
  try {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input && input.uri && /\.py\.py$/i.test(input.uri.path) && samePath(input.uri.fsPath, uri.fsPath)) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
    await vscode.window.showTextDocument(target.cell.document, {
      selection: new vscode.Range(target.position, target.position),
      preview: false,
    });
  } catch (error) {
    if (state.output) {
      state.output.appendLine(`[nav] redirect failed: ${error && error.message}`);
    }
  } finally {
    concatRedirectInProgress = false;
  }
}

// Bulletproof catch-all using the Tabs API: whenever a "<file>.py.py" tab opens
// (as a text editor OR through any other editor), close it immediately and jump to
// the cell definition most recently resolved by our definition provider.
async function closeConcatTabAndReveal(tab) {
  const input = tab && tab.input;
  const uri = input && input.uri;
  if (!uri || !/\.py\.py$/i.test(uri.path)) {
    return;
  }

  // Only hijack the concat tab when the underlying file is actually open as OUR
  // notebook. If the .py is open as plain text, let Pylance's navigation work
  // normally instead of closing the tab and stranding the user.
  const notebookPath = uri.fsPath.replace(/\.py$/i, '');
  const notebookOpen = vscode.workspace.notebookDocuments.some(
    (candidate) => candidate.notebookType === NOTEBOOK_TYPE && samePath(candidate.uri.fsPath, notebookPath),
  );
  if (!notebookOpen) {
    return;
  }

  if (concatRedirectInProgress) {
    return;
  }
  concatRedirectInProgress = true;
  try {
    try {
      await vscode.window.tabGroups.close(tab);
    } catch (error) {
      // ignore close failures
    }

    if (pendingCellDefinition && Date.now() - pendingCellDefinition.at < 8000) {
      const position = pendingCellDefinition.position;
      try {
        await vscode.window.showTextDocument(pendingCellDefinition.uri, {
          selection: new vscode.Range(position, position),
          preview: false,
        });
      } catch (error) {
        if (state.output) {
          state.output.appendLine(`[nav] reveal after tab close failed: ${error && error.message}`);
        }
      }
    }
  } finally {
    concatRedirectInProgress = false;
  }
}

function findCellPositionByLineText(notebook, lineText) {
  const needle = (lineText || '').trim();
  if (!needle) {
    return undefined;
  }
  for (const cell of notebook.getCells()) {
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      continue;
    }
    const lines = cell.document.getText().split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim() === needle) {
        const column = Math.max(0, lines[index].length - lines[index].trimStart().length);
        return { cell, position: new vscode.Position(index, column) };
      }
    }
  }
  return undefined;
}

function findDatabricksNotebookForCellUri(uri) {
    if (uri.scheme !== 'vscode-notebook-cell') {
        return undefined;
    }

    return vscode.workspace.notebookDocuments.find(
        (notebook) => notebook.notebookType === NOTEBOOK_TYPE &&
            samePath(notebook.uri.fsPath, uri.fsPath),
    );
}

// Reconstruct where each cell lives in the on-disk .py serialization so an on-disk
// line number can be mapped back to (cell, lineWithinCell).
function buildCellOnDiskMap(notebook) {
    const entries = [];
    let line = 2; // "# Databricks notebook source" header + following blank line
    const cells = notebook.getCells();

    cells.forEach((cell, index) => {
        const cellText = cell.document.getText();
        const serialized = serializeNotebookCellForSource({
            value: cellText,
            kind: cell.kind
        });

        entries.push({
            cell,
            startLine: line,
            serialized,
            cellLines: cellText.split(/\r?\n/),
        });

        line += serialized.length;

        if (index < cells.length - 1) {
            line += 3; // blank line + "# COMMAND ----------" + blank line
        }
    });

    return entries;
}

function remapOnDiskRangeToCell(cellMap, range) {
    const targetLine = range.start.line;

    for (const entry of cellMap) {
        const offset = targetLine - entry.startLine;

        if (offset < 0 || offset >= entry.serialized.length) {
            continue;
        }

        const cellLine = Math.min(offset, entry.cellLines.length - 1);
        const serializedText = entry.serialized[offset] || '';
        const cellText = entry.cellLines[cellLine] || '';

        const prefixLength = Math.max(
            0,
            serializedText.length - cellText.length
        );

        const character = Math.max(
            0,
            range.start.character - prefixLength
        );

        return new vscode.Location(
            entry.cell.document.uri,
            new vscode.Position(cellLine, character),
        );
    }

    return undefined;
}

// Pylance analyzes notebooks through a virtual document that concatenates the cells
// (backing path + ".py"). That document places 2 leading lines before the first cell
// and separates consecutive cells by 2 lines, matching VS Code's canonical notebook
// text layout. Map a line in that document back to the owning cell.
function buildCellConcatMap(notebook) {
    const entries = [];
    let line = 2; // leading header lines in the concatenated document

    for (const cell of notebook.getCells()) {
        const cellLines = cell.document.getText().split(/\r?\n/);

        entries.push({
            cell,
            startLine: line,
            lineCount: cellLines.length
        });

        line += cellLines.length + 2; // cell body + 2 separator lines before the next cell
    }

    return entries;
}

function remapConcatRangeToCell(cellMap, range) {
    const targetLine = range.start.line;

    for (const entry of cellMap) {
        const offset = targetLine - entry.startLine;

        if (offset < 0 || offset >= entry.lineCount) {
            continue;
        }

        return new vscode.Location(
            entry.cell.document.uri,
            new vscode.Position(offset, range.start.character),
        );
    }

    return undefined;
}

// Control which editor .py files open with via workbench.editorAssociations so VS
// Code opens them correctly BY DEFAULT. This avoids reopen/flash hacks and, crucially,
// stops Go to Definition from bouncing through a notebook view when the toggle is off.
async function syncPyEditorAssociation() {
    const desired = getConfiguration().openPyFilesAsNotebook ? NOTEBOOK_TYPE : 'default';
    const workbench = vscode.workspace.getConfiguration('workbench');
    const current = workbench.get('editorAssociations') || {};

    if (current['*.py'] === desired) {
        return;
    }

    const next = { ...current, '*.py': desired };

    try {
        await workbench.update('editorAssociations', next, vscode.ConfigurationTarget.Workspace);
    } catch (error) {
        if (state.output) {
            state.output.appendLine(`[nav] editorAssociation update failed: ${error && error.message}`);
        }
    }
}

// Reopen the active .py so a toggle change takes effect immediately for the open file.
async function reopenActivePyForCurrentMode() {
    const enabled = getConfiguration().openPyFilesAsNotebook;

    if (!enabled) {
        const notebookEditor = vscode.window.activeNotebookEditor;

        if (
            notebookEditor
            && notebookEditor.notebook.notebookType === NOTEBOOK_TYPE
            && notebookEditor.notebook.uri.scheme === 'file'
            && path.extname(notebookEditor.notebook.uri.fsPath).toLowerCase() === '.py'
        ) {
            await vscode.commands.executeCommand(
                'vscode.openWith',
                notebookEditor.notebook.uri,
                'default'
            );
        }

        return;
    }

    const textEditor = vscode.window.activeTextEditor;

    if (
        textEditor
        && textEditor.document.uri.scheme === 'file'
        && path.extname(textEditor.document.uri.fsPath).toLowerCase() === '.py'
        && !/\.py\.py$/i.test(textEditor.document.uri.fsPath)
    ) {
        await vscode.commands.executeCommand(
            'vscode.openWith',
            textEditor.document.uri,
            NOTEBOOK_TYPE
        );
    }
}

module.exports = {
  DatabricksNotebookNavigationProvider,
  redirectConcatEditorToCell,
  closeConcatTabAndReveal,
  syncPyEditorAssociation,
  reopenActivePyForCurrentMode,
};
