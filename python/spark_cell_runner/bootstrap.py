# Databricks notebook source

import builtins
import os
import re
import shlex
import shutil
import io
import types
from pathlib import Path
_dcr_workspace_path_mappings = globals().get("_dcr_workspace_path_mappings", {})
_dcr_secret_values = globals().get("_dcr_secret_values", {})
_dcr_widget_values = globals().get("_dcr_widget_values", {})
class DCRNotebookExit(Exception):
    pass
def log_appinsights(*args, **kwargs):
    message = kwargs.get("message") if isinstance(kwargs, dict) else None
    if message is None and args:
        message = args[0]
    print(f"[spark-cell-runner] log_appinsights fallback: {message}")
def log_info(message, properties=None):
    print(f"[spark-cell-runner] log_info: {message}")
def log_warning(message, properties=None):
    print(f"[spark-cell-runner] log_warning: {message}")
def log_error(message, properties=None):
    print(f"[spark-cell-runner] log_error: {message}")
def log_metric(name, value, properties=None):
    print(f"[spark-cell-runner] log_metric: {name}={value}")
def display(*args, **kwargs):
    if not args:
        return None
    obj = args[0]
    show = getattr(obj, "show", None)
    if callable(show):
        try:
            return show(20, truncate=False)
        except TypeError:
            return show()
    to_string = getattr(obj, "to_string", None)
    if callable(to_string):
        print(to_string())
        return None
    print(obj)
    return None
def displayHTML(html=""):
    print(html)
for __dcr_df_module in ("pyspark.sql.connect.dataframe", "pyspark.sql.dataframe"):
    try:
        __dcr_df_mod = __import__(__dcr_df_module, fromlist=["DataFrame"])
        __dcr_df_cls = getattr(__dcr_df_mod, "DataFrame", None)
        if __dcr_df_cls is not None and not hasattr(__dcr_df_cls, "display"):
            __dcr_df_cls.display = lambda self, *a, **k: display(self)
    except Exception:
        pass
