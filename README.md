# IMDb Popular - Stremio Addon

<p align="center">
  <img src="logo.png" alt="IMDb Popular" width="128">
</p>

<p align="center">
  A <a href="https://www.stremio.com/">Stremio</a> addon that brings <strong>IMDb Most Popular</strong>, <strong>Trending</strong> and <strong>Top Rated</strong> catalogs for movies and TV series to your home screen, with genre filtering and search. Runs as a Docker container or on Vercel.
</p>

---

## Features

- **Six catalogs**: Popular Movies, Popular Series, Trending Movies, Trending Series, Top Rated Movies, Top Rated Series
- **Genre filtering** on every catalog, with the genre list rebuilt on each refresh rather than hardcoded. Genres are collected from the popular charts, so an uncommon one can come back empty on the shorter Trending and Top Rated rows.
- **Search** across all catalogs, matching title, plot, cast and director
- **Rich metadata**: plot, genres, runtime, cast, director, certificate, year, poster and IMDb rating
- **Readable runtimes**: `1h 30min` rather than `90 min`
- **Locale pinned to en-US**, so titles and certificates do not localise to wherever the server happens to sit
- **Refreshes every 6 hours**, by cron when self-hosted and by TTL when serverless
- **Survives restarts**: the container keeps a disk cache so a restart during an IMDb outage still serves the last good snapshot
- **No database**, one Node process and an in-memory store
- **CORS enabled**, so desktop, web and mobile clients all work

## Install in Stremio

Deploy the addon first (see below), then:

1. Open **Stremio** and go to the **Addons** page (puzzle piece icon)
2. Enter your addon URL in the search bar at the top:
   ```
   https://<your-deployment>/manifest.json
   ```
3. Click **Install**

Or open your deployment's root URL in a browser and use the **Install to Stremio** button.

Six new catalogs appear on your home screen.

> **Stremio Web** needs the addon to be reachable over HTTPS from your browser. A plain
> `http://<ip>:7001` addon works in the desktop app but not on the web client.

## Deploy

### Vercel

The repository is serverless-ready: `api/index.js` re-exports the Express app and `vercel.json`
rewrites every path to it. Import the repository in Vercel and deploy, no configuration required.

There is no persistent disk on Vercel, so the disk cache is skipped and `node-cron` is never loaded.
Data is refreshed lazily instead: the first request after the 6 hour TTL expires triggers a refresh.
Edge cache headers on the catalog and manifest routes keep that from happening on most requests.

### Docker

```bash
docker build -t imdb-popular-stremio .
docker run -d --name imdb-popular -p 7001:7001 --restart unless-stopped imdb-popular-stremio
```

### Docker Compose

```yaml
services:
  imdb-popular:
    build: .
    container_name: imdb-popular
    ports:
      - "7001:7001"
    restart: unless-stopped
```

```bash
docker compose up -d
```

### Node.js

```bash
npm install --omit=dev
node index.js
```

Available at `http://localhost:7001/manifest.json`. Node 18 or newer is required, since the addon
uses the built-in `fetch`.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7001` | HTTP port the addon listens on. Ignored on Vercel. |
| `CACHE_PATH` | `./cache.json` | Where the snapshot is persisted between restarts |
| `VERCEL` | unset | Set by Vercel itself. When present the addon skips the disk cache and `node-cron`, and refreshes on a TTL instead. |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page with the install link and catalog list |
| `GET /manifest.json` | Stremio addon manifest, with genre lists built from the current data |
| `GET /logo.png` | Addon logo |
| `GET /catalog/movie/imdb-popular-movies.json` | Popular movies |
| `GET /catalog/series/imdb-popular-series.json` | Popular series |
| `GET /catalog/movie/imdb-trending-movies.json` | Trending movies |
| `GET /catalog/series/imdb-trending-series.json` | Trending series |
| `GET /catalog/movie/imdb-top-rated-movies.json` | Top rated movies |
| `GET /catalog/series/imdb-top-rated-series.json` | Top rated series |
| `GET /status` | Health check: version, source, snapshot age, per-catalog counts and genre lists |

Catalog endpoints take optional extras as `/:extra.json`, for example
`/catalog/movie/imdb-popular-movies/genre=Action&skip=20.json`. Supported keys are `genre`, `search`
and `skip`.

`/status` reports each catalog's length separately, so a monitor can alert on a single row shrinking
rather than only on the whole snapshot going stale.

## How the catalogs are built

Data comes from IMDb's own GraphQL API at `api.graphql.imdb.com`. Three queries run in parallel
every refresh, and every list is replaced together or none is, so a partial failure keeps the
previous snapshot serving rather than half-updating it.

| Catalog | Source | Ordering | Size |
|---------|--------|----------|------|
| Popular | `MOST_POPULAR_MOVIES` and `MOST_POPULAR_TV_SHOWS` charts | IMDb's own popularity rank, preserved | up to 100 |
| Trending | `topTrendingTitles`, hourly window, worldwide traffic | IMDb's own trending rank, preserved | up to 40 |
| Top Rated | the popular charts, re-ordered | IMDb rating, descending | up to 40 |

Two details worth knowing:

**Top Rated is not a rating threshold.** It is "popular right now and also good", the popularity
chart sorted by rating. A fixed cutoff was tried and does not work, because IMDb TV ratings run
roughly a full point above film ratings, so any threshold that trims movies sensibly leaves most
series untouched.

**Trending and Top Rated require 5,000 votes.** IMDb's trending feed includes announcements with no
audience yet, which would otherwise lead the row on rank alone. The floor drops them. Popular
catalogs are not filtered, since IMDb's own chart already handles that.

The trending feed also mixes every title type IMDb tracks, so types are mapped explicitly rather
than by treating "not a series" as a film: `movie` and `tvMovie` become movies, `tvSeries` and
`tvMiniSeries` become series, and anything else is dropped.

## Tech Stack

- **Runtime:** Node.js 18+ (Docker image is `node:20-slim`)
- **Server:** Express 4
- **Scheduling:** node-cron when self-hosted, TTL when serverless
- **Data:** IMDb GraphQL

## License

This project is licensed under the [MIT License](LICENSE).
