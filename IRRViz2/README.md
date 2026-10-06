# IRRViz 2

Seconde version d'[IRRViz](../IRRViz/) : à partir de vos transactions, visualisez jour après jour le **prix de revente** nécessaire pour atteindre chaque **rendement annuel net cible** (TRI / XIRR), frais de vente inclus.

Même stack que la v1 : site **100 % statique** (HTML, CSS, JavaScript sans dépendance ni étape de build), persistance dans le **localStorage** du navigateur. Ouvrez simplement `index.html`, ou servez le dossier avec n'importe quel serveur statique.

## Application installable et hors ligne

IRRViz 2 est une **application web progressive (PWA)** : servie en `https://` (ou depuis `localhost`), elle peut être installée et fonctionne ensuite **sans connexion**.

- **Installer** : bouton « Installer » dans la barre du haut.
  - Chrome, Edge (ordinateur, Android) : il ouvre l'invite d'installation du navigateur.
  - iPhone / iPad et Safari Mac 17+ : ces navigateurs n'ont pas d'invite d'installation (pas d'événement `beforeinstallprompt`) ; le bouton ouvre un guide pas à pas (Partager › *Sur l'écran d'accueil*, ou Fichier › *Ajouter au Dock*). Sur iPhone / iPad, le guide propose aussi d'exporter une sauvegarde, à restaurer dans l'application installée.
  - Le bouton est masqué quand l'application est déjà ouverte en mode installé.

  L'application s'ouvre alors dans sa propre fenêtre, avec son icône.
- **Hors ligne** : tout fonctionne (saisie, graphique, import / export, cours importés ou en cache) ; seul le téléchargement des cours Yahoo demande une connexion. Un badge « Hors ligne » l'indique, et les cours Yahoo en cache sont rafraîchis au retour de la connexion.
- **Mises à jour** : le service worker (`sw.js`) charge les fichiers depuis le réseau en priorité et ne sert le cache que hors ligne ou si le réseau ne répond pas en 4 s. Une nouvelle version publiée est donc visible dès le rechargement suivant, sans mélange d'anciens et de nouveaux fichiers.
- Les données restent dans le `localStorage` du navigateur. Sur iPhone / iPad, l'application installée a **son propre stockage**, séparé de Safari : exportez une sauvegarde JSON depuis Safari puis restaurez-la dans l'application.
- Ouverte directement depuis le disque (`file://`), l'application fonctionne comme avant, mais sans installation ni mode hors ligne (les navigateurs n'autorisent pas les service workers dans ce cas).

Pour les développeurs : la liste des fichiers mis en cache est `APP_SHELL` dans `sw.js`. Un test vérifie qu'elle contient tout ce que charge `index.html` ; incrémentez `VERSION` quand vous ajoutez, renommez ou supprimez un fichier, pour purger l'ancien cache.

## Synchroniser entre appareils (GitHub)

Pour retrouver les mêmes positions sur plusieurs appareils (ordinateur, iPad…), IRRViz peut en garder une copie dans un **dépôt GitHub privé**, sans serveur : le navigateur parle directement à l'API GitHub. Le `localStorage` reste la référence : l'application fonctionne toujours hors ligne, le dépôt est une copie synchronisée.

### Mise en place (une fois)

