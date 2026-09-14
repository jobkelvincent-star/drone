// =========================================================================
// MAPS/INDEX.JS — Registre des maps disponibles + sélection aléatoire
// Fichiers réels dans le dossier maps/ : bdl.glb, futuriste.glb, luna.glb
// ("feux" retirée du roulement : le fichier maps/feux.glb n'existe pas dans le
// projet, ce qui causait une 404 et une map manquante quand elle était tirée au sort)
// Chaque map a des marqueurs de spawn "1_1"/"1_2"/"1_3" (équipe A) et
// "2_1"/"2_2"/"2_3" (équipe B), lus par les fichiers drones (d1.html à d8.html).
// =========================================================================

const MAPS = [
  { cle: 'bdl' },
  { cle: 'futuriste' },
  { cle: 'luna' }
];

export function obtenirMapAleatoire() {
  return MAPS[Math.floor(Math.random() * MAPS.length)];
}

export function obtenirMapParCle(cle) {
  return MAPS.find((m) => m.cle === cle) || null;
}

export function listeMaps() {
  return MAPS;
}