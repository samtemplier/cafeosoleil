// Proxy serveur vers Overpass API.
// Le navigateur appelle CE endpoint (même domaine → pas de CORS), et c'est Vercel
// qui parle à Overpass en coulisses.
//
// Syntaxe CommonJS (module.exports) volontairement, pas "export default" :
// sans package.json avec "type": "module", Vercel traite les .js comme CommonJS
// par défaut, et la syntaxe ES Modules fait échouer le build silencieusement.

const SERVEURS_OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter"
];

module.exports = async function handler(req, res) {
  const { south, west, north, east } = req.query;
  if (!south || !west || !north || !east) {
    return res.status(400).json({ error: "Paramètres manquants (south, west, north, east)" });
  }

  const requete = `[out:json][timeout:8];node["amenity"~"^(cafe|restaurant|bistro)$"](${south},${west},${north},${east});out body;`;

  // Diagnostic accumulé : si tout échoue, on renvoie le détail pour comprendre pourquoi.
  const diagnostic = [];

  for (const url of SERVEURS_OVERPASS) {
    try {
      const controleur = new AbortController();
      const idTimeout = setTimeout(() => controleur.abort(), 9000);

      // IMPORTANT : Overpass attend le corps au format "data=<requête urlencodée>",
      // avec le Content-Type application/x-www-form-urlencoded. Envoyer la requête
      // brute sans ça fait que certaines instances renvoient une page d'erreur HTML
      // (interprétée ensuite comme une réponse vide côté client).
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(requete),
        signal: controleur.signal
      });
      clearTimeout(idTimeout);

      if (!r.ok) {
        diagnostic.push({ url, status: r.status });
        continue; // serveur suivant
      }

      // On lit d'abord en texte pour détecter une éventuelle réponse non-JSON
      const texte = await r.text();
      let data;
      try {
        data = JSON.parse(texte);
      } catch (e) {
        // Réponse non-JSON (page d'erreur HTML par ex.) → on tente le serveur suivant
        diagnostic.push({ url, status: r.status, erreur: "réponse non-JSON", extrait: texte.slice(0, 120) });
        continue;
      }

      // Succès : cache 1h côté CDN Vercel (les cafés ne bougent pas d'une minute à l'autre)
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
      return res.status(200).json(data);

    } catch (e) {
      diagnostic.push({ url, erreur: e.name === "AbortError" ? "timeout" : e.message });
    }
  }

  // Tous les serveurs ont échoué → on renvoie le diagnostic complet pour déboguer
  return res.status(502).json({ error: "Tous les serveurs Overpass ont échoué", diagnostic });
};
