"""Courbe de charge activée récemment : les semaines NO_DATA d'avant la courbe ne sont plus redemandées

Issue Marlboro62/hassio-addons#48 : collecte de la courbe activée en novembre, courbe disponible chez
Enedis depuis fin juin. Chaque synchro redemandait environ 85 semaines NO_DATA (quota de la passerelle),
et la semaine récente, la seule utile, passait en dernier.
"""

from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import src.models  # noqa: F401  (enregistre tous les modèles)
from src.models.base import Base
from src.models.client_mode import ConsumptionData, DataGranularity
from src.models.pdl import PDL
from src.models.user import User
from src.services.sync import (
    NO_DATA_MARKER,
    NO_DATA_PROBES,
    NO_DATA_STREAK,
    SyncService,
    _is_no_data,
    _no_service_before,
)

PRM = "99999999999993"
NO_DATA = {"success": False, "error": {"code": "NO_DATA", "message": "No consumption data available for this period"}}


@pytest.fixture
async def db() -> AsyncIterator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        user = User(email="client@example.org", hashed_password="x", client_id="cid", client_secret="x")
        session.add(user)
        await session.flush()
        session.add(PDL(usage_point_id=PRM, user_id=user.id, has_consumption=True, has_production=False))
        await session.commit()
        yield session
    await engine.dispose()


async def add_curve(db: AsyncSession, first: date, last: date) -> None:
    """Courbe connue en base, un relevé par jour (suffit à la détection des trous)"""
    day = first
    while day <= last:
        db.add(ConsumptionData(
            usage_point_id=PRM, date=day, granularity=DataGranularity.DETAILED,
            interval_start="00:00", value=500,
        ))
        day += timedelta(days=1)
    await db.commit()


def make_service(db: AsyncSession) -> SyncService:
    service = SyncService.__new__(SyncService)
    service.db = db
    service.adapter = MagicMock()
    service.adapter.get_consumption_detail = AsyncMock(return_value=NO_DATA)
    return service


def asked_weeks(service: SyncService) -> list[date]:
    return [date.fromisoformat(c.args[1]) for c in service.adapter.get_consumption_detail.call_args_list]


def test_no_data_reconnu() -> None:
    assert _is_no_data(NO_DATA)
    assert not _is_no_data({"success": True, "data": {"meter_reading": {}}})
    assert not _is_no_data({"success": False, "error": {"code": "ENEDIS_ERROR", "message": "ADAM-ERR0191"}})


async def test_semaines_no_data_avant_la_courbe_arretees(db: AsyncSession) -> None:
    today = date.today()
    curve_start = today - timedelta(days=140)
    await add_curve(db, curve_start, today - timedelta(days=4))  # les 3 derniers jours pas encore publiés
    service = make_service(db)

    await service._sync_consumption_detail(PRM)

    weeks = asked_weeks(service)
    # La semaine récente d'abord, la semaine vide collée à la courbe aussi jour par jour (1 jour vide suffit),
    # NO_DATA_STREAK semaines avant la courbe, puis NO_DATA_PROBES sondes : au lieu de ~100
    assert weeks[0] > curve_start
    assert len(weeks) == 1 + 1 + NO_DATA_STREAK + NO_DATA_PROBES
    status = await service._get_or_create_sync_status(PRM, "consumption", DataGranularity.DETAILED)
    assert status.error_message.startswith(NO_DATA_MARKER)
    assert _no_service_before(status, datetime.now(UTC)) == curve_start


async def test_synchro_suivante_ne_redemande_que_les_jours_recents(db: AsyncSession) -> None:
    today = date.today()
    await add_curve(db, today - timedelta(days=140), today - timedelta(days=4))
    service = make_service(db)
    await service._sync_consumption_detail(PRM)
    service.adapter.get_consumption_detail.reset_mock()

    await service._sync_consumption_detail(PRM)

    assert [week >= today - timedelta(days=4) for week in asked_weeks(service)] == [True]


async def test_trou_court_franchi(db: AsyncSession) -> None:
    """Un Linky hors ligne quelques semaines ne coupe pas la remontée vers l'historique plus ancien"""
    today = date.today()
    await add_curve(db, today - timedelta(days=60), today - timedelta(days=1))
    await add_curve(db, today - timedelta(days=200), today - timedelta(days=81))  # trou de 3 semaines
    service = make_service(db)

    await service._sync_consumption_detail(PRM)

    weeks = asked_weeks(service)
    assert min(weeks) < today - timedelta(days=200)  # on a dépassé le trou pour remonter plus loin


