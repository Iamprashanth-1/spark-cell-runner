"""spark-cell-runner — headless engine for Databricks notebook cells and SQL.

Runs Databricks notebook-source .py cells and SQL against Databricks
(Databricks Connect) or a local Sail Spark pool, with Unity Catalog sync and
a local Delta / Iceberg warehouse. The VS Code extension of the same name
ships these same modules and spawns them by path; this package is the
pip-installable CLI form.
"""

__version__ = "0.7.1"
