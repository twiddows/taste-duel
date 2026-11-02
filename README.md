# Taste Duel

Find out what kind of website design you actually like by picking one of two, over and over.

Taste Duel shows two designs from the [21st.dev](https://21st.dev/community/templates) catalog side
by side. You pick the one you like more, and the next pair follows your picks: after a few far-apart
pairs to get a read on you, it mostly shows designs it expects you to like that still differ in a few
ways, so every pick teaches it something. At the end you get a taste profile, your favourites, a few
designs you haven't seen that fit your profile, and a short brief you can paste into a design prompt.

## One run per kind of project

What you want on a dashboard isn't what you want on a public site, so you start by saying what the
design is for. Each choice is its own run, with its own pool, profile and saved progress:

| run | compares | pairs |
|---|---|---|
| Dashboards & internal tools | dashboard templates plus dashboard pieces (KPI cards, layouts, data tables) | 29 |
| Marketing site | SaaS, agency, local-business, shop and event sites | 48 |
| Anything | every full site, portfolios included | 50 |

**Switch** goes back to the choice; a run you leave keeps its place.

## Run it

It's static files: no build, no dependencies. Browsers block scripts on `file://` pages in some
setups, so serve the folder:

```
python -m http.server 4611 --bind 127.0.0.1
```

then open http://127.0.0.1:4611. On Windows, double-click `start.cmd`.

## Keys

| key | does |
|---|---|
| ← / → | pick the left / right design |
| ↑ | both good |
| ↓ | neither |
| Backspace | undo the last pick |
| click a preview | full-page screenshot (Esc closes) |

Progress is kept in the browser's local storage, so closing the tab doesn't lose your picks.
**Restart** clears the current run only.

## Keep your favourites

**Download results** saves the run as JSON (profile, brief, favourites, every pick). To turn the
favourites into screenshot files for an inspiration library (for example a
[Taste Vault](https://github.com/cth9191/taste-vault) drop folder):

```
node tools/to-taste-vault.mjs taste-duel-dashboards-2026-11-01.json "D:\path\to\inspiration"
```

It saves the top 12 preview images to `<folder>/taste-duel/<run>-<date>/`, best first, plus a
`taste-duel.md` with the brief and profile. `--top N` changes how many, `--dry-run` shows what it
would save. Files already there are skipped. Needs Node 18 or later.

## How it learns

Each design has a set of features: its kind (SaaS, agency, portfolio, dashboard, business, shop,
event) and style tags (dark, light, motion, minimal, serif, playful, photo, product UI, corporate,
bold, data-dense). The model is a small Bradley-Terry / logistic preference model:

```
score(design) = w · features(design) + bias[design]
```

Picking A over B moves `w` toward A's features and away from B's, and moves the two biases apart, in
proportion to how surprised the model was. "Both good" and "Neither" move both together, relative to
the run's average design. The taste profile on the results page is `w`.

## The data

`data/pool.js` holds about 140 site templates and 36 dashboard components found through the 21st.dev
search on 2026-11-01: name, price, author, a one-line description, the listing URL and the preview
image URL. Previews are loaded from 21st's CDN, not copied. Style tags were assigned by hand from each
listing's description, so they're a judgement call; edit them freely. Listings that sell the same
design twice (React and Next.js) appear once.

## Files

| file | what |
|---|---|
| `index.html` | page shell |
| `style.css` | styles |
| `app.js` | runs, model, pair selection, rendering |
| `data/pool.js` | the design pool |
| `tools/to-taste-vault.mjs` | saves a run's favourites as screenshot files |
| `start.cmd` | Windows launcher |

## License

MIT for the code. The designs listed in `data/pool.js` (names, descriptions, preview images) belong
to their authors on 21st.dev.
