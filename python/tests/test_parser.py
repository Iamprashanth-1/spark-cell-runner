"""Tests for the notebook-source cell parser (Python port of parser.js)."""

from spark_cell_runner import parser as p


NOTEBOOK = """# Databricks notebook source
# a comment header cell

# COMMAND ----------

print('hello')

# COMMAND ----------

# MAGIC %sql
# MAGIC SELECT 1

# COMMAND ----------

# MAGIC %md
# MAGIC # Markdown title
# MAGIC body text

# COMMAND ----------

# MAGIC %pip install Faker
# MAGIC %pip install requests

# COMMAND ----------

x = 41
print(x + 1)
"""


def test_parse_splits_cells():
    cells, is_source = p.parse_notebook_text(NOTEBOOK)
    assert is_source
    assert len(cells) == 6  # header comment counts as a cell; empty ones dropped


def test_plain_python_file_is_not_notebook():
    cells, is_source = p.parse_notebook_text("print('hi')\n")
    assert not is_source
    assert cells == []


def test_classify_python():
    cells, _ = p.parse_notebook_text(NOTEBOOK)
    kind, payload = p.classify_cell(cells[1].lines)
    assert kind == 'python'
    assert "print('hello')" in payload


def test_classify_sql_magic():
    cells, _ = p.parse_notebook_text(NOTEBOOK)
    kind, payload = p.classify_cell(cells[2].lines)
    assert kind == 'sql'
    assert payload.strip() == 'SELECT 1'


def test_classify_markdown():
    cells, _ = p.parse_notebook_text(NOTEBOOK)
    kind, payload = p.classify_cell(cells[3].lines)
    assert kind == 'markdown'
    assert '# Markdown title' in payload
    assert '%md' not in payload


def test_classify_pip():
    cells, _ = p.parse_notebook_text(NOTEBOOK)
    kind, payload = p.classify_cell(cells[4].lines)
    assert kind == 'pip'
    assert payload == ['install', 'Faker', 'install', 'requests']


def test_classify_expression_cell():
    cells, _ = p.parse_notebook_text(NOTEBOOK)
    kind, payload = p.classify_cell(cells[5].lines)
    assert kind == 'python'
    assert 'x = 41' in payload


def test_classify_comment_only_cell_is_skipped():
    kind, _ = p.classify_cell(['# just a comment'])
    assert kind == 'skip'


def test_classify_bare_sql_magic():
    kind, payload = p.classify_cell(['%sql SELECT 2', 'WHERE 1=1'])
    assert kind == 'sql'
    assert 'SELECT 2' in payload and 'WHERE 1=1' in payload


def test_classify_double_hash_separator():
    text = '# Databricks notebook source\nprint(1)\n\n## COMMAND ----------\nprint(2)\n'
    cells, is_source = p.parse_notebook_text(text)
    assert is_source
    assert len(cells) == 2


def test_run_magic():
    kind, payload = p.classify_cell(['# MAGIC %run ./shared'])
    assert kind == 'run'
    assert payload == './shared'


def test_sh_magic():
    kind, payload = p.classify_cell(['# MAGIC %sh echo hi'])
    assert kind == 'sh'
    assert payload == 'echo hi'
