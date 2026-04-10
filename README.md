# Edia Strategic Territory Map

An interactive sales territory map for **Edia Learning** — visualize strategic accounts, active customers, and conference events across the US. Built for the sales team to manage pipelines, prep for meetings, and keep territory data in sync with Salesforce.

Deployed on **Netlify** at build time via Vite.

---

## Quick Start

### Development

```bash
npm install
npm run dev        # starts Vite dev server on localhost:3000
```

### Production

```bash
npm run build      # outputs to dist/
npm run preview    # preview the production build locally
```

Netlify runs `npm run build` and publishes `dist/` automatically on push.

### Linting & Formatting

```bash
npm run lint           # ESLint check
npm run lint:fix       # ESLint auto-fix
npm run format:check   # Prettier check
npm run format         # Prettier auto-fix
```

---

## Map Views

| View            | What it shows                                                    |
| --------------- | ---------------------------------------------------------------- |
| **Accounts**    | Strategic / prospect school districts, color-coded by opp stage  |
| **Active Customers** | Current Edia customers (green pins)                         |

Switch views with the toggle buttons at the top of the sidebar. Use **Reset Filters** to clear all active filters without changing the view.

### Pin Colors

| Color            | Meaning                          |
| ---------------- | -------------------------------- |
| Purple           | No opportunity                   |
| Yellow           | Discovery                        |
| Blue             | Demo                             |
| Red-orange       | Scoping                          |
| Green (bright)   | Validation                       |
| Green (standard) | Active customer                  |
| Gray             | DOE (Department of Education)    |

A legend is always visible in the bottom-right corner of the map.

---

## Welcome Overlay

On first load, a welcome overlay prompts the user to pick a starting context — a team, a rep, or "Show Opps" — so the map doesn't render thousands of unfiltered pins at once.

---

## Team & Rep Selectors

The sidebar includes **Team** and **Rep** dropdowns that scope the entire view:

- Select a team (ENT East, ENT West, SMB, Strategic) to see only that team's accounts
- Drill into a specific rep within the team
- Managers are displayed but not assignable as account owners
- When a team has only one rep, that rep is auto-selected
- Rep dropdowns are sorted alphabetically by first name

Team rosters are configured in `src/data/teams/*.json`. Roster files also support an `sdrs` array with per-SDR state assignments for outreach planning.

---

## Searching & Filtering

- **Search bar** with autocomplete — type a district name and press **Enter** to zoom to it
- **Stage filter pills** at the top — quick cross-team filtering by opportunity stage
- **Sidebar filters**: Region, State, AE, SIS Platform, Opportunity Stage, Enrollment, Segment, CSM
- Filters are view-specific (Accounts vs Customers)
- **Reset Filters** button clears all active filters
- **Reset View** (home icon) resets filters, view, and map zoom to the full lower 48

---

## Account Details

Click any pin to see a popup with:

- District info (enrollment, region, SIS, parent account)
- Leadership contacts
- Opportunity details (stage, forecast, next steps) — supports **multiple opportunities** per account, tracked per product area (Math, Attendance, DIP, etc.)
- Links to org chart, strategic plan, meeting prep
- Gong contacts link (uses client-side SFDC 15→18 character ID conversion)

Click the **expand button** for a full-screen modal with six tabs:

- **Info**: Overview, leadership, all opportunities, resources, notes
- **Math**: Math products, curriculum, contacts, competition
- **Attendance**: SIS platform, attendance system, related contacts
- **🔮 DIP**: District Intelligence Platform opportunity, DIP-specific contacts, DIP opp intel
- **📊 District Intel**: Cross-product snapshot, active next steps, MEDDPIC intelligence, full contact map, engagement summary, nearby customers
- **Schools**: List of individual schools within the district

Swipe left/right to navigate between tabs on mobile.

---

## Dashboard & Stats

- **Stats bar**: Accounts count, Customers count, Overlap, States covered
  - **W/ Pipeline badge** on the Overlap stat shows how many overlap customers have active open opportunities (scoped by current team/rep selection, with holdout-aware filtering)
