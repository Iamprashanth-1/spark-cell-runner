_dcr_workspace_path_mappings = __DCR_WORKSPACE_PATH_MAPPINGS__
_dcr_secret_values = __DCR_SECRET_VALUES__
_dcr_widget_values = __DCR_WIDGET_VALUES__
try:
    dbutils.widgets._overrides = dict(_dcr_widget_values)
except Exception:
    pass
