# Rheinplan

A lightweight, source-aware two-month event calendar for Heidelberg and Mannheim. It supports city separation/together view, event categories, time-overlap callouts, recurring events, and links to each organiser.

## Run locally

Open `index.html` through a static web server (for example VS Code Live Server). The app fetches `events.json` and needs HTTP rather than opening the file directly in some browsers.

## Publish with GitHub Pages

1. Push this folder to the repository's `main` branch.
2. In GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Open **Actions → Deploy Rheinplan → Run workflow**. The completed job shows the public site URL.

The deploy workflow runs on every `main` push. The weekly refresh workflow also deploys immediately after updating `events.json`, so scheduled listings become visible without a separate manual deployment.

## Weekly refresh

The GitHub workflow in `.github/workflows/weekly-refresh.yml` runs each Monday at 08:15 Europe/Berlin time (06:15 UTC during CEST). It calls `scripts/refresh-events.mjs`, updates `events.json`, and commits only if the data changed.

The refresh script preserves reviewed listings and uses optional, authorised integrations:

- `TICKETMASTER_API_KEY`: searches the Discovery API within 30 km of Heidelberg and Mannheim.
- `INSTAGRAM_ACCESS_TOKEN`: reserved for a connected account's approved Meta Graph API feed. The script deliberately does **not** scrape Instagram pages.

Add those as GitHub Actions secrets to enable them. Official city/venue source URLs live in `sources.json`. Heidelberg's main Veranstaltungskalender has a public JSON endpoint; the refresh job directly queries that endpoint with the current 60-day date range and paginates through the results. Other sites are collected through public JSON-LD Event entries. Each imported item keeps its source URL.

## Cinema and recurring events

`Film` is a dedicated category. Karlstorkino's programme is imported directly; the programme pages for Gloria/Gloriette/Kamera, Luxor, Cineplex Mannheim, Atlantis/Odeon, and Cinema Quadrat are also tracked for public structured screening and special-event listings. Cinema programmes are normally published only about one week ahead, so the app cannot responsibly promise ordinary screening times two months in advance. Karlstorkino entries use a clearly labelled estimated two-hour end only to make overlap hints useful.

Recurring language/community sources include DAI Heidelberg Conversation Clubs, Studierendenwerk Heidelberg's International Language Café, Café Tostado, and Mannheim library's Café Colibri. The app expands a listed recurrence into each date in the active two-month window and keeps the organiser link on every card.

## Important scope

No aggregator can promise *every* local event: organisers can update, cancel, or omit events, and Instagram does not offer a public general-event search. The UI therefore says "listings" rather than claiming complete coverage, always exposes source links, and marks recurring dates that still require confirmation.
