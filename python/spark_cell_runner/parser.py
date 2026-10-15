#!/usr/bin/env python3
"""Parsing of Databricks notebook-source (.py) text into cells.

Python port of the extension's parser.js, restricted to what headless
execution needs: splitting on the "# COMMAND ----------" separator, magic
detection (%sql, %md, %python, %pip, %sh, %run — both "# MAGIC" prefixed and
bare forms), and translation of each cell into something executable.
"""

import re

NOTEBOOK_HEADER = '# Databricks notebook source'
COMMAND_SEPARATOR_REGEX = re.compile(r'^\s*#{1,2} COMMAND -+\s*$')
MAGIC_PREFIX_REGEX = re.compile(r'^\s*# MAGIC\s?(.*)$')
BARE_MAGIC_REGEX = re.compile(r'^\s*(%\w.*)$')


class Cell:
    def __init__(self, index, start_line, end_line, lines):
        self.index = index
        self.start_line = start_line
        self.end_line = end_line
        self.lines = lines

    def __repr__(self):  # pragma: no cover - debugging aid
        return f'Cell(index={self.index}, lines={len(self.lines)})'


def trim_empty_edge_lines(lines):
    start = 0
    end = len(lines) - 1
    while start <= end and lines[start].strip() == '':
        start += 1
    while end >= start and lines[end].strip() == '':
        end -= 1
    return lines[start:end + 1]


def is_notebook_source(text):
    lines = text.splitlines()
    return bool(lines) and lines[0].strip() == NOTEBOOK_HEADER


def parse_notebook_text(text):
    """Splits notebook source into cells. Returns (cells, is_notebook_source)."""
    lines = text.splitlines()
    if not is_notebook_source(text):
        return [], False

    cell_ranges = []
    current_start = 1
    for index in range(1, len(lines)):
        if COMMAND_SEPARATOR_REGEX.match(lines[index]):
            cell_ranges.append((current_start, index - 1))
            current_start = index + 1
    cell_ranges.append((current_start, len(lines) - 1))

    cells = []
    for index, (start, end) in enumerate(cell_ranges):
        body = trim_empty_edge_lines(lines[start:end + 1])
        if body:
            cells.append(Cell(index, start, end, body))

    return cells, True


def get_magic_content(line):
    prefixed = MAGIC_PREFIX_REGEX.match(line)
    if prefixed:
        return prefixed.group(1)
    bare = BARE_MAGIC_REGEX.match(line)
    return bare.group(1) if bare else None


def first_nonempty_line(lines):
    for line in lines:
        if line.strip():
            return line
    return ''


# Mirrors parser.js: after the "# MAGIC " prefix, magic-cell body lines keep
# their content; when the first line is any "%" magic, a leading "#" comment
# marker is also stripped (Databricks exports comment the whole SQL body).
def normalize_magic_body_lines(lines, first_line_content):
    normalized = []
    if first_line_content:
        normalized.append(first_line_content)

    for raw_line in lines[1:]:
        prefixed = MAGIC_PREFIX_REGEX.match(raw_line)
        if prefixed:
            normalized.append(prefixed.group(1))
            continue
        commented = re.match(r'^\s*#\s?(.*)$', raw_line)
        if commented and first_line_content and first_line_content.strip().startswith('%'):
            normalized.append(commented.group(1))
            continue
        normalized.append(raw_line)

    return normalized


def is_executable(lines):
    """False for empty cells and comment-only cells without a magic header."""
    meaningful = [line for line in lines if line.strip()]
    if not meaningful:
        return False
    if all(re.match(r'^\s*#', line) for line in meaningful):
        return bool(get_magic_content(meaningful[0]))
    return True


def classify_cell(lines):
    """Classifies one cell into an executable form.

    Returns (kind, payload) where kind is one of:
      python    payload is Python source to exec()
      sql       payload is a SQL query string for spark.sql()
      markdown  payload is the markdown text (not executed)
      pip       payload is a list of pip arguments
      sh        payload is a shell command string
      run       payload is the %run target path (relative or absolute)
      skip      payload is a human reason the cell is not executed
    """
    if not is_executable(lines):
        return 'skip', 'empty or comment-only cell'

    first = first_nonempty_line(lines)
    magic = get_magic_content(first)

    if not magic:
        return 'python', '\n'.join(lines)

    if magic.startswith('%md'):
        # "%md # Title" keeps "# Title" as the first markdown line (like the
        # extension's notebook editor normalization); "-sandbox" is dropped.
        stripped = re.sub(r'^%md(?:-sandbox)?\s?', '', magic)
        body = [stripped] + normalize_magic_body_lines(lines, magic)[1:]
        return 'markdown', '\n'.join(body)

    if magic.startswith('%sql'):
        body = normalize_magic_body_lines(lines, magic)
        query = '\n'.join([body[0][len('%sql'):].strip()] + body[1:]).strip()
        if not query:
            return 'skip', '%sql cell with no query'
        return 'sql', query

    if magic.startswith('%python'):
        body = normalize_magic_body_lines(lines, magic)
        code = '\n'.join([body[0][len('%python'):].strip()] + body[1:]).strip()
        if not code:
            return 'skip', '%python cell with no code'
        return 'python', code

    if magic.startswith('%pip'):
        body = normalize_magic_body_lines(lines, magic)
        args = body[0][len('%pip'):].split()
        for extra in body[1:]:
            if extra.startswith('%pip'):
                extra = extra[len('%pip'):]
            args.extend(extra.split())
        return 'pip', args

    if magic.startswith('%sh'):
        body = normalize_magic_body_lines(lines, magic)
        command = ' '.join([body[0][len('%sh'):].strip()] + body[1:]).strip()
        if not command:
            return 'skip', '%sh cell with no command'
        return 'sh', command

    if magic.startswith('%run'):
        target = magic[len('%run'):].strip()
        if not target:
            return 'skip', '%run cell with no target'
        return 'run', target.split()[0]

    return 'skip', f'unsupported magic: {magic.split()[0]}'
