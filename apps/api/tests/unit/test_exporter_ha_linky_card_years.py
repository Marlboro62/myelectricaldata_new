"""Périodes annuelles de l'export content-card-linky (attributs last_year et current_year_last_year)"""

from datetime import date

import pytest

from src.services.exporters.home_assistant import HomeAssistantExporter


@pytest.mark.parametrize(
    ("today", "expected"),
    [
        (date(2026, 10, 20), (date(2025, 1, 1), date(2025, 12, 31))),
        (date(2026, 1, 1), (date(2025, 1, 1), date(2025, 12, 31))),
        # Année précédente bissextile : 366 jours, 31 décembre inclus
        (date(2025, 3, 1), (date(2024, 1, 1), date(2024, 12, 31))),
    ],
)
def test_previous_year_range_annee_civile_complete(today: date, expected: tuple[date, date]) -> None:
    assert HomeAssistantExporter._previous_year_range(today) == expected