- **Pipeline panel**: Opportunity values grouped by stage, expandable per stage
  - Pipeline overlay header shows unique customer count with open opps
- **Actions panel** (floating workload dashboard):
  - Stalest accounts (days since last touch)
  - Due this week (accounts with next steps due soon)
  - Next-step subtasks per opportunity
  - Untouched accounts (no activity on record)
  - Red alert badge when items need attention
  - Filtered by the current sidebar context (team/rep)

---

## Data Refresh (SFDC Sync)

Data refresh is **password-protected**. After authentication:

1. Click **Data Refresh** (bottom-right corner)
2. Click **SFDC Data**
3. Choose dataset type: **Accounts**, **Customers**, or **Opportunities**
4. Upload a CSV or Excel file exported from Salesforce
5. Preview the merge — see new, updated, and conflicting records
6. Click **Apply** to merge

### Data Separation

Opp data changes frequently and is stored separately in `opps.json`. Account data is relatively static in `accounts.json`. At build time, `scripts/prebuild-data.js` joins opps into accounts by normalized name + state, producing `accounts-with-opps.json` (a gitignored build artifact). At runtime the app imports this pre-joined file.

After an **Opportunities** upload, both `opps.json` and `accounts.json` are downloaded for committing to the repo. After an **Accounts** upload, only `accounts.json` is downloaded. Downloaded JSON files have internal runtime fields stripped (`_nameLc`, `_stateLc`, `_regionLc`, `_schools`, etc.) via `stripRuntimeFields()` before download — committed data stays clean.

The app tracks its data source (`S._dataSource`: `'bundled'` vs `'localStorage'`) to know whether the user is running from the deployed baseline or from locally-persisted merged data.

### Merge Intelligence

- **Smart name matching** normalizes district names ("Dallas Independent School District" ↔ "Dallas ISD")
- **State + enrollment disambiguation** for same-name districts in different states
- **Parent account consolidation** — child accounts roll up under their parent
- **Separate account and opportunity imports** — upload account lists and opp lists independently
- **Multi-opp merging** — new opportunities are upserted per product area without overwriting existing opps
- **MEDDPIC field merging** — MEDDPIC/MEDDPICC fields are merged from opp data and rendered in the District Intel tab
- **Owner resolution logic**: inactive owners fall back to opp owner, managers are bypassed, holdout accounts are preserved, special-case reps are handled
- **Account suppression rules** — configurable per-rep rules to suppress low-enrollment accounts from map rendering
- **Automatic geocoding** with rate limiting, retry logic, and state-aware validation
- **Conflict detection** — when two reps claim the same account, conflicts are stored for manual resolution
- Notes and meeting prep links are preserved across merges

### Post-Upload Summary

After a merge, a detailed summary modal shows:

- Records processed, new, updated
- Geocoding results and failures
- Records hidden by current filters
- Conflict count

---

## Conflict Resolution

When an SFDC upload creates ownership conflicts (two reps assigned to the same account):

- A **Conflicts** badge appears in the sidebar
- Conflict resolution is **independently password-protected** (separate from Data Refresh)
- Each conflict card shows rich context: enrollment, strategic badge, account type (Customer/Account/Inactive Customer with ARR), and a conflict type label (Competing Opportunities / New Opp vs Existing Owner / Account Owner Change / Account Ownership)
- Existing opp details are shown for both reps (product area, stage, ACV)
- Choose which rep should own the account; resolved conflicts are removed from the list
- **CSV export**: Download all conflicts as a detailed CSV from the conflicts overlay
- **Auto-download**: When the last conflict is resolved, `accounts.json`, `opps.json`, and `customers.json` are automatically downloaded for committing to the repo
- **Navigate-to-conflict**: Clicking an account in the conflict list flies the map to that pin, or opens the modal directly if the pin isn't visible under current filters

---

## Conference Tracker

Toggle **Conferences** in the sidebar to overlay education conferences on the map:

- Upload conference data via CSV
- Filter by date range (upcoming, past, custom)
- Conference pins show nearby strategic accounts within a configurable radius
- Click a conference pin for details: dates, location, nearby account count

