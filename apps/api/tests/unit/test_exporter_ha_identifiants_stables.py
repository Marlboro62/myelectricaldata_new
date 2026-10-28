"""Preuve MED-83 : entity_language ne change que `name`, jamais les identifiants des entités

Home Assistant indexe une entité par `uniq_id` : tant que `uniq_id`, `default_entity_id`, `object_id`
et les topics ne bougent pas, passer les noms en français ne renomme aucune entité existante.
Chaque export est joué en `fr` puis en `en` ; les deux séries de publications doivent être identiques
champ à champ, sauf `name` (états et attributs compris).
"""

import json
from datetime import date, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.services.exporters import home_assistant
from src.services.exporters.home_assistant import HomeAssistantExporter

PDL = "12345678901234"
NOW = datetime(2026, 10, 28, 12, 0)
TODAY = NOW.date()


class FrozenDate(date):
    @classmethod
    def today(cls) -> date:
        return TODAY


class FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None) -> datetime:  # type: ignore[override]
        return NOW


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(home_assistant, "date", FrozenDate)
    monkeypatch.setattr(home_assistant, "datetime", FrozenDatetime)


class Result:
    def __init__(self, scalar: Any = None, one: Any = None, rows: list[Any] | None = None):
        self._scalar, self._one, self._rows = scalar, one, rows or []

    def scalar(self) -> Any:
        return self._scalar

    def scalar_one_or_none(self) -> Any:
        return self._one

    def scalars(self) -> Any:
        return SimpleNamespace(all=lambda: list(self._rows))


class Recorder:
    """Client MQTT factice : garde chaque publication (topic, payload) dans l'ordre"""

    def __init__(self) -> None:
        self.published: list[tuple[str, Any]] = []

    async def publish(self, topic: str, payload: Any = None, **kwargs: Any) -> None:
        self.published.append((topic, payload))


def stats() -> MagicMock:
    service = MagicMock()
    service.get_day_total = AsyncMock(return_value=1500)
    service.db.execute = AsyncMock(return_value=Result(one=True))  # PDL avec production (lu par scalar_one_or_none)
    return service


async def play(language: str) -> list[tuple[str, Any]]:
    """Joue les exports pilotables sans base réelle et rend toutes les publications"""
    exporter = HomeAssistantExporter({"mqtt_broker": "mqtt.local", "entity_language": language})
    assert exporter.entity_language == language
    client = Recorder()

    await exporter._export_consumption_stats(client, stats(), PDL)
    await exporter._export_production_stats(client, stats(), PDL)

    summary = {
        f"{period}_{tariff}_kwh": 1.5
        for period in ("yesterday", "this_week", "this_month", "this_year")
        for tariff in ("hp", "hc")
    }
    exporter._get_hp_hc_summary = AsyncMock(return_value=summary)  # type: ignore[method-assign]
    await exporter._export_hp_hc_sensors(client, MagicMock(), PDL)

    bleu = SimpleNamespace(color=SimpleNamespace(value="BLUE"))
    offer = SimpleNamespace(
        name="Tempo EDF", offer_type="TEMPO",
        tempo_blue_hc=0.1, tempo_blue_hp=0.2, tempo_white_hc=0.3,
        tempo_white_hp=0.4, tempo_red_hc=0.5, tempo_red_hp=0.6,
    )
    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        Result(one=bleu), Result(one=bleu),
        Result(scalar=10), Result(scalar=2),
        Result(scalar=43), Result(scalar=0),
        Result(scalar=0), Result(scalar=0),
        Result(rows=[offer]),
    ])
    await exporter._export_tempo(client, db, [PDL])

    zen_db = MagicMock()
    zen_db.execute = AsyncMock(side_effect=[Result(one=None), Result(one=None)])
    await exporter._export_zen_flex(client, zen_db)

    eco_db = MagicMock()
    eco_db.execute = AsyncMock(return_value=Result(one=None, rows=[]))
    await exporter._export_ecowatt(client, eco_db)

    return client.published


