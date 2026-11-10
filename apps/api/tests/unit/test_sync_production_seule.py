"""Mode client : PDL de production seule (revente totale, contrat CRAE) sans épuiser le quota

- pas de synchro de consommation quand le PDL n'a pas de consommation (has_consumption=False) ;
- la production ne remonte pas avant la mise en service du PDL quand le contrat ne la donne pas ;
- ADAM-DC-0007 (client non titulaire à cette période) arrête la remontée de la courbe, comme ADAM-ERR0191.
"""

from collections.abc import AsyncIterator
from datetime import date, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import src.models  # noqa: F401  (enregistre tous les modèles)
from src.models.base import Base
from src.models.pdl import PDL
from src.models.user import User
from src.services.sync import SyncService, _is_no_service

PRM = "99999999999992"
NO_DATA = {"success": False, "error": {"code": "NO_DATA", "message": "No data"}}
NOT_HOLDER = {"success": False, "data": None, "error": {"code": "ENEDIS_ERROR", "message": "ADAM-DC-0007: client non titulaire"}}


@pytest.fixture
async def db() -> AsyncIterator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        user = User(email="client@example.org", hashed_password="x", client_id="cid", client_secret="x")
        session.add(user)
        await session.flush()
        session.add(PDL(usage_point_id=PRM, user_id=user.id, has_consumption=False, has_production=True))
        await session.commit()
        yield session
    await engine.dispose()


def make_service(db: AsyncSession, detail: dict = NO_DATA) -> SyncService:
    service = SyncService.__new__(SyncService)
    service.db = db
    service.adapter = MagicMock()
    for name in ("get_consumption_detail", "get_consumption_daily", "get_consumption_max_power",
                 "get_production_daily", "get_contract", "get_address"):
        setattr(service.adapter, name, AsyncMock(return_value=NO_DATA))
    service.adapter.get_production_detail = AsyncMock(return_value=detail)
    return service


async def test_pas_de_consommation_pour_un_pdl_de_production_seule(db: AsyncSession) -> None:
    service = make_service(db)

    result = await service.sync_pdl(PRM)

    for name in ("get_consumption_detail", "get_consumption_daily", "get_consumption_max_power"):
        assert getattr(service.adapter, name).await_count == 0, name
    assert result["consumption_daily"] == result["consumption_detail"] == result["max_power"] == "skipped (no consumption)"
    assert service.adapter.get_production_daily.await_count >= 1


async def test_consommation_toujours_synchronisee_par_defaut(db: AsyncSession) -> None:
    pdl = (await db.execute(select(PDL).where(PDL.usage_point_id == PRM))).scalar_one()
    pdl.has_consumption = True
    await db.commit()
    service = make_service(db)

    await service.sync_pdl(PRM)

    assert service.adapter.get_consumption_daily.await_count >= 1
    assert service.adapter.get_consumption_detail.await_count >= 1


async def test_production_bornee_a_la_mise_en_service_du_pdl(db: AsyncSession) -> None:
    activation = date.today() - timedelta(days=60)
    pdl = (await db.execute(select(PDL).where(PDL.usage_point_id == PRM))).scalar_one()
    pdl.activation_date = activation
    await db.commit()
    service = make_service(db)

    await service._sync_production_daily(PRM)

    starts = [date.fromisoformat(c.args[1]) for c in service.adapter.get_production_daily.call_args_list]
    assert min(starts) == activation


def test_non_titulaire_traite_comme_courbe_non_souscrite() -> None:
    assert _is_no_service(NOT_HOLDER)
    assert _is_no_service({"error": {"message": "ADAM-ERR0191: aucun service souscrit"}})
    assert not _is_no_service(NO_DATA)


async def test_courbe_arretee_au_premier_non_titulaire(db: AsyncSession) -> None:
    service = make_service(db, detail=NOT_HOLDER)

    await service._sync_production_detail(PRM)

    assert service.adapter.get_production_detail.await_count == 1  # au lieu d'une centaine de semaines
