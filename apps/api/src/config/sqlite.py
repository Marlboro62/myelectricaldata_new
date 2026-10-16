"""Base SQLite du client local (MED-65) : fichier, dossier et réglages de connexion."""

from pathlib import Path
from typing import Any

from sqlalchemy.engine import make_url

# Attente sur verrou : le scheduler (synchro, exports) et l'API écrivent en même temps,
# SQLite n'accepte qu'un écrivain à la fois.
BUSY_TIMEOUT_MS = 30_000


def is_sqlite_url(url: str) -> bool:
    return make_url(url).get_backend_name() == "sqlite"


def prepare_sqlite_file(url: str) -> None:
    """Crée le dossier du fichier SQLite : au premier démarrage, `data/` n'existe pas encore."""
    database = make_url(url).database
    if not is_sqlite_url(url) or not database or database == ":memory:" or database.startswith("file:"):
        return
    Path(database).expanduser().parent.mkdir(parents=True, exist_ok=True)


def apply_sqlite_pragmas(dbapi_connection: Any, _connection_record: Any) -> None:
    """Événement `connect` : WAL (lectures pendant une écriture), attente sur verrou, clés étrangères."""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()
