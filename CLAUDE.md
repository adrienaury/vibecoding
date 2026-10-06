# CLAUDE.md

Dépôt de petits projets web statiques, publiés sur GitHub Pages (`https://adrienaury.github.io/vibecoding/`).
Le projet actif est **IRRViz 2** (`IRRViz2/`). `IRRViz/` est la v1, conservée telle quelle : ne pas la modifier.

## Langue
Tout en **français** : textes de l'interface, commentaires, README, messages de commit, issues et PR, réponses à l'utilisateur.

## Stack (contrainte forte)
- Site **100 % statique** : HTML, CSS, JavaScript **sans dépendance ni outil de compilation** (pas de npm, de bundler ni de framework).
- Persistance dans le **localStorage** du navigateur.
- **Scripts classiques, pas de modules ES** : l'application doit fonctionner ouverte directement depuis le disque (`file://`). Chaque fichier s'attache à l'espace de noms global `IRR` (`IRR.util`, `IRR.model`, `IRR.store`, …). Les modules testables exportent aussi via `module.exports` pour Node.
- Toute nouvelle dépendance externe (script tiers, service distant) doit être discutée avec l'utilisateur avant d'être ajoutée.

## IRRViz 2 : organisation
- `index.html` : charge, dans l'ordre, `js/util.js`, `model.js`, `store.js`, `asset.js`, `chart.js`, `csv.js`, `app.js`.
- `js/util.js` : dates (timestamps UTC à minuit, en ms), formats `fr-FR` / EUR, saisie numérique tolérante, palette des seuils.
- `js/model.js` : prix seuils et TRI (XIRR). Calcul pur, sans DOM.
- `js/store.js` : état, positions multiples, persistance, annuler / rétablir, migrations. **Toute la persistance passe par là.**
- `js/csv.js` : import / export CSV des transactions et des historiques de cours.
- `js/asset.js` : cours Yahoo Finance via `proxy.py` (proxy CORS local, Python standard).
- `js/chart.js` : graphique SVG interactif. `js/app.js` : câblage de l'interface.
- `sw.js` + `manifest.webmanifest` + `icons/` : application installable et hors ligne (PWA).

## Règles à respecter
- **Données utilisateur** : clés `irrviz2-app-v2` (état), `irrviz2-prices-v2:<id>` (cache Yahoo) et `irrviz2-manual-v2:<id>` (cours importés). Ne jamais casser la lecture d'un état existant : tout ce qui est lu passe par `sanitize…` ; toute évolution de format s'accompagne d'une migration (des migrations existent depuis `irrviz2-state-v1` et depuis la v1 `mwviz-state-v1`).
- **Modifications d'état** : `store.update(mutator, { key, kind })` pour les données (annulable) ; `store.setUi(...)` pour les préférences d'affichage (non annulable). Données propres à chaque position, préférences communes.
- **Hors ligne** : quand un fichier de l'application est ajouté, renommé ou supprimé, mettre à jour `APP_SHELL` dans `IRRViz2/sw.js` et incrémenter `VERSION`. Le test `pwa.test.js` échoue si un fichier chargé par `index.html` manque à la liste.
- **iPhone / iPad** : l'application installée a son propre stockage, séparé de Safari. Les connexions OAuth par redirection depuis l'application installée basculent dans Safari : éviter cette approche (voir l'issue #17).
- Les textes de l'interface restent courts et en français ; l'aide intégrée (`?`) et `IRRViz2/README.md` sont mis à jour avec chaque fonctionnalité.
- Un nouveau projet du dépôt s'ajoute à `index.html` et au `README.md` racine.

## Vérifier avant de pousser
- **Tests** : `node --test IRRViz2/tests/*.test.js`. Passer le motif des fichiers : `node --test IRRViz2/tests/` échoue.
- **Navigateur** : servir le dépôt avec `python3 -m http.server 8811 --bind 127.0.0.1`, puis piloter `http://127.0.0.1:8811/IRRViz2/` avec Playwright (Chromium est préinstallé dans l'environnement cloud). Vérifier l'absence d'erreurs console, en bureau et en mobile, en thème clair et sombre.
- Arrêter le serveur par son PID (`echo $! > fichier.pid`, puis `kill`) plutôt qu'avec `pkill -f`, qui peut tuer le shell courant.
- Yahoo Finance et `github.io` ne sont pas joignables depuis l'environnement cloud : simuler les réponses du proxy avec `page.route` dans Playwright.
- Émulation iPad dans Chromium : forcer `navigator.maxTouchPoints` à 5 (Chromium en rapporte 1), sinon iPadOS est pris pour un Mac.

## Git
- Une **branche par fonctionnalité**, créée depuis `main` à jour (ex. `claude/irrviz2-<sujet>`).
- Commits de type `feat(irrviz2): …` / `fix(irrviz2): …`, corps en français, `Closes #N` quand le commit règle une issue.
- Ne pas créer de PR sans demande : l'utilisateur les ouvre lui-même et fusionne après test.
