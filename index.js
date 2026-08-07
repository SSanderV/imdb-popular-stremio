const express = require("express");
const fs = require("fs");
const path = require("path");

const IS_VERCEL = !!process.env.VERCEL;
const cron = IS_VERCEL ? null : require("node-cron");

const app = express();
const PORT = process.env.PORT || 7001;
const VERSION = require("./package.json").version;

// ---------------------------------------------------------------------------
// IMDb GraphQL source
// ---------------------------------------------------------------------------

const IMDB_GQL = "https://api.graphql.imdb.com/";

// The WAF checks that x-imdb-client-name is present; without it every request
// is a bare 403. The locale pair pins titles and certificates to en-US —
// IMDb localises otherwise, e.g. country=EE returns "Ämblikmees. Täitsa uus päev".
const IMDB_HEADERS = {
  "content-type": "application/json",
  "x-imdb-client-name": "imdb-web-next",
  "x-imdb-user-country": "US",
  "x-imdb-user-language": "en-US",
};

const CHART_SIZE = 100; // MOST_POPULAR_* charts are 100 long
const TRENDING_POOL = 250; // one call covers both types, ~120 each
const CATALOG_LIMIT = 40; // length of the derived trending / top-rated rows
const MIN_VOTES = 5000; // keeps unreleased announcements out of derived rows

// The trending feed mixes every title type IMDb tracks, so map explicitly
// rather than treating "not a series" as a movie. tvSpecial in particular is
// isSeries=false and would otherwise be published as a film — currently
// "The Punisher: One Last Kill", 51k votes, so well clear of MIN_VOTES.
const STREMIO_TYPE = {
  movie: "movie",
  tvMovie: "movie",
  tvSeries: "series",
  tvMiniSeries: "series",
};

const TITLE_FIELDS = `
  id
  titleText { text }
  titleType { id }
  releaseYear { year }
  primaryImage { url }
  ratingsSummary { aggregateRating voteCount }
  runtime { seconds }
  certificate { rating }
  titleGenres { genres { genre { text } } }
  plot { plotText { plainText } }
  principalCreditsV2 { grouping { text } credits { name { nameText { text } } } }
`;

const CHART_QUERY = `query Chart($chart: ChartTitleType!, $n: Int!) {
  chartTitles(first: $n, chart: {chartType: $chart}) {
    edges { node { ${TITLE_FIELDS} } }
  }
}`;

// IMDb's own traffic-weighted trending, already ranked. Mixes types, so it is
// split on titleType.isSeries rather than by making two calls.
const TRENDING_QUERY = `query Trending($n: Int!) {
  topTrendingTitles(first: $n, input: {dataWindow: HOURS, trafficSource: XWW}) {
    edges { node { rank item { ${TITLE_FIELDS} } } }
  }
}`;

// ---------------------------------------------------------------------------
// Data store
// ---------------------------------------------------------------------------

const store = {
  popular: { movie: [], series: [] },
  trending: { movie: [], series: [] },
  topRated: { movie: [], series: [] },
  genres: { movie: [], series: [] },
  fetchedAt: null,
};

const CACHE_PATH = process.env.CACHE_PATH || path.join(__dirname, "cache.json");

// ---------------------------------------------------------------------------
// TTL cache (Vercel serverless uses this; Docker uses node-cron instead)
// ---------------------------------------------------------------------------

let refreshPromise = null;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