---

## Proximity Mode

Toggle proximity overlays in the sidebar to explore geographic relationships between accounts and customers:

- **Bidirectional proximity**: Works in both Accounts and Customers views
  - In **Accounts view**: Click an account to see nearby customers within the radius
  - In **Customers view**: Click a customer to see nearby prospect accounts within the radius
- **Adjustable radius** slider (default 50 miles)
- **Nearby accounts badge** on pins showing count of nearby related accounts/customers
- **Account list integration**: The account list panel filters to show only nearby accounts when proximity is active
- **Export integration**: Exports respect the current proximity scope
- **ADA accounts**: Show ADA-related account proximity

---

## Data Export & Outreach Assistant

### Export

Export the current filtered account list as an Excel workbook. The export respects the active team/rep/stage filters and includes leadership contacts, opportunity details, and strategic context. Exports are designed to serve both human planning and downstream AI workflows.

### Outreach Assistant

A single-click workflow that bridges EdiaStratMap with the AI Outreach Assistant:

1. Click the **Outreach Assistant** button (visible when a team is selected)
2. An XLSX export is automatically downloaded with the current filtered accounts
3. A structured prompt with supplementary context (customer list, notes, opp stats) is copied to clipboard
4. The Outreach Assistant Claude project opens in a new tab
5. Paste the prompt and upload the XLSX to generate personalized outreach plans

The Export and Outreach Assistant share `buildExportWorkbook()` so both produce identical XLSX schemas.

---

## Meeting Prep

- Click **"Generate Meeting Prep"** in any account popup
- Copies a structured prompt with all account data to the clipboard
- Opens the Meeting Prep Claude project for AI-assisted meeting preparation
- Save Google Drive meeting prep links per account (inline, from the popup)

---

## Notes

- Add notes to any account via the detail modal or popup
- Notes are tagged with the author's name (prompted on first use, stored as `User Name` in localStorage)
- Notes persist in localStorage across browser sessions — multi-user safe (adding a note does **not** save full account data to localStorage, preventing stale data snapshots)
- Copy / Export / Import functionality available (import merges by deduplicating on timestamp + author)

---

## Theme

Toggle between **dark mode** and **light mode** using the sun/moon button in the sidebar header.

---

## Keyboard Shortcuts

| Key        | Action                      |
| ---------- | --------------------------- |
| **Enter**  | Zoom to searched district   |
| **Escape** | Close full-screen modal     |

---

## Project Structure

```
index.html                Entry point (loads Vite app)
src/
  main.js                 App bootstrap — imports CSS, inits map, registers SW
  js/
    state.js              Shared mutable state object S
    helpers.js            Pure utilities (escapeHtml, escapeAttr, haversine, etc.)
    features.js           Theme toggle, SHA-256 password-protected data refresh
    app.js                Core: map, rendering, sidebar, filters, search, dashboard,
                            popups, welcome overlay, marker pool, mobile features
    account-modal.js      Full-screen account detail modal (Info/Math/Attendance/DIP/District Intel/Schools)
    account-list.js       Sortable/groupable account list sidebar panel
    data-merge.js         SFDC CSV/Excel import, merge logic, geocoding
    data-export.js        Account list export to Excel + Outreach Assistant launcher
    multi-opp.js          Multi-opp rendering, opp upsert, stripRuntimeFields, JSON downloads
    conflict.js           Conflict detection, resolution UI, CSV export, auto-download
    conference.js         Conference tracker overlay — CSV upload, date filtering, proximity
    notes.js              Per-account threaded notes — add, copy, export/import
  styles/
    main.css              All styles (~4,200 lines)
  data/
    accounts.json         Strategic account dataset (no opp fields)
    opps.json             Opportunity data (joined into accounts at build time)
    customers.json        Active customer dataset
    accounts-with-opps.json   (gitignored) Build artifact — opps joined into accounts
    school-map.json           (gitignored) Build artifact — school data by district
    teams/
      ent-east.json       ENT East team roster
      ent-west.json       ENT West team roster
      smb.json            SMB team roster
      strategic.json      Strategic team roster
scripts/
  prebuild-data.js        Build-time opp join + school extraction
  extract-opps.js         Standalone utility to extract opp data from accounts
  merge-duplicates.cjs    Node script for account deduplication
  dedup_accounts.py       Python dedup script
  dedup_review.txt        Dedup review notes
public/
  sw.js                   Minimal service worker (cache cleanup only)
  favicon.png             App icon
.claude/                  Claude Code project configuration
vite.config.js            Vite dev/build config + prebuild plugin + manual chunks
netlify.toml              Netlify build settings
eslint.config.js          ESLint config (ES2022, Prettier integration)
package.json              Dependencies + scripts
```

