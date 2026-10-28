# Migrer depuis l'ancien client (V1)

Cette page s'adresse aux utilisateurs de l'ancien client local **MyElectricalData V1**
(dépôt `myelectricaldata_import`, image `m4dm4rtig4n/myelectricaldata`, interface sur le port 5000,
configuration dans `config.yaml`). Elle explique comment passer au client local V2 **sans perdre
l'historique** déjà téléchargé.

## Ce qui change

| | V1 (`myelectricaldata_import`) | V2 (client local) |
|---|---|---|
| Configuration | `/data/config.yaml` | fichier `.env` et interface web |
| Stockage | SQLite `/data/cache.db` (ou PostgreSQL via `storage_uri`) | SQLite `/app/data/myelectricaldata.db` (recommandé) ou PostgreSQL 16 |
| Compte | compte et token de l'ancienne passerelle | compte sur [www.v2.myelectricaldata.fr](https://www.v2.myelectricaldata.fr), identifiants `MED_CLIENT_ID` / `MED_CLIENT_SECRET` |
| Interface | port 5000 | port 8100 (interface, API sous `/api`) ; 8181 pour l'API en deux conteneurs |

La V2 s'appuie sur une **nouvelle passerelle** : votre compte et votre token V1 ne sont pas repris,
il faut créer un compte V2 et y redonner le consentement Enedis.

La V2 ne récupère auprès d'Enedis que **3 ans de consommation journalière** et **2 ans de courbe de
charge**. Tout l'historique plus ancien que la V1 avait accumulé serait perdu sans l'import décrit
à l'étape 3.

## Ce qui est repris, ce qui ne l'est pas

**Repris par l'import** (pour chaque PDL présent à la fois dans la V1 et dans la V2) :

- consommation et production journalières ;
- courbes de charge de consommation et de production, journée par journée ;
- puissance maximale atteinte chaque jour, avec son heure.

**Non repris** :

- la configuration (`config.yaml`) : les exports se reconfigurent dans l'interface V2 (étape 4) ;
- Tempo et EcoWatt : la V2 les récupère elle-même auprès de la passerelle ;
- les lignes que la V1 avait enregistrées sans donnée réelle (voir ci-dessous).

:::info Lignes écartées
Quand Enedis ne renvoyait rien pour un jour, la V1 enregistrait une ligne à 0 et réessayait plus
tard. L'import ignore ces lignes pour ne pas inscrire de faux zéros dans la V2 :

- consommation journalière à 0 (un compteur consomme toujours un peu, ne serait-ce qu'en veille) ;
- puissance maximale à 0 ;
- toute ligne en échec ou abandonnée par la V1 (`fail_count` ou `blacklist`).

Une production journalière à 0 est une vraie donnée possible (un jour sans soleil), mais aussi la
trace d'une première tentative ratée : dans les 3 ans que la V2 synchronise elle-même, l'import la
lui laisse (elle ramènera la vraie valeur) ; plus ancienne, il la garde.

Même logique pour une journée de courbe de charge incomplète : dans les 2 ans que la V2 synchronise,
elle est écartée en entier pour que la V2 la récupère complète ; plus ancienne, les points présents
sont gardés tels quels.
:::

**Aucune donnée de la V2 n'est écrasée** : si une date existe déjà dans la V2 (synchronisée depuis
Enedis), c'est elle qui fait foi, et l'import ne remplit que les dates manquantes. La commande peut
donc être relancée sans risque.

## Avant de commencer : sauvegarder

Arrêtez la V1 et copiez son dossier de données en entier (`cache.db` et `config.yaml`) :

```bash
cd /chemin/vers/myelectricaldata_v1
docker compose stop
cp -a data data.sauvegarde-$(date +%Y%m%d)
```

:::warning Ne modifiez pas le `config.yaml` de la V1
Si vous retirez un PDL du `config.yaml` puis redémarrez la V1, elle **efface toutes les données de ce
PDL** du `cache.db`. Gardez le fichier tel quel jusqu'à la fin de la migration.
:::

