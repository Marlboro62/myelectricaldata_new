"""Fabrique d'un `cache.db` de l'ancien client local (myelectricaldata_import, MED-60).

Reproduit le sous-ensemble du schéma V1 (révision Alembic `e990284249e4`, toutes versions
0.x publiées) que lit l'import V1 → V2 : les dates sont des DateTime SQLAlchemy stockés
en texte par SQLite (`2024-01-01 00:00:00.000000`), naïfs en heure de Paris.
"""
import hashlib
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

V1_HEAD = "e990284249e4"

SCHEMA = [
    "CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY)",
    "CREATE TABLE usage_points (usage_point_id TEXT NOT NULL PRIMARY KEY, name TEXT)",
    *[
        f"""CREATE TABLE {table} (
            id VARCHAR NOT NULL PRIMARY KEY,
            usage_point_id TEXT NOT NULL,
            date DATETIME NOT NULL,
            value INTEGER NOT NULL,
            blacklist INTEGER NOT NULL DEFAULT 0,
            fail_count INTEGER NOT NULL DEFAULT 0
        )"""
        for table in ("consumption_daily", "production_daily")
    ],
    *[
        f"""CREATE TABLE {table} (
            id VARCHAR NOT NULL PRIMARY KEY,
            usage_point_id TEXT NOT NULL,
            date DATETIME NOT NULL,
            value INTEGER NOT NULL,
            interval INTEGER NOT NULL,
            measure_type TEXT NOT NULL,
            blacklist INTEGER NOT NULL DEFAULT 0,
            fail_count INTEGER NOT NULL DEFAULT 0
        )"""
        for table in ("consumption_detail", "production_detail")
    ],
    """CREATE TABLE consumption_daily_max_power (
        id VARCHAR NOT NULL PRIMARY KEY,
        usage_point_id TEXT NOT NULL,
        date DATETIME NOT NULL,
        event_date DATETIME,
        value INTEGER NOT NULL,
        blacklist INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0
    )""",
]


def _ts(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S.%f")


def _id(usage_point_id: str, when: datetime) -> str:
    return hashlib.md5(f"{usage_point_id}/{when}".encode()).hexdigest()


class V1Cache:
    """Écrit des lignes comme le client V1 (id = md5 du PDL et de la date)."""

    def __init__(self, path: Path, revision: str | None = V1_HEAD):
        self.path = path
        self.conn = sqlite3.connect(path)
        for statement in SCHEMA:
            self.conn.execute(statement)
        if revision:
            self.conn.execute("INSERT INTO alembic_version VALUES (?)", (revision,))

    def usage_point(self, usage_point_id: str) -> "V1Cache":
        self.conn.execute("INSERT INTO usage_points VALUES (?, ?)", (usage_point_id, usage_point_id))
        return self

    def daily(self, usage_point_id: str, day: date, value: int, *, direction: str = "consumption",
              blacklist: int = 0, fail_count: int = 0) -> "V1Cache":
        when = datetime.combine(day, datetime.min.time())
        self.conn.execute(
            f"INSERT INTO {direction}_daily VALUES (?, ?, ?, ?, ?, ?)",
            (_id(usage_point_id, when), usage_point_id, _ts(when), value, blacklist, fail_count),
        )
        return self

    def detail_day(self, usage_point_id: str, day: date, *, direction: str = "consumption",
                   interval: int = 30, values: list[int] | None = None, count: int | None = None) -> "V1Cache":
        """Une journée de courbe de charge : `count` points (journée entière par défaut), en W, horodatés au DÉBUT d'intervalle."""
        points = count if count is not None else 24 * 60 // interval
        values = values or [100 + i for i in range(points)]
        start = datetime.combine(day, datetime.min.time())
        for i in range(points):
            when = start + timedelta(minutes=interval * i)
            self.conn.execute(
                f"INSERT INTO {direction}_detail VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (_id(usage_point_id, when), usage_point_id, _ts(when), values[i % len(values)], interval, "", 0, 0),
            )
        return self

    def max_power(self, usage_point_id: str, day: date, value: int, event: datetime | None, *,
                  blacklist: int = 0, fail_count: int = 0) -> "V1Cache":
        when = datetime.combine(day, datetime.min.time())
        self.conn.execute(
            "INSERT INTO consumption_daily_max_power VALUES (?, ?, ?, ?, ?, ?, ?)",
            (_id(usage_point_id, when), usage_point_id, _ts(when), _ts(event) if event else None,
             value, blacklist, fail_count),
        )
        return self

    def close(self) -> Path:
        self.conn.commit()
        self.conn.close()
        return self.path