async function ensureData() {
  const fresh = store.fetchedAt && Date.now() - store.fetchedAt < CACHE_TTL;
  if (store.popular.movie.length > 0 && fresh) return;
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshAll()
    .catch((e) => { console.error("[ensureData] refresh failed:", e.message); })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

// ---------------------------------------------------------------------------
// Transformation
// ---------------------------------------------------------------------------

// IMDb labels credit groups in both singular and plural — Director/Directors,
// Creator/Creators, Star/Stars — so an exact match silently drops multi-credit
// titles.
const DIRECTOR_GROUP = /^(director|creator)s?$/i;
const CAST_GROUP = /^stars?$/i;

function creditNames(groups, pattern) {
  const group = (groups || []).find((g) => pattern.test(g.grouping?.text || ""));
  if (!group) return null;
  const names = (group.credits || [])
    .map((c) => c.name?.nameText?.text)
    .filter(Boolean);
  return names.length ? names : null;
}

function nodeToMeta(node, type) {
  if (!node || !node.id) return null;
  const meta = { id: node.id, type, name: node.titleText?.text || "Unknown" };

  if (node.primaryImage?.url) meta.poster = node.primaryImage.url;
  if (node.plot?.plotText?.plainText) meta.description = node.plot.plotText.plainText;
  if (node.releaseYear?.year) meta.year = String(node.releaseYear.year);
  if (node.certificate?.rating) meta.certification = node.certificate.rating;

  const rating = node.ratingsSummary?.aggregateRating;
  if (rating != null) meta.imdbRating = String(rating);

  const genres = (node.titleGenres?.genres || [])
    .map((g) => g.genre?.text)
    .filter(Boolean);
  if (genres.length) meta.genres = genres;

  const seconds = node.runtime?.seconds;
  if (seconds) {
    const mins = Math.round(seconds / 60);
    meta.runtime = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}min` : `${mins} min`;
  }

  const director = creditNames(node.principalCreditsV2, DIRECTOR_GROUP);
  if (director) meta.director = director;
  const cast = creditNames(node.principalCreditsV2, CAST_GROUP);
  if (cast) meta.cast = cast;

  // Internal — stripped before serving to Stremio
  meta._votes = node.ratingsSummary?.voteCount || 0;
  return meta;
}

function collectGenres(metas) {
  const set = new Set();
  for (const m of metas) {
    if (m.genres) m.genres.forEach((g) => set.add(g));
  }
  return [...set].sort();
}

// "Popular right now AND good": the popular chart re-ordered by rating rather
// than by meter rank. A fixed rating threshold does not work here because IMDb
// TV ratings run a full point above film ratings (medians 8.0 vs 7.0), so 7.0
// keeps half the movies but 83% of the series.
function deriveTopRated(popular) {
  return popular
    .filter((m) => m.imdbRating && m._votes >= MIN_VOTES)
    .sort((a, b) => parseFloat(b.imdbRating) - parseFloat(a.imdbRating))
    .slice(0, CATALOG_LIMIT);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function gql(query, variables) {
  const res = await fetch(IMDB_GQL, {
    method: "POST",
    headers: IMDB_HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

async function fetchChart(chartType, type) {
  const data = await gql(CHART_QUERY, { chart: chartType, n: CHART_SIZE });
  return (data.chartTitles?.edges || [])
    .map((e) => nodeToMeta(e.node, type))
    .filter(Boolean);
}

async function fetchTrending() {
  const data = await gql(TRENDING_QUERY, { n: TRENDING_POOL });
  const out = { movie: [], series: [] };
  for (const edge of data.topTrendingTitles?.edges || []) {
    const item = edge.node?.item;
    const type = STREMIO_TYPE[item?.titleType?.id];
    if (!type) continue;
    const meta = nodeToMeta(item, type);
    // Native rank order is the edge order, so no re-sorting. The floor drops
    // announcements with no audience yet, which otherwise lead the row.
    if (meta && meta._votes >= MIN_VOTES && out[type].length < CATALOG_LIMIT) {
      out[type].push(meta);
    }
  }
  return out;
}

// The disk cache exists so a container restart does not serve empty catalogs
// while IMDb is unreachable. Vercel has no persistent disk and no restart to
// protect — ensureData already keeps warm invocations populated — and its
// filesystem is read-only, so attempting the write there only produces an error
// on every refresh.
function saveCache() {
  if (IS_VERCEL) return;
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(store));
  } catch (e) {
    console.error("[cache] Write failed:", e.message);
  }
}

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    if (!saved.popular?.movie?.length) return false;
    Object.assign(store, saved);
    const age = Math.round((Date.now() - store.fetchedAt) / 3600000);
    console.log(`[cache] Restored ${store.popular.movie.length} movies, ${age}h old`);
    return true;
  } catch (e) {
    console.error("[cache] Read failed:", e.message);
    return false;
  }
}

async function refreshAll() {
  const [movies, series, trending] = await Promise.all([
    fetchChart("MOST_POPULAR_MOVIES", "movie"),
    fetchChart("MOST_POPULAR_TV_SHOWS", "series"),
    fetchTrending(),
  ]);

  // Every list is replaced or none is, so a partial failure leaves the previous
  // snapshot serving rather than half-updating it.
  if (!movies.length || !series.length) {
    throw new Error(`empty chart (movies=${movies.length} series=${series.length})`);
  }

  store.popular = { movie: movies, series };
  store.trending = trending;
  store.topRated = { movie: deriveTopRated(movies), series: deriveTopRated(series) };
  store.genres = { movie: collectGenres(movies), series: collectGenres(series) };
  store.fetchedAt = Date.now();

  for (const type of ["movie", "series"]) {
    console.log(
      `[${type}] ${store.popular[type].length} popular | ` +
        `${store.trending[type].length} trending | ` +
        `${store.topRated[type].length} top-rated | ` +
        `${store.genres[type].length} genres`
    );
  }
  saveCache();
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

function stripInternal({ _votes, ...clean }) {
  return clean;
}

function resolveCatalog(type, id, extra) {
  if (type !== "movie" && type !== "series") return [];

  let list;
  if (id.startsWith("imdb-popular-")) list = store.popular[type];
  else if (id.startsWith("imdb-trending-")) list = store.trending[type];
  else if (id.startsWith("imdb-top-rated-")) list = store.topRated[type];
  else return [];

  if (!list.length) return [];

  if (extra.genre) {
    list = list.filter((m) => m.genres && m.genres.includes(extra.genre));
  }

  // Search matches title, description, cast, and director
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

  const skip = parseInt(extra.skip) || 0;
  if (skip > 0) list = list.slice(skip);

  return list.map(stripInternal);
}

// ---------------------------------------------------------------------------
// Manifest (built dynamically so genre lists stay current)
// ---------------------------------------------------------------------------

function buildManifest(proto, host) {
  const extrasFor = (type) => [
    { name: "genre", options: store.genres[type] },
    { name: "search" },
    { name: "skip" },
  ];
  const movieExtras = extrasFor("movie");
  const seriesExtras = extrasFor("series");

  return {
    stremioAddonsConfig: {
      issuer: "https://stremio-addons.net",
      signature:
        "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..G-1w-gbjMK8hs2Gr8aYivw.ktgQJPi38gdApAgHbuF5xHOdHum70ITuae6Fvgp8HvDmrB-ymxxInHwkPjw-ak2kp7iEEersXEh7lLV_GZEYEKa7KQ9XAbsnp4zm-zpIcMsjZvVdevRfRXXN7FTHJrSj.Kk6vdgPh8M-3yUCNp2-4tQ",
    },
    id: "community.imdb-popular",
    version: VERSION,
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

function originOf(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return { proto, host: req.headers.host };
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
    const res = await fetch(LOGO_URL);
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
app.get("/", (req, res) => {
  const { proto, host } = originOf(req);
  const manifest = buildManifest(proto, host);
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
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
    <a href="stremio://${host}/manifest.json" class="install-btn">Install to Stremio</a>
    <div class="catalogs">
      ${manifest.catalogs.map((c) => `<span class="catalog-tag">${c.name}</span>`).join("\n      ")}
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
  const { proto, host } = originOf(req);
  res.json(buildManifest(proto, host));
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

// Counts are per catalog so a monitor can alert on a row shrinking, not just on
// the data going stale. Both failures look identical from the outside otherwise.
app.get("/status", (_, res) => {
  res.set("Cache-Control", "no-cache");
  const stats = (type) => ({
    popular: store.popular[type].length,
    trending: store.trending[type].length,
    topRated: store.topRated[type].length,
    genres: store.genres[type],
  });
  res.json({
    status: "ok",
    version: VERSION,
    source: "imdb-graphql",
    fetchedAt: store.fetchedAt ? new Date(store.fetchedAt).toISOString() : null,
    ageSeconds: store.fetchedAt ? Math.round((Date.now() - store.fetchedAt) / 1000) : null,
    hits,
    movies: stats("movie"),
    shows: stats("series"),
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

module.exports = app;

if (!IS_VERCEL) {
  loadCache();
  Promise.all([
    refreshAll().catch((e) => console.error("[boot] Refresh failed:", e.message)),
    ensureLogo(),
  ]).then(() => {
    cron.schedule("0 */6 * * *", () => {
      refreshAll().catch((e) => console.error("[cron] Refresh failed:", e.message));
    });
    app.listen(PORT, "0.0.0.0", () =>
      console.log(`IMDb Popular addon v${VERSION} on :${PORT}`)
    );
  });
}
