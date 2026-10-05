// CodeLens provider for notebook-source .py files shown in the plain text editor.

const vscode = require('vscode');
const state = require('./state');
const { parseNotebookText } = require('./parser');
const { getCellRunState } = require('./ui/decorations');

class DatabricksNotebookCodeLensProvider {
  get onDidChangeCodeLenses() {
    return state.codeLensChangeEmitter.event;
  }

  provideCodeLenses(document) {
    const parsed = parseNotebookText(document.uri.fsPath, document.getText());
    if (!parsed.isNotebookSource) {
      return [];
    }

    const lenses = [];
    lenses.push(
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: 'Run All Databricks Cells',
        command: 'sparkCellRunner.runAllCells',
      }),
    );
    for (const cell of parsed.cells) {
      const range = new vscode.Range(cell.startLine, 0, cell.startLine, 0);
      const runState = getCellRunState(document.uri, cell.index);
      lenses.push(
        new vscode.CodeLens(range, {
          title: 'Run Databricks Cell',
          command: 'sparkCellRunner.runCurrentCell',
          arguments: [cell.startLine],
        }),
      );
      lenses.push(
        new vscode.CodeLens(range, {
          title: 'Preview Generated Script',
          command: 'sparkCellRunner.previewCurrentCell',
          arguments: [cell.startLine],
        }),
      );
      if (runState) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `Databricks: ${runState.message}`,
            command: runState.payload ? 'sparkCellRunner.showCellOutput' : 'sparkCellRunner.runCurrentCell',
            arguments: [cell.startLine],
          }),
        );
        if (runState.preview) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: `Output: ${runState.preview}`,
              command: runState.payload ? 'sparkCellRunner.showCellOutput' : 'sparkCellRunner.runCurrentCell',
              arguments: [cell.startLine],
            }),
          );
        }
      }
    }

    return lenses;
  }
}

module.exports = { DatabricksNotebookCodeLensProvider };
