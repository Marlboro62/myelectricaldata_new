"""Export Energy Dashboard planifié (issue #177)

Une passe planifiée du seul Energy Dashboard (`mqtt=False, energy=True`) affichait toujours
« completed: 0 records », même réussie : le scheduler ne comptait que la partie MQTT. Et quand
l'URL ou le jeton Home Assistant manquait, l'import était sauté sans aucun message.
"""

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from src.models.client_mode import ExportType
from src.services.exporters.home_assistant import HomeAssistantExporter

PRM = "99999999999991"

HA_CONFIG = {
    "mqtt_broker": "core-mosquitto",
    "mqtt_enabled": True,
    "energy_enabled": True,
    "energy_interval_minutes": 60,
    "ha_url": "http://homeassistant:8123",
    "ha_token": "jeton",
}


def ha_config(**overrides):
    cfg = {**HA_CONFIG, **overrides}
    return SimpleNamespace(
        name="Home Assistant",
        export_type=ExportType.HOME_ASSISTANT,
        config=cfg,
        usage_point_ids=[PRM],
        is_enabled=True,
        export_interval_minutes=None,
        next_export_at=None,
        last_export_at=None,
        last_export_status=None,
        last_export_error=None,
        export_count=0,
    )


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


async def run_scheduled_exports():
    from src import scheduler as scheduler_module

    await scheduler_module.SyncScheduler()._run_scheduled_exports()


async def test_passe_energy_dashboard_compte_les_statistiques_importees(monkeypatch, caplog):
    config = ha_config()
    patch_session(monkeypatch, [config])
    results = {
        "consumption": 0, "production": 0, "tempo": 0, "ecowatt": 0, "errors": [],
        "energy_dashboard": {"success": True, "consumption": 120, "cost": 80, "production": 0},
    }
    run = AsyncMock(return_value=results)
    monkeypatch.setattr(HomeAssistantExporter, "run_full_export", run)

    with caplog.at_level(logging.INFO, logger="src.scheduler"):
        await run_scheduled_exports()

    assert run.await_args.kwargs == {"run_mqtt": False, "run_energy": True}
    assert "Export Home Assistant completed: 200 records" in caplog.text
    assert config.last_export_status == "success"


async def test_passe_energy_dashboard_sans_jeton_est_une_erreur(monkeypatch, caplog):
    """Sans jeton, plus de faux succès : la raison est journalisée et remontée dans le statut."""
    config = ha_config(ha_token="")
    patch_session(monkeypatch, [config])
    import_statistics = AsyncMock()
    monkeypatch.setattr(HomeAssistantExporter, "import_statistics", import_statistics)

    with caplog.at_level(logging.INFO):
        await run_scheduled_exports()

    import_statistics.assert_not_awaited()
    assert "Import Energy Dashboard ignoré : jeton Home Assistant manquant" in caplog.text
    assert config.last_export_status == "partial"
    assert "jeton Home Assistant manquant" in config.last_export_error


async def test_export_mqtt_sans_websocket_reste_un_succes():
    """Export MQTT seul (pas d'URL ni de jeton) : simple information, pas d'erreur."""
    exporter = HomeAssistantExporter({**HA_CONFIG, "ha_url": "", "ha_token": "", "mqtt_enabled": False})

    results = await exporter.run_full_export(MagicMock(), [PRM], run_mqtt=True, run_energy=True)

    assert results["errors"] == []
    assert "energy_dashboard" not in results


def test_raison_de_l_import_saute():
    def reason(**cfg):
        return HomeAssistantExporter({**HA_CONFIG, **cfg})._energy_skip_reason(True)

    assert reason() is None
    assert reason(energy_enabled=False) == "Energy Dashboard désactivé dans la configuration de l'export"
    assert reason(ha_url="") == "URL Home Assistant manquant dans la configuration de l'export"
    assert reason(ha_url="", ha_token="") == "URL et jeton Home Assistant manquants dans la configuration de l'export"
    assert HomeAssistantExporter({**HA_CONFIG, "ha_token": ""})._energy_skip_reason(False) is None
