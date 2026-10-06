// CodeLenses for SQL files: a "Run on pool" lens above each statement, plus
// "Run file" above the first one — same feel as the Python notebook lenses.

const vscode = require('vscode');
const sqlRunner = require('../sqlRunner');
const { getConfiguration } = require('../config');

class SqlCodeLensProvider {
  provideCodeLenses(document) {
    // Pool SQL runs only make sense in local mode today.
    if (getConfiguration().connectionMode !== 'local') {
      return [];
    }

    const lenses = [];
    const statements = sqlRunner.splitStatements(document.getText());

    statements.forEach((statement, index) => {
      const range = new vscode.Range(
        statement.startLine,
        0,
        statement.startLine,
        0
      );

      if (index === 0 && statements.length > 1) {
        lenses.push(new vscode.CodeLens(range, {
          title: '$(play) Run file on pool',
          command: 'sparkCellRunner.runSqlFile',
          arguments: [document.uri],
        }));
      }

      lenses.push(new vscode.CodeLens(range, {
        title: '$(play) Run on pool',
        command: 'sparkCellRunner.runSqlRange',
        arguments: [document.uri, statement.startLine],
      }));
    });

    return lenses;
  }
}

module.exports = { SqlCodeLensProvider };
