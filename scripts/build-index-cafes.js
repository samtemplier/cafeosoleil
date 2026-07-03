// Construit un index statique des cafés/restaurants OSM pour les principales villes
// françaises, pour permettre une recherche par nom instantanée et floue côté client
// (voir index.html, rechercheOsmPourGeocoder) au lieu d'interroger Overpass en direct
// à chaque frappe. Script à relancer manuellement de temps en temps pour rafraîchir
// les données (pas automatisé dans le déploiement).
//
// Usage : node scripts/build-index-cafes.js
// Sortie : data/cafes-index.json

const fs = require("fs");
const path = require("path");

const SERVEURS_OVERPASS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
];

const EN_TETES = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "cafeosoleil-build-index/1.0 (+https://cafeosoleil.vercel.app)"
};

// Grandes villes françaises couvertes (centre approximatif + rayon en degrés).
// ~0.15-0.2° a été testé fiable dans l'app (voir historique) ; on garde cette taille
// pour rester dans la zone confortable des miroirs Overpass publics.
const VILLES = [
  { nom: "Paris", lat: 48.8566, lon: 2.3522, rayon: 0.20 },
  { nom: "Marseille", lat: 43.2965, lon: 5.3698, rayon: 0.15 },
  { nom: "Lyon", lat: 45.7640, lon: 4.8357, rayon: 0.15 },
  { nom: "Toulouse", lat: 43.6047, lon: 1.4442, rayon: 0.13 },
  { nom: "Nice", lat: 43.7102, lon: 7.2620, rayon: 0.12 },
  { nom: "Cannes", lat: 43.5528, lon: 7.0174, rayon: 0.10 },
  { nom: "Nantes", lat: 47.2184, lon: -1.5536, rayon: 0.13 },
  { nom: "Strasbourg", lat: 48.5734, lon: 7.7521, rayon: 0.12 },
  { nom: "Montpellier", lat: 43.6108, lon: 3.8767, rayon: 0.12 },
  { nom: "Bordeaux", lat: 44.8378, lon: -0.5792, rayon: 0.13 },
  { nom: "Lille", lat: 50.6292, lon: 3.0573, rayon: 0.12 },
  { nom: "Rennes", lat: 48.1173, lon: -1.6778, rayon: 0.11 },
  { nom: "Reims", lat: 49.2583, lon: 4.0317, rayon: 0.10 },
  { nom: "Le Havre", lat: 49.4944, lon: 0.1079, rayon: 0.09 },
  { nom: "Saint-Étienne", lat: 45.4397, lon: 4.3872, rayon: 0.09 },
  { nom: "Toulon", lat: 43.1242, lon: 5.9280, rayon: 0.10 },
  { nom: "Grenoble", lat: 45.1885, lon: 5.7245, rayon: 0.10 },
  { nom: "Dijon", lat: 47.3220, lon: 5.0415, rayon: 0.09 },
  { nom: "Angers", lat: 47.4784, lon: -0.5632, rayon: 0.09 },
  { nom: "Nîmes", lat: 43.8367, lon: 4.3601, rayon: 0.09 },
  { nom: "Clermont-Ferrand", lat: 45.7772, lon: 3.0870, rayon: 0.09 },
  { nom: "Aix-en-Provence", lat: 43.5297, lon: 5.4474, rayon: 0.09 },
  { nom: "Annecy", lat: 45.8992, lon: 6.1294, rayon: 0.08 },
  { nom: "Biarritz", lat: 43.4832, lon: -1.5586, rayon: 0.07 }
];

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function interrogerUneVille(ville) {
  const { lat, lon, rayon } = ville;
  const south = lat - rayon, north = lat + rayon, west = lon - rayon, east = lon + rayon;
  const requete = `[out:json][timeout:25];node["amenity"~"^(cafe|restaurant)$"](${south},${west},${north},${east});out body;`;

  for (const url of SERVEURS_OVERPASS) {
    try {
      const controleur = new AbortController();
      const idTimeout = setTimeout(() => controleur.abort(), 20000);
      const r = await fetch(url, {
        method: "POST",
        headers: EN_TETES,
        body: "data=" + encodeURIComponent(requete),
        signal: controleur.signal
      });
      clearTimeout(idTimeout);
      if (!r.ok) continue;
      const data = await r.json();
      const nb = Array.isArray(data.elements) ? data.elements.length : 0;
      if (nb === 0) continue;
      return data.elements;
    } catch (e) {
      // essaie le miroir suivant
    }
  }
  return null; // tous les miroirs ont échoué pour cette ville
}

async function main() {
  const parNomEtVille = new Map(); // dédoublonnage par id OSM
  const echecs = [];

  for (const ville of VILLES) {
    process.stdout.write(`${ville.nom}... `);
    const elements = await interrogerUneVille(ville);
    if (!elements) {
      console.log("ÉCHEC (tous les miroirs ont échoué)");
      echecs.push(ville.nom);
    } else {
      let ajoutes = 0;
      for (const el of elements) {
        if (typeof el.lat !== "number" || typeof el.lon !== "number" || !el.tags?.name) continue;
        if (parNomEtVille.has(el.id)) continue;
        parNomEtVille.set(el.id, {
          n: el.tags.name,
          la: Math.round(el.lat * 1e6) / 1e6,
          lo: Math.round(el.lon * 1e6) / 1e6,
          t: el.tags.amenity === "restaurant" ? "restaurant" : "cafe",
          v: el.tags["addr:city"] || el.tags["contact:city"] || ville.nom
        });
        ajoutes++;
      }
      console.log(`${ajoutes} lieux ajoutés (${elements.length} reçus)`);
    }
    await pause(1500); // reste courtois envers les miroirs publics partagés
  }

  const index = [...parNomEtVille.values()];
  const cheminSortie = path.join(__dirname, "..", "data", "cafes-index.json");
  fs.writeFileSync(cheminSortie, JSON.stringify(index));

  console.log(`\n${index.length} lieux au total, écrits dans ${cheminSortie}`);
  console.log(`Taille du fichier : ${(fs.statSync(cheminSortie).size / 1024).toFixed(0)} Ko`);
  if (echecs.length) console.log(`Villes en échec (à relancer plus tard) : ${echecs.join(", ")}`);
}

main().catch(e => { console.error("Erreur fatale:", e); process.exit(1); });
