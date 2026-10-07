# À population égale

Carte interactive de la France métropolitaine : choisir un territoire de référence, puis une commune de départ pour afficher une zone à population équivalente.

**Démo en ligne : [julesgrandin.github.io/cinquante-cinquante](https://julesgrandin.github.io/cinquante-cinquante/)**

Données : populations municipales Insee 2023, Admin Express COG 2026 (IGN).

## Développement local

```bash
python3 -m http.server 8765
```

Ouvrir http://localhost:8765/

## Regénérer les données

Placer le GeoPackage Admin Express à la racine, puis :

```bash
python3 prepare.py
```
