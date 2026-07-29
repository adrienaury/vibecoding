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
- Persistance locale de l'état et de la vue
- 100% local, sans dépendance externe

## Statistiques d'utilisation des modèles

| Heure | Modèle | Coût (USD) | Requêtes | Input Tokens | Output Tokens |
|-------|--------|-----------|----------|-------------|---------------|
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
| minimax/minimax-m3 | 0.332128 | 60 | 3860376 | 53096 |
| alibaba/qwen3.7-plus | 0.017090 | 1 | 13535 | 9968 |
| auto-routing/classifier | 0.000070 | 6 | 0 | 0 |
| google/gemma-4-26b-a4b-it | 0.000848 | 6 | 5809 | 62 |
| stepfun/step-3.7-flash | 0.000000 | 1 | 13091 | 10000 |
| inclusionai/ling-3.0-flash-free | 0.000000 | 21 | 497513 | 10783 |

### Totaux

| Métrique | Valeur |
|----------|--------|
| **Coût total** | 14.133477 USD |
| **Requêtes totales** | 263 |
| **Input Tokens totaux** | 35 472 640 |
| **Output Tokens totaux** | 267 606 |