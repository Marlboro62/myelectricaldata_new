import asyncio
from logging.config import fileConfig

from typing import Any

from sqlalchemy import inspect, pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

# Add src to path for imports
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

# Import models and config
from config import settings
from config.sqlite import prepare_sqlite_file
from models import Base

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Override sqlalchemy.url with our settings
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
# SQLite : au premier démarrage, le dossier du fichier n'existe pas encore
prepare_sqlite_file(settings.DATABASE_URL)

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# add your model's MetaData object here
# for 'autogenerate' support
target_metadata = Base.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def include_object(obj: Any, name: str | None, type_: str, reflected: bool, compare_to: Any) -> bool:
    """Autogenerate : ignorer ce qui est réservé à un autre dialecte (index partiels SQLite, `ddl_if`)."""
    ddl_if = getattr(obj, "_ddl_if", None)
    if ddl_if is not None and ddl_if.dialect and ddl_if.dialect != context.get_context().dialect.name:
        return False
    return True


def bootstrap_sqlite(connection: Connection) -> None:
    """Base SQLite neuve du client local (MED-65).

    Les révisions historiques sont écrites pour PostgreSQL et ne s'appliquent pas à une base SQLite
    vide : le schéma vient des modèles (index partiels SQLite compris), puis la tête est posée. Les
    révisions suivantes s'appliquent ensuite normalement, et doivent donc aussi passer sous SQLite.
    """
    target_metadata.create_all(connection)
    context.get_context().stamp(context.script, "heads")


def do_run_migrations(connection: Connection) -> None:
    # render_as_batch : les révisions autogénérées passent aussi sous SQLite (ALTER limité) ;
    # sous PostgreSQL, les opérations batch restent des ALTER TABLE ordinaires.
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,
        include_object=include_object,
    )

    sqlite = connection.dialect.name == "sqlite"
    with context.begin_transaction():
        if sqlite and not inspect(connection).has_table("alembic_version"):
            bootstrap_sqlite(connection)
        else:
            context.run_migrations()
    if sqlite:
        # DDL non transactionnel sous SQLite : begin_transaction ne valide rien, l'écriture de
        # alembic_version resterait dans une transaction annulée à la fermeture.
        connection.commit()


async def run_async_migrations() -> None:
    """In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
