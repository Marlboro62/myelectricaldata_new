"""Heures creuses saisonnières (réforme TURPE 7) : plages été / hiver saisies dans le client"""

from datetime import date
from types import SimpleNamespace

import pytest

from src.services import enedis_contract
from src.services.exporters.tariff import (
    DEFAULT_OFFPEAK_RANGES,
    SeasonalRanges,
    is_offpeak,
    offpeak_slot_fraction,
    parse_offpeak_ranges,
    ranges_for_day,
    season_of,
    split_hp_hc_wh,
    with_seasons,
)
from src.services.sync import SyncService

SEASONS = {
    "since": "2026-11-01",
    "winter": ["00:00-06:00", "22:00-24:00"],
    "summer": ["02:00-06:00", "11:00-15:00"],
}
RAW = {"ranges": ["22:00-06:00"], "seasons": SEASONS}


def test_saison_ete_du_1er_avril_au_31_octobre():
    assert season_of(date(2027, 3, 31)) == "winter"
    assert season_of(date(2027, 4, 1)) == "summer"
    assert season_of(date(2027, 10, 31)) == "summer"
    assert season_of(date(2027, 11, 1)) == "winter"


def test_plages_habituelles_sans_les_saisons():
    # la clé « seasons » ne se mélange pas aux plages habituelles
    assert parse_offpeak_ranges(RAW) == [(22 * 60, 6 * 60)]
    assert parse_offpeak_ranges({"default": "HC (22H00-6H00)", "seasons": SEASONS}) == [(22 * 60, 6 * 60)]


def test_sans_saison_les_plages_restent_une_liste_simple():
    ranges = [(22 * 60, 6 * 60)]
    assert with_seasons(ranges, {"ranges": ["22:00-06:00"]}) is ranges
    assert with_seasons(ranges, {"ranges": ["22:00-06:00"], "seasons": {"summer": [], "winter": []}}) is ranges


def test_plages_du_jour_selon_la_saison_et_la_date_de_debut():
    ranges = with_seasons(parse_offpeak_ranges(RAW), RAW)
    assert isinstance(ranges, SeasonalRanges)
    assert ranges  # vraie comme une liste non vide
    # avant la date de début : plages habituelles
    assert ranges_for_day(ranges, date(2026, 10, 31)) == [(22 * 60, 6 * 60)]
    # hiver
    assert ranges_for_day(ranges, date(2026, 12, 15)) == [(0, 6 * 60), (22 * 60, 24 * 60)]
    # été
    assert ranges_for_day(ranges, date(2027, 7, 14)) == [(2 * 60, 6 * 60), (11 * 60, 15 * 60)]


def test_is_offpeak_suit_la_saison():
    ranges = with_seasons(parse_offpeak_ranges(RAW), RAW)
    ete, hiver, avant = date(2027, 7, 14), date(2027, 1, 14), date(2026, 10, 1)
    assert is_offpeak(ete, 12, 0, ranges)
    assert not is_offpeak(ete, 23, 0, ranges)
    assert not is_offpeak(hiver, 12, 0, ranges)
    assert is_offpeak(hiver, 23, 0, ranges)
    assert not is_offpeak(avant, 12, 0, ranges)
    assert is_offpeak(avant, 23, 0, ranges)


def test_fraction_de_creneau_et_ventilation():
    ranges = with_seasons(parse_offpeak_ranges(RAW), RAW)
    assert offpeak_slot_fraction(date(2027, 7, 14), "14:30", ranges) == 1.0
    assert offpeak_slot_fraction(date(2027, 1, 14), "14:30", ranges) == 0.0
    records = [
        SimpleNamespace(date=date(2027, 7, 14), interval_start="12:00", value=1000, raw_data=None),
        SimpleNamespace(date=date(2027, 1, 14), interval_start="12:00", value=1000, raw_data=None),
    ]
    assert split_hp_hc_wh(records, ranges) == {"hp": 500.0, "hc": 500.0}


def test_saison_non_saisie_et_sans_date_de_debut():
    raw = {"seasons": {"summer": ["11:00-17:00"]}}
    ranges = with_seasons(parse_offpeak_ranges(raw), raw)
    # aucune plage habituelle : 22h-6h pour l'hiver, non saisi
    assert list(ranges) == DEFAULT_OFFPEAK_RANGES
    assert is_offpeak(date(2025, 6, 1), 12, 0, ranges)
    assert is_offpeak(date(2027, 1, 14), 23, 0, ranges)


def test_date_de_debut_illisible_les_saisons_s_appliquent():
    raw = {"ranges": ["22:00-06:00"], "seasons": {"since": "bientôt", "summer": ["11:00-17:00"]}}
    ranges = with_seasons(parse_offpeak_ranges(raw), raw)
    assert is_offpeak(date(2020, 6, 1), 12, 0, ranges)


@pytest.mark.asyncio
async def test_synchro_conserve_les_saisons():
    service = SyncService.__new__(SyncService)
    service.db = None
    pdl = SimpleNamespace(name="PDL", selected_offer_id=None, activation_date=None, offpeak_hours=dict(RAW))
    await service._apply_remote_fields(pdl, {"offpeak_hours": {"ranges": ["23:00-07:00"]}})
    assert pdl.offpeak_hours == {"ranges": ["23:00-07:00"], "seasons": SEASONS}
    await service._apply_remote_fields(pdl, {"offpeak_hours": ["22:30-06:30"]})
    assert pdl.offpeak_hours == {"ranges": ["22:30-06:30"], "seasons": SEASONS}


def test_contrat_enedis_conserve_les_saisons(monkeypatch):
    monkeypatch.setattr(
        enedis_contract,
        "parse_contract",
        lambda _c: {"subscribed_power": 6, "offpeak_hours": {"default": "HC (23H00-7H00)"}, "activation_date": None},
    )
    pdl = SimpleNamespace(subscribed_power=None, offpeak_hours=dict(RAW), activation_date=None)
    enedis_contract.apply_contract_to_pdl(pdl, {})
    assert pdl.offpeak_hours == {"default": "HC (23H00-7H00)", "seasons": SEASONS}