def decode(published: list[tuple[str, Any]]) -> list[tuple[str, Any]]:
    out = []
    for topic, payload in published:
        try:
            out.append((topic, json.loads(payload)))
        except (TypeError, ValueError):
            out.append((topic, payload))
    return out


def configs(published: list[tuple[str, Any]]) -> dict[str, dict[str, Any]]:
    return {t: p for t, p in decode(published) if t.endswith("/config") and isinstance(p, dict)}


async def test_seul_le_nom_change_entre_fr_et_en() -> None:
    fr, en = decode(await play("fr")), decode(await play("en"))

    assert [t for t, _ in fr] == [t for t, _ in en], "les topics publiés doivent être identiques"
    assert len(fr) == len(en)

    def sans_nom(payload: Any) -> Any:
        if isinstance(payload, dict) and "name" in payload and "uniq_id" in payload:
            return {k: v for k, v in payload.items() if k != "name"}
        return payload

    for (topic, p_fr), (_, p_en) in zip(fr, en, strict=True):
        assert sans_nom(p_fr) == sans_nom(p_en), f"écart hors name sur {topic}"


async def test_identifiants_complets_et_noms_bien_traduits() -> None:
    fr, en = configs(await play("fr")), configs(await play("en"))

    # Couverture de la preuve : consommation, production, HP/HC, Tempo, Zen Flex, EcoWatt
    assert len(fr) >= 28, f"preuve trop étroite : {len(fr)} capteurs seulement"
    for topic in fr:
        assert fr[topic]["uniq_id"] == en[topic]["uniq_id"]
        assert fr[topic]["default_entity_id"] == en[topic]["default_entity_id"]
        assert fr[topic]["object_id"] == en[topic]["object_id"]
        assert fr[topic]["default_entity_id"] == f"sensor.{fr[topic]['uniq_id']}"

    # Production : les 4 capteurs doivent bien être publiés (sinon la preuve les ignorerait sans bruit)
    production = [t for t in fr if "production" in fr[t]["uniq_id"] and PDL in fr[t]["uniq_id"]]
    assert len(production) == 4, f"capteurs de production publiés : {production}"

    # Garde-fou : la langue change bien des noms (sans cela l'égalité ci-dessus serait vide de sens)
    changed = [t for t in fr if fr[t]["name"] != en[t]["name"]]
    assert len(changed) >= 25, f"seulement {len(changed)} noms diffèrent entre fr et en"
    # Les noms anglais sont les noms historiques de l'export : aucune régression pour entity_language=en
    assert en[f"homeassistant/sensor/myelectricaldata_consumption/{PDL}/config"]["name"] == "consumption"
    assert fr[f"homeassistant/sensor/myelectricaldata_consumption/{PDL}/config"]["name"] == "Consommation"


async def test_noms_francais_sans_residu_anglais() -> None:
    names = [c["name"] for c in configs(await play("fr")).values()]
    residus = ("consumption", "production", "Today", "Tomorrow", "Days ", "Price ", "Tempo Info", " this ", "yesterday")
    assert [n for n in names if any(r in n for r in residus)] == []
    assert all(n and n == n.strip() and "_" not in n for n in names), names


def test_entity_language_declaree_et_validee_a_l_enregistrement() -> None:
    """L'option figure dans le schéma (OpenAPI) et une langue inconnue est refusée avant d'être stockée."""
    from fastapi import HTTPException

    from src.models.client_mode import ExportType
    from src.routers.export import HomeAssistantConfig, _validate_export_config

    assert HomeAssistantConfig().entity_language == "fr"
    for langue in ("fr", "en"):
        _validate_export_config(ExportType.HOME_ASSISTANT, {"mqtt_broker": "mqtt.local", "entity_language": langue})
    for invalide in ("de", "FR", ""):
        with pytest.raises(HTTPException) as exc:
            _validate_export_config(ExportType.HOME_ASSISTANT, {"mqtt_broker": "mqtt.local", "entity_language": invalide})
        assert exc.value.status_code == 400