---

## Module Architecture

The app is split into 12 ES modules under `src/js/`. All modules import the shared state object `S` from `state.js`.

| Module             | Lines | Purpose                                                                                      |
| ------------------ | ----: | -------------------------------------------------------------------------------------------- |
| `state.js`         |   128 | Shared mutable state object `S` — imported by all modules                                    |
| `helpers.js`       |   251 | Pure utilities: name normalization, date parsing, haversine distance, XSS escaping (`escapeHtml`, `escapeAttr`), SFDC 15→18 ID conversion (`sfdc15to18`), opp-state helpers (`isOppOpen`), search field precomputation |
| `features.js`      |   112 | Theme toggle (dark/light), SHA-256 password-protected data refresh and SFDC modal access      |
| `app.js`           | 4,084 | Core: map init, Leaflet rendering, sidebar, filters, search/autocomplete, dashboard, popups, welcome overlay, marker pool, performance indices, proximity mode (bidirectional), account suppression, mobile features (bottom sheet, Near Me, long-press, swipe gestures) |
| `account-modal.js` | 1,352 | Full-screen account detail modal (Info, Math, Attendance, DIP, District Intel, Schools tabs), MEDDPIC intelligence rendering, data refresh panel toggle, tab swipe navigation |
| `account-list.js`  |   420 | Sortable/groupable account list sidebar panel with compact number formatting                  |
| `data-merge.js`    | 2,125 | SFDC CSV/Excel import, merge logic, owner resolution, geocoding, holdout detection, MEDDPIC field merging |
| `data-export.js`   |   477 | Account list export to Excel (filtered by current team/rep/stage context), Outreach Assistant launcher (auto-download + clipboard prompt + project open) |
| `multi-opp.js`     | 1,280 | Multi-opportunity rendering, product area tabs, opp upsert, `stripRuntimeFields()`, JSON file download helpers |
| `conflict.js`      |   429 | Conflict detection, resolution UI (independently password-protected), rich context display, CSV export, auto-download when all resolved |
| `conference.js`    |   542 | Conference tracker overlay — CSV upload, date filtering, proximity to strategic accounts      |
| `notes.js`         |   187 | Per-account threaded notes — add, copy, export/import, multi-user safe (no full-data localStorage writes) |
| **Total**          | **11,387** | |

Key architectural patterns:

- All modules import `S` from `state.js` for shared mutable state
- `app.js` exposes callback refs on `S` (e.g., `S._applyFilters`, `S._rebuildMarkerPool`) so other modules can trigger core operations without circular imports
- `src/main.js` bootstraps the app: imports CSS, calls `initMap()` from `app.js`, and registers the service worker

---

## Prebuild Pipeline

`scripts/prebuild-data.js` runs before both `npm run dev` and `npm run build` (configured in `package.json` scripts **and** as a Vite plugin in `vite.config.js`):

1. Reads `src/data/accounts.json` + `src/data/opps.json`
2. Joins opp fields onto accounts by normalized district name + state → writes `src/data/accounts-with-opps.json`
3. Extracts school-level data into `src/data/school-map.json` (keyed by district name + state)

Both generated files are in `.gitignore` — they are build artifacts, not committed source.

Vite config uses `manualChunks` to code-split these data files into separate bundles: `data-accounts`, `data-schools`, `data-customers`. At runtime, `app.js` imports `accounts-with-opps.json` and `school-map.json` and re-hydrates `_schools` onto account records.

