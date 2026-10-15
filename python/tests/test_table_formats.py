"""Tests for table format detection, warehouse walking, and registration."""

import json
import os

import pytest

from spark_cell_runner import table_formats as tf


def make_delta(root, rel):
    table_dir = root / rel
    (table_dir / '_delta_log').mkdir(parents=True)
    (table_dir / '_delta_log' / '00000000000000000000.json').write_text(
        json.dumps({'metaData': {'schemaString': json.dumps({'fields': []})}}), encoding='utf-8'
    )
    return table_dir


def make_iceberg(root, rel):
    table_dir = root / rel
    metadata_dir = table_dir / 'metadata'
    metadata_dir.mkdir(parents=True)
    (metadata_dir / '00000-uuid.metadata.json').write_text('{}', encoding='utf-8')
    return table_dir


def test_detect_delta(tmp_path):
    make_delta(tmp_path, 'orders')
    assert tf.detect_table_format(str(tmp_path / 'orders')) == 'delta'


def test_detect_iceberg(tmp_path):
    make_iceberg(tmp_path, 'events')
    assert tf.detect_table_format(str(tmp_path / 'events')) == 'iceberg'


def test_detect_metadata_dir_without_json_is_not_iceberg(tmp_path):
    (tmp_path / 'notatable' / 'metadata').mkdir(parents=True)
    (tmp_path / 'notatable' / 'metadata' / 'version-hint.text').write_text('1', encoding='utf-8')
    assert tf.detect_table_format(str(tmp_path / 'notatable')) is None


def test_detect_nothing(tmp_path):
    (tmp_path / 'plain').mkdir()
    assert tf.detect_table_format(str(tmp_path / 'plain')) is None


def test_iter_warehouse_tables_mixed(tmp_path):
    make_delta(tmp_path, 'demo.db/orders')
    make_iceberg(tmp_path, 'demo.db/events')
    make_delta(tmp_path, 'spark-warehouse/items-uuid')
    make_iceberg(tmp_path, 'lonely-uuid')

    tables = {
        rel: (schema, name, fmt)
        for rel, _loc, schema, name, fmt in tf.iter_warehouse_tables(str(tmp_path))
    }

    assert set(tables) == {'demo.db/orders', 'demo.db/events', 'spark-warehouse/items-uuid', 'lonely-uuid'}
    assert tables['demo.db/orders'] == ('demo', 'orders', 'delta')
    assert tables['demo.db/events'] == ('demo', 'events', 'iceberg')
    assert tables['spark-warehouse/items-uuid'] == ('spark-warehouse', 'items-uuid', 'delta')
    assert tables['lonely-uuid'] == ('default', 'lonely-uuid', 'iceberg')


def test_table_display_name():
    suffix = '-f731c9ab-3cba-4611-bac0-c26ea422b5ca'
    assert tf.table_display_name('orders' + suffix) == 'orders'
    assert tf.table_display_name('weird name!') == 'weird_name_'


def test_to_file_url():
    assert tf.to_file_url('C:\\data\\warehouse\\t') == 'file:///C:/data/warehouse/t'
    assert tf.to_file_url('/tmp/warehouse/t') == 'file:///tmp/warehouse/t'
    assert tf.to_file_url('file:///already/a/url') == 'file:///already/a/url'


class FakeSpark:
    def __init__(self):
        self.statements = []

    def sql(self, statement):
        self.statements.append(statement)


def test_register_mixed_formats(tmp_path):
    make_delta(tmp_path, 'demo.db/orders')
    make_iceberg(tmp_path, 'demo.db/events')

    spark = FakeSpark()
    registered, skipped = tf.register_warehouse_tables(spark, str(tmp_path))

    assert sorted(registered) == ['demo.events', 'demo.orders']
    assert skipped == []

    joined = '\n'.join(spark.statements)
    assert "CREATE SCHEMA IF NOT EXISTS `demo`" in joined
    assert 'USING DELTA LOCATION' in joined
    assert 'USING ICEBERG LOCATION' in joined
    # Iceberg locations are file:/// URLs.
    for statement in spark.statements:
        if 'USING ICEBERG' in statement:
            assert 'file:///' in statement


def test_register_duplicate_names_skipped(tmp_path):
    make_delta(tmp_path, 'a.db/orders')
    make_delta(tmp_path, 'b.db/orders')

    spark = FakeSpark()
    registered, skipped = tf.register_warehouse_tables(spark, str(tmp_path))

    assert registered == ['a.orders']
    assert len(skipped) == 1
    assert 'duplicate' in skipped[0]


def test_register_error_becomes_skip(tmp_path):
    make_delta(tmp_path, 'demo.db/bad')

    class FailingSpark(FakeSpark):
        def sql(self, statement):
            if 'CREATE TABLE' in statement:
                raise RuntimeError('boom\nsecond line')
            return super().sql(statement)

    spark = FailingSpark()
    registered, skipped = tf.register_warehouse_tables(spark, str(tmp_path))
    assert registered == []
    assert skipped == ['demo.bad: boom']
