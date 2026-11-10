# Cotéo — scan et cote de cartes

Appli web (installable sur Android) pour scanner des cartes à collectionner Pokémon avec la caméra en direct, les ranger en collections et suivre leur cote Cardmarket.

- **Reconnaissance** : photo envoyée à l'API Gemini de Google avec la clé de l'utilisateur (gardée seulement sur son téléphone). Le modèle Flash le plus récent est choisi automatiquement.
- **Cartes et prix** : [TCGdex](https://tcgdex.dev) (cartes françaises, prix Cardmarket). La base `data/db.json` est reconstruite chaque lundi par l'action GitHub *Mise à jour des prix* ; les prix d'une carte sont aussi actualisés en direct quand on la consulte.
- **Collections** : stockées dans le navigateur du téléphone, avec sauvegarde / restauration en fichier.

Appli non officielle, non affiliée à Nintendo, Creatures, GAME FREAK ni à The Pokémon Company.
