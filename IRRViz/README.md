# IRRViz

Mini-application web statique pour visualiser et explorer une idée autour de l'IRR (Taux de Rendement Interne), avec une interface simple et directe.

## Fonctionnalités

- Saisie de transactions (montant, quantité, date)
- Import CSV de transactions
- Seuils de rendement annuel configurables
- Horizon de projection avec raccourcis rapides (+1 an, +2 ans, +5 ans)
- Graphique interactif avec zoom (molette), pan (glisser) et crosshair
- Étiquettes de prix par seuil en survol et sur la ligne « aujourd'hui »
- Statistiques de position en bas du graphique
- **Asset optionnel** : saisie d'un ticker Yahoo Finance pour afficher les bougies OHLC du sous-jacent sur le graphique
- Persistance locale de l'état et de la vue
- 100% local, sans dépendance externe (le proxy pour l'asset est optionnel et local)

## Asset (Yahoo Finance)

Une carte « Asset (optionnel) » dans le panneau latéral permet de saisir un ticker Yahoo Finance (ex. `AAPL`, `MC.PA`, `BTC-USD`) et d'afficher les **bougies japonaises** du sous-jacent sur le graphique :

- Période : du mois précédant la première transaction jusqu'à un mois après l'horizon
- Fréquence : 1 bougie par jour
- 4 valeurs par jour : ouverture, plus haut, plus bas, clôture
- Bougies vertes si clôture ≥ ouverture, rouges sinon
- Le ticker saisi est persisté dans `localStorage` ; les bougies sont re-téléchargées à chaque chargement pour des données fraîches
- CORS : Yahoo Finance ne supporte pas CORS directement. Un proxy local Python est fourni pour contourner cette limitation
- Le survol d'une bougie affiche l'OHLC et la variation dans l'infobulle
- L'échelle Y s'ajuste automatiquement pour inclure les prix de l'asset

### Proxy local (requis)

Pour utiliser la fonctionnalité Asset, lancez le petit serveur proxy Python fourni :

```bash
cd IRRViz
python proxy.py
```

Le proxy écoute sur `http://127.0.0.1:8765`. Vous pouvez changer le port :

```bash
python proxy.py 9000
```

Le proxy n'autorise que les domaines `query1.finance.yahoo.com` et `query2.finance.yahoo.com`, et il n'a besoin que de la bibliothèque standard Python.

## Statistiques d'utilisation des modèles

| Heure | Modèle | Coût (USD) | Requêtes | Input Tokens | Output Tokens |
|-------|--------|-----------|----------|-------------|---------------|
| 2026-07-30 08:00:00 | alibaba/qwen3.7-plus | 0.047466 | 2 | 242472 | 3468 |
| 2026-07-30 08:00:00 | auto-routing/classifier | 0.000012 | 1 | 0 | 0 |
| 2026-07-30 08:00:00 | mistral-embed-2312 | 0.000225 | 16 | 44849 | 0 |
| 2026-07-30 08:00:00 | xai/grok-4.5 | 0.260266 | 2 | 224664 | 368 |
| 2026-07-30 06:00:00 | moonshotai/kimi-k2.7-code | 0.365260 | 9 | 925748 | 7009 |
| 2026-07-30 06:00:00 | alibaba/qwen3.7-plus | 0.086771 | 4 | 361271 | 3013 |
| 2026-07-30 06:00:00 | mistral-embed-2312 | 0.001889 | 128 | 378976 | 0 |
| 2026-07-30 06:00:00 | auto-routing/classifier | 0.000065 | 5 | 0 | 0 |
| 2026-07-30 06:00:00 | minimax/minimax-m3 | 0.299157 | 61 | 3970723 | 17245 |
| 2026-07-28 09:00:00 | anthropic/claude-sonnet-5 | 8.595666 | 85 | 20135906 | 73670 |
| 2026-07-28 08:00:00 | google/gemma-4-26b-a4b-it | 0.000213 | 2 | 2917 | 22 |
| 2026-07-28 08:00:00 | alibaba/qwen3.7-plus | 0.017090 | 1 | 13535 | 9968 |
| 2026-07-28 08:00:00 | auto-routing/classifier | 0.000070 | 6 | 0 | 0 |
| 2026-07-28 08:00:00 | minimax/minimax-m3 | 0.332128 | 60 | 3860376 | 53096 |
| 2026-07-28 08:00:00 | anthropic/claude-sonnet-5 | 5.187675 | 83 | 10945123 | 110027 |
| 2026-07-28 07:00:00 | google/gemma-4-26b-a4b-it | 0.000210 | 1 | 1448 | 11 |
| 2026-07-28 07:00:00 | stepfun/step-3.7-flash | 0.000000 | 1 | 13091 | 10000 |
| 2026-07-25 17:00:00 | google/gemma-4-26b-a4b-it | 0.000425 | 3 | 2731 | 29 |
| 2026-07-25 17:00:00 | inclusionai/ling-3.0-flash-free | 0.000000 | 21 | 497513 | 10783 |

### Résumé par modèle

| Modèle | Coût total (USD) | Requêtes | Input Tokens | Output Tokens |
|--------|-----------------|----------|-------------|---------------|
| anthropic/claude-sonnet-5 | 13.783341 | 168 | 12959029 | 183697 |
| minimax/minimax-m3 | 0.631285 | 121 | 7831099 | 70341 |
| moonshotai/kimi-k2.7-code | 0.365260 | 9 | 925748 | 7009 |
| xai/grok-4.5 | 0.260266 | 2 | 224664 | 368 |
| alibaba/qwen3.7-plus | 0.151327 | 7 | 617278 | 16449 |
| mistral-embed-2312 | 0.002114 | 144 | 423825 | 0 |
| google/gemma-4-26b-a4b-it | 0.000848 | 6 | 5809 | 62 |
| auto-routing/classifier | 0.000147 | 12 | 0 | 0 |
| stepfun/step-3.7-flash | 0.000000 | 1 | 13091 | 10000 |
| inclusionai/ling-3.0-flash-free | 0.000000 | 21 | 497513 | 10783 |

### Totaux

| Métrique | Valeur |
|----------|--------|
| **Coût total** | 15.194588 USD |
| **Requêtes totales** | 491 |
| **Input Tokens totaux** | 41 621 343 |
| **Output Tokens totaux** | 298 709 |