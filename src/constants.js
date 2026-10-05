// Shared constants and regexes used across the extension.

const NOTEBOOK_HEADER = '# Databricks notebook source';
const NOTEBOOK_TYPE = 'databricks-notebook-source';
const JUPYTER_NOTEBOOK_TYPE = 'jupyter-notebook';

const COMMAND_SEPARATOR_REGEX = /^\s*# COMMAND ----------\s*$/;
const MAGIC_PREFIX_REGEX = /^\s*# MAGIC\s?(.*)$/;
const BARE_MAGIC_REGEX = /^\s*(%\w.*)$/;
const RUN_MAGIC_REGEX = /^%run\s+(.+)$/;
const SQL_MAGIC_REGEX = /^%sql(?:\s+(.*))?$/;
const SH_MAGIC_REGEX = /^%sh(?:\s+(.*))?$/;
const PIP_MAGIC_REGEX = /^%pip(?:\s+(.*))?$/;
const MD_MAGIC_REGEX = /^%md(?:-sandbox)?(?:\s+(.*))?$/;
const FS_MAGIC_REGEX = /^%fs\s+(.*)$/;

const BOOTSTRAP_CONNECT_UNAVAILABLE_MARKER =
  '[spark-cell-runner] Databricks Connect bootstrap unavailable:';

module.exports = {
  NOTEBOOK_HEADER,
  NOTEBOOK_TYPE,
  JUPYTER_NOTEBOOK_TYPE,
  COMMAND_SEPARATOR_REGEX,
  MAGIC_PREFIX_REGEX,
  BARE_MAGIC_REGEX,
  RUN_MAGIC_REGEX,
  SQL_MAGIC_REGEX,
  SH_MAGIC_REGEX,
  PIP_MAGIC_REGEX,
  MD_MAGIC_REGEX,
  FS_MAGIC_REGEX,
  BOOTSTRAP_CONNECT_UNAVAILABLE_MARKER,
};
