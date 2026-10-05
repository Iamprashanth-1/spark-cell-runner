# Databricks notebook source
# MAGIC %md
# MAGIC Tests `%run` expansion: pulls in `test/_shared.py` then calls its function.

# %run ./_shared

say_hello("from the included notebook")
print(greeting_prefix, "done")
