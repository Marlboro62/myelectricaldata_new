"""Mode client : offres obsolètes synchronisées et sélectionnables (issue #173)

La synchro des offres demande aussi l'historique à la passerelle (`include_history=true`) :
une grille désactivée reste en base locale, donc dans le sélecteur (« Afficher les offres
obsolètes »), et une offre choisie qui devient obsolète n'est plus supprimée (ce qui effaçait
la sélection du PDL). La sélection d'une offre inactive est acceptée.
"""

from collections.abc import AsyncIterator
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import src.models  # noqa: F401  (enregistre tous les modèles)
from src.adapters.myelectricaldata import MyElectricalDataAdapter
from src.models.base import Base
from src.models.energy_provider import EnergyOffer, EnergyProvider
from src.models.pdl import PDL
from src.models.user import User
from src.routers.pdl import PDLUpdateSelectedOffer, update_pdl_selected_offer
from src.services.sync import SyncService


@pytest.fixture
async def db() -> AsyncIterator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        yield session
    await engine.dispose()


def remote_offer(offer_id: str, name: str, *, active: bool) -> dict:
    return {
        "id": offer_id,
        "provider_id": "remote-ecodigo",
        "name": name,
        "offer_type": "HC_HP",
        "subscription_price": 20.0,
        "hc_price": 0.15,
        "hp_price": 0.2,
        "power_kva": 12,
        "is_active": active,
    }


def local_offer(offer_id: str, name: str, *, active: bool) -> EnergyOffer:
    return EnergyOffer(
        id=offer_id, provider_id="local-ecodigo", name=name, offer_type="HC_HP",
        subscription_price=Decimal("20"), hc_price=Decimal("0.15"), hp_price=Decimal("0.2"),
        power_kva=12, is_active=active,
    )


def make_service(db: AsyncSession, offers: list[dict]) -> SyncService:
    service = SyncService.__new__(SyncService)
    service.db = db
    service.adapter = MagicMock()
    service.adapter.get_energy_offers = AsyncMock(return_value={"success": True, "data": offers})
    service.adapter.get_energy_providers = AsyncMock(
        return_value={"success": True, "data": [{"id": "remote-ecodigo", "name": "Ecodigo"}]}
    )
    return service


async def offers_in_db(db: AsyncSession) -> dict[str, bool]:
    rows = (await db.execute(select(EnergyOffer))).scalars().all()
    return {o.id: o.is_active for o in rows}


async def test_sync_demande_l_historique_et_garde_les_offres_obsoletes(db: AsyncSession) -> None:
    db.add(EnergyProvider(id="local-ecodigo", name="Ecodigo"))
    # Grille sélectionnée par l'utilisateur, désactivée depuis côté passerelle
    db.add(local_offer("sept", "Elec Septembre 2026", active=True))
    # Offre retirée de la passerelle : toujours supprimée (miroir)
    db.add(local_offer("supprimee", "Ancienne offre", active=True))
    await db.commit()

    service = make_service(db, [
        remote_offer("oct", "Elec Octobre 2026", active=True),
        remote_offer("sept", "Elec Septembre 2026", active=False),
        remote_offer("aout", "Elec Août 2026", active=False),
    ])
    result = await service.sync_energy_offers()

    service.adapter.get_energy_offers.assert_awaited_once_with(include_history=True)
    assert result["errors"] == []
    assert result["deleted"] == 1
    assert await offers_in_db(db) == {"oct": True, "sept": False, "aout": False}


async def test_adaptateur_transmet_include_history() -> None:
    adapter = MyElectricalDataAdapter.__new__(MyElectricalDataAdapter)
    adapter._make_request = AsyncMock(return_value={"success": True, "data": []})  # type: ignore[method-assign]

    await adapter.get_energy_offers(include_history=True)
    adapter._make_request.assert_awaited_with("GET", "/energy/offers", params={"include_history": "true"})

    await adapter.get_energy_offers()
    adapter._make_request.assert_awaited_with("GET", "/energy/offers", params=None)


async def setup_pdl(db: AsyncSession) -> tuple[User, PDL]:
    user = User(id="u1", email="local@localhost", hashed_password="x", client_id="cli_test", client_secret="s")
    db.add(user)
    db.add(EnergyProvider(id="local-ecodigo", name="Ecodigo"))
    db.add(local_offer("sept", "Elec Septembre 2026", active=False))
    pdl = PDL(id="p1", usage_point_id="12345678901234", user_id="u1")
    db.add(pdl)
    await db.commit()
    return user, pdl


async def test_selection_d_une_offre_obsolete_acceptee(db: AsyncSession) -> None:
    user, pdl = await setup_pdl(db)

    response = await update_pdl_selected_offer(
        pdl_id="p1", offer_data=PDLUpdateSelectedOffer(selected_offer_id="sept"), current_user=user, db=db
    )

    assert response.success is True
    await db.refresh(pdl)
    assert pdl.selected_offer_id == "sept"
    assert pdl.pricing_option == "HC_HP"


async def test_selection_d_une_offre_inexistante_refusee(db: AsyncSession) -> None:
    user, pdl = await setup_pdl(db)

    response = await update_pdl_selected_offer(
        pdl_id="p1", offer_data=PDLUpdateSelectedOffer(selected_offer_id="inconnue"), current_user=user, db=db
    )

    assert response.success is False
    assert response.error is not None and response.error.code == "OFFER_NOT_FOUND"
    await db.refresh(pdl)
    assert pdl.selected_offer_id is None
