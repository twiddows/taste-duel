# Taste Duel

Find out what kind of website design you actually like by picking one of two, over and over.

Taste Duel shows two site templates from the [21st.dev](https://21st.dev/community/templates) community
catalog side by side. You pick the one you like more, and the next pair follows your picks: after a
few far-apart pairs to get a read on you, it mostly shows sites it expects you to like that still
differ in a few ways, so every pick teaches it something. After 50 pairs (100 sites) you get a taste
profile, your favourites, a few sites you haven't seen that fit your profile, and a short brief you
can paste into a design prompt.

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
| ← / → | pick the left / right site |
| ↑ | both good |
| ↓ | neither |
| Backspace | undo the last pick |
| click a preview | full-page screenshot (Esc closes) |

Progress is kept in the browser's local storage, so closing the tab doesn't lose your picks.
**Restart** clears it.

## How it learns

Each site has a set of features: its kind (SaaS, agency, portfolio, dashboard, business, shop,
event) and style tags (dark, light, motion, minimal, serif, playful, photo, product UI, corporate,
bold). The model is a small Bradley-Terry / logistic preference model:

```
score(site) = w · features(site) + bias[site]
```

Picking A over B moves `w` toward A's features and away from B's, and moves the two sites' biases
apart, in proportion to how surprised the model was. "Both good" and "Neither" move both sites
together, relative to the average site. The taste profile on the results page is `w`.

## The data

`data/pool.js` holds about 125 site templates found through the 21st.dev search on 2026-11-01:
name, price, author, a one-line description, the listing URL and the preview image URL. Previews
are loaded from 21st's CDN, not copied. Style tags were assigned by hand from each listing's
description and preview, so they're a judgement call; edit them freely. Listings that sell the
same design twice (React and Next.js) appear once.

## Files

| file | what |
|---|---|
| `index.html` | page shell |
| `style.css` | styles |
| `app.js` | model, pair selection, rendering |
| `data/pool.js` | the site pool |
| `start.cmd` | Windows launcher |