1. Sur GitHub, créez un dépôt **privé**, par exemple `irrviz-data` ([nouveau dépôt](https://github.com/new), visibilité *Private*). Un dépôt public est refusé : vos données y seraient visibles de tous. N'utilisez pas de Gist « secret », qui n'est pas privé.
2. Créez un [jeton à portée fine](https://github.com/settings/personal-access-tokens/new) (*Settings › Developer settings › Personal access tokens › Fine-grained tokens*) :
   - *Repository access* : **Only select repositories**, puis le dépôt ;
   - *Permissions › Repository permissions › Contents* : **Read and write**, rien d'autre ;
   - une date d'expiration (le jeton se renouvelle à la main).
3. Dans IRRViz : bouton nuage en haut de la page (ou *Données › Synchroniser entre appareils*). Saisissez le dépôt (`propriétaire/irrviz-data` ou son adresse), collez le jeton, indiquez si vous le souhaitez sa date d'expiration (IRRViz prévient 7 jours avant), puis **Tester** et **Connecter**.
4. Répétez l'étape 3 sur chaque appareil. Si le dépôt contient déjà des données, choisissez de les **fusionner** avec celles de l'appareil, ou de **remplacer** celles de l'appareil (proposé d'office quand l'appareil ne contient que l'exemple de départ).

Sur iPhone / iPad, l'application installée a son propre stockage, séparé de Safari : saisissez le jeton **dans l'application installée**. Le jeton étant collé à la main, aucune fenêtre de connexion ne s'ouvre : rien ne bascule dans Safari.

### Fonctionnement

- **Quand** : à l'ouverture, au retour de la connexion, au retour de l'application au premier plan, une minute après la dernière modification (au plus cinq minutes pendant une saisie continue), quand l'application passe en arrière-plan avec des modifications en attente, et à la demande (*Synchroniser maintenant*). Les modifications rapprochées sont donc **regroupées en un seul commit**.
- **Fichier** : `irrviz.json` (modifiable dans les options avancées), au format de la sauvegarde complète, indenté pour être lisible et modifiable sur GitHub ; *Données › Restaurer une sauvegarde* l'accepte aussi. Chaque synchronisation est un commit dont le message indique l'appareil et les positions modifiées : l'historique complet est consultable depuis la fenêtre de synchronisation.
- **Ce qui est synchronisé** : les positions (transactions, seuils, frais, horizon, symbole, nom, ordre) et les historiques de cours importés. **Restent propres à l'appareil** : le cache des cours Yahoo (retéléchargeable), la vue du graphique, le thème, le panneau et le port du proxy.
- **Fusion par position** : chaque position porte sa date de modification ; une position modifiée sur un seul appareil depuis la dernière synchronisation prend cette version. Une position supprimée laisse une trace et ne réapparaît pas, sauf si elle a été modifiée ailleurs après sa suppression.
- **Conflits** : si un autre appareil a écrit entre la lecture et l'écriture, GitHub refuse l'écriture (le `sha` de la version remplacée ne correspond plus) : IRRViz relit, fusionne et réécrit. Une même position modifiée sur deux appareils : la plus récente est gardée et l'autre version est proposée (*Reprendre l'autre version*, *Garder les deux*, *Garder celle-ci*).
- **État affiché** par le bouton nuage : synchronisé (vert), modifications en attente ou hors ligne (orange), conflit, jeton à remplacer ou erreur (rouge). Un fichier distant qui n'est pas une sauvegarde IRRViz n'est jamais écrasé.
- **Sécurité** : le jeton est stocké dans ce navigateur (clé `irrviz2-sync-v2`), envoyé uniquement à `api.github.com`, et n'apparaît ni dans le fichier synchronisé ni dans les sauvegardes JSON. Grâce à la portée fine, un jeton divulgué ne donne accès qu'à ce dépôt. Une politique de sécurité de contenu (CSP) n'autorise que les scripts de l'application et les connexions vers le proxy local et `api.github.com`. *Déconnecter cet appareil* efface le jeton ; les données restent sur l'appareil et dans le dépôt.

## Plusieurs positions

Le menu **Positions** (en haut à gauche) permet de suivre plusieurs actifs. Chaque position a ses propres transactions, seuils, frais, horizon, symbole Yahoo, vue du graphique, historique annuler / rétablir et cache de cours. Le thème, l'affichage du panneau et le port du proxy sont communs.

- Créer une position (vide, en reprenant éventuellement les seuils, frais et horizon de la position courante), la dupliquer, la renommer, la supprimer (annulable depuis la notification), réordonner la liste.
- Passer d'une position à l'autre avec le menu ou `Alt+↑` / `Alt+↓`.
- Sans nom choisi, une position prend automatiquement le symbole de l'actif chargé.
- La sauvegarde JSON contient toutes les positions et leurs cours en cache. Restaurer une sauvegarde complète remplace toutes les positions (annulable) ; une sauvegarde d'avant les positions est ajoutée comme nouvelle position.
- Les données existantes (IRRViz 2 mono-position, ou IRRViz v1) sont reprises automatiquement dans une première position.

## Historique de cours importé (CSV)

Pour un actif absent de Yahoo Finance (fonds en unités de compte, SCPI, non coté…) ou sans lancer le proxy : **Cours de l'actif › Fichier CSV › Importer un historique…**

- Deux colonnes `date;cours` (affichées en ligne, avec des points pour les cotations espacées) ou cinq `date;ouverture;haut;bas;clôture` (affichées en bougies).
- Avec une ligne d'en-tête, les colonnes sont reconnues par leur nom : les exports **Yahoo Finance** (`Date,Open,High,Low,Close,Adj Close,Volume`) et **Investing.com** (`"Date","Price","Open",…`) s'importent tels quels. Les dates américaines `mm/jj/aaaa` sont détectées automatiquement ; les dates futures et les valeurs manquantes sont écartées.
- Aperçu avant import, nom de l'actif modifiable, choix entre **remplacer** et **compléter** l'historique existant ; import et retrait annulables.
- L'historique appartient à la position (une clé localStorage par position, distincte du cache Yahoo) : basculer entre « Yahoo Finance » et « Fichier CSV » ne perd ni l'un ni l'autre. Il est copié avec la position, inclus dans la sauvegarde JSON et exportable en CSV.
- Dernier cours, plus-value latente et TRI actuel sont calculés avec le dernier cours importé (un avertissement signale un cours de plus de 45 jours).
- Si un fichier de cours est ouvert par erreur dans l'import de transactions, IRRViz propose de l'importer comme cours.

```csv
Date;Valeur de part
31/12/2025;250,00
31/03/2026;251,20
30/06/2026;253,10
```

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
| `Alt+↑` / `Alt+↓` | Position précédente / suivante |
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
│   ├── store.js   positions, localStorage, annuler / rétablir, migrations, moteur de fusion
│   ├── github.js  synchronisation : lecture / écriture du fichier sur GitHub (API Contents)
│   ├── sync.js    synchronisation : quand synchroniser, fusion, conflits, état affiché
│   ├── csv.js     import / export CSV (transactions, historiques de cours)
│   ├── asset.js   cours Yahoo Finance via le proxy
│   ├── chart.js   graphique SVG interactif
│   └── app.js     interface
├── manifest.webmanifest, sw.js   application installable, hors ligne
├── icons/                        icônes de l'application (SVG + PNG)
├── proxy.py
└── tests/         model.test.js, store.test.js, prices.test.js, sync.test.js, pwa.test.js
```

Les scripts sont des scripts classiques (pas de modules ES) pour que l'application fonctionne aussi ouverte directement depuis le disque (`file://`).

## Tests

Le moteur de calcul, l'import CSV, la gestion des positions (migrations, création, suppression, restauration) et la synchronisation (fusion, traces de suppression, conflits, adaptateur GitHub simulé, plusieurs appareils) sont testés avec le lanceur intégré de Node.js (≥ 18) :

```bash
node --test IRRViz2/tests/*.test.js
```
