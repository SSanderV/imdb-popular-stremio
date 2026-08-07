const express = require("express");
const fs = require("fs");
const path = require("path");

const IS_VERCEL = !!process.env.VERCEL;
const cron = IS_VERCEL ? null : require("node-cron");

const app = express();
const PORT = process.env.PORT || 7001;
const TOP_RATED_THRESHOLD = 7.0;

const SOURCES = {
  movies: "https://raw.githubusercontent.com/crazyuploader/IMDb-Top-50/main/data/popular/movies.json",
  shows: "https://raw.githubusercontent.com/crazyuploader/IMDb-Top-50/main/data/popular/shows.json",
};

// ---------------------------------------------------------------------------
// Data stores
// ---------------------------------------------------------------------------

const allMetas = { movies: [], shows: [] };
const genreSets = { movie: new Set(), series: new Set() };

// ---------------------------------------------------------------------------
// TTL cache (Vercel serverless uses this; Docker uses node-cron instead)
// ---------------------------------------------------------------------------

let lastRefresh = 0;
let refreshPromise = null;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

async function ensureData() {
  const now = Date.now();
  if (allMetas.movies.length > 0 && now - lastRefresh < CACHE_TTL) return;
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshAll()
    .then(() => { lastRefresh = Date.now(); })
    .catch((e) => { console.error("[ensureData] refresh failed:", e.message); })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

async function fetchJSON(url) {
  const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch }));
  const fn = fetch || globalThis.fetch;
  let res = await fn(url, { redirect: "follow" });
  if ([301, 302, 307, 308].includes(res.status)) {
    const loc = res.headers.get("location");
    if (loc) res = await fn(loc, { redirect: "follow" });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function decodeEntities(str) {
  if (!str || typeof str !== "string") return str;
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractImdbId(item) {
  if (item.imdb_id) return item.imdb_id;
  if (item.id && String(item.id).startsWith("tt")) return item.id;
  const link = item.url || item.link || "";
  const m = link.match(/tt\d{7,}/);
  return m ? m[0] : null;
}

function parseRankChange(str) {
  if (!str || typeof str !== "string") return 0;
  const m = str.match(/(UP|DOWN)\s+(\d+)/i);
  if (!m) return 0;
  return (m[1].toUpperCase() === "UP" ? 1 : -1) * parseInt(m[2], 10);
}

// ---------------------------------------------------------------------------
// Data transformation & loading
// ---------------------------------------------------------------------------

function toStremioMeta(item, type) {
  const id = extractImdbId(item);
  if (!id) return null;
  const meta = { id, type, name: decodeEntities(item.title || item.name || "Unknown") };
  if (item.poster || item.image) meta.poster = item.poster || item.image;
  if (item.rating) meta.imdbRating = String(item.rating);
  if (item.plot) meta.description = decodeEntities(item.plot);
  if (item.genres) {
    const g = typeof item.genres === "string" ? item.genres.split(/,\s*/) : item.genres;
    if (Array.isArray(g) && g.length) meta.genres = g;
  }
  if (item.runtime) {
    const mins = Number(item.runtime);
    meta.runtime = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}min` : `${mins} min`;
  }
  if (item.year) meta.year = String(item.year);
  if (item.certificate) meta.certification = item.certificate;
  if (item.directors) meta.director = Array.isArray(item.directors) ? item.directors : [item.directors];
  if (item.stars) meta.cast = typeof item.stars === "string" ? item.stars.split(/,\s*/) : item.stars;
  // Internal — stripped before serving to Stremio
  meta._rankChange = parseRankChange(item.meterRankChange);
  return meta;
}

function collectGenres(metaList, type) {
  genreSets[type] = new Set();
  for (const m of metaList) {
    if (m.genres) m.genres.forEach((g) => genreSets[type].add(g));
  }
}

async function refreshCatalog(key, url, type) {
  try {
    const data = await fetchJSON(url);
    const items = Array.isArray(data) ? data : data.items || data.results || [];
    const results = items.map((i) => toStremioMeta(i, type)).filter(Boolean);
    if (results.length > 0) {
      allMetas[key] = results;
      collectGenres(results, type);
      const trending = results.filter((m) => m._rankChange > 0).length;
      const topRated = results.filter(
        (m) => m.imdbRating && parseFloat(m.imdbRating) >= TOP_RATED_THRESHOLD
      ).length;
      console.log(
        `[${key}] ${results.length} items | ${trending} trending | ${topRated} top-rated | ${genreSets[type].size} genres`
      );
    }
  } catch (e) {
    console.error(`[${key}] Refresh failed:`, e.message);
  }
}

async function refreshAll() {
  await Promise.all([
    refreshCatalog("movies", SOURCES.movies, "movie"),
    refreshCatalog("shows", SOURCES.shows, "series"),
  ]);
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function parseExtra(str) {
  const result = {};
  if (!str) return result;
  for (const pair of str.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    result[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return result;
}

function stripInternal({ _rankChange, ...clean }) {
  return clean;
}

function resolveCatalog(type, id, extra) {
  const key = type === "movie" ? "movies" : "shows";
  let list = allMetas[key];
  if (!list || !list.length) return [];

  // Base selection by catalog type
  if (id.startsWith("imdb-trending-")) {
    list = list
      .filter((m) => m._rankChange > 0)
      .sort((a, b) => b._rankChange - a._rankChange);
  } else if (id.startsWith("imdb-top-rated-")) {
    list = list
      .filter((m) => m.imdbRating && parseFloat(m.imdbRating) >= TOP_RATED_THRESHOLD)
      .sort((a, b) => parseFloat(b.imdbRating) - parseFloat(a.imdbRating));
  } else if (!id.startsWith("imdb-popular-")) {
    return [];
  }

  // Genre filter
  if (extra.genre) {
    list = list.filter((m) => m.genres && m.genres.includes(extra.genre));
  }

  // Search filter — matches title, description, cast, and director
  if (extra.search) {
    const q = extra.search.toLowerCase();
    list = list.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.description && m.description.toLowerCase().includes(q)) ||
        (m.cast && m.cast.some((c) => c.toLowerCase().includes(q))) ||
        (m.director && m.director.some((d) => d.toLowerCase().includes(q)))
    );
  }

  // Pagination
  const skip = parseInt(extra.skip) || 0;
  if (skip > 0) list = list.slice(skip);

  return list.map(stripInternal);
}

// ---------------------------------------------------------------------------
// Manifest (built dynamically so genre lists stay current)
// ---------------------------------------------------------------------------

function buildManifest(proto, host) {
  const movieGenres = [...genreSets.movie].sort();
  const seriesGenres = [...genreSets.series].sort();

  const movieExtras = [
    { name: "genre", options: movieGenres },
    { name: "search" },
    { name: "skip" },
  ];
  const seriesExtras = [
    { name: "genre", options: seriesGenres },
    { name: "search" },
    { name: "skip" },
  ];

  return {
    stremioAddonsConfig: {
      issuer: "https://stremio-addons.net",
      signature:
        "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..G-1w-gbjMK8hs2Gr8aYivw.ktgQJPi38gdApAgHbuF5xHOdHum70ITuae6Fvgp8HvDmrB-ymxxInHwkPjw-ak2kp7iEEersXEh7lLV_GZEYEKa7KQ9XAbsnp4zm-zpIcMsjZvVdevRfRXXN7FTHJrSj.Kk6vdgPh8M-3yUCNp2-4tQ",
    },
    id: "community.imdb-popular",
    version: "2.0.0",
    name: "IMDb Popular",
    description:
      "IMDb Most Popular Movies & TV Shows — trending, top-rated, genre filtering, and search",
    logo: `${proto}://${host}/logo.png`,
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [
      { type: "movie", id: "imdb-popular-movies", name: "IMDb Popular Movies", extra: movieExtras },
      { type: "series", id: "imdb-popular-series", name: "IMDb Popular Series", extra: seriesExtras },
      { type: "movie", id: "imdb-trending-movies", name: "IMDb Trending Movies", extra: movieExtras },
      { type: "series", id: "imdb-trending-series", name: "IMDb Trending Series", extra: seriesExtras },
      { type: "movie", id: "imdb-top-rated-movies", name: "IMDb Top Rated Movies", extra: movieExtras },
      { type: "series", id: "imdb-top-rated-series", name: "IMDb Top Rated Series", extra: seriesExtras },
    ],
    behaviorHints: { configurable: false },
    idPrefixes: ["tt"],
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const hits = { manifest: 0, catalog: 0 };

app.use(async (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[REQ] ${req.method} ${req.url} from ${ip}`);
  try { await ensureData(); } catch (e) { console.error("[middleware] ensureData error:", e.message); }
  next();
});

// Logo ---
const LOGO_URL =
  "https://raw.githubusercontent.com/QuietAnima/imdb-popular-stremio/main/logo.png";
const LOGO_PATH = path.join(__dirname, "logo.png");
let logoBuf = null;

async function ensureLogo() {
  if (logoBuf) return;
  try {
    if (fs.existsSync(LOGO_PATH)) {
      logoBuf = fs.readFileSync(LOGO_PATH);
      console.log(`[logo] Loaded from cache: ${logoBuf.length} bytes`);
      return;
    }
    const { default: fetch } = await import("node-fetch").catch(() => ({
      default: globalThis.fetch,
    }));
    const fn = fetch || globalThis.fetch;
    const res = await fn(LOGO_URL);
    if (res.ok) {
      logoBuf = Buffer.from(await res.arrayBuffer());
      try { fs.writeFileSync(LOGO_PATH, logoBuf); } catch (_) { /* read-only on Vercel */ }
      console.log(`[logo] Downloaded: ${logoBuf.length} bytes`);
    }
  } catch (e) {
    console.error("[logo] Failed:", e.message);
  }
}

// Landing page
app.get('/', (req, res) => {
  const manifest = buildManifest();
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${manifest.name} - Stremio Addon</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a2e;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 520px;
    }
    .logo {
      width: 120px;
      height: 120px;
      margin-bottom: 1.5rem;
      border-radius: 20px;
    }
    h1 {
      font-size: 2rem;
      font-weight: 700;
      color: #fff;
      margin-bottom: 0.75rem;
    }
    .description {
      font-size: 1.05rem;
      color: #a0a0c0;
      line-height: 1.6;
      margin-bottom: 2rem;
    }
    .install-btn {
      display: inline-block;
      background: #7b5bf5;
      color: #fff;
      text-decoration: none;
      padding: 0.9rem 2.5rem;
      border-radius: 8px;
      font-size: 1.1rem;
      font-weight: 600;
      transition: background 0.2s, transform 0.1s;
    }
    .install-btn:hover {
      background: #6a4be0;
      transform: translateY(-1px);
    }
    .install-btn:active {
      transform: translateY(0);
    }
    .catalogs {
      margin-top: 2.5rem;
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      justify-content: center;
    }
    .catalog-tag {
      background: rgba(123, 91, 245, 0.15);
      color: #b0a0e0;
      padding: 0.35rem 0.75rem;
      border-radius: 20px;
      font-size: 0.8rem;
    }
    footer {
      position: fixed;
      bottom: 1rem;
      color: #505070;
      font-size: 0.8rem;
    }
    footer a { color: #7b5bf5; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <img src="/logo.png" alt="${manifest.name}" class="logo">
    <h1>${manifest.name}</h1>
    <p class="description">${manifest.description}</p>
    <a href="stremio://imdb-popular-stremio.vercel.app/manifest.json" class="install-btn">Install to Stremio</a>
    <div class="catalogs">
      ${manifest.catalogs.map(c => `<span class="catalog-tag">${c.name}</span>`).join('\n      ')}
    </div>
  </div>
  <footer>v${manifest.version} &middot; <a href="/manifest.json">Manifest</a></footer>
</body>
</html>`);
});


app.get("/logo.png", async (_, res) => {
  await ensureLogo();
  if (!logoBuf) return res.status(404).end();
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=604800, s-maxage=604800");
  res.send(logoBuf);
});

// Routes ---
app.get("/manifest.json", (req, res) => {
  hits.manifest++;
  res.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  res.json(buildManifest(proto, req.headers.host));
});

app.get("/catalog/:type/:id.json", (req, res) => {
  hits.catalog++;
  res.set("Cache-Control", "public, max-age=1800, s-maxage=3600, stale-while-revalidate=86400");
  res.json({ metas: resolveCatalog(req.params.type, req.params.id, {}) });
});

app.get("/catalog/:type/:id/:extra.json", (req, res) => {
  hits.catalog++;
  res.set("Cache-Control", "public, max-age=1800, s-maxage=3600, stale-while-revalidate=86400");
  res.json({
    metas: resolveCatalog(req.params.type, req.params.id, parseExtra(req.params.extra)),
  });
});

app.get("/status", (_, res) => {
  res.set("Cache-Control", "no-cache");
  const stats = (key, type) => ({
    count: allMetas[key].length,
    trending: allMetas[key].filter((m) => m._rankChange > 0).length,
    topRated: allMetas[key].filter(
      (m) => m.imdbRating && parseFloat(m.imdbRating) >= TOP_RATED_THRESHOLD
    ).length,
    genres: [...genreSets[type]].sort(),
  });
  res.json({
    status: "ok",
    version: "2.0.0",
    hits,
    movies: stats("movies", "movie"),
    shows: stats("shows", "series"),
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

module.exports = app;

if (!IS_VERCEL) {
  Promise.all([refreshAll(), ensureLogo()]).then(() => {
    lastRefresh = Date.now();
    cron.schedule("0 */6 * * *", () => {
      refreshAll().then(() => { lastRefresh = Date.now(); });
    });
    app.listen(PORT, "0.0.0.0", () =>
      console.log(`IMDb Popular addon v2.0.0 on :${PORT}`)
    );
  });
}
