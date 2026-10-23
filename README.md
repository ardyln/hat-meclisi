# Hat Meclisi · Transit Assembly

**TR:** Türkiye için ortak, canlı bir raylı sistem ve toplu taşıma planı. Herkes hat çizebilir, mevcut bir öneriye alternatif güzergâh önerebilir ve oy verebilir. Harita her koridorda en çok oy alan güzergâhı gösterir. Mevcut hatlar OpenStreetMap'ten ya da GeoJSON/KML dosyasından içe aktarılabilir. Arayüz Türkçe ve İngilizce.

**EN:** A shared, live transit plan for Turkey. Anyone can draw a line, propose alternative alignments for someone else's line, and vote. The map shows the winning alignment of every corridor. Existing lines can be imported from OpenStreetMap or from GeoJSON/KML files. The interface is in Turkish and English.

## What you can do

- **Draw a line** (metro, light rail, tram, commuter rail, regional and high-speed rail, Metrobüs/BRT, cable car, funicular, ferry). Tap to add points, drag points to move them, drag the "+" handles to bend the line, add branches, and place stations. A station placed on another line's station becomes a transfer and takes its name.
- **Propose an alternative alignment.** Every new proposal opens a *corridor*. Anyone can add alternative alignments to it, starting from a copy of the line they are looking at.
- **Vote.** ▲ supports and ▼ opposes an alignment. Each corridor shows its highest-scoring alignment (ties go to the older one). Corridors are ranked by their winner's score. **Winning alignments** shows one line per corridor; **All alternatives** also shows the others, dashed. Downvoted alignments can be hidden.
- **Import existing lines.** **Import → OpenStreetMap** fetches the metro, tram, Marmaray/commuter, YHT, regional rail, Metrobüs, cable car, funicular and ferry routes in the visible area (Overpass API). Both directions of a route are merged into one line, and lines that are already there are skipped. **Import → File** reads GeoJSON or KML: lines become lines, and named points become stations of the nearest line. Files can be imported as existing lines or as proposals.
- **Build on existing lines.** "New proposal based on this" copies any line, existing or proposed, into a new proposal, e.g. an extension.
- **Follow along.** The **Feed** tab and pop-up notices show what others are doing, live. Every line has a shareable link (`#l=<id>`) and a GeoJSON download.
- Length, station count, average station spacing and a rough construction cost (per-km figures by mode) are shown for every line.

After each change you wait **10 seconds**. The database enforces this, so reloading the page does not skip it. Votes have no cooldown, but each visitor has one vote per alignment.

