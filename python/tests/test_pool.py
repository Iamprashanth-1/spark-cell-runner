"""Tests for pool manifests and cell selection (no real servers involved)."""

import json

import pytest

from spark_cell_runner import bootstrap_builder
from spark_cell_runner import pool as pool_manager


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    monkeypatch.setattr(pool_manager, 'home_root', lambda: str(tmp_path))
    return tmp_path


def test_create_and_list_pool(fake_home):
    pool = pool_manager.create_pool('dev', port=15001)
    assert pool['name'] == 'dev'
    assert pool['port'] == 15001
    assert pool['warehousePath'].endswith('dev')

    pools = pool_manager.list_pools()
    assert [p['name'] for p in pools] == ['dev']


def test_create_pool_rejects_bad_name(fake_home):
    with pytest.raises(ValueError):
        pool_manager.create_pool('bad name!')


def test_create_pool_rejects_duplicate(fake_home):
    pool_manager.create_pool('dev', port=15001)
    with pytest.raises(ValueError):
        pool_manager.create_pool('dev', port=15002)


def test_manifest_is_extension_compatible(fake_home):
    pool = pool_manager.create_pool('dev', port=15001)
    with open(pool_manager.pool_manifest_path('dev'), encoding='utf-8') as handle:
        manifest = json.load(handle)

    # The VS Code extension's poolManager reads these exact fields.
    for field in ('name', 'engine', 'pythonCommand', 'port', 'warehousePath', 'pid', 'createdAt', 'logFile'):
        assert field in manifest
    assert manifest['engine'] == 'sail'
    assert manifest['pid'] is None
    assert 'running' not in manifest


def test_delete_pool(fake_home):
    pool_manager.create_pool('dev', port=15001)
    assert pool_manager.delete_pool('dev')
    assert pool_manager.list_pools() == []
    assert not pool_manager.delete_pool('dev')


def test_parse_cell_selection():
    assert bootstrap_builder.parse_cell_selection('all', 5) == {1, 2, 3, 4, 5}
    assert bootstrap_builder.parse_cell_selection('3', 5) == {3}
    assert bootstrap_builder.parse_cell_selection('1-3', 5) == {1, 2, 3}
    assert bootstrap_builder.parse_cell_selection('2,4', 5) == {2, 4}

    with pytest.raises(ValueError):
        bootstrap_builder.parse_cell_selection('9', 5)


def test_resolve_pool_target_sc_url(fake_home):
    target, pool = bootstrap_builder.resolve_pool_target('sc://127.0.0.1:15002')
    assert target == 'sc://127.0.0.1:15002'
    assert pool is None


def test_resolve_pool_target_single_pool(fake_home):
    pool_manager.create_pool('dev', port=15001)
    target, pool = bootstrap_builder.resolve_pool_target(None)
    assert target == 'sc://127.0.0.1:15001'
    assert pool['name'] == 'dev'


def test_resolve_pool_target_ambiguous(fake_home):
    pool_manager.create_pool('one', port=15001)
    pool_manager.create_pool('two', port=15002)
    with pytest.raises(ValueError):
        bootstrap_builder.resolve_pool_target(None)


def test_build_local_bootstrap_mentions_registration(fake_home):
    pool_manager.create_pool('dev', port=15001)
    source, description = bootstrap_builder.build_bootstrap(pool='dev')
    assert description == 'local pool dev'
    assert 'sc://127.0.0.1:15001' in source
    assert 'register_warehouse_tables' in source
    assert "SparkSession.builder.remote" in source


def test_build_databricks_bootstrap_serverless():
    source, description = bootstrap_builder.build_bootstrap(serverless=True)
    assert description == 'databricks'
    assert 'DatabricksSession' in source
    assert 'serverless(True)' in source
