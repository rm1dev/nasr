# Mobile PWA Quran & Dua Sync

## Run locally

```bash
npx serve .
```

Then open the shown URL on mobile (or mobile emulator).

## Features

- Mobile-first PWA (`manifest.webmanifest` + `sw.js`)
- Theme based on `theme.jpg`
- Word-by-word Arabic highlight while audio is playing
- Persian translation under each Arabic line
- Tafsir note box under each line (stored in browser local storage)

## Text data source refresh

```bash
node scripts/build-data.mjs
```

This regenerates `data/tracks.json` from online sources.
