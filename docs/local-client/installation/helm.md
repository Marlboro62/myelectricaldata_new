# Installation Helm (Kubernetes)

Déploiement du mode client sur Kubernetes via Helm Chart.

## Prérequis

- Kubernetes 1.25+
- Helm 3.10+
- kubectl configuré
- Ingress Controller (nginx recommandé)
- StorageClass disponible

```bash
# Vérifier les versions
kubectl version --client
helm version
```

## Installation

### Étape 1 : Cloner le dépôt

```bash
git clone https://github.com/MyElectricalData/myelectricaldata_new.git
cd myelectricaldata_new/helm
```

### Étape 2 : Télécharger les dépendances

```bash
helm dependency build ./myelectricaldata-client
```

### Étape 3 : Créer un fichier de valeurs

```bash
cat > my-values.yaml << EOF
secrets:
  med:
    apiUrl: "https://www.v2.myelectricaldata.fr/api"
    clientId:
      value: "cli_xxxxxxxxxxxxxxxxxxxxxxxxx"
    clientSecret:
      value: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Base SQLite sur le volume du backend (recommandé pour une nouvelle installation).
# Pour PostgreSQL, voir « Base de données » plus bas.
postgres:
  enabled: false

ingress:
  enabled: true
  hosts:
    - host: myelectricaldata.local
      paths:
        - path: /
          pathType: Prefix
          service: frontend
        - path: /api
          pathType: Prefix
          service: backend
EOF
```

### Étape 4 : Installer

```bash
helm install myelectricaldata ./myelectricaldata-client -f my-values.yaml
```

### Étape 5 : Vérifier

```bash
# Statut
helm status myelectricaldata

# Pods
kubectl get pods -l app.kubernetes.io/instance=myelectricaldata
```

---

## Architecture déployée

```
┌────────────────────────────────────────────────────────┐
│                  Kubernetes Cluster                     │
├────────────────────────────────────────────────────────┤
│  ┌─────────────┐                                       │
│  │   Ingress   │ ◄─── myelectricaldata.local           │
│  └──────┬──────┘                                       │
│         │                                              │
│    ┌────┴────┐                                         │
│    │         │                                         │
│  ┌─▼───────┐ ┌─▼───────┐                               │
│  │Frontend │ │ Backend │ ────► API MED                 │
│  └─────────┘ └────┬────┘                               │
│                   │                                    │
│         ┌─────────┼─────────┐                          │
│         │         │         │                          │
│  ┌──────▼───┐ ┌───▼────────┐                           │
│  │ SQLite / │ │VictoriaM.  │                           │
│  │PostgreSQL│ │            │                           │
│  └──────────┘ └────────────┘                           │
└────────────────────────────────────────────────────────┘
```

---

## Configuration

### Secrets API MyElectricalData

```yaml
secrets:
  med:
    apiUrl: "https://www.v2.myelectricaldata.fr/api"
    clientId:
      value: "cli_xxx"
      # Ou avec un secret existant :
      # existingSecretRef:
      #   name: "med-credentials"
      #   key: "client-id"
    clientSecret:
      value: "xxx"
```

### Base de données

Trois choix, selon `postgres.enabled` et `externalDatabase` :

| Valeurs | Base | Remarques |
|---------|------|-----------|
| `postgres.enabled: false`, `externalDatabase` vide | **SQLite** dans `/app/data` (PVC du backend) | Recommandé pour une nouvelle installation : pas de pod de base de données |
| `postgres.enabled: true` (défaut du chart) | PostgreSQL 16 embarqué (sous-chart) | Mot de passe requis |
| `postgres.enabled: false`, `externalDatabase.host` renseigné | Serveur PostgreSQL existant | Mot de passe ou `existingSecret` requis |

Changer de base ne déplace pas les données : la nouvelle repart vide et se resynchronise depuis la passerelle.

#### SQLite

```yaml
postgres:
  enabled: false

backend:
  replicaCount: 1        # SQLite n'accepte qu'un seul pod écrivain
  persistence:
    enabled: true        # la base vit sur ce volume
    size: 5Gi
```

Le chart passe alors le déploiement du backend en stratégie `Recreate` (l'ancien pod s'arrête avant que le nouveau démarre, le volume étant en `ReadWriteOnce`) et refuse le rendu avec plusieurs réplicas, l'autoscaling, ou sans persistance.

:::info Désinstallation
En mode SQLite, le PVC du backend porte `helm.sh/resource-policy: keep`, comme celui de PostgreSQL : `helm uninstall` le laisse en place et une réinstallation sous le même nom de release le reprend. Pour effacer les données, supprimez-le à la main (`kubectl delete pvc <release>-myelectricaldata-client-backend`). Sauvegarde : voir [Sauvegarde SQLite](./docker.md#sqlite), commandes à passer par `kubectl exec` et `kubectl cp`.
:::

#### PostgreSQL embarqué

```yaml
postgres:
  enabled: true
  auth:
    database: myelectricaldata_client
    username: myelectricaldata
    password: ""  # Requis
    # Ou secret existant :
    # existingSecret: "postgres-credentials"
  persistence:
    enabled: true
    size: 10Gi
```

### VictoriaMetrics

```yaml
victoriametrics:
  enabled: true
  server:
    retentionPeriod: "365d"
    persistentVolume:
      enabled: true
      size: 10Gi
```

### Exports domotique

```yaml
exports:
  homeAssistant:
    enabled: false
    url: "http://homeassistant.local:8123"
    token: ""

  mqtt:
    enabled: false
    host: "mqtt.local"
    port: 1883
    topic: "myelectricaldata"
```

### Ingress

```yaml
ingress:
  enabled: true
  className: "nginx"
  hosts:
    - host: myelectricaldata.local
      paths:
        - path: /
          pathType: Prefix
          service: frontend
        - path: /api
          pathType: Prefix
          service: backend
  tls: []
  # - secretName: myelectricaldata-tls
  #   hosts:
  #     - myelectricaldata.local
```

---

## Commandes utiles

```bash
# Statut
helm status myelectricaldata

# Valeurs actuelles
helm get values myelectricaldata

# Mise à jour
helm upgrade myelectricaldata ./myelectricaldata-client -f my-values.yaml

# Désinstaller
helm uninstall myelectricaldata

# Logs backend
kubectl logs -l app.kubernetes.io/name=myelectricaldata-backend -f
```

---

## Dépannage

### Pods en erreur

```bash
# Événements
kubectl describe pod -l app.kubernetes.io/name=myelectricaldata-backend

# Logs
kubectl logs -l app.kubernetes.io/name=myelectricaldata-backend
```

### Ingress non fonctionnel

```bash
# Vérifier l'Ingress
kubectl describe ingress myelectricaldata

# Vérifier les Services
kubectl get svc -l app.kubernetes.io/instance=myelectricaldata
```

### PVC en attente

```bash
# Vérifier les PVC
kubectl get pvc -l app.kubernetes.io/instance=myelectricaldata

# Vérifier la StorageClass
kubectl get storageclass
```

---

## Désinstallation

```bash
# Supprimer le déploiement
helm uninstall myelectricaldata

# Supprimer les PVC (données)
kubectl delete pvc -l app.kubernetes.io/instance=myelectricaldata
```
