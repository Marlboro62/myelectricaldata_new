"""Proposer un fournisseur seul par une contribution NEW_PROVIDER (MED-80, issue #162).

« Proposer un nouveau fournisseur » appelait `POST /energy/providers`, réservé à `offers.edit` : un
contributeur recevait un 403. Il envoie désormais une contribution NEW_PROVIDER sans offre ni puissance,
qu'un modérateur approuve. Marqueur retenu : `offer_name = "[NOUVEAU FOURNISSEUR] <nom>"`, comme
`[SUPPRESSION FOURNISSEUR]` et `[RENOMMAGE]`. L'approbation unitaire (`approve_contribution`) et en lot
(`bulk_approve_contributions`) doivent laisser la même base : fournisseur créé (ou réutilisé par nom,
`EnergyProvider.name` est unique), aucune offre pour un fournisseur seul.
"""
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from src.models import EnergyOffer, EnergyProvider, OfferContribution, User
from src.models.base import Base
from src.routers import energy_offers

SITE = "https://www.eniplenitude.fr"
GRILLE = "https://example.org/grille.pdf"
MARQUEUR = "[NOUVEAU FOURNISSEUR] Plenitude"


@pytest.fixture
async def db() -> AsyncIterator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    tables = [User.__table__, EnergyProvider.__table__, EnergyOffer.__table__, OfferContribution.__table__]
    async with engine.begin() as conn:
        await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        yield session
    await engine.dispose()


@pytest.fixture(autouse=True)
def sans_notification(monkeypatch: pytest.MonkeyPatch) -> None:
    async def rien(*_args: object, **_kwargs: object) -> None:
        return None

    for nom in ("send_contribution_notification", "send_batch_contribution_notification", "send_batch_approval_notification"):
        monkeypatch.setattr(energy_offers, nom, rien)
    monkeypatch.setattr(energy_offers.slack_service, "send_contribution_notification", rien)
    monkeypatch.setattr(energy_offers.slack_service, "send_batch_contribution_notification", rien)


@pytest.fixture
async def contributeur(db: AsyncSession) -> SimpleNamespace:
    """Un contributeur sans droit particulier : ni admin, ni modérateur."""
    user = User(email="c@example.org", hashed_password="x", client_id="cid", client_secret="s")
    db.add(user)
    await db.commit()
    return SimpleNamespace(id=user.id, email=user.email, is_admin=False, role=None)


def fournisseur_seul(**champs: object) -> dict:
    """Corps envoyé par NewProviderForm : pas de puissance, pas de prix, un lien vers la grille."""
    return {
        "contribution_type": "NEW_PROVIDER",
        "provider_name": "Plenitude",
        "provider_website": SITE,
        "offer_name": MARQUEUR,
        "offer_type": "BASE",
        "price_sheet_url": GRILLE,
        **champs,
    }


async def nb_fournisseurs(db: AsyncSession, nom: str) -> int:
    return (await db.execute(select(func.count()).select_from(EnergyProvider).where(EnergyProvider.name == nom))).scalar_one()


async def nb_offres(db: AsyncSession) -> int:
    return (await db.execute(select(func.count()).select_from(EnergyOffer))).scalar_one()


async def en_attente(db: AsyncSession) -> list[OfferContribution]:
    db.expire_all()
    return list((await db.execute(select(OfferContribution))).scalars().all())


# --- Soumission -------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_contribute_accepte_un_fournisseur_seul_sans_puissance(db: AsyncSession, contributeur: SimpleNamespace) -> None:
    reponse = await energy_offers.create_contribution(fournisseur_seul(), current_user=contributeur, db=db)

    assert reponse.success, reponse.error
    [contribution] = await en_attente(db)
    assert (contribution.contribution_type, contribution.status) == ("NEW_PROVIDER", "pending")
    assert (contribution.provider_name, contribution.provider_website) == ("Plenitude", SITE)
    assert contribution.offer_name == MARQUEUR
    assert contribution.power_kva is None and not contribution.power_variants
    assert contribution.price_sheet_url == GRILLE


@pytest.mark.asyncio
async def test_contribute_refuse_un_fournisseur_qui_existe_deja(db: AsyncSession, contributeur: SimpleNamespace) -> None:
    db.add(EnergyProvider(name="Plenitude"))
    await db.commit()

    reponse = await energy_offers.create_contribution(fournisseur_seul(), current_user=contributeur, db=db)

    assert not reponse.success
    assert reponse.error.code == "PROVIDER_EXISTS"
    assert await en_attente(db) == []


@pytest.mark.asyncio
async def test_contribute_refuse_le_doublon_sans_tenir_compte_de_la_casse(db: AsyncSession, contributeur: SimpleNamespace) -> None:
    db.add(EnergyProvider(name="Plenitude"))
    await db.commit()

    reponse = await energy_offers.create_contribution(
        fournisseur_seul(provider_name="  PLENITUDE ", offer_name="[NOUVEAU FOURNISSEUR] PLENITUDE"),
        current_user=contributeur,
        db=db,
    )

    assert not reponse.success
    assert reponse.error.code == "PROVIDER_EXISTS"


@pytest.mark.asyncio
async def test_contribute_exige_toujours_le_lien_de_la_grille_pour_un_contributeur(db: AsyncSession, contributeur: SimpleNamespace) -> None:
    reponse = await energy_offers.create_contribution(fournisseur_seul(price_sheet_url=""), current_user=contributeur, db=db)

    assert not reponse.success
    assert reponse.error.code == "MISSING_FIELD"


