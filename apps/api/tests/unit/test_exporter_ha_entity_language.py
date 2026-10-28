"""Langue des noms affichés des entités Home Assistant (option entity_language)

Seul le nom change : unique_id et entity_id suggéré restent identiques, pour ne casser ni les cartes
ni les automatisations. L'anglais reprend les noms historiques de l'export.
"""

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.services.exporters.home_assistant import HomeAssistantExporter


def exporter(language: str | None = None) -> HomeAssistantExporter:
    config: dict[str, Any] = {"mqtt_broker": "mqtt.local"}
    if language is not None:
        config["entity_language"] = language
    return HomeAssistantExporter(config)


def test_francais_par_defaut() -> None:
    assert exporter().entity_language == "fr"
    assert exporter("EN").entity_language == "en"
    assert exporter("de").entity_language == "fr"  # langue inconnue : français


@pytest.mark.parametrize(
    ("key", "values", "fr", "en"),
    [
        ("consumption", {}, "Consommation", "consumption"),
        ("production", {}, "Production", "production"),
        ("consumption_last", {"days": 7}, "Consommation 7 derniers jours", "consumption last7day"),
        ("production_last", {"days": 30}, "Production 30 derniers jours", "production last30day"),
        ("today", {}, "Aujourd'hui", "Today"),
        ("tomorrow", {}, "Demain", "Tomorrow"),
        ("tempo_days_blue", {}, "Jours bleus", "Days Blue"),
        ("tempo_days_red", {}, "Jours rouges", "Days Red"),
        ("tempo_info", {}, "Infos Tempo", "Tempo Info"),
        ("ecowatt_j0", {}, "Aujourd'hui", "j0"),
        ("ecowatt_j2", {}, "Après-demain", "j2"),
    ],
)
def test_noms_fr_et_noms_historiques_en(key: str, values: dict[str, Any], fr: str, en: str) -> None:
    assert exporter()._entity_name(key, **values) == fr
    assert exporter("en")._entity_name(key, **values) == en


@pytest.mark.parametrize(
    ("language", "sensor_key", "expected"),
    [
        ("fr", "this_month_hc", "Consommation mois HC"),
        ("fr", "yesterday_hp", "Consommation hier HP"),
        ("en", "this_month_hc", "consumption this month hc"),
        ("en", "yesterday_hp", "consumption yesterday hp"),
    ],
)
def test_noms_hp_hc(language: str, sensor_key: str, expected: str) -> None:
    exp = exporter(language)
    period, tariff = sensor_key.rsplit("_", 1)
    name = exp._entity_name("consumption_period", period=exp._entity_word(period), tariff=exp._entity_word(tariff))
    assert name == expected


@pytest.mark.parametrize(
    ("language", "price_key", "expected"),
    [("fr", "blue_hc", "Prix bleu HC"), ("fr", "red_hp", "Prix rouge HP"), ("en", "white_hc", "Price White HC")],
)
def test_noms_prix_tempo(language: str, price_key: str, expected: str) -> None:
    exp = exporter(language)
    color, tariff = price_key.split("_")
    name = exp._entity_name("tempo_price", color=exp._entity_word(color), tariff=exp._entity_word(tariff).upper())
    assert name == expected


@pytest.mark.parametrize("language", ["fr", "en"])
async def test_identifiants_inchanges_selon_la_langue(language: str) -> None:
    exp = exporter(language)
    client = MagicMock()
    client.publish = AsyncMock()
    await exp._publish_sensor_old_format(
        client,
        topic="myelectricaldata_edf/tempo_info",
        name=exp._entity_name("tempo_info"),
        unique_id="myelectricaldata_tempo_info",
        device={"name": "EDF Tempo"},
        state="BLUE",
    )
    [config] = [
        json.loads(c.kwargs["payload"])
        for c in client.publish.await_args_list
        if c.args[0].endswith("/config") and c.kwargs.get("payload")
    ]
    assert config["uniq_id"] == "myelectricaldata_tempo_info"
    assert config["default_entity_id"] == "sensor.myelectricaldata_tempo_info"
    assert config["name"] == ("Infos Tempo" if language == "fr" else "Tempo Info")