The site is static (GitHub Pages). Live sync uses a free Firebase Realtime Database with anonymous sign-in, the same setup as [İlçeler Kıyameti](https://github.com/UpgradeWasTaken/ilceler-kiyameti).

## Setup (about 10 minutes)

### 1. Create the Firebase backend

1. Go to <https://console.firebase.google.com> → **Add project**. Analytics is not needed, and the free **Spark** plan is enough.
2. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable → Save.**
   Visitors are signed in anonymously in the background. Authorship, votes and the cooldown are tied to that anonymous user.
3. **Build → Realtime Database → Create database.** Pick a location (e.g. `europe-west1`) and start in **locked mode**.
4. Open the database's **Rules** tab, paste the contents of [`database.rules.json`](database.rules.json) and press **Publish**.
   (Or, with the Firebase CLI: `firebase deploy --only database`.)
5. **Project settings (⚙) → General → Your apps → Web (`</>`)**: register an app (Hosting not needed) and copy the values into [`js/config.js`](js/config.js):

   ```js
   export const FIREBASE_CONFIG = {
     apiKey: 'AIza…',
     authDomain: 'your-project.firebaseapp.com',
     databaseURL: 'https://your-project-default-rtdb.europe-west1.firebasedatabase.app',
     projectId: 'your-project',
     appId: '1:…:web:…',
   };
   ```

   These values are public by design. The database rules are what protect the data.

### 2. Publish on GitHub Pages

Commit `js/config.js`, then go to **Settings → Pages → Build and deployment → Deploy from a branch**, pick the branch and `/ (root)`. The site appears at `https://<user>.github.io/<repo>/`.

### Optional hardening

- In Google Cloud Console → APIs & Services → Credentials, restrict the browser API key to the HTTP referrer `https://<user>.github.io/*`.
- Enable Firebase **App Check** (reCAPTCHA) to make scripted clients harder.

### Resetting

In the Realtime Database **Data** tab, delete the `lines`, `corr`, `votes`, `log` and `cool` nodes.

## How it works

| Piece | What it does |
| --- | --- |
| `js/app.js` | Map (Leaflet), side panel, detail card, voting, editor and importer panels. |
| `js/editor.js` | The line editor: draw, move, insert and delete points, branches, stations with snapping, undo. |
| `js/model.js` | Line format, corridors and the ranking of alignments, statistics, GeoJSON export. |
| `js/importers.js` | OpenStreetMap import (Overpass), and GeoJSON/KML parsing. |
| `js/geo.js` | Encoded polylines, distances, Douglas–Peucker simplification, nearest-point snapping. |
| `js/backend.js` | Firebase sync, and a same-interface demo backend in `localStorage`. |
| `js/i18n.js` | Turkish and English text. |
| `database.rules.json` | Server-side validation, authorship and the 10-second cooldown. |

**Data model.** `lines/<id>` holds one line: name, kind (`p` proposal / `e` existing), mode, colour, geometry and stations, plus the author's anonymous uid, nickname and server timestamps. Geometry is stored as Google encoded polylines (one per branch, ~1 m precision), and stations as a small JSON string, so a 30 km metro line with 25 stations takes about 2 KB. Proposals carry a corridor id `g`. `corr/<id>` holds the corridor's title (owned by whoever opened it), `votes/<lineId>/<uid>` is `1` or `-1`, `log` is the feed, and `cool/<uid>` is the visitor's last change. Lines imported from OpenStreetMap use the id `osm-r<relation id>`, so the same route can't be imported twice.

**Rules.** Each change is one atomic multi-path write: the line(s), the visitor's `cool/<uid>` stamp and a feed entry. All three must carry the server's own timestamp, and the previous stamp must be at least 10 000 ms old. Only a line's author can edit or delete it. Kind, corridor and creation time can't change after creation. A proposal must belong to an existing corridor, and a corridor can only be opened together with its first alignment. Votes can only be cast as yourself, only on proposals, and only as ±1. When an author deletes a line, its votes go with it. Field shapes and sizes are validated (geometry ≤ 60 000 characters, stations ≤ 16 000).

The cooldown and votes follow the anonymous Firebase user, so reloading doesn't reset them. A visitor who clears site data or opens a private window becomes a new user (and could vote again). Per-IP limits would need a server (Cloud Functions on the paid plan).

**Free-tier limits.** The Spark plan allows **100 simultaneous connections**, 1 GB stored and 10 GB downloaded per month. Each visitor downloads all lines once (roughly 2 KB per line), then only changes. If the site gets popular, switch the project to the pay-as-you-go **Blaze** plan.

## Development

```bash
python3 -m http.server 8080          # then open http://localhost:8080
```

- With an empty `js/config.js`, the site runs in **demo mode**: changes stay in your browser and sync between its tabs.
- `?demo` forces demo mode even when Firebase is configured. `?demo&cool=0` turns the cooldown off there.
- `?emulator=127.0.0.1:9000` connects to local emulators (database on 9000, auth on 9099):
  `npx firebase-tools emulators:start --only database,auth --project demo-hat-meclisi`
- `?debug` exposes `window.hm` (`map`, state, `select`) in the console.

Rules tests (`cd tools && npm install` first), from the repository root:

```bash
npx firebase-tools emulators:exec --only database --project demo-hat-meclisi "node tools/test-rules.mjs"
```

The tests cover the cooldown, authorship, corridors and alternatives, edits that try to change locked fields, field validation, votes, batch imports with OSM ids, deletion together with votes, and the feed.

## Data and licences

- Base map tiles: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, served by the OpenStreetMap Foundation under its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). This suits a hobby project. If traffic grows, switch to a tile provider made for it (one line in `js/app.js`).
- Rail overlay: [OpenRailwayMap](https://www.openrailwaymap.org/) (CC BY-SA).
- Lines imported from OpenStreetMap are © OpenStreetMap contributors under the [ODbL 1.0](https://opendatacommons.org/licenses/odbl/). A database containing them is a derivative database, so it must keep that attribution and stay under the ODbL. Each imported line links back to its OSM relation.
- Imports query the public [Overpass API](https://overpass-api.de/), which is shared and rate-limited. Large areas can take a minute, and busy times can fail. Try again later.
- [Leaflet](https://leafletjs.com/) 1.9.4 (BSD-2-Clause) is vendored in `vendor/leaflet`. The Firebase JS SDK 10.12.2 is loaded from Google's CDN.
