# Edia Strategic Territory Map

A single-page interactive map for **Edia Learning's sales team** to visualize strategic accounts and active customers across the US.

---

## Quick Start

1. Open `index.html` in any modern browser
2. Data is embedded — the map loads immediately with strategic accounts and customers
3. Use the sidebar to search, filter, and switch views
4. Click any pin to see details; click the expand button for a full-screen modal
5. Click the **reset button** (top-right of sidebar) to clear all filters and return to the default view

---

## Map Views

| View | What it shows |
|------|---------------|
| **Strategic Accounts** | Purple pins — prospect school districts |
| **Active Customers** | Green pins — current Edia customers |
| **All** | Both, color-coded by opportunity stage |

Switch views with the buttons at the top of the sidebar.

### Pin Colors (All View)

| Color | Meaning |
|-------|---------|
| Purple | No opportunity |
| Yellow | Discovery stage |
| Blue | Demo stage |
| Red-orange | Scoping stage |
| Green (bright) | Validation stage |
| Green (standard) | Active customer |

A legend showing opportunity stages is always visible in the bottom-right corner of the map.

### Reset View

Click the **reset button** in the top-right of the sidebar header to:
- Reset all filters
- Switch back to Strategic Accounts view
- Reset the map to show the full lower 48 US states
- Turn off proximity overlays

---

## Searching & Filtering

- **Search bar**: Type a district name and press **Enter** to zoom to it
- **Filters**: Region, State, AE, SIS Platform, Opportunity Stage, Enrollment, Segment, CSM
- Filters are view-specific (strategic vs customer filters)

---

## Account Details

Click any pin to see a popup with:
- District info (enrollment, region, SIS)
- Leadership contacts
- Opportunity details (stage, forecast, next steps)
- Links to org chart, strategic plan, meeting prep

Click the **expand button** for a full-screen modal with organized tabs:
- **Info**: Overview, leadership, opportunities, resources, notes
- **Math**: Math products, curriculum, contacts, competition
- **Attendance**: SIS platform, attendance system, related contacts

---

## Dashboard & Stats

- Top bar shows: Strategic accounts, Customers, Overlap, States covered
- **Pipeline panel**: Opportunity values by stage
- **Actions button**: Opens a floating workload panel with:
  - Stalest accounts (days since last touch)
  - Due this week (accounts with next steps due)
  - Untouched accounts (no activity on record)
  - Red alert badge when items are due

---

## Proximity Mode

Toggle proximity overlays in the sidebar:
- **Strategic proximity**: Show strategic accounts near existing customers
- **ADA accounts**: Show ADA-related account proximity
- Adjustable radius slider

---

## Data Refresh

1. Click **Data Refresh** (bottom-right, above the legend)
2. Click **SFDC Data**
3. Choose data type (Strategic or Customers)
4. Drag-and-drop or select a CSV exported from Salesforce
5. Preview changes and click **Apply**

Smart name matching normalizes school district names:
- "Dallas Independent School District" matches "Dallas ISD"
- "DeSoto County School District" matches "Desoto County Schools"

Notes and meeting prep links are preserved during merges.

---

## Meeting Prep

- Click **"Generate Meeting Prep"** in any account popup
- Copies all account data to clipboard
- Opens ChatGPT for meeting preparation
- Save Google Drive meeting prep links per account

---

## Notes

- Add notes to any account (stored in localStorage)
- Notes persist across browser sessions
- Copy / Export / Import functionality available

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **Enter** | Zoom to searched district |
| **Escape** | Close full-screen modal |

---

## Tech Stack

- Single self-contained HTML file
- [Leaflet.js](https://leafletjs.com/) for mapping
- [SheetJS](https://sheetjs.com/) for Excel file reading
- Vanilla JavaScript — no build step required
- localStorage for persistence (notes, links, SFDC refresh timestamp)

---

## Data Storage

All data is stored in the browser's localStorage:

| Key | Contents |
|-----|----------|
| Notes | Per-account notes |
| Meeting Prep Links | Google Drive links |
| SFDC Refresh | Last refresh timestamp |

This data persists across sessions but is local to your browser.
