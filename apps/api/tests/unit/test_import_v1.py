"""Import de l'historique de l'ancien client local (myelectricaldata_import, « V1 ») : lecture et conversion (MED-60).

La V1 garde tout dans un SQLite `/data/cache.db` ; la V2 ne resynchronise que 1095 jours de
journalier et 730 jours de courbe de charge. L'import lit le `cache.db` et produit des lignes
`consumption_data`, `production_data` et `max_power_data` identiques à celles de la synchro V2
(points Data Connect 2026 dans `raw_data`, valeurs en chaînes, horodatage au début d'intervalle).
"""
from datetime import date, datetime

import pytest

from src.models.client_mode import DataGranularity
from src.services.import_v1 import (
    SOURCE,
    V1_ALEMBIC_HEAD,
    V1SchemaError,
    load_v1,
    to_source_url,
)
from tests.v1_cache import V1_HEAD, V1Cache

PDL = "12345678901234"
AUTRE_PDL = "98765432109876"


@pytest.fixture
def cache(tmp_path):
    return V1Cache(tmp_path / "cache.db").usage_point(PDL)


def test_tete_alembic_v1_connue():
    assert V1_ALEMBIC_HEAD == V1_HEAD


@pytest.mark.parametrize(
    ("argument", "attendu"),
    [
        ("/v1/cache.db", "sqlite+aiosqlite:////v1/cache.db"),
        ("postgresql://med:pw@db:5432/med", "postgresql+asyncpg://med:pw@db:5432/med"),
        ("postgresql+asyncpg://med:pw@db/med", "postgresql+asyncpg://med:pw@db/med"),
    ],
)
def test_url_de_la_source(argument, attendu):
    assert to_source_url(argument) == attendu


