# Installation Docker

Installation du mode client via Docker Compose.

Trois fichiers compose sont fournis :

| Fichier | Base | Services | Pour qui |
|---------|------|----------|----------|
| `docker-compose.client.yml` | SQLite (un fichier dans le volume `myelectricaldata_data`), ou PostgreSQL externe via `DATABASE_URL` | `client` (un seul conteneur : interface et API) | **Recommandé pour une nouvelle installation** : un service, un port, un volume |
| `docker-compose.sqlite.yml` | SQLite (même volume `myelectricaldata_data`) | `backend`, `frontend` | Installations existantes en deux conteneurs (voir [Passer à un seul conteneur](#passer-de-deux-conteneurs-à-un-seul)) |
| `docker-compose.yml` | PostgreSQL 16 embarqué (volume `postgres_data`) | `postgres`, `backend`, `frontend` | Installations existantes, ou besoin d'un serveur PostgreSQL embarqué |

Tous donnent le même client (mêmes pages, mêmes exports). L'image `client` réunit le front (nginx) et l'API (FastAPI) : nginx sert l'interface sur le port 80 du conteneur et transmet `/api` à l'API, qui n'écoute qu'à l'intérieur du conteneur. Changer de base (SQLite, PostgreSQL) ne déplace pas les données : la nouvelle base repart vide et se resynchronise depuis la passerelle (3 ans de journalier, 2 ans de courbe de charge).

## Prérequis

- Docker 24+ et Docker Compose v2
- Accès réseau vers `www.v2.myelectricaldata.fr`
- Une machine **amd64** (x86_64) ou **arm64** (Raspberry Pi 4 ou 5 avec un système 64 bits, voir [Raspberry Pi](#installation-sur-raspberry-pi))

Les images `ghcr.io/myelectricaldata/myelectricaldata_new/client`, `.../backend` et `.../frontend` sont publiques : aucun compte GitHub ni `docker login` n'est nécessaire.

```bash
# Vérifier les versions
docker --version
docker compose version
```

## Installation

### Étape 1 : Cloner le dépôt

```bash
git clone https://github.com/MyElectricalData/myelectricaldata_new.git
cd myelectricaldata_new
```

### Étape 2 : Configurer

```bash
# Copier le template
cp .env.local-client.example .env

# Éditer avec vos credentials
nano .env
```

Docker Compose lit automatiquement le fichier `.env` du dossier courant.

**Contenu minimum de `.env`** :

```bash
# === OBLIGATOIRE ===
# Credentials API MyElectricalData (depuis votre compte)
MED_CLIENT_ID=cli_xxxxxxxxxxxxxxxxxxxxxxxxx
MED_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# === RECOMMANDÉ (avant le premier démarrage) ===
# Clé de signature des sessions, à générer :
#   python3 -c "import secrets; print(secrets.token_urlsafe(32))"
# Vide : clé aléatoire à chaque démarrage (sessions perdues au redémarrage)
SECRET_KEY=

# === OPTIONNEL ===
TZ=Europe/Paris
# Port de l'interface (docker-compose.client.yml)
CLIENT_PORT=8100
# Ports en deux conteneurs (docker-compose.client.yml, docker-compose.yml)
CLIENT_FRONTEND_PORT=8100
CLIENT_BACKEND_PORT=8181

# === POSTGRESQL SEULEMENT (docker-compose.yml) ===
# Mot de passe de la base PostgreSQL embarquée : lettres, chiffres, - _ . ~ seulement
# (il est repris tel quel dans l'URL de connexion, un @ / : # ? la casserait)
POSTGRES_PASSWORD=un-mot-de-passe-solide
```

Seule l'adresse http://localhost:8100 est à ouvrir : l'API répond sous http://localhost:8100/api.

:::tip PostgreSQL existant
Pour utiliser votre propre serveur PostgreSQL, renseignez `DATABASE_URL` dans `.env` (format `postgresql+asyncpg://utilisateur:motdepasse@hote:5432/base`) : `docker-compose.client.yml` l'utilise à la place de SQLite. L'hôte doit être joignable depuis le conteneur (`postgres`, le nom du service de `docker-compose.yml`, n'existe pas dans `docker-compose.client.yml`).
:::

:::info Portainer
Chaque fichier compose (de préférence `docker-compose.client.yml`) peut être déployé tel quel comme stack Portainer : renseignez `MED_CLIENT_ID` et `MED_CLIENT_SECRET` (plus `POSTGRES_PASSWORD` avec `docker-compose.yml`) dans les variables d'environnement de la stack. Aucun autre fichier n'est nécessaire.
:::

### Étape 3 : Démarrer

```bash
# Un seul conteneur (recommandé)
docker compose -f docker-compose.client.yml up -d
```

Au premier démarrage, l'API crée la base (fichier `/app/data/myelectricaldata.db` en SQLite) et son schéma. Le conteneur passe `healthy` quand l'interface et l'API répondent (`docker compose -f docker-compose.client.yml ps`).

:::note Commandes de cette page
Les exemples suivants visent `docker-compose.client.yml` et son service `client`. En deux conteneurs, remplacez-le par `docker-compose.sqlite.yml` (ou `docker-compose.yml`) et le service par `backend`.
:::

### Étape 4 : Vérifier

```bash
# Logs
docker compose -f docker-compose.client.yml logs -f

# Accéder à l'interface
open http://localhost:8100
```

---

## Première synchronisation

Au premier démarrage, les données ne sont pas encore synchronisées.

### Synchronisation automatique

Le scheduler lance une synchronisation quotidienne à 6h00.

### Synchronisation manuelle

1. Accéder à http://localhost:8100
2. Aller dans **Dashboard**
3. Cliquer sur **Synchroniser**

---

## Installation sur Raspberry Pi

:::info Images multi-architecture
Les images sont publiées pour **linux/amd64** et **linux/arm64** : Docker télécharge automatiquement celle qui correspond à la machine, l'installation est la même que sur un PC. Un système **32 bits** (ARMv7, `armv7l`) n'est pas pris en charge : installez un Raspberry Pi OS 64 bits.
:::

```bash
# Vérifier l'architecture : aarch64 (Raspberry Pi 64 bits) ou x86_64 (PC)
uname -m
```

---

## Commandes utiles

```bash
# Démarrer
docker compose -f docker-compose.client.yml up -d

# Arrêter
docker compose -f docker-compose.client.yml down

# Logs
docker compose -f docker-compose.client.yml logs -f
docker compose -f docker-compose.client.yml logs -f client

# Redémarrer
docker compose -f docker-compose.client.yml restart client

# Appliquer une modification du .env (restart ne relit pas le fichier)
docker compose -f docker-compose.client.yml up -d
```

---

## Mise à jour

```bash
# Mettre à jour le compose et la doc
git pull

# Télécharger les nouvelles images et recréer les conteneurs
docker compose -f docker-compose.client.yml pull
docker compose -f docker-compose.client.yml up -d
```

L'API applique les migrations de la base au démarrage.

---

## Passer de deux conteneurs à un seul

Depuis `docker-compose.sqlite.yml` (services `backend` et `frontend`), dans le **même dossier** : le nom du projet compose (celui du dossier) ne change pas, donc le volume `myelectricaldata_data` et sa base SQLite sont repris tels quels.

```bash
git pull
docker compose -f docker-compose.client.yml pull
# Crée le conteneur client et retire les anciens conteneurs backend et frontend
docker compose -f docker-compose.client.yml up -d --remove-orphans
```

- Le port de l'interface reste **8100** (`CLIENT_PORT`, défaut 8100 ; reportez la valeur de `CLIENT_FRONTEND_PORT` si vous l'aviez changée).
- Le port **8181** de l'API disparaît : un script, Home Assistant ou un autre outil qui appelait `http://<hôte>:8181/api/...` doit passer par `http://<hôte>:8100/api/...` (même chemin).
- Retour arrière : `docker compose -f docker-compose.sqlite.yml up -d --remove-orphans` (même volume).

Depuis `docker-compose.yml` (PostgreSQL embarqué) : la base PostgreSQL n'est pas reprise par l'image client seule. Gardez `docker-compose.yml`, ou repartez sur SQLite avec `docker-compose.client.yml` (resynchronisation depuis la passerelle), après une [sauvegarde](#postgresql).

---

## Sauvegarde

### SQLite

La copie passe par SQLite lui-même (cohérente même pendant une synchronisation), puis sort du conteneur :

```bash
docker compose -f docker-compose.client.yml exec client python -c "import sqlite3; sqlite3.connect('/app/data/myelectricaldata.db', timeout=30).backup(sqlite3.connect('/app/data/backup.db'))"
docker compose -f docker-compose.client.yml cp client:/app/data/backup.db ./backup.db
docker compose -f docker-compose.client.yml exec client rm /app/data/backup.db
```

Restauration, conteneur démarré (SQLite réécrit la base en place, puis le redémarrage repart d'un état propre) :

```bash
docker compose -f docker-compose.client.yml cp ./backup.db client:/app/data/restore.db
docker compose -f docker-compose.client.yml exec client python -c "import sqlite3; sqlite3.connect('/app/data/restore.db').backup(sqlite3.connect('/app/data/myelectricaldata.db', timeout=30))"
docker compose -f docker-compose.client.yml exec client rm /app/data/restore.db
docker compose -f docker-compose.client.yml restart client
```

:::warning Ne pas copier le fichier par-dessus la base
La base tourne en mode WAL : des écritures récentes vivent dans `myelectricaldata.db-wal`. Remplacer `myelectricaldata.db` par une copie, même conteneur arrêté, laisse ce fichier en place et SQLite le rejoue sur la base restaurée (données perdues ou base corrompue). Passez toujours par la commande ci-dessus.
:::

### PostgreSQL

```bash
docker compose -f docker-compose.yml exec postgres \
  pg_dump -U myelectricaldata myelectricaldata_client > backup.sql
```

Restauration :

```bash
docker compose -f docker-compose.yml exec -T postgres \
  psql -U myelectricaldata myelectricaldata_client < backup.sql
```

---

## Dépannage

### Le conteneur ne démarre pas ou redémarre en boucle

```bash
# Vérifier les logs (interface et API dans le même flux)
docker compose -f docker-compose.client.yml logs client

# Port déjà utilisé ? Modifier CLIENT_PORT
```

Si l'interface ou l'API s'arrête, le conteneur s'arrête avec elle et Docker le relance (`restart: unless-stopped`) : la cause est dans les dernières lignes des logs.

### Erreur de connexion API

Vérifier que `MED_CLIENT_ID` et `MED_CLIENT_SECRET` sont corrects dans `.env`, puis `docker compose -f docker-compose.client.yml up -d`.

### Erreur 405 ou page d'accueil à la place de l'API

Les appels `/api` doivent atteindre l'API. Avec `docker-compose.client.yml`, c'est interne au conteneur : mettre l'image à jour (`docker compose pull`). En deux conteneurs, vérifier que le service `frontend` a bien `API_PROXY_URL=http://backend:8000` et que l'image frontend est à jour.

### `denied` au téléchargement des images

Les images doivent être `ghcr.io/myelectricaldata/myelectricaldata_new/client` (ou `.../backend` et `.../frontend`). Un ancien compose dont les images n'ont pas le suffixe `_new` vise un registre privé : mettre à jour le dépôt (`git pull`) ou corriger les deux lignes `image:`.

### Réinitialiser la base

```bash
# ATTENTION : perte de données
docker compose -f docker-compose.client.yml down -v
docker compose -f docker-compose.client.yml up -d
```

---

## Désinstallation

```bash
# Arrêter et supprimer
docker compose -f docker-compose.client.yml down

# Supprimer les données
docker compose -f docker-compose.client.yml down -v
```
