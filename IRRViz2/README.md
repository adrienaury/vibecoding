# IRRViz 2

Seconde version d'[IRRViz](../IRRViz/) : à partir de vos transactions, visualisez jour après jour le **prix de revente** nécessaire pour atteindre chaque **rendement annuel net cible** (TRI / XIRR), frais de vente inclus.

Même stack que la v1 : site **100 % statique** (HTML, CSS, JavaScript sans dépendance ni étape de build), persistance dans le **localStorage** du navigateur. Ouvrez simplement `index.html`, ou servez le dossier avec n'importe quel serveur statique.

## Nouveautés par rapport à la v1

### Lecture du graphique
- **TRI au survol** : l'infobulle indique le rendement annualisé obtenu si vous vendiez au prix pointé (ou à la clôture de la bougie survolée).
- **Indicateurs de synthèse** : position, capital net investi, seuil de rentabilité du jour et, si un actif est chargé, dernier cours, plus-value latente et **TRI actuel**. Pour une position soldée : TRI réalisé.
- Pastilles de date et de prix sur les axes, réticule, étiquettes de seuils qui ne se chevauchent plus et restent dans la zone de tracé.
- Échelle des prix ajustée automatiquement au contenu visible (plus d'axe écrasé depuis 0 €), graduations adaptées aux petits prix, graduations temporelles qui ne se chevauchent pas.
- Périodes où la position est soldée hachurées ; ligne d'horizon ; courbe 0 % mise en avant.
- Bougies remplacées par une ligne de clôture et une enveloppe haut/bas quand le zoom est trop large pour qu'elles restent lisibles.

### Navigation
- Zoom molette, **pavé tactile** (pincer, défilement horizontal), **écran tactile** (glisser, pincer à deux doigts).
- Glisser sur l'axe des prix pour étirer l'échelle ; double-clic pour revenir à la vue d'ensemble (sur l'axe des prix : échelle automatique).
- Boutons de zoom et navigation au clavier (flèches, `+`, `−`, `0`).
- Courbes masquables d'un clic (légende ou pastille du seuil) ; zones, étiquettes et cours activables séparément.
- Clic sur un point de transaction : la ligne correspondante est retrouvée dans la liste, et inversement le survol d'une ligne met le point en évidence.

### Saisie et données
- **Annuler / rétablir** (`Ctrl+Z` / `Ctrl+Maj+Z`) sur toutes les modifications, et bouton « Annuler » dans les notifications après une suppression, un import, etc.
- Liste triée par date, type déduit automatiquement (achat, vente, flux), prix unitaire et position cumulée sur chaque ligne, **alertes** (signes incohérents, position négative, date invalide).
- Saisie tolérante des nombres : `1 234,56`, `-1000.5`, `12,5 €`…
- Duplication d'une transaction, `Entrée` pour passer au champ suivant puis créer une nouvelle ligne.
- **Import CSV** dans une fenêtre dédiée : glisser-déposer (ou déposer le fichier n'importe où sur la page), aperçu des lignes reconnues et rejetées avec la raison, détection d'en-tête, ajout ou remplacement, doublons ignorés, prise en charge des exports Excel en Windows-1252.
- **Export CSV** des transactions, **sauvegarde / restauration JSON** complète.
- Reprise automatique des données d'IRRViz v1 au premier lancement (même origine).

### Actif (Yahoo Finance)
- Indicateur d'état du proxy local, port configurable, bouton de test.
- Nom, place de cotation et devise de l'actif affichés ; alerte si la devise n'est pas l'euro.
- **Cache** des derniers cours téléchargés : affichage immédiat au rechargement, et consultation possible même sans proxy.

### Confort
- Thème **clair, sombre ou automatique** (système).
- Panneau latéral repliable (`P`), cartes repliables avec mémorisation, tiroir sur mobile.
- Interface utilisable sur téléphone et tablette.
- Aide intégrée (`?`) et raccourcis clavier.

## Raccourcis

| Touche | Action |
|---|---|
| `N` | Nouvelle transaction |
| `I` | Importer un CSV |
| `Ctrl+Z` / `Ctrl+Maj+Z` | Annuler / rétablir |
| `+` / `−` / `0` | Zoomer / dézoomer / vue d'ensemble |
| `←` `→` `↑` `↓` | Déplacer la vue (graphique sélectionné) |
| `Z` / `L` / `C` | Zones / étiquettes / cours |
| `P` | Panneau latéral |
| `T` | Thème |
| `?` | Aide |

## Format CSV

Trois colonnes : date (`jj/mm/aaaa` ou `aaaa-mm-jj`), montant net en euros, quantité. Séparateur `;`, tabulation ou `,` (les champs entre guillemets peuvent contenir des virgules).

```csv
date;montant;quantite
01/01/2026;-1000,00;1000
01/02/2026;500,00;-400
01/03/2026;10,00;0
```

Montant négatif = décaissement (achat, frais), positif = encaissement (vente, dividende). Quantité positive à l'achat, négative à la vente, nulle pour un simple flux.

## Cours de l'actif : proxy local

Yahoo Finance n'autorise pas les appels directs depuis un navigateur (CORS). Un petit proxy Python (bibliothèque standard uniquement) est fourni :

```bash
cd IRRViz2
python proxy.py          # http://127.0.0.1:8765
python proxy.py 9000     # autre port, à reporter dans « Cours de l'actif › Proxy local »
```

Le proxy n'accepte que `query1.finance.yahoo.com` et `query2.finance.yahoo.com`.

## Structure

```
IRRViz2/
├── index.html
├── css/style.css
├── js/
│   ├── util.js    dates, formats, saisie numérique, palette
│   ├── model.js   prix seuils, TRI, synthèse de position
│   ├── store.js   état, localStorage, annuler / rétablir, migration v1
│   ├── csv.js     import / export CSV
│   ├── asset.js   cours Yahoo Finance via le proxy
│   ├── chart.js   graphique SVG interactif
│   └── app.js     interface
├── proxy.py
└── tests/model.test.js
```

Les scripts sont des scripts classiques (pas de modules ES) pour que l'application fonctionne aussi ouverte directement depuis le disque (`file://`).

## Tests

Le moteur de calcul et l'import CSV sont testés avec le lanceur intégré de Node.js (≥ 18) :

```bash
node --test IRRViz2/tests/*.test.js
```
