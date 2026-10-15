"""Importe l'historique de l'ancien client local myelectricaldata_import (« V1 ») dans ce client (MED-60).

Dans le conteneur backend du client local, après la première connexion (les PDL doivent
exister côté V2) :

    docker compose cp ./ancien/data/cache.db backend:/tmp/cache.db
    docker compose exec backend python scripts/import_v1.py /tmp/cache.db --dry-run
    docker compose exec backend python scripts/import_v1.py /tmp/cache.db

La source peut aussi être l'URL PostgreSQL de la V1 (clé `storage_uri` de son config.yaml).
Une donnée déjà présente dans la V2 n'est jamais écrasée ; la commande peut être relancée.
"""
import argparse
import asyncio
import sys

sys.path.insert(0, "/app")

from src.config import settings  # noqa: E402
from src.services.import_v1 import V1SchemaError, run_import, to_source_url  # noqa: E402

TABLES = {
    "consumption_data": "Consommation",
    "production_data": "Production",
    "max_power_data": "Puissance max",
}
MOTIFS = {
    "blacklist": "abandonnées par la V1 (blacklist)",
    "echec": "échecs de récupération V1",
    "zero_consommation": "consommation à 0 (échec V1)",
    "puissance_nulle": "puissance max à 0 (échec V1)",
    "journee_incomplete": "journées de courbe de charge incomplètes",
}


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="import_v1",
        description="Importe l'historique d'un cache.db myelectricaldata_import (V1) dans le client local V2.",
    )
    parser.add_argument("source", help="chemin du cache.db V1, ou URL postgresql:// de la base V1")
    parser.add_argument("--pdl", action="append", dest="pdls", metavar="PDL",
                        help="n'importer que ce PDL (option répétable)")
    parser.add_argument("--dry-run", action="store_true", help="compter sans rien écrire")
    return parser.parse_args(argv)


def print_report(report) -> None:
    mode = "À BLANC, rien n'a été écrit" if report.dry_run else "terminé"
    print(f"Import V1 {mode}")
    for table, label in TABLES.items():
        print(f"  {label:14} {report.inserted.get(table, 0):>8} ajoutées   {report.present.get(table, 0):>8} déjà présentes")
    for motif, count in sorted(report.skipped.items()):
        print(f"  écartées : {count} {MOTIFS.get(motif, motif)}")
    if report.unknown_pdls:
        print(f"  PDL ignorés, absents de ce client : {', '.join(report.unknown_pdls)}")
        print("  (connectez-vous d'abord à l'interface pour les synchroniser depuis votre compte, puis relancez)")


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if settings.SERVER_MODE:
        print("Erreur : l'import V1 est réservé au client local (SERVER_MODE=true ici)", file=sys.stderr)
        return 2
    try:
        url = to_source_url(args.source)
    except ValueError as e:
        print(f"Erreur : {e}", file=sys.stderr)
        return 2

    from src.models.database import async_session_maker

    try:
        async with async_session_maker() as db:
            report = await run_import(url, db, pdls=args.pdls, dry_run=args.dry_run)
    except (FileNotFoundError, V1SchemaError) as e:
        print(f"Erreur : {e}", file=sys.stderr)
        return 1
    print_report(report)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
