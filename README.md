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

| View | What it shows |
|------|---------------|
| **Accounts** | Strategic / prospect school districts, color-coded by opportunity stage |
| **Active Customers** | Current Edia customers (green pins) |

Switch views with the toggle buttons at the top of the sidebar. Use **Reset Filters** to clear all active filters without changing the view.

### Pin Colors

| Color | Meaning |
|-------|---------|
| Purple | No opportunity |
| Yellow | Discovery |
| Blue | Demo |
| Red-orange | Scoping |
| Green (bright) | Validation |
| Green (standard) | Active customer |
| Gray | DOE (Department of Education) account |

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

Team rosters are configured in `src/data/teams/*.json`.

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
- Opportunity details (stage, forecast, next steps) — supports **multiple opportunities** per account, tracked per product area (Math, Attendance, etc.)
- Links to org chart, strategic plan, meeting prep

Click the **expand button** for a full-screen modal with tabs:
- **Info**: Overview, leadership, all opportunities, resources, notes
- **Math**: Math products, curriculum, contacts, competition
- **Attendance**: SIS platform, attendance system, related contacts
- **Schools**: List of individual schools within the district

---

## Dashboard & Stats

- **Stats bar**: Accounts count, Customers count, Overlap, States covered
- **Pipeline panel**: Opportunity values grouped by stage, expandable per stage
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
3. Choose dataset type: **Accounts** or **Customers**
4. Upload a CSV or Excel file exported from Salesforce
5. Preview the merge — see new, updated, and conflicting records
6. Click **Apply** to merge

### Merge intelligence

- **Smart name matching** normalizes district names ("Dallas Independent School District" ↔ "Dallas ISD")
- **State + enrollment disambiguation** for same-name districts in different states
- **Parent account consolidation** — child accounts roll up under their parent
- **Separate account and opportunity imports** — upload account lists and opp lists independently
- **Multi-opp merging** — new opportunities are upserted per product area without overwriting existing opps
- **Owner resolution logic**: inactive owners fall back to opp owner, managers are bypassed, holdout accounts are preserved, special-case reps are handled
- **Automatic geocoding** with rate limiting, retry logic, and state-aware validation
- **Conflict detection** — when two reps claim the same account, conflicts are stored for manual resolution
- Notes and meeting prep links are preserved across merges

### Post-upload summary

After a merge, a detailed summary modal shows:
- Records processed, new, updated
- Geocoding results and failures
- Records hidden by current filters
- Conflict count

---

## Conflict Resolution

When an SFDC upload creates ownership conflicts (two reps assigned to the same account):

- A **Conflicts** badge appears in the sidebar
- Open the conflicts overlay to see each disputed account
- Choose which rep should own the account
- Resolved conflicts are removed from the list

---

## Conference Tracker

Toggle **Conferences** in the sidebar to overlay education conferences on the map:

- Upload conference data via CSV
- Filter by date range (upcoming, past, custom)
- Conference pins show nearby strategic accounts within a configurable radius
- Click a conference pin for details: dates, location, nearby account count

---

## Proximity Mode

Toggle proximity overlays in the sidebar:
- **Strategic proximity**: Show strategic accounts near existing customers
- **ADA accounts**: Show ADA-related account proximity
- Adjustable radius slider

---

## Meeting Prep

- Click **"Generate Meeting Prep"** in any account popup
- Copies a structured prompt with all account data to the clipboard
- Opens ChatGPT for AI-assisted meeting preparation
- Save Google Drive meeting prep links per account (inline, from the popup)

---

## Notes

- Add notes to any account via the detail modal
- Notes persist in localStorage across browser sessions
- Copy / Export / Import functionality available

---

## Theme

Toggle between **dark mode** and **light mode** using the sun/moon button in the sidebar header.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **Enter** | Zoom to searched district |
| **Escape** | Close full-screen modal |

---

## Project Structure

```
index.html              Entry point (loads Vite app)
src/
  main.js               App bootstrap — imports CSS + initializes map
  js/
    app.js              Core application (~7k lines)
  styles/
    main.css            All styles (~3k lines)
  data/
    accounts.json       Strategic account dataset
    customers.json      Active customer dataset
    teams/
      ent-east.json     ENT East team roster
      ent-west.json     ENT West team roster
      smb.json          SMB team roster
      strategic.json    Strategic team roster
vite.config.js          Vite dev/build config
netlify.toml            Netlify build settings
eslint.config.js        ESLint config (ES2022, Prettier integration)
package.json            Dependencies + scripts
```

---

## Tech Stack

- **[Vite](https://vite.dev/)** — dev server + production bundler
- **[Leaflet.js](https://leafletjs.com/)** — interactive map rendering (via CDN)
- **[SheetJS](https://sheetjs.com/)** — CSV and Excel file parsing (via CDN)
- **Vanilla JavaScript** (ES modules) — no framework
- **localStorage** — client-side persistence for accounts, customers, notes, links, conflicts, and refresh timestamps
- **Netlify** — hosting and continuous deployment

---

## Data Storage

All user data is stored in the browser's localStorage:

| Key | Contents |
|-----|----------|
| Account / Customer data | Full datasets after SFDC merge |
| Notes | Per-account notes |
| Meeting Prep Links | Google Drive links per account |
| Conflicts | Unresolved ownership conflicts |
| SFDC Refresh | Last refresh timestamp |
| Theme | Dark/light mode preference |

Data persists across sessions but is local to the browser. Use **Reset to Baseline** (in the Data Refresh panel) to clear persisted data and revert to the bundled JSON.
