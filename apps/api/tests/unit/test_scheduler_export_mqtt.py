"""Exports MQTT génériques planifiés (MED-32, issue #134, PR #119)

Le scheduler ne traitait que Home Assistant et VictoriaMetrics : un export MQTT dû finissait en
`ValueError: Unknown export type: ExportType.MQTT`, statut `failed`. L'export manuel passe par
`MQTTExporter.run_full_export` : le scheduler doit appeler la même méthode, donc publier les mêmes topics.
"""

import logging
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from src.models.client_mode import ExportType
from src.services.exporters.mqtt import MQTTExporter

PRM = "99999999999991"


def mqtt_config(**overrides):
    values = {
        "name": "MQTT",
        "export_type": ExportType.MQTT,
        "config": {"broker": "core-mosquitto"},
        "usage_point_ids": [PRM],
        "is_enabled": True,
        "export_interval_minutes": 60,
        "next_export_at": None,
        "last_export_at": None,
        "last_export_status": None,
        "last_export_error": None,
        "export_count": 0,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def patch_session(monkeypatch, configs):
    """async_session_maker du scheduler : une session dont le select renvoie `configs`."""
    db = MagicMock()
    db.execute = AsyncMock(return_value=SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: configs)))
    db.commit = AsyncMock()

    class Session:
        async def __aenter__(self):
            return db

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr("src.models.database.async_session_maker", lambda: Session())
    return db


def patch_run_full_export(monkeypatch, **counts):
    results = {"consumption": 0, "production": 0, "tempo": 0, "zen_flex": 0, "ecowatt": 0, "errors": []}
    results.update(counts)
    run = AsyncMock(return_value=results)
    monkeypatch.setattr(MQTTExporter, "run_full_export", run)
    return run


async def run_scheduled_exports():
    from src import scheduler as scheduler_module

    await scheduler_module.SyncScheduler()._run_scheduled_exports()


async def test_export_mqtt_planifie_appelle_run_full_export(monkeypatch):
    config = mqtt_config()
    db = patch_session(monkeypatch, [config])
    run = patch_run_full_export(monkeypatch, consumption=1, tempo=1, zen_flex=1, ecowatt=1)
    before = datetime.now(UTC)

    await run_scheduled_exports()

    run.assert_awaited_once_with(db, [PRM])
    assert config.last_export_status == "success"
    assert config.last_export_error is None
    assert config.export_count == 1
    assert config.next_export_at >= before + timedelta(minutes=60)


async def test_export_mqtt_planifie_avec_erreurs_partielles(monkeypatch):
    config = mqtt_config()
    patch_session(monkeypatch, [config])
    patch_run_full_export(monkeypatch, consumption=1, errors=["EcoWatt: broker timeout"])

    await run_scheduled_exports()

    assert config.last_export_status == "partial"
    assert config.last_export_error == "EcoWatt: broker timeout"


async def test_export_mqtt_planifie_compte_zen_flex(monkeypatch, caplog):
    patch_session(monkeypatch, [mqtt_config()])
    patch_run_full_export(monkeypatch, consumption=1, tempo=1, zen_flex=1, ecowatt=1)

    with caplog.at_level(logging.INFO, logger="src.scheduler"):
        await run_scheduled_exports()

    assert "Export MQTT completed: 4 records" in caplog.text


async def test_export_mqtt_pas_encore_du_n_est_pas_lance(monkeypatch):
    config = mqtt_config(next_export_at=datetime.now(UTC) + timedelta(minutes=30))
    patch_session(monkeypatch, [config])
    run = patch_run_full_export(monkeypatch)

    await run_scheduled_exports()

    run.assert_not_awaited()
    assert config.last_export_status is None
