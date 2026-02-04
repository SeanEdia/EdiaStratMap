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
- Filter by: Region, State, Account Executive, SIS Platform, Opportunity Stage, Enrollment size, Segment, CSM
- Toggle views: Strategic only, Customers only, or All

### Account Popups (Pin Details)
- District info: enrollment, region, SIS platform
- Leadership contacts: Superintendent, Asst Supts, Directors
- Opportunity details: stage, forecast, probability, next steps
- Links: Org Chart, Strategic Plan, Meeting Prep docs
- Revenue data for customers: ARR, GDR, NDR

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

### Meeting Prep Generation
- One-click to copy account data and open ChatGPT
- Generates comprehensive meeting preparation

### Meeting Prep Links
- Save Google Drive links to meeting prep docs per account
- Shows inline with Strategic Plan link

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
4. Add notes and meeting prep links as needed

## Data Refresh

To update data from Salesforce:
1. Export CSV from SFDC
2. Use the "SFDC Data Refresh" panel in the sidebar
3. Drag and drop the CSV file
4. Review changes and click "Apply"

Your notes and meeting prep links will be preserved during the merge.
