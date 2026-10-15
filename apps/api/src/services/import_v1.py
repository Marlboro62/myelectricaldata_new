"""Import de l'historique de l'ancien client local myelectricaldata_import (« V1 ») dans le client V2 (MED-60).

La V1 garde tout dans un SQLite `/data/cache.db` (ou une base PostgreSQL via `storage_uri`),
au schéma Alembic `e990284249e4` dans toutes ses versions publiées (0.x). La V2 ne
resynchronise que 1095 jours de journalier et 730 jours de courbe de charge : sans import,
l'historique plus ancien est perdu.

Les lignes produites sont celles qu'écrirait la synchro V2 (points Data Connect 2026 dans
`raw_data`, valeurs en chaînes, courbe de charge en W horodatée au début d'intervalle), avec
`source = "myelectricaldata_v1"`. L'écriture se fait en `ON CONFLICT DO NOTHING` : une donnée
déjà présente en V2 fait toujours foi, et l'import peut être rejoué.
"""
from __future__ import annotations

import logging
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import bindparam, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from ..models.client_mode import ConsumptionData, DataGranularity, MaxPowerData, ProductionData
from ..models.pdl import PDL

logger = logging.getLogger(__name__)

V1_ALEMBIC_HEAD = "e990284249e4"
SOURCE = "myelectricaldata_v1"
PARIS = ZoneInfo("Europe/Paris")
# ~8 colonnes par ligne : reste loin des 32 767 paramètres d'une requête PostgreSQL
BATCH_SIZE = 2000
DIRECTIONS = ("consumption", "production")


class V1SchemaError(Exception):
    """La base source n'est pas un cache.db V1 au schéma connu."""


@dataclass
class V1Records:
    """Lignes V2 tirées d'une base V1, et décompte des lignes écartées par motif."""

    usage_points: list[str] = field(default_factory=list)
    consumption: list[dict[str, Any]] = field(default_factory=list)
    production: list[dict[str, Any]] = field(default_factory=list)
    max_power: list[dict[str, Any]] = field(default_factory=list)
    skipped: dict[str, int] = field(default_factory=dict)


@dataclass
class ImportReport:
    dry_run: bool
    inserted: dict[str, int] = field(default_factory=dict)
    present: dict[str, int] = field(default_factory=dict)
    unknown_pdls: list[str] = field(default_factory=list)
    skipped: dict[str, int] = field(default_factory=dict)


def to_source_url(source: str) -> str:
    """Chemin d'un cache.db ou URL PostgreSQL V1 (`storage_uri`) → URL SQLAlchemy async."""
    if "://" not in source:
        return f"sqlite+aiosqlite:///{Path(source).absolute()}"
    scheme, rest = source.split("://", 1)
    if scheme in ("postgresql", "postgres", "postgresql+psycopg2"):
        return f"postgresql+asyncpg://{rest}"
    if scheme in ("postgresql+asyncpg", "sqlite+aiosqlite"):
        return source
    if scheme == "sqlite":
        return f"sqlite+aiosqlite://{rest}"
    raise ValueError(f"Base V1 non prise en charge : {scheme} (cache.db SQLite ou PostgreSQL)")


def _engine_url(url: str) -> str:
    """SQLite ouvert en lecture seule : le cache.db n'est jamais modifié (souvent monté en :ro)."""
    if not url.startswith("sqlite"):
        return url
    path = Path(url.split(":///", 1)[1])
    if not path.is_file():
        raise FileNotFoundError(f"cache.db V1 introuvable : {path}")
    return f"sqlite+aiosqlite:///file:{path}?mode=ro&uri=true"


def _as_datetime(value: Any) -> datetime:
    """DateTime V1 : objet (PostgreSQL) ou texte `2020-01-05 00:00:00.000000` (SQLite), naïf en heure de Paris."""
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    return datetime.fromisoformat(str(value))


