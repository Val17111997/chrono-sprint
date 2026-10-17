# Chrono Sprint

Chronométrage de sprint sans réseau avec deux téléphones : synchro « clap-clap » (les deux micros entendent les mêmes claquements), détection caméra du passage, correction de la dérive des horloges par QR code en fin de séance.

App statique : `index.html` + service worker. Ouvrir en HTTPS, puis « Ajouter à l'écran d'accueil ».

QR codes : jsQR (Apache-2.0) et qrcode-generator (MIT), intégrés à la page.
