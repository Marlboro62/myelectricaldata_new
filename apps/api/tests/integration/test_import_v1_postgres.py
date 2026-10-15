"""Import V1 → V2 dans une vraie base PostgreSQL (MED-60).

L'écriture passe par `INSERT … ON CONFLICT DO NOTHING` sur les contraintes uniques NULLS NOT
DISTINCT du client (PostgreSQL 15+, le compose client fournit postgres:16). Base fournie par
`TEST_POSTGRES_URL` (ex. un `docker run postgres:16-alpine`), sinon lancée avec les binaires
locaux s'ils sont en version 15 ou plus ; à défaut le module est ignoré.
"""
import importlib.util
import os
import re
import shutil
import socket
import subprocess
import tempfile
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from src.models import Base
from src.models.client_mode import ConsumptionData, DataGranularity, MaxPowerData, ProductionData
from src.services.import_v1 import SOURCE, run_import, to_source_url
from src.services.local_data import LocalDataService
from tests.v1_cache import V1Cache

PDL = "12345678901234"
PDL_INCONNU = "98765432109876"


def _local_postgres() -> tuple[str, str] | None:
    initdb, pg_ctl = shutil.which("initdb"), shutil.which("pg_ctl")
    if not (initdb and pg_ctl):
        return None
    version = subprocess.run([initdb, "--version"], capture_output=True, text=True).stdout
    match = re.search(r"(\d+)\.", version)
    if not match or int(match.group(1)) < 15:
        return None
    return initdb, pg_ctl


@pytest.fixture(scope="module")
def pg_url(tmp_path_factory):
    if os.environ.get("TEST_POSTGRES_URL"):
        yield os.environ["TEST_POSTGRES_URL"]
        return
    binaries = _local_postgres()
    if not binaries:
        pytest.skip("PostgreSQL 15+ requis (TEST_POSTGRES_URL, ou initdb/pg_ctl >= 15)")
    initdb, pg_ctl = binaries
    data = tmp_path_factory.mktemp("pgdata")
    sock = Path(tempfile.mkdtemp(prefix="pg", dir="/tmp"))
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    subprocess.run([initdb, "-D", str(data), "-U", "postgres", "-A", "trust", "-E", "UTF8"],
                   check=True, capture_output=True)
    try:
        subprocess.run([pg_ctl, "-D", str(data), "-w", "-l", str(data / "log"), "-o",
                        f"-p {port} -k {sock} -c listen_addresses=127.0.0.1", "start"],
                       check=True, capture_output=True)
        yield f"postgresql+asyncpg://postgres@127.0.0.1:{port}/postgres"
    finally:
        subprocess.run([pg_ctl, "-D", str(data), "-m", "immediate", "stop"], capture_output=True)
        shutil.rmtree(sock, ignore_errors=True)


