"""Mode serveur : cache passerelle activé par défaut et refus de quota journalisé (MED-43).

Un conteneur local <= 2.1.x n'envoie pas `use_cache` : avec un défaut à False, il ne profitait
d'aucun cache et butait sur la limite journalière sans cache (50 appels), refusée sans aucun log.
Le front et les conteneurs >= 2.2.0 envoient le paramètre explicitement sur les routes de mesures ; ces
conteneurs appellent contrat et adresse sans lui : ces deux routes passent au cache passerelle (24 h).
"""

import importlib
import inspect
import logging
from typing import Any

import pytest

from src.routers import enedis as router
from src.services.rate_limiter import RateLimiterService

# `src.services` exporte l'instance `rate_limiter`, qui masque le module du même nom
rate_limiter_module = importlib.import_module("src.services.rate_limiter")

ROUTES = [
    "get_consumption_daily",
    "get_consumption_detail",
    "get_consumption_detail_batch",
    "get_max_power",
    "get_production_daily",
    "get_production_detail",
    "get_production_detail_batch",
    "get_contract",
    "get_address",
    "get_customer",
    "get_contact",
]

ENDPOINT = "/enedis/production/detail/{usage_point_id}"


@pytest.mark.parametrize("handler", ROUTES)
def test_use_cache_vrai_par_defaut(handler):
    default = inspect.signature(getattr(router, handler)).parameters["use_cache"].default

    assert default.default is True


# --- refus de quota journalisé ----------------------------------------------------------------


class FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def get(self, key: str) -> str | None:
        return self.store.get(key)

    async def setex(self, key: str, ttl: int, value: Any) -> bool:
        self.store[key] = str(value)
        return True

    async def set(self, key: str, value: Any, ex: int | None = None, nx: bool = False) -> bool | None:
        if nx and key in self.store:
            return None
        self.store[key] = str(value)
        return True

    async def incr(self, key: str) -> int:
        self.store[key] = str(int(self.store.get(key, "0")) + 1)
        return int(self.store[key])

    async def expire(self, key: str, ttl: int) -> bool:
        return True


@pytest.fixture
def limiter(monkeypatch) -> RateLimiterService:
    monkeypatch.setattr(rate_limiter_module.cache_service, "redis_client", FakeRedis())
    monkeypatch.setattr(rate_limiter_module.settings, "USER_DAILY_LIMIT_NO_CACHE", 2)
    monkeypatch.setattr(rate_limiter_module.settings, "USER_DAILY_LIMIT_WITH_CACHE", 3)
    return RateLimiterService()


def warnings_of(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]


async def test_premier_refus_journalise_une_seule_fois(limiter, caplog):
    caplog.set_level(logging.INFO)

    allowed = [(await limiter.increment_and_check("u1", False, endpoint=ENDPOINT))[0] for _ in range(5)]

    assert allowed == [True, True, False, False, False]
    messages = warnings_of(caplog)
    assert len(messages) == 1
    assert "u1" in messages[0]
    assert "2/2" in messages[0]
    assert ENDPOINT in messages[0]


async def test_aucun_log_tant_que_la_limite_n_est_pas_atteinte(limiter, caplog):
    caplog.set_level(logging.INFO)

    for _ in range(2):
        await limiter.increment_and_check("u1", False, endpoint=ENDPOINT)

    assert warnings_of(caplog) == []


async def test_un_log_par_utilisateur_et_par_type_de_quota(limiter, caplog):
    caplog.set_level(logging.INFO)

    for user, cache_used, calls in [("u1", False, 4), ("u2", False, 4), ("u1", True, 5)]:
        for _ in range(calls):
            await limiter.increment_and_check(user, cache_used, endpoint=ENDPOINT)

    messages = warnings_of(caplog)
    assert len(messages) == 3
    assert sum("u1" in m for m in messages) == 2
    assert sum("u2" in m for m in messages) == 1


async def test_admin_jamais_refuse_ni_journalise(limiter, caplog):
    caplog.set_level(logging.INFO)

    allowed = [(await limiter.increment_and_check("admin", False, is_admin=True))[0] for _ in range(5)]

    assert all(allowed)
    assert warnings_of(caplog) == []
