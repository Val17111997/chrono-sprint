# Chrono Sprint

Chronométrage de sprint sans réseau avec deux téléphones (synchro acoustique côte à côte, détection caméra du passage).

App statique : `index.html` + service worker. Ouvrir en HTTPS, puis « Ajouter à l'écran d'accueil ».

## Développement

- Sources : `dev/src/` (`core.js` = traitement du signal, `app.js` = application, `index.template.html`).
- Tests : `node dev/test/test_core.js`
- Construction : `python3 dev/build.py` (régénère `index.html`, `sw.js`, `manifest.webmanifest`, icônes à la racine).

Police : Barlow Condensed (SIL Open Font License), intégrée à la page.
