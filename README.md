# Edia Territory Map

A web-based interactive map for **Edia Learning's sales team** to visualize and manage their territory - strategic accounts (prospects) and active customers across the US.

---

## Core Features

### Interactive Map
- Leaflet.js-powered map with color-coded pins
- **Purple pins** = Strategic accounts (prospects)
- **Green pins** = Active customers
- Pin colors change based on opportunity stage (Discovery, Demo, Scoping, Validation)
- Click any pin to see full account details

### Dashboard & Stats
- Real-time counts: Strategic accounts, Customers, Overlap, States covered
- Pipeline summary panel showing opportunity values by stage

### Filtering & Search
- Search districts by name
- **Press Enter** to zoom to the searched district and open its popup
- Filter by: Region, State, Account Executive, SIS Platform, Opportunity Stage, Enrollment size, Segment, CSM
- Toggle views: Strategic only, Customers only, or All

### Account Popups (Pin Details)
- District info: enrollment, region, SIS platform
- Leadership contacts: Superintendent, Asst Supts, Directors
- Opportunity details: stage, forecast, probability, next steps
- Links: Org Chart, Strategic Plan, Meeting Prep docs
- Revenue data for customers: ARR, GDR, NDR

### Full-Screen View with Product Tabs
Click the **expand button (↗)** in any popup to open a full-screen modal with organized tabs:

- **Info Tab**: District overview, leadership contacts, opportunity details, resources, notes
- **Math Tab**: Math products/curriculum, math-specific contacts, competition intel
- **Attendance Tab**: SIS platform, attendance system, related contacts

Press **Escape** or click outside to close.

### Notes System
- Add notes to any account (stored in browser localStorage)
- Notes persist across sessions
- Copy/Export/Import notes functionality

### Proximity Mode
- Toggle to show strategic accounts near existing customers
- Adjustable radius slider

### SFDC Refresh
- Drag-and-drop CSV upload to refresh data from Salesforce
- Merges without losing notes or local customizations
- Preview changes before applying

### Meeting Prep Generation
- One-click **"Generate Meeting Prep"** button in account popups
- Copies all account data to clipboard (district info, leadership, opportunities, notes)
- Automatically opens ChatGPT Meeting Research project
- Just paste and hit Enter for comprehensive meeting preparation

### Meeting Prep Links
- Save Google Drive links to meeting prep docs per account
- Shows inline with Strategic Plan link
- Click **"+ Add Meeting Prep"** to add a link
- Updates instantly without page refresh

---

## Tech Stack

- Single HTML file (self-contained)
- Leaflet.js for mapping
- Vanilla JavaScript
- localStorage for notes/links persistence
- Dark theme UI

---

## Usage

1. Open `index.html` in a web browser
2. Use the sidebar to filter and search accounts
3. Click pins on the map to view account details
4. Click the **expand button (↗)** for full-screen view with product tabs
5. Add notes and meeting prep links as needed
6. Click **"Generate Meeting Prep"** to prepare for meetings with ChatGPT

## Data Refresh

To update data from Salesforce:
1. Export CSV from SFDC
2. Use the "SFDC Data Refresh" panel in the sidebar
3. Select data type (Strategic or Customers)
4. Drag and drop the CSV file
5. Review changes and click "Apply"

Your notes and meeting prep links will be preserved during the merge.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Enter | Zoom to searched district and open popup |
| Escape | Close full-screen modal |

---

## Data Storage

The following data is stored in your browser's localStorage:
- **Notes**: Per-account notes you've added
- **Meeting Prep Links**: Google Drive links to meeting prep documents
- **Last SFDC Refresh**: Timestamp of last data refresh

This data persists across sessions but is local to your browser.
