// Notebook serializer for the "databricks-notebook-source" notebook type: turns
// notebook-source .py text into notebook cells and back.

const vscode = require('vscode');
const { NOTEBOOK_HEADER } = require('./constants');
const {
  splitSourceIntoCellChunks,
  stripPaddingBlankLines,
  normalizeNotebookCellForEditor,
  serializeNotebookCellForSource,
} = require('./parser');

class DatabricksNotebookSerializer {
  async deserializeNotebook(content) {
    const text = new TextDecoder().decode(content);
    const lines = text ? text.split(/\r?\n/) : [''];
    const isNotebookSource = lines[0] && lines[0].trim() === NOTEBOOK_HEADER;

    // Split into cell chunks WITHOUT dropping empty cells or reordering, so that
    // deserialize(serialize(x)) preserves the exact cell structure (Jupyter-like).
    const chunks = isNotebookSource
      ? splitSourceIntoCellChunks(lines).map((chunk) => stripPaddingBlankLines(chunk))
      : [lines];

    const cells = chunks.map((chunkLines) => {
      const normalizedCell = normalizeNotebookCellForEditor(chunkLines);
      return new vscode.NotebookCellData(normalizedCell.kind, normalizedCell.lines.join('\n'), normalizedCell.language);
    });

    return new vscode.NotebookData(cells);
  }

  async serializeNotebook(data) {
    // Canonical on-disk layout (matches buildCellOnDiskMap in navigation.js):
    // header, blank, cell, blank, "# COMMAND ----------", blank, cell, ...
    const lines = [NOTEBOOK_HEADER, ''];

    data.cells.forEach((cell, index) => {
      lines.push(...serializeNotebookCellForSource(cell));

      if (index < data.cells.length - 1) {
        lines.push('');
        lines.push('# COMMAND ----------');
        lines.push('');
      }
    });

    return new TextEncoder().encode(`${lines.join('\n').trimEnd()}\n`);
  }
}

module.exports = { DatabricksNotebookSerializer };
