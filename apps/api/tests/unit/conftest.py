import json
from pathlib import Path
from typing import Any

import pytest

FIXTURES_ENEDIS_2026 = Path(__file__).parent.parent / "fixtures" / "enedis_2026"


@pytest.fixture
def enedis_fixture():
    """Charge une réponse Enedis capturée en prod (anonymisée) depuis tests/fixtures/enedis_2026."""

    def _load(name: str) -> Any:
        return json.loads((FIXTURES_ENEDIS_2026 / f"{name}.json").read_text())

    return _load


@pytest.fixture(autouse=True)
def _reset_sync_quota_block(monkeypatch: pytest.MonkeyPatch) -> None:
    """Le blocage de quota de la synchro est un état de module : ne pas le laisser fuir d'un test à l'autre."""
    from src.services import sync

    monkeypatch.setattr(sync, "_quota_blocked_until", None)