@pytest.mark.asyncio
async def test_batch_accepte_un_fournisseur_seul_sans_puissance(db: AsyncSession, contributeur: SimpleNamespace) -> None:
    reponse = await energy_offers.create_contributions_batch(
        {"contributions": [fournisseur_seul()], "price_sheet_url": GRILLE}, current_user=contributeur, db=db
    )

    assert reponse.success, reponse.error
    assert reponse.data["created"] == 1, reponse.data
    assert reponse.data["errors"] == 0, reponse.data
    [contribution] = await en_attente(db)
    assert (contribution.contribution_type, contribution.offer_name) == ("NEW_PROVIDER", MARQUEUR)


@pytest.mark.asyncio
async def test_batch_refuse_un_fournisseur_qui_existe_deja(db: AsyncSession, contributeur: SimpleNamespace) -> None:
    db.add(EnergyProvider(name="Plenitude"))
    await db.commit()

    reponse = await energy_offers.create_contributions_batch(
        {"contributions": [fournisseur_seul()], "price_sheet_url": GRILLE}, current_user=contributeur, db=db
    )

    assert reponse.data["created"] == 0
    assert reponse.data["errors"] == 1
    assert "Plenitude" in reponse.data["error_details"][0]
    assert await en_attente(db) == []


# --- Approbation : les deux chemins ----------------------------------------------------------------

Approbation = Callable[[AsyncSession, list[str]], Awaitable[None]]


async def une_par_une(db: AsyncSession, ids: list[str]) -> None:
    admin = SimpleNamespace(id=None, email="admin@example.org")
    for cid in ids:
        reponse = await energy_offers.approve_contribution(cid, current_user=admin, db=db)
        assert reponse.success, reponse.error


async def en_lot(db: AsyncSession, ids: list[str]) -> None:
    admin = SimpleNamespace(id=None, email="admin@example.org")
    reponse = await energy_offers.bulk_approve_contributions({"contribution_ids": ids}, current_user=admin, db=db)
    assert reponse.success, reponse.error
    assert reponse.data["processed"] == len(ids), reponse.data


CHEMINS = [pytest.param(une_par_une, id="unitaire"), pytest.param(en_lot, id="lot")]


async def soumise(db: AsyncSession, contributeur: SimpleNamespace, **champs: object) -> str:
    base = {"offer_name": MARQUEUR, "offer_type": "BASE", "valid_from": datetime(2026, 10, 27, tzinfo=UTC)}
    contribution = OfferContribution(
        contributor_user_id=contributeur.id, contribution_type="NEW_PROVIDER", provider_name="Plenitude",
        provider_website=SITE, price_sheet_url=GRILLE, **{**base, **champs},
    )
    db.add(contribution)
    await db.commit()
    return contribution.id


@pytest.mark.asyncio
@pytest.mark.parametrize("approuver", CHEMINS)
async def test_approbation_cree_le_fournisseur_sans_offre(
    db: AsyncSession, contributeur: SimpleNamespace, approuver: Approbation
) -> None:
    cid = await soumise(db, contributeur)

    await approuver(db, [cid])

    db.expire_all()
    fournisseur = (await db.execute(select(EnergyProvider).where(EnergyProvider.name == "Plenitude"))).scalar_one()
    assert fournisseur.website == SITE
    assert await nb_offres(db) == 0
    assert (await db.get(OfferContribution, cid)).status == "approved"


@pytest.mark.asyncio
@pytest.mark.parametrize("approuver", CHEMINS)
async def test_approbation_reutilise_un_fournisseur_du_meme_nom(
    db: AsyncSession, contributeur: SimpleNamespace, approuver: Approbation
) -> None:
    """Créé entre la soumission et l'approbation (par un modérateur, ou par une autre contribution)."""
    cid = await soumise(db, contributeur)
    db.add(EnergyProvider(name="Plenitude"))
    await db.commit()

    await approuver(db, [cid])

    assert await nb_fournisseurs(db, "Plenitude") == 1
    assert await nb_offres(db) == 0
    assert (await db.get(OfferContribution, cid)).status == "approved"


@pytest.mark.asyncio
@pytest.mark.parametrize("approuver", CHEMINS)
async def test_approbation_rattache_l_offre_d_une_contribution_complete_au_fournisseur_existant(
    db: AsyncSession, contributeur: SimpleNamespace, approuver: Approbation
) -> None:
    """NEW_PROVIDER avec offre (import IA d'un fournisseur inconnu) : le doublon de nom ne casse plus l'approbation."""
    existant = EnergyProvider(name="Plenitude")
    db.add(existant)
    await db.commit()
    existant_id = existant.id  # relu avant expire_all : un chargement paresseux échouerait hors greenlet
    cid = await soumise(
        db, contributeur, offer_name="Pleniweb", power_kva=6,
        pricing_data={"subscription_price": 15.0, "base_price": 0.2},
    )

    await approuver(db, [cid])

    assert await nb_fournisseurs(db, "Plenitude") == 1
    db.expire_all()
    [offre] = (await db.execute(select(EnergyOffer))).scalars().all()
    assert (offre.provider_id, offre.name, offre.power_kva) == (existant_id, "Pleniweb", 6)


@pytest.mark.asyncio
async def test_lot_de_deux_contributions_du_meme_fournisseur_n_en_cree_qu_un(
    db: AsyncSession, contributeur: SimpleNamespace
) -> None:
    premiere = await soumise(db, contributeur)
    seconde = await soumise(db, contributeur)

    await en_lot(db, [premiere, seconde])

    assert await nb_fournisseurs(db, "Plenitude") == 1
    assert await nb_offres(db) == 0
