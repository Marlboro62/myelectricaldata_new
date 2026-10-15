"""Import V1 → V2 dans une vraie base PostgreSQL (MED-60).

L'écriture passe par `INSERT … ON CONFLICT DO NOTHING` sur les contraintes uniques NULLS NOT
DISTINCT du client (PostgreSQL 15+, le compose client fournit postgres:16). Base fournie par
`TEST_POSTGRES_URL` (ex. un `docker run postgres:16-alpine`), sinon lancée avec les binaires
locaux s'ils sont en version 15 ou plus ; à défaut le module est ignoré.

⚠️ La base visée est VIDÉE à chaque test (drop_all du schéma V2) : jamais une base réelle.
"""
import importlib.util
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from src.models import Base
from src.models.client_mode import (
    ConsumptionData,
    DataGranularity,
    MaxPowerData,
    ProductionData,
    SyncStatus,
    SyncStatusType,
)
from src.services.import_v1 import SOURCE, run_import, to_source_url
from src.services.local_data import LocalDataService
from tests.v1_cache import SCHEMA, V1Cache

PDL = "12345678901234"
PDL_INCONNU = "98765432109876"
V1_TABLES = ("alembic_version", "usage_points", "consumption_daily", "production_daily",
             "consumption_detail", "production_detail", "consumption_daily_max_power")


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


async def _copy_v1_to_postgres(sqlite_path: str, conn) -> None:
    """Rejoue un cache.db dans une base PostgreSQL vide (dates texte SQLite → TIMESTAMP)."""
    for statement in SCHEMA:
        await conn.execute(text(statement.replace("DATETIME", "TIMESTAMP")))
    src = sqlite3.connect(sqlite_path)
    for table in V1_TABLES:
        columns = src.execute(f"PRAGMA table_info({table})").fetchall()
        names = [c[1] for c in columns]
        dates = {c[1] for c in columns if c[2] == "DATETIME"}
        rows = [
            {n: datetime.fromisoformat(v) if n in dates and v else v for n, v in zip(names, r)}
            for r in src.execute(f"SELECT {', '.join(names)} FROM {table}")
        ]
        if rows:
            params = ", ".join(f":{n}" for n in names)
            await conn.execute(text(f"INSERT INTO {table} ({', '.join(names)}) VALUES ({params})"), rows)
    src.close()


@pytest.fixture
async def v1_postgres(pg_url, v1):
    """La même V1 que `v1`, servie par PostgreSQL (clé `storage_uri` de son config.yaml) : base jetable à côté."""
    name = f"v1_{uuid.uuid4().hex[:8]}"
    admin = create_async_engine(pg_url, isolation_level="AUTOCOMMIT")
    try:
        async with admin.connect() as conn:
            await conn.execute(text(f"CREATE DATABASE {name}"))
    except DBAPIError:
        await admin.dispose()
        pytest.skip("CREATE DATABASE refusé sur TEST_POSTGRES_URL")
    url = pg_url.replace("postgresql+asyncpg://", "postgresql://").rsplit("/", 1)[0] + f"/{name}"
    engine = create_async_engine(to_source_url(url))
    async with engine.begin() as conn:
        await _copy_v1_to_postgres(v1, conn)
    await engine.dispose()
    yield url
    async with admin.connect() as conn:
        await conn.execute(text(f"DROP DATABASE {name} WITH (FORCE)"))
    await admin.dispose()


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


async def test_journee_v2_fait_foi_meme_a_un_autre_pas(session, v1):
    """Une journée de courbe de charge déjà en V2 est gardée en entier : la V1 au même jour n'ajoute rien, quel que soit son pas."""
    session.add(ConsumptionData(usage_point_id=PDL, date=date(2020, 1, 5), granularity=DataGranularity.DETAILED,
                                interval_start="00:10", value=900, source="myelectricaldata",
                                raw_data={"v": "900", "d": "2020-01-05 00:10:00", "p": "PT10M"}))
    await session.commit()

    report = await run_import(to_source_url(v1), session)

    assert report.inserted["consumption_data"] == 2
    assert report.present["consumption_data"] == 48
    assert await _count(session, ConsumptionData) == 3


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


async def test_source_v1_sur_postgresql(session, v1_postgres):
    """`storage_uri` V1 en PostgreSQL : mêmes lignes qu'avec le cache.db (dates reçues en objets, pas en texte)."""
    report = await run_import(to_source_url(v1_postgres), session)

    assert report.inserted == {"consumption_data": 50, "production_data": 1, "max_power_data": 1}
    assert report.unknown_pdls == [PDL_INCONNU]
    pic = (await session.execute(select(MaxPowerData))).scalar_one()
    assert (pic.date, pic.interval_start, pic.raw_data["d"]) == (date(2020, 1, 5), "18:42", "2020-01-05 18:42:00")
    detail = (await session.execute(
        select(ConsumptionData.interval_start).where(ConsumptionData.granularity == DataGranularity.DETAILED)
        .order_by(ConsumptionData.interval_start)
    )).scalars().all()
    assert (detail[0], detail[-1], len(detail)) == ("00:00", "23:30", 48)


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


# --- Bornes de données des statuts de synchro (MED-64) -----------------------------------------
# Le front borne l'historique demandé par `oldest_data_date` : il doit refléter les données V1
# dès l'import, sans attendre la synchro suivante.


async def _bounds(db) -> dict[tuple[str, DataGranularity], tuple[date | None, date | None]]:
    rows = (await db.execute(select(SyncStatus).where(SyncStatus.usage_point_id == PDL))).scalars()
    return {(r.data_type, r.granularity): (r.oldest_data_date, r.newest_data_date) for r in rows}


async def test_import_pose_les_bornes_des_statuts_de_synchro(session, v1):
    await run_import(to_source_url(v1), session)

    assert await _bounds(session) == {
        ("consumption", DataGranularity.DAILY): (date(2020, 1, 5), date(2020, 1, 6)),
        ("consumption", DataGranularity.DETAILED): (date(2020, 1, 5), date(2020, 1, 5)),
        ("production", DataGranularity.DAILY): (date(2020, 1, 5), date(2020, 1, 5)),
        ("max_power", DataGranularity.DAILY): (date(2020, 1, 5), date(2020, 1, 5)),
    }


async def test_import_recule_la_borne_d_un_statut_existant_sans_toucher_au_reste(session, v1):
    """PDL déjà synchronisé depuis la passerelle : seule la borne ancienne recule, l'état de synchro reste."""
    existant = SyncStatus(
        usage_point_id=PDL, data_type="consumption", granularity=DataGranularity.DAILY,
        status=SyncStatusType.SUCCESS, oldest_data_date=date(2023, 10, 17), newest_data_date=date(2026, 10, 15),
        total_records=1095,
    )
    session.add(existant)
    await session.commit()

    await run_import(to_source_url(v1), session)

    await session.refresh(existant)
    assert (existant.oldest_data_date, existant.newest_data_date) == (date(2020, 1, 5), date(2026, 10, 15))
    assert (existant.status, existant.total_records) == (SyncStatusType.SUCCESS, 1095)


async def test_import_a_blanc_ne_touche_pas_aux_statuts(session, v1):
    await run_import(to_source_url(v1), session, dry_run=True)

    assert await _bounds(session) == {}