async def test_sans_courbe_connue_aucun_arret(db: AsyncSession) -> None:
    """Aucune courbe en base : NO_DATA ne permet pas de situer le début de la courbe (comportement inchangé)"""
    service = make_service(db)

    await service._sync_consumption_detail(PRM)

    assert len(asked_weeks(service)) > NO_DATA_STREAK * 10
    status = await service._get_or_create_sync_status(PRM, "consumption", DataGranularity.DETAILED)
    assert not (status.error_message or "").startswith(NO_DATA_MARKER)


def curve_response(first_day: date):
    """Passerelle : NO_DATA pour une plage qui commence avant first_day, la courbe sinon"""

    async def fetch(_prm: str, start: str, end: str) -> dict:
        if date.fromisoformat(start) < first_day:
            return NO_DATA
        return {"success": True, "data": {"start": start, "end": end}}

    return fetch


def parse_one_per_day(response: dict, usage_point_id: str, granularity: DataGranularity) -> list[dict]:
    """Un relevé par jour demandé (remplace l'analyse du format Enedis)"""
    if response.get("success") is not True:
        return []
    day, end = date.fromisoformat(response["data"]["start"]), date.fromisoformat(response["data"]["end"])
    records = []
    while day < end:
        records.append({
            "usage_point_id": usage_point_id, "date": day, "granularity": granularity,
            "interval_start": "00:00", "value": 500, "source": "myelectricaldata", "raw_data": {},
        })
        day += timedelta(days=1)
    return records


async def known_days(db: AsyncSession) -> set[date]:
    from sqlalchemy import select

    rows = await db.execute(select(ConsumptionData.date).where(ConsumptionData.usage_point_id == PRM))
    return {row[0] for row in rows}


async def test_premiers_jours_de_la_courbe_recuperes_jour_par_jour(db: AsyncSession) -> None:
    """La semaine qui commence avant la courbe répond NO_DATA en entier : ses derniers jours sont repris"""
    today = date.today()
    first_day = today - timedelta(days=12)
    await add_curve(db, today - timedelta(days=8), today - timedelta(days=1))  # 4 premiers jours manquants
    service = make_service(db)
    service.adapter.get_consumption_detail = AsyncMock(side_effect=curve_response(first_day))
    service._parse_meter_reading = parse_one_per_day

    await service._sync_consumption_detail(PRM)

    days = await known_days(db)
    assert all(first_day + timedelta(days=n) in days for n in range(4))
    assert first_day - timedelta(days=1) not in days


async def test_courbe_retrouvee_apres_un_long_trou(db: AsyncSession) -> None:
    """Un trou plus long que NO_DATA_STREAK semaines : une sonde retrouve la courbe plus ancienne"""
    today = date.today()
    await add_curve(db, today - timedelta(days=30), today - timedelta(days=1))
    gap_end = today - timedelta(days=30)
    gap_start = gap_end - timedelta(weeks=NO_DATA_STREAK + 2)  # trou de 6 semaines
    old_start = gap_start - timedelta(weeks=20)

    async def fetch(_prm: str, start: str, end: str) -> dict:
        s, e = date.fromisoformat(start), date.fromisoformat(end)
        if old_start <= s and e <= gap_start:
            return {"success": True, "data": {"start": start, "end": end}}
        return NO_DATA

    service = make_service(db)
    service.adapter.get_consumption_detail = AsyncMock(side_effect=fetch)
    service._parse_meter_reading = parse_one_per_day

    await service._sync_consumption_detail(PRM)

    days = await known_days(db)
    assert min(days) < gap_start  # courbe d'avant le trou retrouvée par une sonde
    assert old_start + timedelta(days=7) in days  # remontée poursuivie au-delà de la sonde


async def test_arret_no_data_garde_sa_cause_aux_synchros_suivantes(db: AsyncSession) -> None:
    """L'arrêt NO_DATA mémorisé restait « absente » une seule synchro, puis devenait « non souscrite »"""
    today = date.today()
    curve_start = today - timedelta(days=140)
    await add_curve(db, curve_start, today - timedelta(days=4))  # jours récents pas encore publiés
    service = make_service(db)

    await service._sync_consumption_detail(PRM)
    status = await service._get_or_create_sync_status(PRM, "consumption", DataGranularity.DETAILED)
    assert status.error_message.startswith(NO_DATA_MARKER)
    stopped_at = status.last_error_at

    # Synchro suivante : jour récent manquant, l'arrêt mémorisé est réécrit
    service.adapter.get_consumption_detail.reset_mock()
    await service._sync_consumption_detail(PRM)
    status = await service._get_or_create_sync_status(PRM, "consumption", DataGranularity.DETAILED)
    assert status.error_message.startswith(NO_DATA_MARKER)
    assert _no_service_before(status, datetime.now(UTC)) == curve_start
    assert status.last_error_at == stopped_at  # nouvel essai toujours 7 jours après l'arrêt