def __dcr_safe_callable(fn, name):
    if not callable(fn):
        return fn
    if getattr(fn, "__dcr_safe_wrapper__", False):
        return fn
    def _wrapped(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            print(f"[spark-cell-runner] {name} failed: {exc}")
            return None
    _wrapped.__dcr_safe_wrapper__ = True
    return _wrapped
def __dcr_wrap_logging_helpers():
    for _name in ["log_appinsights", "log_info", "log_warning", "log_error", "log_metric"]:
        if _name in globals():
            globals()[_name] = __dcr_safe_callable(globals()[_name], _name)
def __dcr_wrap_hello__config_reader():
    reader_cls = globals().get("AladdinConfigReader")
    if reader_cls is None:
        return
    original = getattr(reader_cls, "get_config_variables", None)
    if not callable(original) or getattr(original, "__dcr_safe_wrapper__", False):
        return
    def _wrapped(self, hello__file_id):
        result = original(self, hello__file_id)
        if result is not None:
            return result
        try:
            full_table_name = getattr(self, "full_table_name", f"{getattr(self, 'catalog_name', '')}.{getattr(self, 'schema_name', 'common')}")
            row = spark.sql(f"SELECT * from table1").collect()
            if not row:
                return None
            row = row[0]
            file_info = {
                "config_path": row["ConfigPath"],
            }
            app_path = globals().get("app_storage_path", "")
            full_config_path = f"{app_path.rstrip('/')}/{file_info['config_path'].lstrip('/')}"
        except Exception as exc:
            print(f"[spark-cell-runner] Aladdin config fallback failed: {exc}")
            return None

        try:
            json_content = dbutils.fs.head(full_config_path)
        except Exception:
            json_content = dcr_read_text_via_spark(full_config_path)

        # NOTE: the original hardcoded bootstrap ended here mid-function; _wrapped is
        # intentionally left unattached until the Aladdin fallback is finished.
        return None
def dcr_translate_workspace_path(value):
    if not isinstance(value, str):
        return value
    normalized = value.replace("\\", "/")
    for source_prefix, target_prefix in sorted(_dcr_workspace_path_mappings.items(), key=lambda item: len(item[0]), reverse=True):
        source_norm = source_prefix.replace("\\", "/")
        if normalized == source_norm or normalized.startswith(source_norm + "/"):
            suffix = normalized[len(source_norm):].lstrip("/")
            translated = os.path.join(target_prefix, *([part for part in suffix.split("/") if part] if suffix else []))
            return translated
    return value
def dcr_list_mapped_library_entries(translated):
    if isinstance(translated, str) and translated.lower().endswith(".txt") and dcr_original_isfile(translated):
        entries = []
        with dcr_original_open(translated, "r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                entries.append(line.split("=", 1)[0].strip())
        return entries
    return None
def dcr_wheel_to_requirement(token):
    basename = os.path.basename(token)
    match = re.match(r"(?P<name>.+?)-(?P<version>\d[^-]*)-", basename)
    if match:
        return f"{match.group('name')}=={match.group('version')}"
    stem = re.sub(r"\.(whl|egg)$", "", basename, flags=re.IGNORECASE)
    return stem
def dcr_translate_pip_command(command):
    args = shlex.split(command)
    translated_args = []
    for arg in args:
        translated = dcr_translate_workspace_path(arg)
        if isinstance(arg, str) and arg.startswith("/Volumes/") and not os.path.exists(translated):
            lowered = arg.lower()
            if lowered.endswith(".whl") or lowered.endswith(".egg"):
                translated_args.append(dcr_wheel_to_requirement(arg))
                continue
        translated_args.append(translated)
    return translated_args
def dcr_read_text_via_spark(path_value, max_bytes=65536):
    spark_session = globals().get("spark")
    if spark_session is None:
        raise FileNotFoundError(path_value)
    rows = spark_session.read.text(path_value).collect()
    text_value = "\n".join([row[0] for row in rows])
    return text_value[:max_bytes]
def dcr_path_is_abfss(path_value):
    return isinstance(path_value, str) and path_value.startswith("abfss://")
def dcr_list_via_spark(path_value):
    spark_session = globals().get("spark")
    if spark_session is None:
        raise FileNotFoundError(path_value)
    rows = spark_session.read.format("binaryFile").load(path_value.rstrip("/") + "/*").select("path").collect()
    items = []
    for row in rows:
        item_path = row[0]
        name = item_path.rsplit("/", 1)[-1]
        items.append(DcrFileInfo(item_path, name, False))
    return items
def dcr_write_text_via_spark(path_value, text_value):
    spark_session = globals().get("spark")
    if spark_session is None:
        raise FileNotFoundError(path_value)
    spark_session.createDataFrame([(text_value,)], ["value"]).coalesce(1).write.mode("overwrite").text(path_value)
    return True
def dcr_rm_via_spark(path_value, recurse=False):
    spark_session = globals().get("spark")
    if spark_session is None:
        raise FileNotFoundError(path_value)
    sc = getattr(spark_session, "sparkContext", None)
    jvm = getattr(sc, "_jvm", None) or getattr(spark_session, "_jvm", None)
    if jvm is None or sc is None:
        raise RuntimeError("JVM access unavailable for external rm")
    hadoop_path = jvm.org.apache.hadoop.fs.Path(path_value)
    hadoop_conf = sc._jsc.hadoopConfiguration()
    fs = hadoop_path.getFileSystem(hadoop_conf)
    return bool(fs.delete(hadoop_path, bool(recurse)))
dcr_original_open = getattr(builtins, "__dcr_original_open", builtins.open)
builtins.__dcr_original_open = dcr_original_open
def dcr_is_databricks_path(path_value):
    if not isinstance(path_value, str):
        return False
    return (
        path_value.startswith("/Volumes/")
        or path_value.startswith("/dbfs/")
        or path_value.startswith("dbfs:/")
        or path_value.startswith("abfss://")
    )
def dcr_read_binary_via_spark(path_value):
    spark_session = globals().get("spark")
    if spark_session is None:
        raise FileNotFoundError(path_value)
    rows = spark_session.read.format("binaryFile").load(path_value).select("content").collect()
    if not rows:
        raise FileNotFoundError(path_value)
    return rows[0][0]
class DcrRawStream(io.RawIOBase):
    def __init__(self, source):
        self._source = source
    def readable(self):
        return True
    def readinto(self, buffer):
        chunk = self._source.read(len(buffer))
        if not chunk:
            return 0
        count = len(chunk)
        buffer[:count] = chunk
        return count
    def close(self):
        try:
            self._source.close()
        except Exception:
            pass
        super().close()
def dcr_open_databricks_stream(path_value, mode, kwargs):
    raw_source = None
    if path_value.startswith("/Volumes/"):
        try:
            from databricks.sdk import WorkspaceClient
            client = globals().get("__dcr_workspace_client")
            if client is None:
                client = WorkspaceClient()
                globals()["__dcr_workspace_client"] = client
            raw_source = client.files.download(path_value).contents
        except Exception:
            raw_source = None
    if raw_source is not None:
        buffered = io.BufferedReader(DcrRawStream(raw_source))
    else:
        buffered = io.BytesIO(dcr_read_binary_via_spark(path_value))
    if isinstance(mode, str) and "b" in mode:
        return buffered
    return io.TextIOWrapper(
        buffered,
        encoding=kwargs.get("encoding") or "utf-8",
        errors=kwargs.get("errors"),
        newline=kwargs.get("newline"),
    )
def __dcr_open(file, *args, **kwargs):
    translated = dcr_translate_workspace_path(file)
    mode = args[0] if args else kwargs.get("mode", "r")
    is_read = not isinstance(mode, str) or ("w" not in mode and "a" not in mode and "x" not in mode and "+" not in mode)
    if is_read and dcr_is_databricks_path(translated) and not dcr_original_exists(translated):
        try:
            return dcr_open_databricks_stream(translated, mode, kwargs)
        except Exception as exc:
            print(f"[spark-cell-runner] could not read Databricks path {translated}: {exc}")
    return dcr_original_open(translated, *args, **kwargs)
builtins.open = __dcr_open
dcr_original_exists = getattr(os.path, "__dcr_original_exists", os.path.exists)
os.path.__dcr_original_exists = dcr_original_exists
os.path.exists = lambda value: dcr_original_exists(dcr_translate_workspace_path(value))
dcr_original_isfile = getattr(os.path, "__dcr_original_isfile", os.path.isfile)
os.path.__dcr_original_isfile = dcr_original_isfile
os.path.isfile = lambda value: dcr_original_isfile(dcr_translate_workspace_path(value))
dcr_original_isdir = getattr(os.path, "__dcr_original_isdir", os.path.isdir)
os.path.__dcr_original_isdir = dcr_original_isdir
os.path.isdir = lambda value: (dcr_list_mapped_library_entries(dcr_translate_workspace_path(value)) is not None) or dcr_original_isdir(dcr_translate_workspace_path(value))
dcr_original_listdir = getattr(os, "__dcr_original_listdir", os.listdir)
os.__dcr_original_listdir = dcr_original_listdir
os.listdir = lambda value: (dcr_list_mapped_library_entries(dcr_translate_workspace_path(value)) if dcr_list_mapped_library_entries(dcr_translate_workspace_path(value)) is not None else dcr_original_listdir(dcr_translate_workspace_path(value)))
dcr_original_path_open = getattr(Path, "__dcr_original_path_open", Path.open)
Path.__dcr_original_path_open = dcr_original_path_open
def __dcr_path_open(self, *args, **kwargs):
    return dcr_original_path_open(self, *args, **kwargs)
Path.open = __dcr_path_open
class DcrFileInfo:
    def __init__(self, path_value, name, is_dir=False, size=0):
        self.path = path_value
        self.name = name
        self.size = size
        self._is_dir = bool(is_dir)
    def isDir(self):
        return self._is_dir
    def isFile(self):
        return not self._is_dir
    @classmethod
    def from_entry(cls, entry):
        if isinstance(entry, cls):
            return entry
        path_value = getattr(entry, "path", None) or getattr(entry, "file_path", None) or ""
        name = getattr(entry, "name", None) or (path_value.rstrip("/").rsplit("/", 1)[-1] if path_value else "")
        size = getattr(entry, "size", 0)
        is_dir = getattr(entry, "_is_dir", None)
        if is_dir is None and hasattr(entry, "isDir"):
            try:
                candidate = getattr(entry, "isDir")
                is_dir = candidate() if callable(candidate) else candidate
            except Exception:
                is_dir = None
        if is_dir is None and hasattr(entry, "is_dir"):
            try:
                candidate = getattr(entry, "is_dir")
                is_dir = candidate() if callable(candidate) else candidate
            except Exception:
                is_dir = None
        if is_dir is None and path_value:
            translated = dcr_translate_workspace_path(path_value)
            is_dir = os.path.isdir(translated)
        return cls(path_value, name, bool(is_dir), size)
    def __repr__(self):
        return f"DcrFileInfo(path={self.path!r}, name={self.name!r}, is_dir={self._is_dir!r}, size={self.size!r})"
class DcrFsProxy:
    def __init__(self, wrapped):
        self._wrapped = wrapped
    def ls(self, value):
        translated = dcr_translate_workspace_path(value)
        mapped = dcr_list_mapped_library_entries(translated)
        if mapped is not None:
            return [DcrFileInfo(f"{str(value).rstrip('/')}/{name}", name, os.path.isdir(os.path.join(translated, name)), os.path.getsize(os.path.join(translated, name)) if os.path.isfile(os.path.join(translated, name)) else 0) for name in mapped]
        if dcr_path_is_abfss(value):
            return dcr_list_via_spark(value)
        if os.path.isdir(translated):
            return [DcrFileInfo(f"{str(value).rstrip('/')}/{name}", name, os.path.isdir(os.path.join(translated, name)), os.path.getsize(os.path.join(translated, name)) if os.path.isfile(os.path.join(translated, name)) else 0) for name in os.listdir(translated)]
        if self._wrapped is not None:
            return [DcrFileInfo.from_entry(entry) for entry in self._wrapped.fs.ls(value)]
        raise FileNotFoundError(translated)
    def head(self, value, max_bytes=65536):
        translated = dcr_translate_workspace_path(value)
        if isinstance(value, str) and value.startswith("abfss://"):
            try:
                return dcr_read_text_via_spark(value, max_bytes)
            except Exception:
                pass
        if dcr_original_isfile(translated):
            with dcr_original_open(translated, "r", encoding="utf-8") as handle:
                return handle.read(max_bytes)
        if self._wrapped is not None:
            return self._wrapped.fs.head(value, max_bytes)
        raise FileNotFoundError(translated)
    def mkdirs(self, value):
        if dcr_path_is_abfss(value):
            return True
        os.makedirs(dcr_translate_workspace_path(value), exist_ok=True)
        return True
    def put(self, value, contents, overwrite=False):
        if dcr_path_is_abfss(value):
            return dcr_write_text_via_spark(value, contents)
        translated = dcr_translate_workspace_path(value)
        parent = os.path.dirname(translated)
        if parent:
            os.makedirs(parent, exist_ok=True)
        if not overwrite and os.path.exists(translated):
            raise FileExistsError(translated)
        with dcr_original_open(translated, "w", encoding="utf-8") as handle:
            handle.write(contents)
        return True
    def mv(self, src, dst, recurse=False):
        if (dcr_path_is_abfss(src) or dcr_path_is_abfss(dst)) and self._wrapped is not None:
            return self._wrapped.fs.mv(src, dst, recurse)
        translated_src = dcr_translate_workspace_path(src)
        translated_dst = dcr_translate_workspace_path(dst)
        parent = os.path.dirname(translated_dst)
        if parent:
            os.makedirs(parent, exist_ok=True)
        shutil.move(translated_src, translated_dst)
        return True
    def rm(self, value, recurse=False):
        if dcr_path_is_abfss(value):
            try:
                return dcr_rm_via_spark(value, recurse)
            except Exception as exc:
                if self._wrapped is not None:
                    try:
                        return self._wrapped.fs.rm(value, recurse)
                    except Exception:
                        pass
                print("[spark-cell-runner] Skipping rm for external path %r (%s)" % (value, exc))
                return True
        translated = dcr_translate_workspace_path(value)
        if os.path.isdir(translated):
            shutil.rmtree(translated, ignore_errors=recurse)
        elif os.path.exists(translated):
            os.remove(translated)
        return True
    def cp(self, src, dst, recurse=False):
        if (dcr_path_is_abfss(src) or dcr_path_is_abfss(dst)) and self._wrapped is not None:
            return self._wrapped.fs.cp(src, dst, recurse)
        translated_src = dcr_translate_workspace_path(src)
        translated_dst = dcr_translate_workspace_path(dst)
        parent = os.path.dirname(translated_dst)
        if parent:
            os.makedirs(parent, exist_ok=True)
        if os.path.isdir(translated_src):
            shutil.copytree(translated_src, translated_dst, dirs_exist_ok=True)
        else:
            shutil.copy2(translated_src, translated_dst)
        return True
    def __getattr__(self, name):
        if self._wrapped is None:
            raise AttributeError(name)
        return getattr(self._wrapped.fs, name)
class DcrWidgetsProxy:
    def __init__(self):
        self._values = {}
        _dcr_overrides = globals().get('__dcr_widget_values', {})
        self._overrides = dict(_dcr_overrides) if isinstance(_dcr_overrides, dict) else {}
    def _register(self, name, defaultValue=''):
        self._values.setdefault(name, defaultValue)
    def text(self, name, defaultValue='', label=None):
        self._register(name, defaultValue)
    def dropdown(self, name, defaultValue='', choices=None, label=None):
        self._register(name, defaultValue)
    def combobox(self, name, defaultValue='', choices=None, label=None):
        self._register(name, defaultValue)
    def multiselect(self, name, defaultValue='', choices=None, label=None):
        self._register(name, defaultValue)
    def get(self, name):
        if name in self._overrides and self._overrides[name] not in (None, ''):
            return self._overrides[name]
        return self._values.get(name, '')
    def getArgument(self, name, defaultValue=''):
        value = self.get(name)
        return value if value != '' else defaultValue
    def removeAll(self):
        self._values.clear()
def dcr_workspace_host():
    client = globals().get('__dcr_workspace_client')
    if client is None:
        try:
            from databricks.sdk import WorkspaceClient
            client = WorkspaceClient()
            globals()['__dcr_workspace_client'] = client
        except Exception:
            client = None
    if client is not None:
        try:
            host = client.config.host
            if host:
                return host
        except Exception:
            pass
    return os.environ.get('DATABRICKS_HOST', '')
class DcrScalaOption:
    def __init__(self, value):
        self._value = value
    def get(self):
        return self._value
    def getOrElse(self, default):
        return self._value if self._value not in (None, '') else default
    def isDefined(self):
        return self._value not in (None, '')
    def isEmpty(self):
        return self._value in (None, '')
    def toString(self):
        return str(self._value if self._value is not None else '')
class DcrTagsMap:
    def __init__(self, data=None):
        self._data = data or {}
    def apply(self, key):
        return self._data.get(key, '')
    def get(self, key, default=None):
        return DcrScalaOption(self._data.get(key))
    def getOrElse(self, key, default):
        return self._data.get(key, default)
class DcrNotebookContext:
    def _bare_host(self):
        return dcr_workspace_host().replace('https://', '').replace('http://', '').rstrip('/')
    def apiUrl(self):
        return DcrScalaOption(dcr_workspace_host())
    def workspaceUrl(self):
        return DcrScalaOption(self._bare_host())
    def browserHostName(self):
        return DcrScalaOption(self._bare_host())
    def notebookPath(self):
        return DcrScalaOption(globals().get('__dcr_notebook_path', ''))
    def tags(self):
        return DcrTagsMap()
    def __getattr__(self, name):
        return lambda *args, **kwargs: DcrScalaOption(None)
class DcrNotebookContextHolder:
    def getContext(self):
        return DcrNotebookContext()
class DcrEntryPointDbutils:
    def notebook(self):
        return DcrNotebookContextHolder()
class DcrEntryPoint:
    def getDbutils(self):
        return DcrEntryPointDbutils()
class DcrNotebookProxy:
    def __init__(self):
        self.entry_point = DcrEntryPoint()
    def exit(self, value=None):
        raise DcrNotebookExit(value)
    def run(self, path=None, timeout_seconds=None, arguments=None, *args, **kwargs):
        print('[spark-cell-runner] Skipping dbutils.notebook.run(%r) in local execution' % (path,))
        return ''
    def getContext(self):
        return DcrNotebookContext()
class DcrSecretsProxy:
    def get(self, scope=None, key=None):
        _dcr_secrets = globals().get('__dcr_secret_values', {})
        scoped_key = f'{scope}/{key}' if scope and key else None
        if scoped_key and scoped_key in _dcr_secrets:
            return _dcr_secrets[scoped_key]
        if key and key in _dcr_secrets:
            return _dcr_secrets[key]
        env_key = key or scoped_key or ''
        env_key = env_key.replace('-', '_').replace('/', '_').upper()
        if env_key and env_key in os.environ:
            return os.environ[env_key]
        return ''
class DcrLibraryProxy:
    def __init__(self, wrapped):
        self._wrapped = wrapped
    def restartPython(self):
        print('[spark-cell-runner] Skipping dbutils.library.restartPython() in local execution')
    def __getattr__(self, name):
        if self._wrapped is None:
            raise AttributeError(name)
        return getattr(self._wrapped.library, name)
class DcrDbutilsProxy:
    def __init__(self, wrapped):
        self._wrapped = wrapped
        self.fs = DcrFsProxy(wrapped)
        self.widgets = DcrWidgetsProxy()
        self.notebook = DcrNotebookProxy()
        self.secrets = DcrSecretsProxy()
        self.library = DcrLibraryProxy(wrapped)
    def __getattr__(self, name):
        if self._wrapped is None:
            raise AttributeError(name)
        return getattr(self._wrapped, name)
try:
    from databricks.sdk.runtime import dbutils as runtime_dbutils
except Exception:
    runtime_dbutils = None
dbutils = globals().get('dbutils') or DcrDbutilsProxy(runtime_dbutils)
__SCR_CONNECTION_BLOCK__
