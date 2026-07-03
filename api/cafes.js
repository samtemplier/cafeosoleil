// Proxy serveur vers Overpass API.
// Le navigateur appelle CE endpoint (même domaine → pas de CORS), et c'est Vercel
// qui parle à Overpass en coulisses.
//
// Syntaxe CommonJS (module.exports) volontairement, pas "export default" :
// sans package.json avec "type": "module", Vercel traite les .js comme CommonJS
// par défaut, et la syntaxe ES Modules fait échouer le build silencieusement.

// IMPORTANT : overpass.kumi.systems (injoignable) et overpass.osm.ch (renvoie
// systématiquement 200 avec 0 élément, y compris pour des requêtes sur Paris/Londres/NY —
// une instance cassée dont le faux succès court-circuitait le fallback) ont été retirés.
const SERVEURS_OVERPASS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
];

// overpass-api.de (et les instances qui partagent son code) renvoient 406 Not Acceptable
// aux requêtes sans User-Agent explicite.
const EN_TETES = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "cafeosoleil/1.0 (+https://cafeosoleil.vercel.app)"
};

// Échappe une saisie utilisateur pour l'utiliser comme sous-chaîne littérale dans le
// filtre regex Overpass ["name"~"..."] : d'abord les caractères spéciaux regex (pour
// que la recherche reste une correspondance de texte simple, pas une regex arbitraire),
// puis les guillemets/antislashs pour l'insertion dans la chaîne Overpass QL.
function echapperNomPourOverpass(nom) {
  const sansMetacaracteres = nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return sansMetacaracteres.replace(/"/g, '\\"');
}

// Minuscules + accents retirés, pour comparer "café" et "cafe"/"café" sans être
// sensible aux variantes d'accentuation.
function normaliser(texte) {
  return texte.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Mots génériques d'hôtellerie-restauration à éviter comme critère de recherche
// Overpass : "café" ne filtre presque rien côté sélectivité, ET surtout ne matche pas
// des variantes orthographiques comme "Caffè" — alors que le nom propre qui accompagne
// (ex. "Roma") est à la fois plus sélectif et orthographié de façon plus stable.
const MOTS_GENERIQUES = new Set([
  "cafe", "caffe", "coffee", "bar", "restaurant", "resto", "bistro", "bistrot",
  "brasserie", "snack", "pizzeria", "boulangerie", "patisserie", "glacier",
  "salon", "the", "house", "shop", "place", "le", "la", "les", "de", "du", "des"
]);

// Choisit, parmi les mots de la recherche, celui à utiliser comme filtre Overpass :
// le plus long des mots non-génériques (le nom propre, généralement), ou à défaut le
// plus long mot tout court. Les autres mots servent seulement au classement ensuite
// (voir classerParPertinence), pas au filtrage côté serveur Overpass.
function motDistinctif(nom) {
  const mots = nom.trim().split(/\s+/).filter(m => m.length >= 2);
  if (mots.length === 0) return nom.trim();
  const nonGeneriques = mots.filter(m => !MOTS_GENERIQUES.has(normaliser(m)));
  const candidats = nonGeneriques.length > 0 ? nonGeneriques : mots;
  return candidats.reduce((a, b) => (b.length > a.length ? b : a));
}

// Classe les résultats par nombre de mots de la recherche originale retrouvés dans le
// nom du lieu (après normalisation accents/casse) : les correspondances les plus
// complètes remontent en premier, même si le filtre Overpass n'a porté que sur un seul
// mot distinctif.
function classerParPertinence(elements, requeteOriginale) {
  const motsRequete = normaliser(requeteOriginale).split(/\s+/).filter(Boolean);
  return elements
    .map(el => {
      const nomNormalise = normaliser(el.tags?.name || "");
      const score = motsRequete.filter(m => nomNormalise.includes(m)).length;
      return { el, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ el }) => el);
}

module.exports = async function handler(req, res) {
  const { south, west, north, east, nom } = req.query;
  if (!south || !west || !north || !east) {
    return res.status(400).json({ error: "Paramètres manquants (south, west, north, east)" });
  }

  // Recherche par nom (ex. "Café Roma") en plus du filtre géographique : utilisé par
  // la recherche de café par nom, en plus du bouton "chercher dans cette zone" qui
  // n'envoie pas ce paramètre. On filtre côté Overpass sur le mot le plus distinctif
  // de la requête (pas la phrase entière) : un mot générique comme "café" ne matche
  // pas "Caffè" (orthographe différente selon la langue), alors que le nom propre qui
  // l'accompagne (ex. "Roma") est à la fois plus sélectif et plus stable. Les résultats
  // sont ensuite reclassés par nombre de mots de la requête retrouvés (classerParPertinence).
  const filtreNom = nom ? `["name"~"${echapperNomPourOverpass(motDistinctif(nom))}",i]` : "";
  const requete = `[out:json][timeout:25];node["amenity"~"^(cafe|restaurant)$"]${filtreNom}(${south},${west},${north},${east});out body;`;

  const diagnostic = [];
  let derniereReponseVide = null; // on garde une réponse vide valide en dernier recours

  for (const url of SERVEURS_OVERPASS) {
    try {
      const controleur = new AbortController();
      const idTimeout = setTimeout(() => controleur.abort(), 9000);

      // Overpass attend "data=<requête urlencodée>" avec ce Content-Type.
      const r = await fetch(url, {
        method: "POST",
        headers: EN_TETES,
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
      if (nom) data.elements = classerParPertinence(data.elements, nom);
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