L'import ouvre le `cache.db` en lecture seule : il ne le modifie jamais.

## Étape 1 : créer le compte V2

1. Rendez-vous sur [www.v2.myelectricaldata.fr](https://www.v2.myelectricaldata.fr) et cliquez sur
   **Créer un compte**. Le compte V1 n'existe pas sur cette passerelle, l'inscription est nécessaire
   même si vous utilisiez déjà MyElectricalData.
2. Une fois connecté, lancez le **Consentement Enedis** : vous êtes redirigé vers votre espace Enedis
   pour autoriser l'accès à vos points de livraison (PDL). Les PDL autorisés apparaissent ensuite
   dans votre tableau de bord.
3. Vérifiez que **tous les PDL de votre `config.yaml` V1** sont bien présents. Un PDL déjà rattaché à
   un autre compte V2 est refusé : dans ce cas, utilisez ce compte-là.
4. Dans **Paramètres** > **API**, copiez le **Client ID** et le **Client Secret** : ce sont les
   identifiants du client local (voir [Configuration](./configuration.md)).

## Étape 2 : installer la V2 à côté de la V1

Installez le client local V2 avec [Docker](./installation/docker.md) ou
[Helm](./installation/helm.md), en renseignant `MED_CLIENT_ID` et `MED_CLIENT_SECRET`. Les ports par
défaut (8100, et 8181 en deux conteneurs) ne croisent pas celui de la V1 (5000) : les deux peuvent coexister le temps de
la migration.

Ouvrez l'interface (http://localhost:8100) et attendez que vos PDL apparaissent : le client les
récupère auprès de la passerelle au démarrage, puis lance la première synchronisation. L'import ne
traite que les PDL déjà connus de la V2.

:::tip
L'import peut se faire avant ou après la fin de la première synchronisation : dans les deux cas, les
données venues d'Enedis sont conservées et l'import ne comble que les trous.
:::

## Étape 3 : importer l'historique V1

La commande `scripts/import_v1.py` est incluse dans les images client et backend. Elle lit le `cache.db` V1 et
écrit dans la base de la V2, SQLite ou PostgreSQL 15 ou plus (le compose et le chart Helm
fournissent PostgreSQL 16 ; seule une base externe plus ancienne est refusée).

### Avec Docker Compose

Depuis le dossier de la V2. Les exemples visent `docker-compose.client.yml` et son service `client` ; en deux
conteneurs, remplacez-le par `docker-compose.sqlite.yml` (ou `docker-compose.yml` avec PostgreSQL) et
le service par `backend`.

```bash
# 1. Copier le cache.db V1 dans le conteneur
docker compose -f docker-compose.client.yml cp /chemin/vers/myelectricaldata_v1/data/cache.db client:/tmp/cache.db

# 2. Simulation : compte ce qui serait importé, sans rien écrire
docker compose -f docker-compose.client.yml exec client python scripts/import_v1.py /tmp/cache.db --dry-run

# 3. Import réel
docker compose -f docker-compose.client.yml exec client python scripts/import_v1.py /tmp/cache.db

# 4. Supprimer la copie (le cache.db contient aussi les anciens tokens V1)
docker compose -f docker-compose.client.yml exec client rm /tmp/cache.db
```

Exemple de sortie :

```text
Import V1 terminé
  Consommation       2898 ajoutées          1 déjà présentes
  Production         1460 ajoutées          0 déjà présentes
  Puissance max      1460 ajoutées          0 déjà présentes
  écartées : 1 journées de courbe de charge incomplètes, laissées à la synchro V2
  écartées : 1 consommation à 0 (échec V1)
  PDL ignorés, absents de ce client : 98765432109876
  (attendez la première synchronisation, ou lancez-la depuis le Dashboard, puis relancez l'import)
```

- **ajoutées** : lignes V1 écrites dans la V2 ;
- **déjà présentes** : dates que la V2 avait déjà, laissées intactes ;
- **écartées** : lignes V1 sans donnée réelle (voir plus haut) ;
- **PDL ignorés** : PDL du `cache.db` inconnus de la V2. Vérifiez qu'ils sont bien sur votre compte
  V2 (étape 1), puis relancez la commande.

Options :

- `--pdl 12345678901234` : n'importer que ce PDL (option répétable) ;
- `--dry-run` : simulation, rien n'est écrit.

### Avec Helm (Kubernetes)

```bash
NS=myelectricaldata   # namespace de la release
POD=$(kubectl -n $NS get pod \
  -l app.kubernetes.io/name=myelectricaldata-client,app.kubernetes.io/component=backend \
  -o jsonpath='{.items[0].metadata.name}')

kubectl -n $NS cp ./cache.db $POD:/tmp/cache.db -c backend
kubectl -n $NS exec $POD -c backend -- python scripts/import_v1.py /tmp/cache.db --dry-run
kubectl -n $NS exec $POD -c backend -- python scripts/import_v1.py /tmp/cache.db
kubectl -n $NS exec $POD -c backend -- rm /tmp/cache.db
```

Si plusieurs releases cohabitent dans le namespace, ajoutez `app.kubernetes.io/instance=<release>` au
sélecteur.

### V1 sur PostgreSQL

Si votre `config.yaml` V1 contenait une clé `storage_uri` en `postgresql://…`, passez cette URL à la
place du chemin du `cache.db` :

```bash
docker compose -f docker-compose.client.yml exec client \
  python scripts/import_v1.py "postgresql://user:motdepasse@hote:5432/myelectricaldata" --dry-run
```

La base V1 doit être joignable depuis le conteneur backend de la V2. MySQL n'est pas pris en charge.

### Afficher l'historique importé

Rechargez les pages Consommation et Production après l'import : elles affichent tout l'historique de
la base locale, au-delà des 3 ans de journalier et des 2 ans de courbe de charge que la V2 sait
redemander à Enedis. Chaque année importée a sa carte, sa barre et sa courbe annuelle, ses heures
creuses et heures pleines, et sa puissance maximale. La passerelle n'est interrogée que dans sa
fenêtre, pour combler les trous récents : les années V1 viennent toutes de la base locale.

L'import met à jour la date de la donnée la plus ancienne de chaque PDL, ce qui suffit à étendre
l'affichage. Un import fait avec une version antérieure est pris en compte à la prochaine
synchronisation, ou en relançant la commande (elle n'écrit alors rien de neuf).

La page Consommation (€) reste sur les 2 dernières années : elle chiffre la consommation au tarif
de l'offre actuelle et ne dispose des jours Tempo que sur cette période.

## Étape 4 : basculer les exports

:::warning Arrêtez la V1 avant d'activer les exports V2
Les deux versions publient sur les mêmes topics de découverte MQTT de Home Assistant : si elles
tournent ensemble, elles écrasent mutuellement leurs entités.
:::

Configurez ensuite les exports dans l'interface V2 ([Exporteurs](./exporters.md)).

### Home Assistant

- **Capteurs Linky et Tempo** : la V2 reprend les mêmes identifiants que la V1, les entités, leur
  historique et vos tableaux de bord sont conservés.
- **EcoWatt** : les identifiants changent (`j0` au lieu de `J0`), de nouvelles entités sont créées.
  Supprimez les anciennes et mettez à jour les cartes qui les utilisent.
- **Capteurs `_last5day` et `_history`** : ils n'existent plus en V2, supprimez-les de Home Assistant.

### Panneau Énergie

Les statistiques V2 ne portent pas les mêmes identifiants que celles de la V1
(`myelectricaldata:consumption_<pdl>_base` contre `myelectricaldata:<pdl>_base_consumption`), mais
partagent le même préfixe `myelectricaldata`.

:::warning Le panneau Énergie ne couvre que la période de la courbe de charge
L'exporteur V2 bâtit les statistiques sur la courbe de charge dès qu'il en a, et ne se rabat sur le
journalier que s'il n'existe aucune courbe de charge pour le PDL. Les années anciennes dont la V1 ne
gardait que le journalier sont bien importées et visibles dans l'interface V2, mais n'apparaissent
pas dans le panneau Énergie.
:::

Deux options :

- **Repartir sur les statistiques V2** (le plus simple) : après l'import, lancez un export
  **Complet (réinitialise)**. Il supprime les statistiques du préfixe, celles de la V1 comprises,
  puis réimporte l'historique depuis la V2, courbe de charge V1 incluse. Resélectionnez ensuite
  les nouvelles séries dans **Paramètres** > **Tableaux de bord** > **Énergie** de Home Assistant.
- **Garder les statistiques V1** : changez `statistic_id_prefix` (par exemple `myelectricaldata_v2`)
  avant le premier export. Les anciennes séries restent intactes et consultables ; ne sélectionnez
  pas les deux jeux comme sources du panneau Énergie, il additionnerait les périodes communes.

Voir [Home Assistant](./integrations/home-assistant.md) pour le détail des modes d'export.

### MQTT, InfluxDB et Grafana

Les topics MQTT de la V2 ne reprennent pas ceux de la V1. L'export InfluxDB de la V1 est remplacé
par l'exporteur [VictoriaMetrics](./integrations/victoriametrics.md), qui écrit d'autres mesures
(`electricity_*`). Les automatisations et tableaux Grafana qui lisaient les données V1 sont à
adapter.

## Étape 5 : arrêter définitivement la V1

Une fois l'import fait et les exports vérifiés :

```bash
cd /chemin/vers/myelectricaldata_v1
docker compose down
```

Gardez la sauvegarde du dossier `data` quelque temps : l'import peut être relancé à partir d'elle.

## Questions fréquentes

### « Avertissement : cache.db en révision … »

Toutes les versions publiées de la V1 (0.x) laissent un `cache.db` en révision `e990284249e4`.
Certaines images non publiées (construites depuis une branche de développement) en portent une autre,
par exemple `d4f21c9a8b6e`. L'import ne s'arrête pas à la révision : il vérifie que les tables et
colonnes qu'il lit sont toutes présentes, importe si c'est le cas et le signale par cet avertissement.
Lancez d'abord `--dry-run` et vérifiez que les volumes du bilan sont cohérents avant l'import réel.

### « Base V1 en révision … incompatible avec l'import, il y manque : … »

Le `cache.db` n'a pas toutes les tables ou colonnes lues par l'import (elles sont nommées dans le
message, sous la forme `table` ou `table.colonne`). Il vient d'une version de la V1 trop ancienne, ou
d'une variante modifiée. Démarrez une fois la dernière version 0.x de la V1 sur ce dossier `data` (elle
met le `cache.db` à jour au démarrage), arrêtez-la, puis relancez l'import.

### Puis-je relancer l'import ?

Oui. Les lignes déjà présentes sont comptées en « déjà présentes » et laissées telles quelles.

### Comment annuler l'import ?

Les lignes importées portent la source `myelectricaldata_v1`. Pour les retirer, en SQLite :

```bash
docker compose -f docker-compose.client.yml exec client python -c "
import sqlite3
db = sqlite3.connect('/app/data/myelectricaldata.db', timeout=30)
for table in ('consumption_data', 'production_data', 'max_power_data'):
    db.execute(f\"DELETE FROM {table} WHERE source = 'myelectricaldata_v1'\")
db.commit()"
```

En PostgreSQL :

```bash
docker compose -f docker-compose.yml exec postgres psql -U myelectricaldata myelectricaldata_client -c "
  DELETE FROM consumption_data WHERE source = 'myelectricaldata_v1';
  DELETE FROM production_data WHERE source = 'myelectricaldata_v1';
  DELETE FROM max_power_data WHERE source = 'myelectricaldata_v1';"
```

Les données synchronisées depuis Enedis ne sont pas touchées.
