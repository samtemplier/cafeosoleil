// Proxy serveur vers Overpass API.
// Le navigateur appelle CE endpoint (même domaine → pas de CORS), et c'est Vercel
// qui parle à Overpass en coulisses.
//
// Syntaxe CommonJS (module.exports) volontairement, pas "export default" :
// sans package.json avec "type": "module", Vercel traite les .js comme CommonJS
// par défaut, et la syntaxe ES Modules fait échouer le build silencieusement.

// IMPORTANT : overpass.kumi.systems est placé en PREMIER car overpass-api.de a
// (constaté en pratique) des données incomplètes qui renvoient 0 élément avec un
// statut 200 — ce qui bloquait tout, la fonction s'arrêtant sur ce faux succès.
const SERVEURS_OVERPASS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass-api.de/api/interpreter"
];

module.exports = async function handler(req, res) {
  const { south, west, north, east } = req.query;
  if (!south || !west || !north || !east) {
    return res.status(400).json({ error: "Paramètres manquants (south, west, north, east)" });
  }

  const requete = `[out:json][timeout:25];node["amenity"~"^(cafe|restaurant)$"](${south},${west},${north},${east});out body;`;

  const diagnostic = [];
  let derniereReponseVide = null; // on garde une réponse vide valide en dernier recours

  for (const url of SERVEURS_OVERPASS) {
    try {
      const controleur = new AbortController();
      const idTimeout = setTimeout(() => controleur.abort(), 9000);

      // Overpass attend "data=<requête urlencodée>" avec ce Content-Type.
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(requete),
        signal: controleur.signal
      });
      clearTimeout(idTimeout);

      if (!r.ok) {
        diagnostic.push({ url, status: r.status });
        continue;
      }

      const texte = await r.text();
      let data;
      try {
        data = JSON.parse(texte);
      } catch (e) {
        diagnostic.push({ url, status: r.status, erreur: "réponse non-JSON", extrait: texte.slice(0, 120) });
        continue;
      }

      const nb = Array.isArray(data.elements) ? data.elements.length : 0;

      if (nb === 0) {
        // Réponse valide mais vide : peut-être une instance aux données cassées.
        // On la mémorise et on tente le serveur suivant ; si tous sont vides,
        // on renverra cette réponse (la zone est peut-être réellement sans café).
        diagnostic.push({ url, status: 200, elements: 0 });
        derniereReponseVide = data;
        continue;
      }

      // Succès avec des données : cache 1h côté CDN Vercel
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
      return res.status(200).json(data);

    } catch (e) {
      diagnostic.push({ url, erreur: e.name === "AbortError" ? "timeout" : e.message });
    }
  }

  // Aucun serveur n'a renvoyé de données non vides.
  // Si au moins un a répondu correctement (mais vide), on renvoie cette réponse vide :
  // la zone est probablement réellement sans café.
  if (derniereReponseVide) {
    res.setHeader("Cache-Control", "s-maxage=600"); // cache plus court pour les zones vides
    return res.status(200).json(derniereReponseVide);
  }

  // Tous les serveurs ont vraiment échoué
  return res.status(502).json({ error: "Tous les serveurs Overpass ont échoué", diagnostic });
};
