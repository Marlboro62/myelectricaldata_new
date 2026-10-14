"""Métadonnées de recorder/import_statistics au point d'envoi : mean_type et unit_class (MED-48, suite de #135)

La PR #135 teste la fonction pure `_with_statistics_metadata` ; ici on vérifie le payload WebSocket réellement
envoyé par `_import_stats_in_chunks` (import, et création d'entité vide) et la capture de `ha_version` depuis
le message `auth_ok`, dont dépend l'ajout des clés.
"""

import json
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from src.services.exporters.home_assistant import HomeAssistantExporter

PDL = "00000000000000"
METADATA: dict[str, Any] = {
    "has_mean": False,
    "has_sum": True,
    "statistic_id": f"myelectricaldata:consumption_{PDL}_base",
    "name": "Consommation",
    "source": "myelectricaldata",
    "unit_of_measurement": "kWh",
}
STATS = [{"start": "2026-10-13T00:00:00+02:00", "state": 1.0, "sum": 1.0}]


def make_exporter(ha_version: str | None = None) -> HomeAssistantExporter:
    exporter = HomeAssistantExporter.__new__(HomeAssistantExporter)
    exporter.config = {"ha_url": "http://ha.local:8123", "ha_token": "token"}
    if ha_version is not None:
        exporter._ha_version = ha_version
    return exporter


def capture_sends(exporter: HomeAssistantExporter) -> list[dict[str, Any]]:
    """Remplace _ws_send_and_receive : garde chaque message envoyé, répond success"""
    sent: list[dict[str, Any]] = []

    async def send_and_receive(ws: Any, message: dict[str, Any], msg_id: int, timeout: int = 300) -> dict[str, Any]:
        sent.append(message)
        return {"id": msg_id, "success": True, "result": []}

    exporter._ws_send_and_receive = send_and_receive  # type: ignore[method-assign,assignment]
    return sent


async def imported_metadata(
    exporter: HomeAssistantExporter, stats: list[dict[str, Any]], metadata: dict[str, Any] = METADATA
) -> list[dict[str, Any]]:
    sent = capture_sends(exporter)
    await exporter._import_stats_in_chunks(MagicMock(), stats, metadata, msg_id_start=1, sync_delay_ms=0)
    return [m["metadata"] for m in sent if m["type"] == "recorder/import_statistics"]


async def test_payload_energie_sur_ha_recent() -> None:
    (md,) = await imported_metadata(make_exporter("2026.9.4"), STATS)
    assert md["mean_type"] == 0
    assert md["unit_class"] == "energy"
    assert md["has_sum"] is True  # le reste des métadonnées est intact
    assert "mean_type" not in METADATA  # le dict d'origine n'est pas modifié


async def test_payload_cout_sans_classe_d_unite() -> None:
    (md,) = await imported_metadata(make_exporter("2026.9.4"), STATS, {**METADATA, "unit_of_measurement": "EUR"})
    assert md["mean_type"] == 0
    assert md["unit_class"] is None


async def test_entite_vide_recoit_aussi_les_cles() -> None:
    """Le chemin « stats vides » (création de l'entité dans HA) passe par le même envoi"""
    (md,) = await imported_metadata(make_exporter("2026.9.4"), [])
    assert md["mean_type"] == 0
    assert md["unit_class"] == "energy"


async def test_ha_ancien_ne_recoit_pas_les_cles() -> None:
    """HA < 2025.11 refuse ces clés (schéma strict) : elles ne sont pas envoyées"""
    (md,) = await imported_metadata(make_exporter("2025.10.4"), STATS)
    assert "mean_type" not in md
    assert "unit_class" not in md


async def test_version_jamais_captee_traitee_comme_recente() -> None:
    """Exporteur qui n'a jamais reçu auth_ok : pas d'attribut _ha_version, les clés sont envoyées"""
    (md,) = await imported_metadata(make_exporter(None), STATS)
    assert md["mean_type"] == 0


async def test_ha_version_captee_a_l_authentification() -> None:
    """`ha_version` du message auth_ok est retenue sur l'exporteur, avant tout import"""
    exporter = make_exporter()
    exporter._has_websocket_config = MagicMock(return_value=True)  # type: ignore[method-assign]
    capture_sends(exporter)

    @asynccontextmanager
    async def connect():  # type: ignore[no-untyped-def]
        ws = MagicMock()
        ws.recv = AsyncMock(
            side_effect=[
                json.dumps({"type": "auth_required", "ha_version": "2026.9.4"}),
                json.dumps({"type": "auth_ok", "ha_version": "2026.9.4"}),
            ]
        )
        ws.send = AsyncMock()
        yield ws

    exporter._ws_connect = connect  # type: ignore[method-assign,assignment]
    result = await exporter.list_statistics()
    assert result["success"] is True
    assert exporter._ha_version == "2026.9.4"
