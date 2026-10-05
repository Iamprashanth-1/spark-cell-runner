// Parsing of Databricks notebook-source (.py) text into cells, magic handling,
// and the cell normalization used by the notebook serializer.

const vscode = require('vscode');
const {
  NOTEBOOK_HEADER,
  COMMAND_SEPARATOR_REGEX,
  MAGIC_PREFIX_REGEX,
  BARE_MAGIC_REGEX,
} = require('./constants');

function parseNotebookText(notebookPath, text) {
    const lines = text.split(/\r?\n/);
    const isNotebookSource = lines[0] && lines[0].trim() === NOTEBOOK_HEADER;
    if (!isNotebookSource) {
        return { notebookPath, lines, cells: [], isNotebookSource };
    }

    const cellRanges = [];
    let currentStartLine = 1;

    for (let index = 1; index < lines.length; index += 1) {
        if (COMMAND_SEPARATOR_REGEX.test(lines[index])) {
            cellRanges.push({
                startLine: currentStartLine,
                endLine: index - 1
            });
            currentStartLine = index + 1;
        }
    }

    cellRanges.push({ startLine: currentStartLine, endLine: lines.length - 1 });

    const cells = cellRanges
        .map((range, index) => ({
            index,
            startLine: range.startLine,
            endLine: range.endLine,
            lines: trimEmptyEdgeLines(lines.slice(range.startLine, range.endLine + 1)),
        }))
        .filter((cell) => cell.lines.length > 0);

    return { notebookPath, lines, cells, isNotebookSource };
}

function trimEmptyEdgeLines(lines) {
    let start = 0;
    let end = lines.length - 1;

    while (start <= end && lines[start].trim() === '') {
        start += 1;
    }

    while (end >= start && lines[end].trim() === '') {
        end -= 1;
    }

    return lines.slice(start, end + 1);
}

// Split notebook-source lines on the "# COMMAND ----------" separator, keeping every
// cell (including empty ones) in order. Never drops or merges cells.
function splitSourceIntoCellChunks(lines) {
  const chunks = [];
  let current = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (COMMAND_SEPARATOR_REGEX.test(lines[index])) {
      chunks.push(current);
      current = [];
    } else {
      current.push(lines[index]);
    }
  }
  chunks.push(current);
  return chunks;
}

// Remove only the single leading/trailing blank line that serializeNotebook adds as
// padding, preserving any intentional blank lines inside the cell body.
function stripPaddingBlankLines(lines) {
  const result = lines.slice();
  if (result.length > 0 && result[0].trim() === '') {
    result.shift();
  }
  if (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop();
  }
  return result;
}

function parseNotebookFromNotebookDocument(notebook) {
    const cells = notebook.getCells().map((cell, index) => {
        const lines = trimEmptyEdgeLines(
            cell.document.getText().split(/\r?\n/)
        );

        return {
            index,
            kind: cell.kind,
            language: cell.document.languageId,
            startLine: index,
            endLine: index,
            lines,
        };
    }).filter((cell) => cell.lines.length > 0);

    return {
        notebookPath: notebook.uri?.fsPath || notebook.uri?.path,
        cells,
    };
}

function normalizeNotebookCellForEditor(lines) {
    const firstLine = lines.find((line) => line.trim() !== '') || '';
    const firstMagic = getMagicContent(firstLine);

    if (firstMagic && firstMagic.startsWith('%md')) {
        return {
            kind: vscode.NotebookCellKind.Markup,
            language: 'markdown',
            lines: normalizeMagicBodyLines(
                lines,
                firstMagic.replace(/^%md(?:-sandbox)?\s?/, '')
            ),
        };
    }

    if (firstMagic && firstMagic.startsWith('%')) {
        return {
            kind: vscode.NotebookCellKind.Code,
            language: 'python',
            lines: normalizeMagicBodyLines(lines, firstMagic),
        };
    }

    return {
        kind: vscode.NotebookCellKind.Code,
        language: 'python',
        lines,
    };
}

function normalizeMagicBodyLines(lines, firstLineContent) {
    const normalized = [];

    if (firstLineContent) {
        normalized.push(firstLineContent);
    }

    for (const rawLine of lines.slice(1)) {
        const prefixedMagic = rawLine.match(MAGIC_PREFIX_REGEX);

        if (prefixedMagic) {
            normalized.push(prefixedMagic[1]);
            continue;
        }

        const commentedSqlBody = rawLine.match(/^\s*#\s?(.*)$/);

        if (commentedSqlBody && firstLineContent.trim().startsWith('%')) {
            normalized.push(commentedSqlBody[1]);
            continue;
        }

        normalized.push(rawLine);
    }

    return normalized;
}

function serializeNotebookCellForSource(cell) {
    const cellLines = cell.value.split(/\r?\n/);

    if (cell.kind === vscode.NotebookCellKind.Markup) {
        return cellLines.map((line, index) =>
            index === 0 ? `# MAGIC %md ${line}` : `# MAGIC ${line}`
        );
    }

    const firstNonEmpty = cellLines.find((line) => line.trim() !== '') || '';

    if (firstNonEmpty.trim().startsWith('%')) {
        return cellLines.map((line) => `# MAGIC ${line}`);
    }

    return cellLines;
}

function getMagicContent(line) {
    const prefixedMatch = line.match(MAGIC_PREFIX_REGEX);

    if (prefixedMatch) {
        return prefixedMatch[1];
    }

    const bareMatch = line.match(BARE_MAGIC_REGEX);
    return bareMatch ? bareMatch[1] : undefined;
}

function collectMagicBody(magicLines, firstLineContent) {
    const lines = [];

    if (firstLineContent) {
        lines.push(firstLineContent);
    }

    for (const line of magicLines.slice(1)) {
        if (line !== undefined) {
            lines.push(line);
        }
    }

    return lines;
}

function collectCellBodyLines(cellLines, firstLineContent) {
    const lines = [];

    if (firstLineContent) {
        lines.push(firstLineContent);
    }

    for (const line of cellLines.slice(1)) {
        lines.push(line);
    }

    return lines;
}

function findCellIndexForLine(cells, line) {
    return cells.findIndex((cell) => line >= cell.startLine && line <= cell.endLine);
}

function isExecutableNotebookCell(cell) {
    if (!cell || !Array.isArray(cell.lines) || cell.lines.length === 0) {
        return false;
    }

    if (cell.kind === vscode.NotebookCellKind.Markup) {
        return false;
    }

    const meaningfulLines = cell.lines.filter((line) => line.trim() !== '');

    if (meaningfulLines.length === 0) {
        return false;
    }

    if (meaningfulLines.every((line) => /^\s*#/.test(line))) {
        const firstMagic = getMagicContent(meaningfulLines[0]);

        if (!firstMagic) {
            return false;
        }
    }

    return true;
}

function indentLines(lines, spaces) {
    const prefix = ' '.repeat(spaces);
    return lines.map((line) => (line ? `${prefix}${line}` : ''));
}

function escapeForDoubleQuotedPython(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

module.exports = {
    parseNotebookText,
    trimEmptyEdgeLines,
    splitSourceIntoCellChunks,
    stripPaddingBlankLines,
    parseNotebookFromNotebookDocument,
    normalizeNotebookCellForEditor,
    serializeNotebookCellForSource,
    getMagicContent,
    collectMagicBody,
    collectCellBodyLines,
    findCellIndexForLine,
    isExecutableNotebookCell,
    indentLines,
    escapeForDoubleQuotedPython,
};