def _day_minutes(day: date) -> int:
    """Durée murale d'une journée à Paris : 1380 au passage à l'heure d'été, 1440 sinon.

    Le jour du retour à l'heure d'hiver dure 1500 minutes, mais la V1 indexe ses points par
    horodatage naïf : l'heure répétée n'y existe qu'une fois, la journée y compte 1440 minutes.
    """
    start = datetime.combine(day, time.min, PARIS).astimezone(UTC)
    end = datetime.combine(day + timedelta(days=1), time.min, PARIS).astimezone(UTC)
    return min(int((end - start).total_seconds() // 60), 24 * 60)


def _skip_reason(direction: str, value: int | None, blacklist: int, fail_count: int) -> str | None:
    """Motif d'écart d'une ligne journalière V1, ou None pour la garder.

    Un jour sans donnée Enedis laisse en V1 une ligne à 0 (`daily_fail_increment`), dès la
    première tentative et donc avec `fail_count = 0` : un 0 de consommation est un échec (un
    Linky consomme toujours en veille), un 0 de production peut être une vraie journée nulle.
    """
    if blacklist:
        return "blacklist"
    if fail_count:
        return "echec"
    if not value and direction == "consumption":
        return "zero_consommation"
    if not value and direction == "max_power":
        return "puissance_nulle"
    return None


def _daily_record(usage_point_id: str, when: datetime, value: int) -> dict[str, Any]:
    day = when.date()
    return {
        "usage_point_id": usage_point_id,
        "date": day,
        "granularity": DataGranularity.DAILY,
        "interval_start": None,
        "value": int(value),
        "source": SOURCE,
        "raw_data": {"v": str(value), "d": day.isoformat()},
    }


def _detail_records(rows: list[Any], skipped: Counter[str]) -> list[dict[str, Any]]:
    """Courbe de charge V1 (W moyen, horodatée au début d'intervalle), journées incomplètes écartées.

    La synchro V2 tient une date pour présente dès une ligne (`_find_missing_ranges`) : une
    journée partielle importée ne serait jamais complétée depuis la passerelle.
    """
    by_day: dict[tuple[str, date], dict[datetime, Any]] = defaultdict(dict)
    for row in rows:
        start = _as_datetime(row.date)
        by_day[(row.usage_point_id, start.date())][start] = row

    records = []
    for (usage_point_id, day), points in by_day.items():
        if sum(int(row.interval) for row in points.values()) < _day_minutes(day):
            skipped["journee_incomplete"] += 1
            continue
        for start in sorted(points):
            row = points[start]
            records.append({
                "usage_point_id": usage_point_id,
                "date": day,
                "granularity": DataGranularity.DETAILED,
                "interval_start": start.strftime("%H:%M"),
                "value": int(row.value),
                "source": SOURCE,
                "raw_data": {"v": str(row.value), "d": start.strftime("%Y-%m-%d %H:%M:%S"), "p": f"PT{int(row.interval)}M"},
            })
    return records


def _max_power_record(row: Any) -> dict[str, Any]:
    day = _as_datetime(row.date).date()
    event = _as_datetime(row.event_date) if row.event_date else None
    return {
        "usage_point_id": row.usage_point_id,
        "date": day,
        "interval_start": event.strftime("%H:%M") if event else None,
        "value": int(row.value),
        "source": SOURCE,
        "raw_data": {"v": str(row.value), "d": event.strftime("%Y-%m-%d %H:%M:%S") if event else day.isoformat()},
    }


async def load_v1(url: str, pdls: list[str] | None = None) -> V1Records:
    """Lit une base V1 (lecture seule) et la convertit en lignes V2, sans rien écrire."""
    engine = create_async_engine(_engine_url(url))
    try:
        async with engine.connect() as conn:
            try:
                revision = (await conn.execute(text("SELECT version_num FROM alembic_version"))).scalar()
            except DBAPIError as e:
                raise V1SchemaError(f"Pas une base myelectricaldata_import (table alembic_version absente) : {e}") from e
            if revision != V1_ALEMBIC_HEAD:
                raise V1SchemaError(
                    f"Révision V1 {revision} non prise en charge (attendu {V1_ALEMBIC_HEAD}, client V1 0.x à jour) : "
                    "démarrez une dernière fois la V1 à jour pour migrer son cache.db"
                )

            usage_points = [r[0] for r in await conn.execute(text("SELECT usage_point_id FROM usage_points ORDER BY 1"))]
            if pdls is not None:
                usage_points = [p for p in usage_points if p in set(pdls)]
            records = V1Records(usage_points=usage_points)
            if not usage_points:
                return records

            def query(sql: str):
                stmt = text(sql + " WHERE usage_point_id IN :pdls ORDER BY usage_point_id, date")
                return conn.execute(stmt.bindparams(bindparam("pdls", expanding=True)), {"pdls": usage_points})

            skipped: Counter[str] = Counter()
            for direction in DIRECTIONS:
                target = records.consumption if direction == "consumption" else records.production
                for row in await query(f"SELECT usage_point_id, date, value, blacklist, fail_count FROM {direction}_daily"):
                    reason = _skip_reason(direction, row.value, row.blacklist, row.fail_count)
                    if reason:
                        skipped[reason] += 1
                    else:
                        target.append(_daily_record(row.usage_point_id, _as_datetime(row.date), row.value))
                detail = await query(f"SELECT usage_point_id, date, value, interval FROM {direction}_detail")
                target.extend(_detail_records(list(detail), skipped))

            for row in await query(
                "SELECT usage_point_id, date, event_date, value, blacklist, fail_count FROM consumption_daily_max_power"
            ):
                reason = _skip_reason("max_power", row.value, row.blacklist, row.fail_count)
                if reason:
                    skipped[reason] += 1
                else:
                    records.max_power.append(_max_power_record(row))

            records.skipped = dict(skipped)
            return records
    finally:
        await engine.dispose()


async def _insert(db: AsyncSession, model: type, constraint: str, rows: list[dict[str, Any]]) -> int:
    """INSERT … ON CONFLICT DO NOTHING par lots ; renvoie le nombre de lignes réellement ajoutées."""
    inserted = 0
    for i in range(0, len(rows), BATCH_SIZE):
        stmt = pg_insert(model).values(rows[i:i + BATCH_SIZE]).on_conflict_do_nothing(constraint=constraint)
        result = await db.execute(stmt.returning(model.id))
        inserted += len(result.all())
    return inserted


async def run_import(
    url: str, db: AsyncSession, *, pdls: list[str] | None = None, dry_run: bool = False
) -> ImportReport:
    """Importe une base V1 dans la base du client V2 ; `dry_run` compte puis annule tout."""
    records = await load_v1(url, pdls)
    known = set((await db.execute(
        select(PDL.usage_point_id).where(PDL.usage_point_id.in_(records.usage_points))
    )).scalars())
    report = ImportReport(
        dry_run=dry_run,
        unknown_pdls=[p for p in records.usage_points if p not in known],
        skipped=records.skipped,
    )

    targets = [
        (ConsumptionData, "uq_consumption_data", records.consumption),
        (ProductionData, "uq_production_data", records.production),
        (MaxPowerData, "uq_max_power_data", records.max_power),
    ]
    try:
        for model, constraint, rows in targets:
            rows = [r for r in rows if r["usage_point_id"] in known]
            inserted = await _insert(db, model, constraint, rows)
            report.inserted[model.__tablename__] = inserted
            report.present[model.__tablename__] = len(rows) - inserted
    except Exception:
        await db.rollback()
        raise

    if dry_run:
        await db.rollback()
    else:
        await db.commit()
    logger.info(f"[IMPORT V1] {'(à blanc) ' if dry_run else ''}ajoutées={report.inserted} déjà présentes={report.present}")
    return report