def test_url_de_la_source_relative_devient_absolue(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert to_source_url("data/cache.db") == f"sqlite+aiosqlite:///{tmp_path / 'data' / 'cache.db'}"


def test_url_mysql_refusee():
    with pytest.raises(ValueError):
        to_source_url("mysql://med@db/med")


async def test_revision_v1_inconnue_refusee(tmp_path):
    path = V1Cache(tmp_path / "cache.db", revision="0b59c59dad3c").usage_point(PDL).close()
    with pytest.raises(V1SchemaError, match="0b59c59dad3c"):
        await load_v1(to_source_url(str(path)))


async def test_base_sans_alembic_refusee(tmp_path):
    path = V1Cache(tmp_path / "cache.db", revision=None).usage_point(PDL).close()
    with pytest.raises(V1SchemaError):
        await load_v1(to_source_url(str(path)))


async def test_fichier_absent_refuse(tmp_path):
    with pytest.raises(FileNotFoundError):
        await load_v1(to_source_url(str(tmp_path / "absent.db")))


async def test_journalier_consommation_converti_comme_la_synchro(cache):
    path = cache.daily(PDL, date(2020, 1, 5), 12345).close()

    records = await load_v1(to_source_url(str(path)))

    assert records.usage_points == [PDL]
    assert records.consumption == [
        {
            "usage_point_id": PDL,
            "date": date(2020, 1, 5),
            "granularity": DataGranularity.DAILY,
            "interval_start": None,
            "value": 12345,
            "source": SOURCE,
            "raw_data": {"v": "12345", "d": "2020-01-05"},
        }
    ]
    assert records.production == []


async def test_zeros_et_echecs_du_journalier(cache):
    """Règle validée par l'utilisateur : un 0 de consommation est un échec V1, un 0 de production peut être réel."""
    path = (
        cache.daily(PDL, date(2020, 1, 1), 0)  # fantôme d'une première tentative ratée
        .daily(PDL, date(2020, 1, 2), 9000, blacklist=1)
        .daily(PDL, date(2020, 1, 3), 0, fail_count=4)
        .daily(PDL, date(2020, 1, 4), 8000)
        .daily(PDL, date(2020, 1, 1), 0, direction="production")  # vraie journée sans production
        .daily(PDL, date(2020, 1, 2), 0, direction="production", fail_count=2)
        .daily(PDL, date(2020, 1, 3), 0, direction="production", blacklist=1)
        .daily(PDL, date(2020, 1, 4), 1500, direction="production")
        .close()
    )

    records = await load_v1(to_source_url(str(path)))

    assert [(r["date"], r["value"]) for r in records.consumption] == [(date(2020, 1, 4), 8000)]
    assert [(r["date"], r["value"]) for r in records.production] == [
        (date(2020, 1, 1), 0),
        (date(2020, 1, 4), 1500),
    ]
    assert records.skipped == {"zero_consommation": 1, "blacklist": 2, "echec": 2}


async def test_courbe_de_charge_journee_complete(cache):
    path = cache.detail_day(PDL, date(2020, 1, 5)).close()

    records = await load_v1(to_source_url(str(path)))

    detail = [r for r in records.consumption if r["granularity"] == DataGranularity.DETAILED]
    assert len(detail) == 48
    assert detail[0] == {
        "usage_point_id": PDL,
        "date": date(2020, 1, 5),
        "granularity": DataGranularity.DETAILED,
        "interval_start": "00:00",
        "value": 100,  # W moyen, comme la synchro V2 (l'exporteur convertit avec le pas)
        "source": SOURCE,
        "raw_data": {"v": "100", "d": "2020-01-05 00:00:00", "p": "PT30M"},
    }
    assert detail[-1]["interval_start"] == "23:30"
    assert detail[-1]["date"] == date(2020, 1, 5)


async def test_courbe_de_charge_au_pas_de_10_minutes(cache):
    path = cache.detail_day(PDL, date(2020, 1, 5), interval=10).close()

    records = await load_v1(to_source_url(str(path)))

    assert len(records.consumption) == 144
    assert {r["raw_data"]["p"] for r in records.consumption} == {"PT10M"}


async def test_journee_incomplete_ecartee(cache):
    """La synchro V2 tient une date pour présente dès une ligne : une journée partielle ne serait jamais complétée."""
    path = cache.detail_day(PDL, date(2020, 1, 5), count=47).detail_day(PDL, date(2020, 1, 6)).close()

    records = await load_v1(to_source_url(str(path)))

    assert {r["date"] for r in records.consumption} == {date(2020, 1, 6)}
    assert records.skipped == {"journee_incomplete": 1}


async def test_passage_a_l_heure_d_ete_journee_de_46_points(cache):
    path = cache.detail_day(PDL, date(2020, 3, 29), count=46).close()

    records = await load_v1(to_source_url(str(path)))

    assert len(records.consumption) == 46
    assert records.skipped == {}


async def test_courbe_de_production_garde_les_zeros_de_nuit(cache):
    values = [0] * 16 + [500] * 20 + [0] * 12
    path = cache.detail_day(PDL, date(2020, 6, 1), direction="production", values=values).close()

    records = await load_v1(to_source_url(str(path)))

    assert [r["value"] for r in records.production] == values
    assert records.consumption == []


async def test_puissance_max(cache):
    path = (
        cache.max_power(PDL, date(2020, 1, 5), 6100, datetime(2020, 1, 5, 18, 42, 7))
        .max_power(PDL, date(2020, 1, 6), 0, None)  # fantôme
        .max_power(PDL, date(2020, 1, 7), 5000, datetime(2020, 1, 7, 9, 0), blacklist=1)
        .max_power(PDL, date(2020, 1, 8), 4000, None)  # pic sans heure connue
        .close()
    )

    records = await load_v1(to_source_url(str(path)))

    assert records.max_power == [
        {
            "usage_point_id": PDL,
            "date": date(2020, 1, 5),
            "interval_start": "18:42",
            "value": 6100,  # VA
            "source": SOURCE,
            "raw_data": {"v": "6100", "d": "2020-01-05 18:42:07"},
        },
        {
            "usage_point_id": PDL,
            "date": date(2020, 1, 8),
            "interval_start": None,
            "value": 4000,
            "source": SOURCE,
            "raw_data": {"v": "4000", "d": "2020-01-08"},
        },
    ]
    assert records.skipped == {"puissance_nulle": 1, "blacklist": 1}


async def test_filtre_par_pdl(cache):
    path = (
        cache.usage_point(AUTRE_PDL)
        .daily(PDL, date(2020, 1, 5), 1000)
        .daily(AUTRE_PDL, date(2020, 1, 5), 2000)
        .close()
    )

    records = await load_v1(to_source_url(str(path)), pdls=[AUTRE_PDL])

    assert records.usage_points == [AUTRE_PDL]
    assert [r["usage_point_id"] for r in records.consumption] == [AUTRE_PDL]


async def test_source_lue_sans_modification(cache):
    """L'import ne doit jamais toucher au cache.db (souvent monté en lecture seule)."""
    path = cache.daily(PDL, date(2020, 1, 5), 1000).close()
    before = path.read_bytes()

    await load_v1(to_source_url(str(path)))

    assert path.read_bytes() == before
