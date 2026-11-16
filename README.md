# Drawline

Mobile-friendly web app for Ontario Lotto 6/49 and Lotto Max picks — built for
use on a phone (add to home screen) and on the desktop.

## What it does

- Picks valid Lotto 6/49 and Lotto Max lines within a budget, uniformly at
  random.
- Shows the next draw countdown (6/49 Wed/Sat, Max Tue/Fri, 10:30 PM Toronto
  time).
- Saves lines locally, checks them against past draws, and shows descriptive
  history (frequencies, recent draws) on a separate History screen.

## Honesty rule

Every valid combination has the same chance of winning. Past draws do not
predict future draws, so history is descriptive only — it never feeds the
picker, and the app makes no predictions.

## History data

On open, the app checks a history file in Google Drive first, then
lottochaos.com, then the bundled copy in `public/data/`.

## Run it

```sh
npm install
npm run dev      # local dev server
npm run build    # production build into dist/
npm test         # test suite
```

## Deploy

GitHub Pages serves the built site from the `docs/` folder on `main`
(the contents of `dist/` after `npm run build`).