@pytest.fixture
async def session(pg_url):
    """Schéma V2 complet, un compte et le PDL `PDL` déjà synchronisé depuis la passerelle."""
    engine = create_async_engine(pg_url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
        user_id = str(uuid.uuid4())
        await conn.execute(
            text("INSERT INTO users (id, email, hashed_password, client_id, client_secret, is_active, is_admin, "
                 "email_verified, debug_mode, admin_data_sharing) "
                 "VALUES (:id, 'v1@example.org', 'x', :cid, 'x', true, false, true, false, false)"),
            {"id": user_id, "cid": f"cid-{user_id}"},
        )
        await conn.execute(
            text("INSERT INTO pdls (id, usage_point_id, user_id, has_consumption, has_production, is_active) "
                 "VALUES (:id, :pdl, :user_id, true, true, true)"),
            {"id": str(uuid.uuid4()), "pdl": PDL, "user_id": user_id},
        )
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as db:
        yield db
    await engine.dispose()


@pytest.fixture
def v1(tmp_path):
    """cache.db V1 : 2 jours de journalier, 1 journée de courbe de charge, 1 pic, sur le PDL connu et un inconnu."""
    return str(
        V1Cache(tmp_path / "cache.db")
        .usage_point(PDL)
        .usage_point(PDL_INCONNU)
        .daily(PDL, date(2020, 1, 5), 12000)
        .daily(PDL, date(2020, 1, 6), 13000)
        .daily(PDL, date(2020, 1, 5), 4000, direction="production")
        .detail_day(PDL, date(2020, 1, 5))
        .max_power(PDL, date(2020, 1, 5), 6100, datetime(2020, 1, 5, 18, 42))
        .daily(PDL_INCONNU, date(2020, 1, 5), 99999)
        .close()
    )


async def _count(db, model) -> int:
    return (await db.execute(select(func.count()).select_from(model))).scalar_one()


async def test_import_dans_une_base_vide(session, v1):
    report = await run_import(to_source_url(v1), session)

    assert report.inserted == {"consumption_data": 2 + 48, "production_data": 1, "max_power_data": 1}
    assert report.present == {"consumption_data": 0, "production_data": 0, "max_power_data": 0}
    assert report.unknown_pdls == [PDL_INCONNU]
    assert report.dry_run is False

    row = (await session.execute(
        select(ConsumptionData).where(ConsumptionData.date == date(2020, 1, 6))
    )).scalar_one()
    assert (row.value, row.granularity, row.interval_start, row.source) == (13000, DataGranularity.DAILY, None, SOURCE)
    assert row.raw_data == {"v": "13000", "d": "2020-01-06"}
    pic = (await session.execute(select(MaxPowerData))).scalar_one()
    assert (pic.value, pic.interval_start) == (6100, "18:42")
    assert await _count(session, ProductionData) == 1


async def test_donnee_v2_jamais_ecrasee(session, v1):
    """La donnée déjà synchronisée par la V2 fait foi : l'import ne remplit que les trous."""
    session.add(ConsumptionData(usage_point_id=PDL, date=date(2020, 1, 5), granularity=DataGranularity.DAILY,
                                interval_start=None, value=11111, source="myelectricaldata",
                                raw_data={"v": "11111", "d": "2020-01-05"}))
    await session.commit()

    report = await run_import(to_source_url(v1), session)

    assert report.inserted["consumption_data"] == 1 + 48
    assert report.present["consumption_data"] == 1
    row = (await session.execute(
        select(ConsumptionData).where(ConsumptionData.date == date(2020, 1, 5),
                                      ConsumptionData.granularity == DataGranularity.DAILY)
    )).scalar_one()
    assert (row.value, row.source) == (11111, "myelectricaldata")


async def test_import_rejouable(session, v1):
    await run_import(to_source_url(v1), session)

    report = await run_import(to_source_url(v1), session)

    assert report.inserted == {"consumption_data": 0, "production_data": 0, "max_power_data": 0}
    assert report.present == {"consumption_data": 50, "production_data": 1, "max_power_data": 1}
    assert await _count(session, ConsumptionData) == 50


async def test_dry_run_compte_sans_ecrire(session, v1):
    report = await run_import(to_source_url(v1), session, dry_run=True)

    assert report.dry_run is True
    assert report.inserted == {"consumption_data": 50, "production_data": 1, "max_power_data": 1}
    assert await _count(session, ConsumptionData) == 0
    assert await _count(session, MaxPowerData) == 0


async def test_filtre_pdl(session, v1):
    report = await run_import(to_source_url(v1), session, pdls=[PDL_INCONNU])

    assert report.inserted == {"consumption_data": 0, "production_data": 0, "max_power_data": 0}
    assert report.unknown_pdls == [PDL_INCONNU]


async def test_la_synchro_ne_redemande_pas_les_dates_importees(session, v1):
    """Après import, les dates V1 ne sont plus des trous pour la V2 (pas de rappel inutile de la passerelle)."""
    await run_import(to_source_url(v1), session)

    service = LocalDataService(session)
    daily = await service._find_missing_ranges(
        ConsumptionData, PDL, date(2020, 1, 5), date(2020, 1, 8), DataGranularity.DAILY
    )
    detailed = await service._find_missing_ranges(
        ConsumptionData, PDL, date(2020, 1, 5), date(2020, 1, 6), DataGranularity.DETAILED
    )

    assert daily == [(date(2020, 1, 7), date(2020, 1, 8))]
    assert detailed == []


def _load_cli():
    path = Path(__file__).resolve().parents[2] / "scripts" / "import_v1.py"
    spec = importlib.util.spec_from_file_location("import_v1_cli", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def cli(session, monkeypatch):
    """La commande `scripts/import_v1.py`, branchée sur la base de test au lieu de DATABASE_URL."""
    from src.models import database

    monkeypatch.setattr(database, "async_session_maker",
                        async_sessionmaker(session.bind, class_=AsyncSession, expire_on_commit=False))
    return _load_cli()


async def test_commande_a_blanc_puis_reelle(cli, session, v1, capsys):
    assert await cli.main([v1, "--dry-run"]) == 0
    sortie = capsys.readouterr().out
    assert "À BLANC" in sortie
    assert "50 ajoutées" in sortie
    assert PDL_INCONNU in sortie
    assert await _count(session, ConsumptionData) == 0

    assert await cli.main([v1]) == 0
    assert "Import V1 terminé" in capsys.readouterr().out
    assert await _count(session, ConsumptionData) == 50


async def test_commande_fichier_absent(cli, tmp_path, capsys):
    assert await cli.main([str(tmp_path / "absent.db")]) == 1
    assert "introuvable" in capsys.readouterr().err


async def test_commande_base_non_prise_en_charge(cli, capsys):
    assert await cli.main(["mysql://med@db/med"]) == 2
    assert "non prise en charge" in capsys.readouterr().err


async def test_gros_volume_par_lots(session, tmp_path):
    """Deux ans de courbe de charge (~35 000 lignes) : au-delà de la limite de 32 767 paramètres d'une requête."""
    cache = V1Cache(tmp_path / "gros.db").usage_point(PDL)
    start = date(2018, 1, 1)
    for i in range(730):
        cache.detail_day(PDL, start + timedelta(days=i))
    path = str(cache.close())

    report = await run_import(to_source_url(path), session)

    expected = (await session.execute(select(func.count()).select_from(ConsumptionData))).scalar_one()
    assert report.inserted["consumption_data"] == expected
    assert expected >= 730 * 46
