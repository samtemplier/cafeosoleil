// Proxy serveur vers Overpass API.
// Le navigateur appelle CE endpoint (même domaine → pas de CORS), et c'est Vercel
// qui parle à Overpass en coulisses. Ça évite le blocage 406 qu'overpass-api.de
// applique parfois aux appels faits directement depuis le navigateur sur des
// domaines d'hébergement génériques (*.vercel.app, *.netlify.app...).

const SERVEURS_OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter"
];

export default async function handler(req, res) {
  const { south, west, north, east } = req.query;

  if (!south || !west || !north || !east) {
    return res.status(400).json({ error: "Paramètres manquants (south, west, north, east)" });
  }

  const requete = `[out:json][timeout:8];node["amenity"~"^(cafe|restaurant|bistro)$"](${south},${west},${north},${east});out body;`;

  let dernierStatus = null;

  for (const url of SERVEURS_OVERPASS) {
    try {
      const controleur = new AbortController();
      const idTimeout = setTimeout(() => controleur.abort(), 8000);

      const r = await fetch(url, {
        method: "POST",
        body: requete,
        signal: controleur.signal
      });
      clearTimeout(idTimeout);

      dernierStatus = r.status;
      if (!r.ok) continue;

      const data = await r.json();
      // Cache 1h côté CDN Vercel : les cafés ne bougent pas d'une minute à l'autre,
      // ça évite de re-solliciter Overpass à chaque visiteur sur la même zone.
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
      return res.status(200).json(data);
    } catch (e) {
      // on essaie le serveur Overpass suivant
    }
  }

  return res.status(502).json({ error: "Tous les serveurs Overpass ont échoué", dernierStatus });
}
