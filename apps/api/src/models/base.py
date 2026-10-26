from datetime import UTC, datetime
from typing import Any

from sqlalchemy import DateTime
from sqlalchemy.engine import Dialect
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.sql import func
from sqlalchemy.types import TypeDecorator


class Base(DeclarativeBase):
    pass


class TZDateTime(TypeDecorator[datetime]):
    """DateTime(timezone=True) qui garde son fuseau sous SQLite (MED-65).

    PostgreSQL stocke un timestamptz et rend des dates avec fuseau : rien ne change. SQLite n'a pas
    de type date et rend des dates naïves, que le code compare à `datetime.now(UTC)` (TypeError) :
    on y écrit l'instant en UTC et on le relit en UTC. Une date naïve est prise pour de l'UTC, comme
    le fait asyncpg et comme le vaut CURRENT_TIMESTAMP des server_default.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None or dialect.name != "sqlite" or value.tzinfo is None:
            return value
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: Any, dialect: Dialect) -> datetime | None:
        if value is None or dialect.name != "sqlite" or value.tzinfo is not None:
            return value  # type: ignore[no-any-return]
        return value.replace(tzinfo=UTC)  # type: ignore[no-any-return]


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TZDateTime(), server_default=func.now(), onupdate=func.now(), nullable=False
    )
