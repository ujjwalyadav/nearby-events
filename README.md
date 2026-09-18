# Rheinplan

A lightweight, source-aware two-month event calendar for Heidelberg and Mannheim. It supports city separation/together view, event categories, time-overlap callouts, recurring events, and links to each organiser.

## Run locally

Open `index.html` through a static web server (for example VS Code Live Server). The app fetches `events.json` and needs HTTP rather than opening the file directly in some browsers.

## Weekly refresh

The GitHub workflow in `.github/workflows/weekly-refresh.yml` runs each Monday at 08:15 Europe/Berlin time (06:15 UTC during CEST). It calls `scripts/refresh-events.mjs`, updates `events.json`, and commits only if the data changed.

The refresh script preserves reviewed listings and uses optional, authorised integrations:

- `TICKETMASTER_API_KEY`: searches the Discovery API within 30 km of Heidelberg and Mannheim.
- `INSTAGRAM_ACCESS_TOKEN`: reserved for a connected account's approved Meta Graph API feed. The script deliberately does **not** scrape Instagram pages.

Add those as GitHub Actions secrets to enable them. Official city/venue source URLs live in `sources.json`. Heidelberg's main Veranstaltungskalender has a public JSON endpoint; the refresh job directly queries that endpoint with the current 60-day date range and paginates through the results. Other sites are collected through public JSON-LD Event entries. Each imported item keeps its source URL.

## Important scope

No aggregator can promise *every* local event: organisers can update, cancel, or omit events, and Instagram does not offer a public general-event search. The UI therefore says "listings" rather than claiming complete coverage, always exposes source links, and marks recurring dates that still require confirmation.
