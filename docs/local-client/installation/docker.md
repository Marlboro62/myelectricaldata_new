# Installation Docker

Installation du mode client via Docker Compose.

## Prérequis

- Docker 24+ et Docker Compose v2
- Accès réseau vers `www.v2.myelectricaldata.fr`
- Une machine **amd64** (x86_64) : les images ne sont pas encore publiées pour ARM (voir [Raspberry Pi](#installation-sur-raspberry-pi))

Les images `ghcr.io/myelectricaldata/myelectricaldata_new/backend` et `.../frontend` sont publiques : aucun compte GitHub ni `docker login` n'est nécessaire.

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
# Mot de passe de la base PostgreSQL embarquée : lettres, chiffres, - _ . ~ seulement
# (il est repris tel quel dans l'URL de connexion, un @ / : # ? la casserait)
POSTGRES_PASSWORD=un-mot-de-passe-solide
# Clé de signature des sessions, à générer :
#   python3 -c "import secrets; print(secrets.token_urlsafe(32))"
# Vide : clé aléatoire à chaque démarrage (sessions perdues au redémarrage)
SECRET_KEY=

# === OPTIONNEL ===
TZ=Europe/Paris
CLIENT_FRONTEND_PORT=8100
CLIENT_BACKEND_PORT=8181
```

Le compose démarre trois services : `postgres` (base de données, volume `postgres_data`), `backend` et `frontend`. Le frontend transmet les appels `/api` au backend : seule l'adresse http://localhost:8100 est à ouvrir.

:::tip PostgreSQL existant
Pour utiliser votre propre serveur PostgreSQL, renseignez `DATABASE_URL` dans `.env` (format `postgresql+asyncpg://utilisateur:motdepasse@hote:5432/base`). SQLite n'est pas pris en charge.
:::

:::info Portainer
Le fichier `docker-compose.yml` peut être déployé tel quel comme stack Portainer : renseignez `MED_CLIENT_ID`, `MED_CLIENT_SECRET` (et `POSTGRES_PASSWORD`) dans les variables d'environnement de la stack. Aucun autre fichier n'est nécessaire.
:::

### Étape 3 : Démarrer

```bash
docker compose -f docker-compose.yml up -d
```

### Étape 4 : Vérifier

```bash
# Logs
docker compose -f docker-compose.yml logs -f

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

:::caution Pas encore d'images ARM
Les images publiées ne sont construites que pour **linux/amd64**. Sur un Raspberry Pi (ARM64 ou ARMv7), `docker compose up` échoue avec `no matching manifest for linux/arm64`. En attendant des images multi-architecture, utiliser une machine amd64.
:::

```bash
# Vérifier l'architecture (x86_64 attendu)
uname -m
```

---

## Commandes utiles

```bash
# Démarrer
docker compose -f docker-compose.yml up -d

# Arrêter
docker compose -f docker-compose.yml down

# Logs
docker compose -f docker-compose.yml logs -f
docker compose -f docker-compose.yml logs -f backend

# Redémarrer
docker compose -f docker-compose.yml restart backend

# Appliquer une modification du .env (restart ne relit pas le fichier)
docker compose -f docker-compose.yml up -d
```

---

## Mise à jour

```bash
# Mettre à jour le compose et la doc
git pull

# Télécharger les nouvelles images et recréer les conteneurs
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
```

Le backend applique les migrations de la base au démarrage.

---

## Sauvegarde

### PostgreSQL

```bash
docker compose -f docker-compose.yml exec postgres \
  pg_dump -U myelectricaldata myelectricaldata_client > backup.sql
```

### Restauration

```bash
docker compose -f docker-compose.yml exec -T postgres \
  psql -U myelectricaldata myelectricaldata_client < backup.sql
```

---

## Dépannage

### Le frontend ne démarre pas

```bash
# Vérifier les logs
docker compose -f docker-compose.yml logs frontend

# Port déjà utilisé ? Modifier CLIENT_FRONTEND_PORT
```

### Erreur de connexion API

Vérifier que `MED_CLIENT_ID` et `MED_CLIENT_SECRET` sont corrects dans `.env`, puis `docker compose -f docker-compose.yml up -d`.

### Erreur 405 ou page d'accueil à la place de l'API

Les appels `/api` doivent atteindre le backend. Vérifier que le service `frontend` a bien `API_PROXY_URL=http://backend:8000` et que l'image frontend est à jour (`docker compose pull`).

### `denied` au téléchargement des images

Les images doivent être `ghcr.io/myelectricaldata/myelectricaldata_new/backend` et `.../frontend`. Un ancien compose dont les images n'ont pas le suffixe `_new` vise un registre privé : mettre à jour le dépôt (`git pull`) ou corriger les deux lignes `image:`.

### Réinitialiser la base

```bash
# ATTENTION : perte de données
docker compose -f docker-compose.yml down -v
docker compose -f docker-compose.yml up -d
```

---

## Désinstallation

```bash
# Arrêter et supprimer
docker compose -f docker-compose.yml down

# Supprimer les données
docker compose -f docker-compose.yml down -v
```