---

## Security

- **Password protection**: Data Refresh and Conflict Resolution are **independently** password-protected — each has its own SHA-256 hash
- **SHA-256 hashing**: Passwords are verified against SHA-256 hashes using `crypto.subtle.digest()` — no plaintext passwords in the codebase
- **XSS prevention**: All user-supplied data rendered in popups, modals, and the conflict overlay is escaped via `escapeHtml()` and `escapeAttr()` in `helpers.js`

> **Note**: This is client-side security-by-obscurity, not true authentication — the hashes are visible in source. It's a guardrail against accidental changes, not a security boundary.

---

## Mobile Support

The app is fully responsive with phone (<=768px), tablet (769-1024px), and desktop (>1024px) breakpoints:

- **Bottom sheet** replaces the sidebar on mobile for account details
- **Floating search bar** makes map search accessible on mobile
- **Swipe gestures**: Swipe-to-close on bottom sheet and modals; pull-down dismiss for modals; swipe left/right to navigate modal tabs
- **Near Me**: Uses browser geolocation to show the user's location on the map with a configurable radius circle highlighting nearby accounts
- **Long-press context menu** on map pins (mobile alternative to hover)
- **Smart map zoom**: Map auto-fits to visible accounts when changing team, rep, or closing an account card

---

## Service Worker

`public/sw.js` is a minimal service worker that only cleans up caches from a previous version. It has no fetch handler — all caching is delegated to Netlify CDN. Registered on load in `src/main.js`. Not critical — the app works fully without it.

---

## Performance

- **Marker pool**: All map markers are pre-built once and shown/hidden via layer operations instead of being recreated on every filter change
- **O(1) lookup indices**: `buildIndices()` creates `_repToTeam`, `_teamRepsSet`, `_repToAccounts`, `_teamToAccounts`, and `_custByName` maps for instant team/rep/customer lookups
- **Customer grid cache**: Spatial grid (`_custGrid`) for fast proximity calculations without scanning all customers
- **Note index cache**: `_accountsWithNotes` Set avoids scanning all localStorage keys on every filter pass
- **Autocomplete cache**: Search results are cached and invalidated only on data changes

---

## Tech Stack

- **[Vite](https://vite.dev/)** — dev server + production bundler
- **[Leaflet.js](https://leafletjs.com/)** — interactive map rendering (via CDN)
- **[SheetJS](https://sheetjs.com/)** — CSV and Excel file parsing (via CDN)
- **Vanilla JavaScript** (ES modules) — no framework, ~11,387 lines across 12 modules
- **[DM Sans](https://fonts.google.com/specimen/DM+Sans)** — UI text font (Google Fonts)
- **[JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono)** — data/code values font (Google Fonts)
- **localStorage** — client-side persistence for accounts, customers, notes, links, conflicts, and refresh timestamps
- **Netlify** — hosting and continuous deployment

---

## Scripts

| Script                   | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| `prebuild-data.js`       | Build-time opp join + school data extraction (see above)   |
| `extract-opps.js`        | Standalone utility to extract opp data from accounts       |
| `merge-duplicates.cjs`   | Node script for account deduplication                      |
| `dedup_accounts.py`      | Python dedup script                                        |

---

## Data Storage

All user data is stored in the browser's localStorage:

| Key                      | Contents                                      |
| ------------------------ | --------------------------------------------- |
| Account / Customer data  | Full datasets after SFDC merge                |
| Notes                    | Per-account notes (keyed by district)         |
| Meeting Prep Links       | Google Drive links per account                |
| Conflicts                | Unresolved ownership conflicts                |
| SFDC Refresh             | Last refresh timestamp                        |
| Theme                    | Dark/light mode preference                    |
| Data Source              | `'bundled'` vs `'localStorage'` origin        |
| User Name                | Author name for note tagging                  |

Data persists across sessions but is local to the browser. Use **Reset to Baseline** (in the Data Refresh panel) to clear persisted data and revert to the bundled JSON.
