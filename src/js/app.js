// Import data
import strategicData from '../data/strategic.json';
import customerData from '../data/customers.json';

// Mutable data arrays (can be replaced on refresh)
let STRATEGIC_DATA = [...strategicData];
let CUSTOMER_DATA = [...customerData];

// ============ PERFORMANCE INDICES ============
// Pre-computed lookup structures rebuilt when data changes.
// Converts O(n) scans into O(1) lookups for team/rep filtering.
let _repToTeam = {};          // rep name -> team name
let _teamRepsSet = {};        // team name -> Set of rep names
let _repToAccounts = {};      // rep name -> [account indices]
let _teamToAccounts = {};     // team name -> [account indices]
let _overlapCount = 0;        // cached count of strategic accounts that are also customers
let _uniqueCache = {};        // key -> sorted unique values (invalidated on scope change)
let _autocompleteCache = null; // pre-built state/region counts

function buildIndices() {
  // Map reps to teams (Set-based for O(1) lookup)
  _repToTeam = {};
  _teamRepsSet = {};
  Object.entries(TEAM_REP_DATA).forEach(([team, info]) => {
    const reps = new Set(info.reps);
    if (info.manager) reps.add(info.manager);
    _teamRepsSet[team] = reps;
    reps.forEach(rep => { _repToTeam[rep] = team; });
  });

  // Index strategic accounts by rep and team
  _repToAccounts = {};
  _teamToAccounts = {};
  STRATEGIC_DATA.forEach((d, i) => {
    const tAE = getTerritoryAE(d);
    const hAE = getHoldoutAE(d);
    // Index by territory AE
    if (tAE) {
      if (!_repToAccounts[tAE]) _repToAccounts[tAE] = [];
      _repToAccounts[tAE].push(i);
    }
    // Index by holdout AE (if different)
    if (hAE && hAE !== tAE) {
      if (!_repToAccounts[hAE]) _repToAccounts[hAE] = [];
      _repToAccounts[hAE].push(i);
    }
    // Index by team
    Object.entries(_teamRepsSet).forEach(([team, reps]) => {
      if ((tAE && reps.has(tAE)) || (hAE && reps.has(hAE))) {
        if (!_teamToAccounts[team]) _teamToAccounts[team] = [];
        _teamToAccounts[team].push(i);
      }
    });
  });

  // De-duplicate team indices (an account may be added for both territory and holdout AE)
  Object.keys(_teamToAccounts).forEach(team => {
    _teamToAccounts[team] = [...new Set(_teamToAccounts[team])];
  });

  // Cache overlap count
  _overlapCount = STRATEGIC_DATA.filter(d => d.is_customer).length;

  // Invalidate caches
  _uniqueCache = {};
  _autocompleteCache = null;
}

function invalidateCaches() {
  _uniqueCache = {};
  _autocompleteCache = null;
}

// Pre-build autocomplete state/region counts (called lazily on first search)
function getAutocompleteCache() {
  if (_autocompleteCache) return _autocompleteCache;

  const stateCounts = {};
  const regionSet = new Set();
  const regionCounts = {};

  STRATEGIC_DATA.forEach(d => {
    if (d.state) stateCounts[d.state.toLowerCase()] = (stateCounts[d.state.toLowerCase()] || 0) + 1;
    if (d.region) { regionSet.add(d.region); regionCounts[d.region] = (regionCounts[d.region] || 0) + 1; }
  });
  CUSTOMER_DATA.forEach(d => {
    if (d.state) stateCounts[d.state.toLowerCase()] = (stateCounts[d.state.toLowerCase()] || 0) + 1;
    if (d.region) { regionSet.add(d.region); regionCounts[d.region] = (regionCounts[d.region] || 0) + 1; }
  });

  _autocompleteCache = { stateCounts, regionSet: [...regionSet].sort(), regionCounts };
  return _autocompleteCache;
}

// ============ TEAM / REP DATA ============
const TEAM_REP_DATA = {
  'Strategic': {
    manager: null,
    reps: ['Sean Johnson'],
  },
  'ENT West': {
    manager: 'Brad Halsey',
    reps: ['Aric Walden', 'Lance Baretz', 'Sydney Smith', 'Ben Skillman', 'Jimmy Koerner'],
  },
  'ENT East': {
    manager: 'Samantha Santucci',
    reps: ['Andy Graham', 'David Thomas', 'Susan Speiser', 'Hannah O\'Brien', 'Ally McCready', 'Victoria Macoul'],
  },
  'SMB': {
    manager: 'Christina Ceballos',
    reps: ['Jonathan Pacheco', 'Callie Brennan', 'Paulina Famiano', 'Caroline Uhlarik', 'Daniel Way'],
  },
};

// Holdout detection — automatic, no manual map needed.
// A strategic account is a holdout when its AE is NOT on the Strategic team.
// The territory AE is the Strategic team's primary rep.
let _strategicRepsCache = null;
function getStrategicReps() {
  if (!_strategicRepsCache) {
    _strategicRepsCache = getAllRepsForTeam('Strategic');
  }
  return _strategicRepsCache;
}

// Helper: returns the territory (assigned) AE for an account.
// If the account's AE is outside the Strategic team, the territory AE is the Strategic team rep.
function getTerritoryAE(d) {
  if (!d.ae) return d.ae;
  const reps = getStrategicReps();
  if (reps.includes(d.ae)) return d.ae;       // already assigned to Strategic team
  return reps[0] || d.ae;                      // holdout — territory AE is the Strategic rep
}

// Helper: returns the holdout AE if account is a holdout, otherwise null.
function getHoldoutAE(d) {
  if (!d.ae) return null;
  const reps = getStrategicReps();
  return reps.includes(d.ae) ? null : d.ae;    // holdout if AE is outside Strategic team
}

// ============ STATE ============
let currentView = 'strategic';
let selectedTeam = '';   // '' = all teams
let selectedRep = '';    // '' = all reps
let selectedStages = new Set();  // multi-select stage filter
let map;
let stratLayer, custLayer, proxLayer;
let filters = {};
let proximityOn = false;
let PROXIMITY_MILES = 50;
let adaFilterOn = false;

// Account list state
let markerLookup = {};          // name -> { marker, data, type }
let filteredStratData = [];     // current filtered strategic data
let filteredCustData = [];      // current filtered customer data
let accountListSort = 'enrollment_desc';
let accountListGroupBy = null;  // null | 'state' | 'stage'
let accountListOpen = false;
let collapsedGroups = {};       // track collapsed group headers
let accountListDisplayLimit = 200; // cap DOM rows; increased by "Show more"

// Conference state
let CONFERENCE_DATA = [];
let conferencesOn = false;
let confRangeMode = 'all';
let confDateFrom = null;
let confDateTo = null;
let confLayer = null;
let confProxLayer = null;
let filteredConfData = [];

// ============ INIT ============
function initMap() {
  // Data is loaded from the seed JSON files (strategic.json / customers.json).
  // These files are the single source of truth so that all users see the same data.
  // After a merge, updated JSON is downloaded for committing back to the repo.

  // Build performance indices for team/rep/proximity lookups
  buildIndices();

  // Pre-populate district data cache for modal access
  window.districtDataCache = {};
  STRATEGIC_DATA.forEach(d => {
    const key = d.name.replace(/[^a-zA-Z0-9]/g, '_');
    window.districtDataCache[key] = d;
  });

  map = L.map('map', {
    center: [39.5, -98.5],
    zoom: 5,
    zoomControl: true,
    attributionControl: false,
    minZoom: 3,
    maxZoom: 18
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }).addTo(map);

  stratLayer = L.layerGroup().addTo(map);
  custLayer = L.layerGroup().addTo(map);
  proxLayer = L.layerGroup().addTo(map);
  confLayer = L.layerGroup().addTo(map);
  confProxLayer = L.layerGroup().addTo(map);

  renderTeamRepSelectors();
  renderFilters();
  applyFilters();
  updateNoteCount();
}

// ============ VIEWS ============
function setView(view) {
  currentView = view;
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.className = 'view-btn';
    if (btn.dataset.view === view) {
      if (view === 'strategic') btn.classList.add('active-strat');
      else if (view === 'customers') btn.classList.add('active-cust');
      else btn.classList.add('active-both');
    }
  });
  filters = {};
  selectedTeam = '';
  selectedRep = '';
  selectedStages = new Set();
  document.getElementById('searchInput').value = '';
  accountListSort = (view === 'customers') ? 'arr_desc' : 'enrollment_desc';
  accountListGroupBy = null;
  collapsedGroups = {};
  invalidateCaches();
  renderTeamRepSelectors();
  renderFilters();
  applyFilters();
}

// ============ TEAM / REP SELECTORS ============
function getAllRepsForTeam(team) {
  const t = TEAM_REP_DATA[team];
  if (!t) return [];
  const reps = [...t.reps];
  if (t.manager) reps.unshift(t.manager);
  return reps;
}

function renderTeamRepSelectors() {
  const wrap = document.getElementById('teamRepSelectors');
  if (!wrap) return;

  // Show selectors only in strategic or all view
  const show = currentView === 'strategic' || currentView === 'all';
  wrap.style.display = show ? '' : 'none';
  if (!show) return;

  // Team dropdown
  const teamSel = document.getElementById('teamSelect');
  teamSel.innerHTML = '<option value="">All Teams</option>';
  Object.keys(TEAM_REP_DATA).forEach(team => {
    const sel = selectedTeam === team ? ' selected' : '';
    teamSel.innerHTML += `<option value="${team}"${sel}>${team}</option>`;
  });
  teamSel.classList.toggle('select-active', !!selectedTeam);

  // Rep dropdown (visible only when team is selected)
  const repRow = document.getElementById('repRow');
  const repSel = document.getElementById('repSelect');
  if (selectedTeam) {
    repRow.style.display = '';
    const reps = getAllRepsForTeam(selectedTeam);
    repSel.innerHTML = '<option value="">All Reps</option>';
    reps.forEach(rep => {
      const sel = selectedRep === rep ? ' selected' : '';
      const info = TEAM_REP_DATA[selectedTeam];
      const suffix = info.manager === rep ? ' (Manager)' : '';
      repSel.innerHTML += `<option value="${rep}"${sel}>${rep}${suffix}</option>`;
    });
    repSel.classList.toggle('select-active', !!selectedRep);
  } else {
    repRow.style.display = 'none';
    repSel.innerHTML = '<option value="">All Reps</option>';
    repSel.classList.remove('select-active');
  }
}

function onTeamChange(team) {
  selectedTeam = team;
  selectedRep = '';
  // Clear filters that may no longer be valid for the new team scope
  delete filters.strat_region;
  delete filters.strat_state;

  delete filters.strat_sis;
  invalidateCaches(); // Scoped unique values changed
  renderTeamRepSelectors();
  renderFilters();
  applyFilters();
}

function onRepChange(rep) {
  selectedRep = rep;
  // Clear filters that may no longer be valid for the new rep scope
  delete filters.strat_region;
  delete filters.strat_state;

  delete filters.strat_sis;
  invalidateCaches(); // Scoped unique values changed
  renderFilters();
  applyFilters();
}

// ============ STAGE FILTER ============
const STAGE_OPTIONS = [
  { value: 'Has Open Opp', label: 'Has Opp', cls: 'stage-has-opp' },
  { value: '1 - Discovery', label: 'Discovery', cls: 'stage-discovery' },
  { value: '2 - Demo', label: 'Demo', cls: 'stage-demo' },
  { value: '3 - Scoping', label: 'Scoping', cls: 'stage-scoping' },
  { value: '4 - Proposal', label: 'Proposal', cls: 'stage-proposal' },
  { value: '5 - Validation & Negotiation', label: 'Validation', cls: 'stage-validation' },
  { value: '6 - Procurement', label: 'Procurement', cls: 'stage-procurement' },
];

function onStageChange(stage) {
  if (selectedStages.has(stage)) selectedStages.delete(stage);
  else selectedStages.add(stage);
  renderFilters();
  applyFilters();
}

// ============ FILTERS UI ============

// Returns the strategic dataset scoped to the currently selected team/rep.
// Uses pre-built indices for O(1) lookups instead of scanning all accounts.
function getScopedStratData() {
  if (selectedRep) {
    const indices = _repToAccounts[selectedRep];
    return indices ? indices.map(i => STRATEGIC_DATA[i]) : [];
  }
  if (selectedTeam) {
    const indices = _teamToAccounts[selectedTeam];
    return indices ? indices.map(i => STRATEGIC_DATA[i]) : [];
  }
  return STRATEGIC_DATA;
}

function renderFilters() {
  const area = document.getElementById('filtersArea');
  let html = '';

  if (currentView === 'strategic' || currentView === 'all') {
    // Stage pills (multi-select)
    html += `<div class="filter-group"><div class="filter-label">Opp Stage`;
    if (selectedStages.size > 0) html += `<span class="clear-btn" onclick="clearStages()">clear</span>`;
    html += `</div><div class="filter-chips">`;
    STAGE_OPTIONS.forEach(opt => {
      const active = selectedStages.has(opt.value) ? ' active' : '';
      html += `<div class="filter-chip stage-chip ${opt.cls}${active}" onclick="onStageChange('${opt.value}')">${opt.label}</div>`;
    });
    html += `</div></div>`;

    // Scope filter options to the selected team/rep
    const scopedStrat = getScopedStratData();
    html += buildFilterGroup('Region', 'strat_region', getUnique(scopedStrat, 'region'), 'chips');
    html += buildFilterGroup('State', 'strat_state', getUnique(scopedStrat, 'state'), 'select');
    html += buildFilterGroup('SIS Platform', 'strat_sis', getUnique(scopedStrat, 'sis'), 'select');
    html += buildSliderGroup('Min Enrollment', 'strat_enrollment', 0, 1100000);
  }

  if (currentView === 'customers' || currentView === 'all') {
    if (currentView === 'all') {
      html += `<div style="height:1px;background:var(--panel-border);margin:18px 0 14px;"></div>`;
      html += `<div style="font-size:10px;font-weight:600;color:var(--accent-cust);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">Customer Filters</div>`;
    }
    html += buildFilterGroup('Region', 'cust_region', getUnique(CUSTOMER_DATA, 'region'), 'chips', true);
    html += buildFilterGroup('State', 'cust_state', getUnique(CUSTOMER_DATA, 'state'), 'select');
    html += buildFilterGroup('Segment', 'cust_segment', getUnique(CUSTOMER_DATA, 'segment'), 'chips', true);
    html += buildFilterGroup('CSM', 'cust_csm', getUnique(CUSTOMER_DATA, 'csm'), 'select');
    html += buildFilterGroup('Account Owner', 'cust_ae', getUnique(CUSTOMER_DATA, 'ae'), 'select');
  }

  html += `<button class="reset-btn" onclick="resetFilters()">↺ Reset All Filters</button>`;
  area.innerHTML = html;
}

function buildFilterGroup(label, key, options, type, isCust) {
  let html = `<div class="filter-group">`;
  html += `<div class="filter-label">${label}`;
  if (filters[key]) html += `<span class="clear-btn" onclick="clearFilter('${key}')">clear</span>`;
  html += `</div>`;

  if (type === 'select') {
    html += `<select class="filter-select" onchange="setFilter('${key}', this.value)">`;
    html += `<option value="">All</option>`;
    options.forEach(o => {
      const sel = filters[key] === o ? 'selected' : '';
      html += `<option value="${o}" ${sel}>${o}</option>`;
    });
    html += `</select>`;
  } else if (type === 'chips') {
    html += `<div class="filter-chips">`;
    options.forEach(o => {
      const active = (filters[key] === o) ? (isCust ? 'cust-active' : 'active') : '';
      html += `<div class="filter-chip ${active}" onclick="toggleChip('${key}','${o}')">${o}</div>`;
    });
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function buildSliderGroup(label, key, min, max) {
  const val = filters[key] || min;
  return `<div class="filter-group">
    <div class="filter-label">${label}</div>
    <div class="range-display">${Number(val).toLocaleString()}+ students</div>
    <input type="range" min="${min}" max="${max}" step="5000" value="${val}"
      oninput="setFilter('${key}', this.value); this.previousElementSibling.textContent = Number(this.value).toLocaleString() + '+ students'">
  </div>`;
}

// ============ FILTER LOGIC ============
function getUnique(data, field) {
  // Use cached result if available (cache keyed by dataset identity + field)
  const isStrategic = data === STRATEGIC_DATA;
  const isCustomer = data === CUSTOMER_DATA;
  const scopeKey = isStrategic ? 'strat' : isCustomer ? 'cust' : (selectedRep || selectedTeam || 'all');
  const cacheKey = scopeKey + ':' + field;
  if (_uniqueCache[cacheKey]) return _uniqueCache[cacheKey];

  const result = [...new Set(data.map(d => d[field]).filter(Boolean))].sort();
  _uniqueCache[cacheKey] = result;
  return result;
}

// Collect unique AE names — resolves territory AEs and includes holdout reps in dropdown
function getUniqueAEs(data) {
  const s = new Set();
  data.forEach(d => {
    const tAE = getTerritoryAE(d);
    const hAE = getHoldoutAE(d);
    if (tAE) s.add(tAE);
    if (hAE) s.add(hAE);
  });
  return [...s].sort();
}

function setFilter(key, val) {
  if (!val || val === '') delete filters[key];
  else filters[key] = val;
  applyFilters();
}

function toggleChip(key, val) {
  if (filters[key] === val) delete filters[key];
  else filters[key] = val;
  renderFilters();
  applyFilters();
}

function clearFilter(key) {
  delete filters[key];
  renderFilters();
  applyFilters();
}

function clearStages() {
  selectedStages = new Set();
  renderFilters();
  applyFilters();
}

function resetFilters() {
  filters = {};
  selectedTeam = '';
  selectedRep = '';
  selectedStages = new Set();
  document.getElementById('searchInput').value = '';
  adaFilterOn = false;
  const adaCheck = document.getElementById('adaCheck');
  if (adaCheck) adaCheck.checked = false;
  invalidateCaches();
  renderTeamRepSelectors();
  renderFilters();
  applyFilters();
}

function resetMapView() {
  // Reset view to Strategic Accounts (keeps team/rep selection)
  currentView = 'strategic';
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.className = 'view-btn';
    if (btn.dataset.view === 'strategic') btn.classList.add('active-strat');
  });

  // Clear all filters and stages but keep team/rep
  filters = {};
  selectedStages = new Set();
  document.getElementById('searchInput').value = '';
  accountListSort = 'enrollment_desc';
  accountListGroupBy = null;
  collapsedGroups = {};

  // Reset proximity toggles
  proximityOn = false;
  const proxCheck = document.getElementById('proxCheck');
  if (proxCheck) proxCheck.checked = false;
  const proxWrap = document.getElementById('proxRadiusWrap');
  if (proxWrap) proxWrap.style.display = 'none';
  proxLayer.clearLayers();
  adaFilterOn = false;
  const adaCheck = document.getElementById('adaCheck');
  if (adaCheck) adaCheck.checked = false;

  // Collapse all panels
  const filtersWrap = document.getElementById('filtersWrap');
  if (filtersWrap) filtersWrap.classList.add('collapsed');
  const pipelinePanel = document.getElementById('pipelinePanel');
  if (pipelinePanel) pipelinePanel.classList.add('pl-collapsed');
  const pipelineDetail = document.getElementById('pipelineDetail');
  if (pipelineDetail) pipelineDetail.classList.add('collapsed');

  // Close overlays
  if (accountListOpen) {
    accountListOpen = false;
    const alOverlay = document.getElementById('alOverlay');
    const badge = document.getElementById('countBadge');
    if (alOverlay) alOverlay.classList.remove('open');
    if (badge) badge.classList.remove('active');
  }
  if (actionDashboardOpen) {
    actionDashboardOpen = false;
    const adOverlay = document.getElementById('adOverlay');
    const adTrigger = document.getElementById('adTrigger');
    if (adOverlay) adOverlay.classList.remove('open');
    if (adTrigger) adTrigger.classList.remove('active');
  }

  invalidateCaches();
  renderTeamRepSelectors();
  renderFilters();
  applyFilters();

  // Reset map to lower 48 US view
  map.setView([39.5, -98.5], 5, { animate: true });
}

function toggleFiltersPanel() {
  const filtersWrap = document.getElementById('filtersWrap');
  const isOpening = filtersWrap.classList.contains('collapsed');
  filtersWrap.classList.toggle('collapsed');
  // Collapse pipeline when opening filters
  if (isOpening) {
    const pp = document.getElementById('pipelinePanel');
    const pd = document.getElementById('pipelineDetail');
    if (pp) pp.classList.add('pl-collapsed');
    if (pd) pd.classList.add('collapsed');
  }
}

function updateFiltersActiveCount() {
  const count = Object.keys(filters).length + selectedStages.size;
  const el = document.getElementById('filtersActiveCount');
  if (el) el.textContent = count > 0 ? count + ' active' : '';
}

// Track search results for zoom functionality
let lastSearchResults = [];
let searchExactMatch = false; // true when search is from autocomplete selection

function applyFilters() {
  const search = document.getElementById('searchInput').value.toLowerCase().trim();

  stratLayer.clearLayers();
  custLayer.clearLayers();
  if (proximityOn) drawProximity();
  accountListDisplayLimit = 200; // Reset pagination on filter change

  let stratCount = 0, custCount = 0;
  let statesSet = new Set();
  lastSearchResults = []; // Reset search results
  markerLookup = {};            // Reset marker lookup
  filteredStratData = [];       // Reset filtered data
  filteredCustData = [];

  // Strategic accounts
  if (currentView === 'strategic' || currentView === 'all') {
    const filtered = STRATEGIC_DATA.filter(d => {
      const territoryAE = getTerritoryAE(d);
      const holdoutAE = getHoldoutAE(d);
      if (search) {
        if (searchExactMatch) {
          // Exact match for state/region selected from autocomplete
          const stMatch = d.state && d.state.toLowerCase() === search;
          const regMatch = d.region && d.region.toLowerCase() === search;
          const nameMatch = d.name.toLowerCase() === search;
          const aeMatch = territoryAE && territoryAE.toLowerCase() === search;
          const holdoutMatch = holdoutAE && holdoutAE.toLowerCase() === search;
          if (!stMatch && !regMatch && !nameMatch && !aeMatch && !holdoutMatch) return false;
        } else {
          if (!d.name.toLowerCase().includes(search)
              && !(d.state && d.state.toLowerCase().includes(search))
              && !(d.region && d.region.toLowerCase().includes(search))
              && !(territoryAE && territoryAE.toLowerCase().includes(search))
              && !(holdoutAE && holdoutAE.toLowerCase().includes(search))) return false;
        }
      }
      // Stage filter (multi-select, applied before team/rep for cross-team visibility)
      if (selectedStages.size > 0) {
        if (!d.opp_stage) return false;
        if (!selectedStages.has('Has Open Opp') && !selectedStages.has(d.opp_stage)) return false;
      }
      // Team / rep filter (applied before other filters)
      // Holdout accounts match both the territory AE and the holdout AE
      // Uses Set-based lookup (_teamRepsSet) for O(1) instead of Array.includes O(n)
      if (selectedRep) {
        if (territoryAE !== selectedRep && holdoutAE !== selectedRep) return false;
      } else if (selectedTeam) {
        const teamReps = _teamRepsSet[selectedTeam];
        if (!teamReps || (!teamReps.has(territoryAE) && !(holdoutAE && teamReps.has(holdoutAE)))) return false;
      }
      if (filters.strat_region && d.region !== filters.strat_region) return false;
      if (filters.strat_state && d.state !== filters.strat_state) return false;
      if (filters.strat_sis && d.sis !== filters.strat_sis) return false;
      if (filters.strat_enrollment && parseInt(d.enrollment) < parseInt(filters.strat_enrollment)) return false;
      if (adaFilterOn && !d.ada_adm) return false;
      return true;
    });

    filtered.forEach(d => {
      if (!d.lat || !d.lng) return;
      const students = parseInt(d.enrollment) || 0;
      const isLarge = students > 50000;
      let oppClass = '';
      if (d.opp_stage) {
        if (d.opp_stage.startsWith('1')) oppClass = ' opp-discovery';
        else if (d.opp_stage.startsWith('2')) oppClass = ' opp-demo';
        else if (d.opp_stage.startsWith('3')) oppClass = ' opp-scoping';
        else if (d.opp_stage.startsWith('4')) oppClass = ' opp-proposal';
        else if (d.opp_stage.startsWith('5')) oppClass = ' opp-validation';
        else if (d.opp_stage.startsWith('6')) oppClass = ' opp-procurement';
        else oppClass = ' has-opp';
      }
      const noteKey = 'edia_notes_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
      const hasNote = (() => { try { return JSON.parse(localStorage.getItem(noteKey) || '[]').length > 0; } catch(e) { return false; } })() ? ' has-note' : '';
      const isCust = d.is_customer ? ' is-customer' : '';
      const icon = L.divIcon({
        className: `marker-strat${oppClass}${hasNote}${isCust} ${isLarge ? 'large' : ''}`,
        iconSize: isLarge ? [18, 18] : [14, 14],
        iconAnchor: isLarge ? [9, 9] : [7, 7],
      });

      const marker = L.marker([d.lat, d.lng], { icon }).addTo(stratLayer);
      marker.bindPopup(buildStratPopup(d), { maxWidth: 320 });
      marker.on('click', function() {
        map.flyTo([d.lat + 2.5, d.lng], 7, { duration: 0.6 });
      });
      statesSet.add(d.state);
      markerLookup[d.name] = { marker, data: d, type: 'strategic' };

      // Track for search zoom functionality
      if (search) {
        lastSearchResults.push({ marker, data: d, type: 'strategic' });
      }
    });
    stratCount = filtered.length;
    filteredStratData = filtered;
  }

  // Active customers
  if (currentView === 'customers' || currentView === 'all') {
    const filtered = CUSTOMER_DATA.filter(d => {
      if (search) {
        if (searchExactMatch) {
          const stMatch = d.state && d.state.toLowerCase() === search;
          const regMatch = d.region && d.region.toLowerCase() === search;
          const nameMatch = d.name.toLowerCase() === search;
          const aeMatch = d.ae && d.ae.toLowerCase() === search;
          if (!stMatch && !regMatch && !nameMatch && !aeMatch) return false;
        } else {
          if (!d.name.toLowerCase().includes(search)
              && !(d.state && d.state.toLowerCase().includes(search))
              && !(d.region && d.region.toLowerCase().includes(search))
              && !(d.ae && d.ae.toLowerCase().includes(search))) return false;
        }
      }
      if (filters.cust_region && d.region !== filters.cust_region) return false;
      if (filters.cust_state && d.state !== filters.cust_state) return false;
      if (filters.cust_segment && d.segment !== filters.cust_segment) return false;
      if (filters.cust_csm && d.csm !== filters.cust_csm) return false;
      if (filters.cust_ae && d.ae !== filters.cust_ae) return false;
      return true;
    });

    filtered.forEach(d => {
      if (!d.lat || !d.lng) return;
      const isAlsoStrat = d.also_strategic ? ' also-strategic' : '';
      const icon = L.divIcon({
        className: `marker-cust${isAlsoStrat}`,
        iconSize: d.also_strategic ? [14, 14] : [10, 10],
        iconAnchor: d.also_strategic ? [7, 7] : [5, 5],
      });

      const marker = L.marker([d.lat, d.lng], { icon }).addTo(custLayer);
      marker.bindPopup(buildCustPopup(d), { maxWidth: 320 });
      marker.on('click', function() {
        map.flyTo([d.lat + 2.5, d.lng], 7, { duration: 0.6 });
      });
      statesSet.add(d.state);
      if (!markerLookup[d.name]) {
        markerLookup[d.name] = { marker, data: d, type: 'customer' };
      }

      // Track for search zoom functionality
      if (search) {
        lastSearchResults.push({ marker, data: d, type: 'customer' });
      }
    });
    custCount = filtered.length;
    filteredCustData = filtered;
  }

  // Update stats - context-aware (uses cached overlap count)
  const overlapCount = _overlapCount;
  const stratEl = document.getElementById('stat-strat-count');
  const custEl = document.getElementById('stat-cust-count');
  const overlapEl = document.getElementById('stat-overlap-count');
  const overlapLabel = document.getElementById('stat-overlap-label');
  const stratCard = stratEl.parentElement;
  const custCard = custEl.parentElement;
  const overlapCard = document.getElementById('stat-card-overlap');

  if (currentView === 'strategic') {
    // Show: Strategic | Overlap | Opps | States
    stratEl.textContent = stratCount;
    stratCard.style.display = '';
    custCard.style.display = 'none';
    overlapEl.textContent = overlapCount;
    overlapEl.style.color = '#00b894';
    overlapLabel.textContent = 'Customers';
    overlapCard.style.display = '';
  } else if (currentView === 'customers') {
    // Show: Customers | Overlap | (hide strat) | States
    custEl.textContent = custCount;
    custCard.style.display = '';
    stratCard.style.display = 'none';
    overlapEl.textContent = overlapCount;
    overlapEl.style.color = '#E8853D';
    overlapLabel.textContent = 'Also Strategic';
    overlapCard.style.display = '';
  } else {
    // All view: Strategic | Customers | Overlap | States
    stratEl.textContent = stratCount;
    custEl.textContent = custCount;
    stratCard.style.display = '';
    custCard.style.display = '';
    overlapEl.textContent = overlapCount;
    overlapEl.style.color = '#E8853D';
    overlapLabel.textContent = 'Overlap';
    overlapCard.style.display = '';
  }
  document.getElementById('stat-states').textContent = statesSet.size;

  // Update count badge
  updateCountBadge(stratCount, custCount);
  updateLegend();
  updatePipeline();
  updateActionDashboard();
  renderAccountList();
  updateFiltersActiveCount();
}

// ============ AUTOCOMPLETE SEARCH ============

let acSelectedIndex = -1;
let acItems = [];

function buildAutocompleteList(query) {
  if (!query || query.length < 1) return [];

  const q = query.toLowerCase();
  const results = [];
  const seen = new Set();

  // US state abbreviation map for matching
  const stateNames = {
    'al':'Alabama','ak':'Alaska','az':'Arizona','ar':'Arkansas','ca':'California',
    'co':'Colorado','ct':'Connecticut','de':'Delaware','fl':'Florida','ga':'Georgia',
    'hi':'Hawaii','id':'Idaho','il':'Illinois','in':'Indiana','ia':'Iowa','ks':'Kansas',
    'ky':'Kentucky','la':'Louisiana','me':'Maine','md':'Maryland','ma':'Massachusetts',
    'mi':'Michigan','mn':'Minnesota','ms':'Mississippi','mo':'Missouri','mt':'Montana',
    'ne':'Nebraska','nv':'Nevada','nh':'New Hampshire','nj':'New Jersey','nm':'New Mexico',
    'ny':'New York','nc':'North Carolina','nd':'North Dakota','oh':'Ohio','ok':'Oklahoma',
    'or':'Oregon','pa':'Pennsylvania','ri':'Rhode Island','sc':'South Carolina',
    'sd':'South Dakota','tn':'Tennessee','tx':'Texas','ut':'Utah','vt':'Vermont',
    'va':'Virginia','wa':'Washington','wv':'West Virginia','wi':'Wisconsin','wy':'Wyoming','dc':'District of Columbia'
  };

  // Match states — uses pre-computed counts instead of filtering all accounts per state
  const acCache = getAutocompleteCache();
  Object.entries(stateNames).forEach(([abbr, name]) => {
    if (abbr.startsWith(q) || name.toLowerCase().startsWith(q)) {
      const key = 'state:' + abbr;
      if (!seen.has(key)) {
        seen.add(key);
        const count = (acCache.stateCounts[abbr] || 0) + (acCache.stateCounts[name.toLowerCase()] || 0);
        if (count > 0) {
          results.push({ type: 'state', label: name + ' (' + abbr.toUpperCase() + ')', meta: count + ' accounts', abbr, name });
        }
      }
    }
  });

  // Match regions — uses pre-computed counts instead of filtering all accounts per region
  acCache.regionSet.forEach(region => {
    if (region.toLowerCase().includes(q)) {
      const count = acCache.regionCounts[region] || 0;
      results.push({ type: 'region', label: region, meta: count + ' accounts', region });
    }
  });

  // Match districts (strategic accounts)
  STRATEGIC_DATA.forEach(d => {
    const nameMatch = d.name && d.name.toLowerCase().includes(q);
    if (nameMatch && !seen.has('strat:' + d.name)) {
      seen.add('strat:' + d.name);
      results.push({ type: 'strat', label: d.name, meta: d.state || '', data: d });
    }
  });

  // Match districts (customers)
  CUSTOMER_DATA.forEach(d => {
    const nameMatch = d.name && d.name.toLowerCase().includes(q);
    if (nameMatch && !seen.has('cust:' + d.name) && !seen.has('strat:' + d.name)) {
      seen.add('cust:' + d.name);
      results.push({ type: 'cust', label: d.name, meta: d.state || '', data: d });
    }
  });

  // Sort: prioritize starts-with matches, then alphabetical
  results.sort((a, b) => {
    const aStarts = a.label.toLowerCase().startsWith(q) ? 0 : 1;
    const bStarts = b.label.toLowerCase().startsWith(q) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    // Type priority: state > region > strat > cust
    const typeOrder = { state: 0, region: 1, strat: 2, cust: 3 };
    if (typeOrder[a.type] !== typeOrder[b.type]) return typeOrder[a.type] - typeOrder[b.type];
    return a.label.localeCompare(b.label);
  });

  return results.slice(0, 12);
}

function renderAutocomplete(items) {
  const dropdown = document.getElementById('searchAutocomplete');
  if (items.length === 0) {
    dropdown.classList.remove('open');
    dropdown.innerHTML = '';
    acItems = [];
    acSelectedIndex = -1;
    return;
  }

  acItems = items;
  acSelectedIndex = -1;
  const q = document.getElementById('searchInput').value.toLowerCase();

  dropdown.innerHTML = items.map((item, i) => {
    const typeLabels = { strat: 'Acct', cust: 'Cust', state: 'State', region: 'Region' };
    // Highlight matching portion in label
    const idx = item.label.toLowerCase().indexOf(q);
    let labelHtml = item.label;
    if (idx >= 0) {
      labelHtml = item.label.substring(0, idx) + '<b>' + item.label.substring(idx, idx + q.length) + '</b>' + item.label.substring(idx + q.length);
    }
    return `<div class="search-ac-item" data-index="${i}" onmousedown="selectAutocomplete(${i})">
      <span class="search-ac-type ${item.type}">${typeLabels[item.type]}</span>
      <span class="search-ac-name">${labelHtml}</span>
      <span class="search-ac-meta">${item.meta}</span>
    </div>`;
  }).join('');
  dropdown.classList.add('open');
}

let _searchDebounceTimer = null;
function onSearchInput() {
  searchExactMatch = false; // typing resets exact match mode
  const query = document.getElementById('searchInput').value.trim();
  // Autocomplete renders immediately for responsiveness
  const items = buildAutocompleteList(query);
  renderAutocomplete(items);
  // Debounce the expensive filter + marker rebuild (150ms)
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    applyFilters();
    // When search is cleared, fly out to lower 48 US view (same as reset view button)
    if (!query && map) {
      map.setView([39.5, -98.5], 5, { animate: true });
    }
  }, 150);
}

function onSearchKeydown(e) {
  const dropdown = document.getElementById('searchAutocomplete');
  if (!dropdown.classList.contains('open')) {
    if (e.key === 'Enter') { zoomToSearchResult(); }
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    acSelectedIndex = Math.min(acSelectedIndex + 1, acItems.length - 1);
    updateAcSelection();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    acSelectedIndex = Math.max(acSelectedIndex - 1, -1);
    updateAcSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (acSelectedIndex >= 0) {
      selectAutocomplete(acSelectedIndex);
    } else if (acItems.length > 0) {
      selectAutocomplete(0);
    }
  } else if (e.key === 'Escape') {
    closeAutocomplete();
  }
}

function updateAcSelection() {
  const dropdown = document.getElementById('searchAutocomplete');
  dropdown.querySelectorAll('.search-ac-item').forEach((el, i) => {
    el.classList.toggle('selected', i === acSelectedIndex);
  });
  // Scroll selected into view
  const selected = dropdown.querySelector('.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function selectAutocomplete(index) {
  const item = acItems[index];
  if (!item) return;
  closeAutocomplete();

  if (item.type === 'state') {
    // Filter to this state and fit bounds
    document.getElementById('searchInput').value = item.abbr.toUpperCase();
    searchExactMatch = true;
    applyFilters();
    // Fit map to all accounts in this state
    const bounds = [];
    [...STRATEGIC_DATA, ...CUSTOMER_DATA].forEach(d => {
      const st = (d.state || '').toLowerCase();
      if ((st === item.abbr || st === item.name.toLowerCase()) && d.lat && d.lng) {
        bounds.push([d.lat, d.lng]);
      }
    });
    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
    }
  } else if (item.type === 'region') {
    document.getElementById('searchInput').value = item.region;
    searchExactMatch = true;
    applyFilters();
    const bounds = [];
    [...STRATEGIC_DATA, ...CUSTOMER_DATA].forEach(d => {
      if (d.region === item.region && d.lat && d.lng) {
        bounds.push([d.lat, d.lng]);
      }
    });
    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
    }
  } else {
    // Individual account
    document.getElementById('searchInput').value = item.label;
    searchExactMatch = true;
    applyFilters();
    const entry = markerLookup[item.label];
    if (entry && entry.marker) {
      const latLng = entry.marker.getLatLng();
      map.setView([latLng.lat + 2.5, latLng.lng], 7, { animate: true });
      setTimeout(() => entry.marker.openPopup(), 400);
    } else if (item.data && item.data.lat && item.data.lng) {
      map.setView([item.data.lat + 2.5, item.data.lng], 7, { animate: true });
    }
  }
}

function closeAutocomplete() {
  const dropdown = document.getElementById('searchAutocomplete');
  dropdown.classList.remove('open');
  dropdown.innerHTML = '';
  acItems = [];
  acSelectedIndex = -1;
}

function zoomToSearchResult() {
  closeAutocomplete();
  if (lastSearchResults.length === 0) return;

  // Find best match
  const search = document.getElementById('searchInput').value.toLowerCase().trim();
  let bestMatch = lastSearchResults.find(r => r.data.name.toLowerCase() === search);
  if (!bestMatch) bestMatch = lastSearchResults.find(r => r.data.name.toLowerCase().startsWith(search));
  if (!bestMatch) bestMatch = lastSearchResults[0];

  if (lastSearchResults.length === 1) {
    const latLng = bestMatch.marker.getLatLng();
    map.setView([latLng.lat + 2.5, latLng.lng], 7, { animate: true });
    setTimeout(() => bestMatch.marker.openPopup(), 300);
  } else {
    // Multiple results — fit bounds
    const bounds = lastSearchResults.map(r => r.marker.getLatLng());
    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
    }
    // Still open best match popup
    setTimeout(() => bestMatch.marker.openPopup(), 400);
  }
}

function togglePipelinePanel() {
  const panel = document.getElementById('pipelinePanel');
  const detail = document.getElementById('pipelineDetail');
  const isOpening = panel.classList.contains('pl-collapsed');
  detail.classList.toggle('collapsed');
  panel.classList.toggle('pl-collapsed');
  // Collapse filters when opening pipeline
  if (isOpening) {
    const fw = document.getElementById('filtersWrap');
    if (fw) fw.classList.add('collapsed');
  }
}

function updatePipeline() {
  const panel = document.getElementById('pipelinePanel');
  const stats = document.getElementById('pipelineStats');
  if (currentView === 'customers') { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  // Scope pipeline to selected team/rep
  const withOpp = getScopedStratData().filter(d => d.opp_stage);
  const stages = [
    { key: '1', label: 'Discovery', color: '#fdcb6e' },
    { key: '2', label: 'Demo', color: '#74b9ff' },
    { key: '3', label: 'Scoping', color: '#e17055' },
    { key: '4', label: 'Proposal', color: '#a29bfe' },
    { key: '5', label: 'Validation', color: '#55efc4' },
    { key: '6', label: 'Procurement', color: '#fd79a8' },
  ];

  let h = '';
  let totalACV = 0;
  let totalCount = 0;
  stages.forEach((s, idx) => {
    const inStage = withOpp.filter(d => d.opp_stage && d.opp_stage.startsWith(s.key));
    const acv = inStage.reduce((sum, d) => sum + (Number(d.opp_acv) || 0), 0);
    totalACV += acv;
    totalCount += inStage.length;
    if (inStage.length > 0) {
      // Sort by ACV descending to show largest first
      const sorted = [...inStage].sort((a, b) => (Number(b.opp_acv) || 0) - (Number(a.opp_acv) || 0));
      const stageId = `stage-dropdown-${idx}`;
      h += `<div class="pipeline-stage-container">`;
      h += `<div class="pipeline-detail-row pipeline-clickable" onclick="toggleStageDropdown('${stageId}')">`;
      h += `<span class="label"><span class="stage-dot" style="background:${s.color}"></span>${s.label} (${inStage.length})</span>`;
      h += `<span class="value">$${acv.toLocaleString()} <span class="dropdown-arrow">▼</span></span>`;
      h += `</div>`;
      h += `<div id="${stageId}" class="stage-dropdown" style="display:none;">`;
      sorted.forEach(d => {
        const oppAcv = Number(d.opp_acv) || 0;
        const districtKey = d.name.replace(/[^a-zA-Z0-9]/g, '_');
        h += `<div class="stage-dropdown-item" onclick="event.stopPropagation(); openAccountModalByKey('${districtKey}')">`;
        h += `<span class="dropdown-name">${d.name}</span>`;
        h += `<span class="dropdown-acv">$${oppAcv.toLocaleString()}</span>`;
        h += `</div>`;
      });
      h += `</div></div>`;
    }
  });
  h += `<div class="pipeline-total"><span class="label">${totalCount} Open Opps</span><span class="value">$${totalACV.toLocaleString()}</span></div>`;
  stats.innerHTML = h;
}

function toggleStageDropdown(stageId) {
  const dropdown = document.getElementById(stageId);
  const arrow = dropdown.previousElementSibling.querySelector('.dropdown-arrow');
  if (dropdown.style.display === 'none') {
    // Close all other dropdowns first
    document.querySelectorAll('.stage-dropdown').forEach(d => {
      d.style.display = 'none';
      const otherArrow = d.previousElementSibling.querySelector('.dropdown-arrow');
      if (otherArrow) otherArrow.classList.remove('open');
    });
    dropdown.style.display = 'block';
    if (arrow) arrow.classList.add('open');
  } else {
    dropdown.style.display = 'none';
    if (arrow) arrow.classList.remove('open');
  }
}

// ============ ACTION DASHBOARD ============

let actionDashboardOpen = false;

function toggleActionDashboard() {
  actionDashboardOpen = !actionDashboardOpen;
  const overlay = document.getElementById('adOverlay');
  const trigger = document.getElementById('adTrigger');
  if (overlay) overlay.classList.toggle('open', actionDashboardOpen);
  if (trigger) trigger.classList.toggle('active', actionDashboardOpen);
}

// Close overlay when clicking outside
document.addEventListener('click', function(e) {
  if (!actionDashboardOpen) return;
  const overlay = document.getElementById('adOverlay');
  const trigger = document.getElementById('adTrigger');
  if (overlay && trigger && !overlay.contains(e.target) && !trigger.contains(e.target)) {
    actionDashboardOpen = false;
    overlay.classList.remove('open');
    trigger.classList.remove('active');
  }
});

// Close account list overlay when clicking outside
document.addEventListener('click', function(e) {
  if (!accountListOpen) return;
  // Skip close if a sort/group action just re-rendered (target removed from DOM)
  if (!document.body.contains(e.target)) return;
  const overlay = document.getElementById('alOverlay');
  const badge = document.getElementById('countBadge');
  if (overlay && badge && !overlay.contains(e.target) && !badge.contains(e.target)) {
    accountListOpen = false;
    overlay.classList.remove('open');
    badge.classList.remove('active');
  }
});

function parseUSDate(str) {
  if (!str) return null;
  const parts = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!parts) return null;
  let year = parseInt(parts[3]);
  if (year < 100) year += 2000;
  return new Date(year, parseInt(parts[1]) - 1, parseInt(parts[2]));
}

function daysAgo(dateStr) {
  const d = parseUSDate(dateStr);
  if (!d) return Infinity;
  const now = new Date();
  now.setHours(0,0,0,0);
  d.setHours(0,0,0,0);
  return Math.floor((now - d) / 86400000);
}

function extractDatesFromText(text) {
  if (!text) return [];
  // Match M/D, M/D/YY, M/D/YYYY, or MM/DD patterns
  const datePatterns = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g);
  if (!datePatterns) return [];
  const results = [];
  const now = new Date();
  const currentYear = now.getFullYear();
  datePatterns.forEach(p => {
    const m = p.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (!m) return;
    const month = parseInt(m[1]);
    const day = parseInt(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return;
    let year = currentYear;
    if (m[3]) {
      year = parseInt(m[3]);
      if (year < 100) year += 2000;
    }
    results.push(new Date(year, month - 1, day));
  });
  return results;
}

function isThisWeek(date) {
  const now = new Date();
  now.setHours(0,0,0,0);
  // Start of week (Monday)
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() + mondayOffset);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23,59,59,999);
  const d = new Date(date);
  d.setHours(0,0,0,0);
  return d >= weekStart && d <= weekEnd;
}

function updateActionDashboard() {
  const body = document.getElementById('actionDashboardBody');
  if (!body) return;

  let allAccounts = [];
  window.districtDataCache = window.districtDataCache || {};

  // Gather accounts based on current view
  if (currentView === 'strategic' || currentView === 'all') {
    STRATEGIC_DATA.forEach(d => {
      const key = d.name.replace(/[^a-zA-Z0-9]/g, '_');
      window.districtDataCache[key] = d;
      allAccounts.push({
        name: d.name,
        key: key,
        lastActivity: d.opp_last_activity || '',
        nextStep: d.opp_next_step || '',
        type: 'strategic',
        data: d
      });
    });
  }
  if (currentView === 'customers' || currentView === 'all') {
    CUSTOMER_DATA.forEach(d => {
      // Avoid duplicates in 'all' view
      if (currentView === 'all' && allAccounts.some(a => a.name === d.name)) return;
      const key = d.name.replace(/[^a-zA-Z0-9]/g, '_');
      window.districtDataCache[key] = d;
      allAccounts.push({
        name: d.name,
        key: key,
        lastActivity: d.last_activity || '',
        nextStep: '',
        type: 'customer',
        data: d
      });
    });
  }

  // 1) Stalest accounts - those with activity dates, sorted oldest first
  const withActivity = allAccounts
    .filter(a => a.lastActivity && parseUSDate(a.lastActivity))
    .map(a => ({ ...a, daysSince: daysAgo(a.lastActivity) }))
    .sort((a, b) => b.daysSince - a.daysSince);
  const stalest = withActivity.slice(0, 8);

  // 2) Next steps due this week
  const dueThisWeek = [];
  allAccounts.forEach(a => {
    if (!a.nextStep) return;
    const dates = extractDatesFromText(a.nextStep);
    if (dates.some(d => isThisWeek(d))) {
      dueThisWeek.push(a);
    }
  });

  // 3) Untouched accounts - no activity date at all
  const untouched = allAccounts.filter(a => !a.lastActivity || !parseUSDate(a.lastActivity));

  let html = '';

  // --- Stalest Accounts ---
  html += `<div class="ad-section">`;
  html += `<div class="ad-section-header">Stalest Accounts <span class="ad-count">${stalest.length}</span></div>`;
  if (stalest.length === 0) {
    html += `<div class="ad-empty">No activity dates on record</div>`;
  } else {
    stalest.forEach(a => {
      const label = a.daysSince === 1 ? '1d ago' : a.daysSince + 'd ago';
      html += `<div class="ad-item" onclick="openAccountModalByKey('${a.key}')">`;
      html += `<span class="ad-name">${a.name}</span>`;
      html += `<span class="ad-meta ad-stale">${label}</span>`;
      html += `</div>`;
    });
  }
  html += `</div>`;

  // --- Next Steps Due This Week ---
  html += `<div class="ad-section">`;
  html += `<div class="ad-section-header">Due This Week <span class="ad-count">${dueThisWeek.length}</span></div>`;
  if (dueThisWeek.length === 0) {
    html += `<div class="ad-empty">No next steps due this week</div>`;
  } else {
    dueThisWeek.forEach(a => {
      const truncStep = a.nextStep.length > 40 ? a.nextStep.slice(0, 40) + '...' : a.nextStep;
      html += `<div class="ad-item" onclick="openAccountModalByKey('${a.key}')" title="${a.nextStep.replace(/"/g, '&quot;')}">`;
      html += `<span class="ad-name">${a.name}</span>`;
      html += `<span class="ad-next-step-text ad-due">${truncStep}</span>`;
      html += `</div>`;
    });
  }
  html += `</div>`;

  // --- Untouched Accounts ---
  html += `<div class="ad-section">`;
  html += `<div class="ad-section-header">Untouched <span class="ad-count">${untouched.length}</span></div>`;
  if (untouched.length === 0) {
    html += `<div class="ad-empty">All accounts have activity dates</div>`;
  } else {
    const shown = untouched.slice(0, 8);
    shown.forEach(a => {
      html += `<div class="ad-item" onclick="openAccountModalByKey('${a.key}')">`;
      html += `<span class="ad-name">${a.name}</span>`;
      html += `<span class="ad-meta ad-untouched">no activity</span>`;
      html += `</div>`;
    });
    if (untouched.length > 8) {
      html += `<div class="ad-empty">+ ${untouched.length - 8} more</div>`;
    }
  }
  html += `</div>`;

  body.innerHTML = html;

  // Update alert badge on trigger button
  const trigger = document.getElementById('adTrigger');
  if (trigger) {
    const alertCount = dueThisWeek.length;
    const existing = trigger.querySelector('.ad-alert');
    if (existing) existing.remove();
    if (alertCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'ad-alert';
      badge.textContent = alertCount;
      trigger.appendChild(badge);
    }
  }
}

// ============ POPUPS ============

function toggleProximity(on) {
  proximityOn = on;
  document.getElementById('proxRadiusWrap').style.display = on ? 'flex' : 'none';
  drawProximity();
}

function toggleAdaFilter(on) {
  adaFilterOn = on;
  applyFilters();
}

function updateProxRadius(val) {
  PROXIMITY_MILES = parseInt(val);
  const miInput = document.getElementById('proxMilesInput');
  if (miInput) miInput.value = PROXIMITY_MILES;
  if (proximityOn) drawProximity();
}

function setProxRadiusFromInput(val) {
  let n = parseInt(val);
  if (isNaN(n) || n < 10) n = 10;
  if (n > 150) n = 150;
  PROXIMITY_MILES = n;
  const slider = document.getElementById('proxRadius');
  if (slider) slider.value = n;
  if (proximityOn) drawProximity();
}

// Spatial grid for fast proximity lookups.
// Divides the map into ~1° cells and only checks neighbors instead of all accounts.
let _custGrid = null;
let _custGridMiles = null;

function buildCustGrid() {
  if (_custGrid && _custGridMiles === PROXIMITY_MILES) return _custGrid;
  const cellSize = Math.max(1, PROXIMITY_MILES / 50); // ~1° cells for 50mi radius
  const grid = {};
  CUSTOMER_DATA.forEach(c => {
    if (!c.lat || !c.lng) return;
    const gx = Math.floor(c.lng / cellSize);
    const gy = Math.floor(c.lat / cellSize);
    const key = gx + ':' + gy;
    if (!grid[key]) grid[key] = [];
    grid[key].push(c);
  });
  _custGrid = grid;
  _custGridMiles = PROXIMITY_MILES;
  return grid;
}

function isNearAnyCustomer(lat, lng, miles) {
  const grid = buildCustGrid();
  const cellSize = Math.max(1, miles / 50);
  const gx = Math.floor(lng / cellSize);
  const gy = Math.floor(lat / cellSize);
  // Check surrounding cells (3x3 grid covers all possible neighbors)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const cell = grid[(gx + dx) + ':' + (gy + dy)];
      if (!cell) continue;
      for (let i = 0; i < cell.length; i++) {
        if (haversine(lat, lng, cell[i].lat, cell[i].lng) <= miles) return true;
      }
    }
  }
  return false;
}

function drawProximity() {
  proxLayer.clearLayers();
  if (!proximityOn) return;

  const milesToMeters = PROXIMITY_MILES * 1609.34;
  _custGrid = null; // Invalidate grid when radius changes

  CUSTOMER_DATA.forEach(c => {
    if (!c.lat || !c.lng) return;
    L.circle([c.lat, c.lng], {
      radius: milesToMeters,
      color: '#00b894',
      weight: 1,
      opacity: 0.25,
      fillColor: '#00b894',
      fillOpacity: 0.06,
      interactive: false,
    }).addTo(proxLayer);
  });

  // Count strategic accounts inside any customer radius — uses spatial grid
  let nearby = 0;
  STRATEGIC_DATA.forEach(s => {
    if (!s.lat || !s.lng) return;
    if (isNearAnyCustomer(s.lat, s.lng, PROXIMITY_MILES)) nearby++;
  });

  const nearbyEl = document.getElementById('proxNearbyCount');
  if (nearbyEl) nearbyEl.textContent = nearby + ' nearby';
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ============ NOTES SYSTEM ============
function getUserName() {
  let name = localStorage.getItem('edia_user_name');
  if (!name) {
    name = prompt('Enter your name (this tags your notes so teammates know who wrote them):');
    if (name && name.trim()) {
      name = name.trim();
      localStorage.setItem('edia_user_name', name);
    } else {
      name = 'Anonymous';
    }
  }
  return name;
}

function getAccountNotes(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); }
  catch(e) { return []; }
}

function addNote(key, el) {
  const text = el.value.trim();
  if (!text) return;
  const author = getUserName();
  const notes = getAccountNotes(key);
  notes.push({ author, text, ts: new Date().toISOString() });
  localStorage.setItem(key, JSON.stringify(notes));
  el.value = '';
  updateNoteCount();
  // Refresh the popup to show the new note
  const popup = el.closest('.leaflet-popup-content');
  if (popup) {
    const thread = popup.querySelector('.notes-thread');
    const label = popup.querySelector('.popup-section-label');
    if (thread) {
      thread.innerHTML += `<div class="note-entry"><div class="note-meta"><span class="note-author">${author}</span><span class="note-time">just now</span></div><div class="note-text">${text}</div></div>`;
    } else {
      // First note - insert thread before add-wrap
      const addWrap = popup.querySelector('.note-add-wrap');
      const threadDiv = document.createElement('div');
      threadDiv.className = 'notes-thread';
      threadDiv.innerHTML = `<div class="note-entry"><div class="note-meta"><span class="note-author">${author}</span><span class="note-time">just now</span></div><div class="note-text">${text}</div></div>`;
      addWrap.parentNode.insertBefore(threadDiv, addWrap);
    }
    // Update count in header
    if (label) label.innerHTML = label.innerHTML.replace(/Notes \(\d+\)/, 'Notes (' + notes.length + ')');
  }

  // Update last activity date to today (resets staleness clock)
  const districtName = key.replace('edia_notes_', '').replace(/_/g, ' ');
  const matchedAccount = STRATEGIC_DATA.find(d => d.name.replace(/[^a-zA-Z0-9]/g, '_') === key.replace('edia_notes_', ''));
  if (matchedAccount) {
    const today = new Date();
    const dateStr = (today.getMonth() + 1) + '/' + today.getDate() + '/' + today.getFullYear();
    matchedAccount.opp_last_activity = dateStr;
  }
}

function handleNoteKey(e, key, el) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    addNote(key, el);
  }
}

function formatNoteTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff/86400000) + 'd ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function copyAccountNotes(key, accountName) {
  const notes = getAccountNotes(key);
  if (!notes.length) return;
  const formatted = notes.map(n => `[${n.author} · ${new Date(n.ts).toLocaleDateString('en-US', {month:'short',day:'numeric'})}] ${n.text}`).join('\n');
  const text = accountName + '\n' + formatted;
  navigator.clipboard.writeText(text);
}

function updateNoteCount() {
  let count = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('edia_notes_')) {
      try {
        const notes = JSON.parse(localStorage.getItem(key));
        if (notes.length) count++;
      } catch(e) { /* ignored */ }
    }
  }
  const el = document.getElementById('notesCount');
  if (el) el.textContent = count ? count + ' account' + (count > 1 ? 's' : '') + ' with notes' : 'No notes yet';
}

function exportNotes() {
  const data = { _user: localStorage.getItem('edia_user_name') || 'Unknown' };
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('edia_notes_') || key === 'edia_user_name') {
      data[key] = localStorage.getItem(key);
    }
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'edia_notes_' + (data._user || 'export') + '_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
}

function importNotes(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const imported = JSON.parse(e.target.result);
      let merged = 0;
      Object.entries(imported).forEach(([key, val]) => {
        if (!key.startsWith('edia_notes_')) return;
        try {
          const incoming = JSON.parse(val);
          const existing = getAccountNotes(key);
          // Merge: add incoming notes that don't already exist (by ts+author)
          const existingKeys = new Set(existing.map(n => n.ts + n.author));
          incoming.forEach(n => {
            if (!existingKeys.has(n.ts + n.author)) { existing.push(n); merged++; }
          });
          existing.sort((a, b) => new Date(a.ts) - new Date(b.ts));
          localStorage.setItem(key, JSON.stringify(existing));
        } catch(e2) { /* ignored */ }
      });
      updateNoteCount();
      applyFilters();
      alert('Merged ' + merged + ' new note' + (merged !== 1 ? 's' : '') + '.');
    } catch(err) { alert('Invalid file format.'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function copyAllNotes() {
  let lines = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith('edia_notes_')) continue;
    try {
      const notes = JSON.parse(localStorage.getItem(key));
      if (!notes.length) continue;
      const name = key.replace('edia_notes_', '').replace(/_/g, ' ');
      lines.push(name.toUpperCase());
      notes.forEach(n => {
        lines.push(`  [${n.author} · ${new Date(n.ts).toLocaleDateString('en-US', {month:'short',day:'numeric'})}] ${n.text}`);
      });
      lines.push('');
    } catch(e) { /* ignored */ }
  }
  if (lines.length) {
    navigator.clipboard.writeText(lines.join('\n'));
    alert('Copied all notes to clipboard.');
  } else {
    alert('No notes to copy.');
  }
}


function copyText(text, el) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = el.innerHTML;
    el.classList.add('copied');
    el.setAttribute('data-tooltip', 'Copied!');
    setTimeout(() => { el.classList.remove('copied'); el.setAttribute('data-tooltip', 'Click to copy'); }, 1200);
  });
}

function buildStratPopup(d) {
  // Store data in global map for safe retrieval (avoids escaping issues in onclick)
  const districtKey = d.name.replace(/[^a-zA-Z0-9]/g, '_');
  window.districtDataCache = window.districtDataCache || {};
  window.districtDataCache[districtKey] = d;

  let html = `<div class="popup-card" style="position:relative;">`;
  html += `<button class="popup-expand-btn" onclick="openAccountModalByKey('${districtKey}')" title="Full screen view">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
  </button>`;
  const territoryAE = getTerritoryAE(d);
  const holdoutAE = getHoldoutAE(d);
  let typeLabel = d.is_customer ? 'Strategic Account + Customer' : 'Strategic Account';
  if (holdoutAE) typeLabel += ` · <span class="holdout-badge">Holdout — ${holdoutAE}</span>`;
  html += `<div class="popup-type ${d.is_customer ? 'both' : 'strat'}">${typeLabel}</div>`;
  html += `<h3 class="copyable" data-tooltip="Click to copy" onclick="copyText('${d.name.replace(/'/g, "\\\\'")}', this)">${d.name}</h3>`;

  // Build Account Exec display: show territory AE (Assigned) and holdout AE on second line
  let aeDisplay = null;
  if (territoryAE) {
    aeDisplay = holdoutAE
      ? `${territoryAE} <span class="ae-role">(Assigned)</span><br>${holdoutAE} <span class="ae-role">(Holdout)</span>`
      : territoryAE;
  }

  const rows = [
    ['State', d.state],
    ['Region', d.region],
    ['Enrollment', d.enrollment ? parseInt(d.enrollment).toLocaleString() : '—'],
    ['Account Exec', aeDisplay],
    ['SIS Platform', d.sis],
    ['SFDC Type', d.type || 'Prospect'],
  ];

  rows.forEach(([k, v]) => {
    if (v) html += `<div class="popup-row"><span class="pk">${k}</span><span class="pv">${v}</span></div>`;
  });

  // Leadership section
  const leaders = [
    ['Superintendent', d.superintendent],
    ['Asst Supt C&I', d.asst_supt_ci],
    ['Asst Supt Stu Svcs', d.asst_supt_ss],
    ['Asst Supt Tech', d.asst_supt_tech],
    ['Dir C&I', d.dir_ci],
    ['Dir Math', d.dir_math],
    ['Dir Attendance', d.dir_attendance],
  ].filter(([_, v]) => v);

  // Show customer ARR if this is also a customer
  if (d.is_customer) {
    const custMatch = CUSTOMER_DATA.find(c => c.name === d.customer_name);
    if (custMatch) {
      const custArr = parseFloat(custMatch.arr) || 0;
      const custGdr = custMatch.gdr ? parseFloat(custMatch.gdr) : null;
      const custNdr = custMatch.ndr ? parseFloat(custMatch.ndr) : null;
      html += `<div class="popup-section-label">💰 Active Customer Revenue</div>`;
      html += `<div class="popup-row"><span class="pk">Active ARR</span><span class="pv money">$${custArr.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</span></div>`;
      if (custGdr !== null) {
        html += `<div class="popup-row"><span class="pk">GDR</span><span class="pv">${custGdr.toFixed(1)}%</span></div>`;
      }
      if (custNdr !== null) {
        html += `<div class="popup-row"><span class="pk">NDR</span><span class="pv">${custNdr.toFixed(1)}%</span></div>`;
      }
      html += `<div class="popup-row"><span class="pk">CSM</span><span class="pv">${custMatch.csm || '—'}</span></div>`;
    }
  }

  if (leaders.length) {
    html += `<div class="popup-section-label">Leadership</div>`;
    leaders.forEach(([k, v]) => {
      html += `<div class="popup-row"><span class="pk">${k}</span><span class="pv copyable" data-tooltip="Click to copy" onclick="copyText('${v.replace(/'/g, "\\'")}', this)">${v}</span></div>`;
    });
  }

  // Products section
  const products = [
    ['Math Products', d.math_products],
    ['Attendance', d.attendance],
    ['ADA/ADM', d.ada_adm],
  ].filter(([_, v]) => v);

  if (products.length) {
    html += `<div class="popup-section-label">Intel</div>`;
    products.forEach(([k, v]) => {
      html += `<div class="popup-row"><span class="pk">${k}</span><span class="pv">${v}</span></div>`;
    });
  }

  // Opportunity section
  if (d.opp_stage) {
    const stageColors = {'1':'#fdcb6e','2':'#74b9ff','3':'#e17055','4':'#a29bfe','5':'#55efc4','6':'#fd79a8'};
    const stageNum = d.opp_stage.charAt(0);
    const sc = stageColors[stageNum] || '#ccc';
    html += `<div class="popup-section-label" style="display:flex;align-items:center;gap:8px;">Opportunity <span class="popup-opp-stage-pill" style="font-size:10px;background:${sc}22;padding:1px 7px;border-radius:8px;border:1px solid ${sc}44;">${d.opp_stage}</span></div>`;
    const oppRows = [
      ['Forecast', d.opp_forecast, false],
      ['Areas', d.opp_areas, false],
      ['Year 1 ACV', d.opp_acv ? '$' + Number(d.opp_acv).toLocaleString() : '', false],
      ['Probability', d.opp_probability ? d.opp_probability + '%' : '', false],
      ['Contact', d.opp_contact ? (d.opp_contact + (d.opp_contact_title ? ' (' + d.opp_contact_title + ')' : '')) : '', d.opp_contact],
      ['Next Step', d.opp_next_step, false],
      ['Last Activity', d.opp_last_activity, false],
      ['SDR', d.opp_sdr, false],
      ['Champion', d.opp_champion, d.opp_champion],
      ['Econ. Buyer', d.opp_economic_buyer, d.opp_economic_buyer],
      ['Competition', d.opp_competition, false],
    ].filter(([_, v]) => v);
    oppRows.forEach(([k, v, copyVal]) => {
      if (copyVal) {
        html += `<div class="popup-row"><span class="pk">${k}</span><span class="pv copyable" data-tooltip="Click to copy" onclick="copyText('${String(copyVal).replace(/'/g, "\\'")}', this)">${v}</span></div>`;
      } else {
        html += `<div class="popup-row"><span class="pk">${k}</span><span class="pv">${v}</span></div>`;
      }
    });
  }

  // Research links (including Meeting Prep)
  const prepLinkKey = 'edia_prep_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
  const savedPrepLink = localStorage.getItem(prepLinkKey) || d.prep_doc_url || '';

  const links = [];
  if (d.org_chart_url) links.push(`<a href="${d.org_chart_url}" target="_blank" style="color:#FFFF66;text-decoration:none;font-size:11px;margin-right:12px;">📋 Org Chart</a>`);
  if (d.strategic_plan_url) links.push(`<a href="${d.strategic_plan_url}" target="_blank" style="color:#FFFF66;text-decoration:none;font-size:11px;margin-right:12px;">📄 Strategic Plan</a>`);

  // Meeting Prep link - from localStorage or data
  if (savedPrepLink) {
    links.push(`<a href="${savedPrepLink}" target="_blank" class="popup-link prep" style="text-decoration:none;font-size:11px;" id="prepLink_${prepLinkKey}">📝 Meeting Prep</a>`);
  }

  // Always show the links row (with add option if no prep link)
  html += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--panel-border);display:flex;flex-wrap:wrap;align-items:center;gap:4px;" id="linksRow_${prepLinkKey}">`;
  html += links.join('');

  // Add Meeting Prep input/add button
  if (!savedPrepLink) {
    html += `<span id="prepAddBtn_${prepLinkKey}" style="display:inline-flex;align-items:center;gap:4px;">
      <span class="popup-link prep" style="text-decoration:none;font-size:11px;cursor:pointer;opacity:0.7;" onclick="showPrepInput('${prepLinkKey}')">+ Add Meeting Prep</span>
    </span>
    <span id="prepInputWrap_${prepLinkKey}" style="display:none;align-items:center;gap:4px;">
      <input type="text" id="prepInput_${prepLinkKey}" placeholder="Paste link..."
        style="padding:4px 8px;font-size:10px;background:var(--bg);border:1px solid var(--panel-border);border-radius:4px;color:var(--text);width:140px;outline:none;"
        onkeydown="if(event.key==='Enter')savePrepLinkInline('${prepLinkKey}','${d.name.replace(/'/g, "\\'")}')">
      <button onclick="savePrepLinkInline('${prepLinkKey}','${d.name.replace(/'/g, "\\'")}')"
        style="padding:4px 8px;font-size:10px;background:var(--accent-cust);border:none;border-radius:4px;color:#fff;cursor:pointer;">Save</button>
      <button onclick="hidePrepInput('${prepLinkKey}')"
        style="padding:4px 6px;font-size:10px;background:transparent;border:1px solid var(--panel-border);border-radius:4px;color:var(--text-muted);cursor:pointer;">×</button>
    </span>`;
  } else {
    html += `<span style="margin-left:8px;">
      <button onclick="showEditPrepInput('${prepLinkKey}', '${savedPrepLink.replace(/'/g, "\\'")}')"
        style="padding:2px 6px;font-size:9px;background:transparent;border:1px solid var(--panel-border);border-radius:3px;color:var(--text-muted);cursor:pointer;margin-right:4px;">Edit</button>
      <button onclick="removePrepLinkInline('${prepLinkKey}','${d.name.replace(/'/g, "\\'")}')"
        style="padding:2px 6px;font-size:9px;background:transparent;border:1px solid var(--panel-border);border-radius:3px;color:var(--text-muted);cursor:pointer;">×</button>
    </span>
    <span id="prepEditWrap_${prepLinkKey}" style="display:none;align-items:center;gap:4px;width:100%;margin-top:6px;">
      <input type="text" id="prepEditInput_${prepLinkKey}" placeholder="Paste link..."
        style="flex:1;padding:4px 8px;font-size:10px;background:var(--bg);border:1px solid var(--panel-border);border-radius:4px;color:var(--text);outline:none;">
      <button onclick="savePrepLinkInline('${prepLinkKey}','${d.name.replace(/'/g, "\\'")}')"
        style="padding:4px 8px;font-size:10px;background:var(--accent-cust);border:none;border-radius:4px;color:#fff;cursor:pointer;">Save</button>
      <button onclick="hideEditPrepInput('${prepLinkKey}')"
        style="padding:4px 6px;font-size:10px;background:transparent;border:1px solid var(--panel-border);border-radius:4px;color:var(--text-muted);cursor:pointer;">×</button>
    </span>`;
  }
  html += `</div>`;

  // Notes section
  const noteKey = 'edia_notes_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
  const notes = getAccountNotes(noteKey);
  html += `<div class="note-section">`;
  html += `<div class="popup-section-label" style="display:flex;justify-content:space-between;align-items:center;">Notes (${notes.length})<span class="note-actions"><button class="note-copy-btn" onclick="copyAccountNotes('${noteKey}', '${d.name.replace(/'/g, "\\'")}')">📋 Copy All</button></span></div>`;
  if (notes.length) {
    html += `<div class="notes-thread">`;
    notes.forEach((n, i) => {
      html += `<div class="note-entry"><div class="note-meta"><span class="note-author">${n.author}</span><span class="note-time">${formatNoteTime(n.ts)}</span></div><div class="note-text">${n.text}</div></div>`;
    });
    html += `</div>`;
  }
  html += `<div class="note-add-wrap"><textarea class="note-input" id="noteInput_${noteKey}" placeholder="Add a note..." onkeydown="handleNoteKey(event, '${noteKey}', this)"></textarea><button class="note-add-btn" onclick="addNote('${noteKey}', document.getElementById('noteInput_${noteKey}'))">Add</button></div>`;
  html += `</div>`;

  // Meeting Prep Button
  html += `<button class="meeting-prep-btn" onclick="generateMeetingPrepByKey('${districtKey}')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
    </svg>
    Generate Meeting Prep
  </button>`;

  html += `</div>`;
  return html;
}

function buildCustPopup(d) {
  let html = `<div class="popup-card">`;
  if (d.also_strategic) {
    html += `<div class="popup-type both">Active Customer + Strategic</div>`;
  } else {
    html += `<div class="popup-type cust">Active Customer</div>`;
  }
  html += `<h3>${d.name}</h3>`;

  const arr = parseFloat(d.arr) || 0;
  const arr12 = parseFloat(d.arr_12mo_ago) || 0;
  const gdr = d.gdr ? parseFloat(d.gdr) : null;
  const ndr = d.ndr ? parseFloat(d.ndr) : null;

  const rows = [
    ['State', d.state],
    ['Region', d.region],
    ['Segment', d.segment],
    ['Students', d.students ? parseInt(d.students).toLocaleString() : '—'],
    ['Address', d.address],
  ];

  rows.forEach(([k, v]) => {
    if (v) html += `<div class="popup-row"><span class="pk">${k}</span><span class="pv">${v}</span></div>`;
  });

  html += `<div class="popup-section-label">Revenue</div>`;
  html += `<div class="popup-row"><span class="pk">Active ARR</span><span class="pv money">$${arr.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</span></div>`;
  html += `<div class="popup-row"><span class="pk">ARR 12mo Ago</span><span class="pv">$${arr12.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</span></div>`;

  if (gdr !== null) {
    html += `<div class="popup-row"><span class="pk">GDR</span><span class="pv">${gdr.toFixed(1)}%</span></div>`;
  }
  if (ndr !== null) {
    html += `<div class="popup-row"><span class="pk">NDR</span><span class="pv">${ndr.toFixed(1)}%</span></div>`;
  }

  html += `<div class="popup-section-label">Team</div>`;
  if (d.csm) html += `<div class="popup-row"><span class="pk">CSM</span><span class="pv">${d.csm}</span></div>`;
  if (d.ae) html += `<div class="popup-row"><span class="pk">Account Owner</span><span class="pv">${d.ae}</span></div>`;
  if (d.last_activity) html += `<div class="popup-row"><span class="pk">Last Activity</span><span class="pv">${d.last_activity}</span></div>`;

  html += `</div>`;
  return html;
}

// ============ ACCOUNT LIST ============
function toggleAccountListOverlay() {
  accountListOpen = !accountListOpen;
  const overlay = document.getElementById('alOverlay');
  const badge = document.getElementById('countBadge');
  if (overlay) overlay.classList.toggle('open', accountListOpen);
  if (badge) badge.classList.toggle('active', accountListOpen);
  // Close action dashboard if open
  if (accountListOpen && actionDashboardOpen) {
    actionDashboardOpen = false;
    const adOverlay = document.getElementById('adOverlay');
    const adTrigger = document.getElementById('adTrigger');
    if (adOverlay) adOverlay.classList.remove('open');
    if (adTrigger) adTrigger.classList.remove('active');
  }
  if (accountListOpen) renderAccountList();
}

function getStageInfo(d) {
  if (d.opp_stage) {
    if (d.opp_stage.startsWith('1')) return { cls: 'stage-discovery', label: 'Discovery', order: 1 };
    if (d.opp_stage.startsWith('2')) return { cls: 'stage-demo', label: 'Demo', order: 2 };
    if (d.opp_stage.startsWith('3')) return { cls: 'stage-scoping', label: 'Scoping', order: 3 };
    if (d.opp_stage.startsWith('4')) return { cls: 'stage-proposal', label: 'Proposal', order: 4 };
    if (d.opp_stage.startsWith('5')) return { cls: 'stage-validation', label: 'Validation', order: 5 };
    if (d.opp_stage.startsWith('6')) return { cls: 'stage-procurement', label: 'Procurement', order: 6 };
    return { cls: 'stage-none', label: 'Opp', order: 0 };
  }
  return { cls: 'stage-none', label: 'No Opp', order: 0 };
}

function getAccountListDefaultSort() {
  if (currentView === 'customers') return 'arr_desc';
  return 'enrollment_desc';
}

function setAccountListSort(sortKey) {
  // If clicking the same base sort, toggle direction
  const baseKey = sortKey.replace(/_(?:asc|desc)$/, '');
  const currentBase = accountListSort.replace(/_(?:asc|desc)$/, '');
  if (baseKey === currentBase) {
    // Flip direction
    if (accountListSort.endsWith('_desc')) accountListSort = baseKey + '_asc';
    else accountListSort = baseKey + '_desc';
  } else {
    accountListSort = sortKey;
  }
  renderAccountList();
}

function toggleAccountListGroup(groupBy) {
  if (accountListGroupBy === groupBy) accountListGroupBy = null;
  else accountListGroupBy = groupBy;
  collapsedGroups = {};
  renderAccountList();
}

function toggleGroupCollapse(groupKey) {
  collapsedGroups[groupKey] = !collapsedGroups[groupKey];
  const items = document.getElementById('alg-items-' + groupKey.replace(/[^a-zA-Z0-9]/g, '_'));
  const header = document.getElementById('alg-header-' + groupKey.replace(/[^a-zA-Z0-9]/g, '_'));
  if (items) items.classList.toggle('collapsed-group');
  if (header) header.classList.toggle('collapsed');
}

function sortAccountListData(items) {
  const sort = accountListSort;
  return items.slice().sort((a, b) => {
    switch (sort) {
      case 'name_asc': return (a.name || '').localeCompare(b.name || '');
      case 'name_desc': return (b.name || '').localeCompare(a.name || '');
      case 'enrollment_desc': return (parseInt(b.enrollment || b.students || 0)) - (parseInt(a.enrollment || a.students || 0));
      case 'enrollment_asc': return (parseInt(a.enrollment || a.students || 0)) - (parseInt(b.enrollment || b.students || 0));
      case 'acv_desc': return (Number(b.opp_acv || 0)) - (Number(a.opp_acv || 0));
      case 'acv_asc': return (Number(a.opp_acv || 0)) - (Number(b.opp_acv || 0));
      case 'arr_desc': return (parseFloat(b.arr || 0)) - (parseFloat(a.arr || 0));
      case 'arr_asc': return (parseFloat(a.arr || 0)) - (parseFloat(b.arr || 0));
      case 'stage_asc': return getStageInfo(a).order - getStageInfo(b).order;
      case 'stage_desc': return getStageInfo(b).order - getStageInfo(a).order;
      case 'state_asc': return (a.state || '').localeCompare(b.state || '');
      case 'state_desc': return (b.state || '').localeCompare(a.state || '');
      case 'products_asc': return (a.opp_areas || '').localeCompare(b.opp_areas || '');
      case 'products_desc': return (b.opp_areas || '').localeCompare(a.opp_areas || '');
      case 'last_activity_desc': {
        const da = parseActivityDate(a.opp_last_activity || a.last_activity);
        const db = parseActivityDate(b.opp_last_activity || b.last_activity);
        return db - da;
      }
      case 'last_activity_asc': {
        const da = parseActivityDate(a.opp_last_activity || a.last_activity);
        const db = parseActivityDate(b.opp_last_activity || b.last_activity);
        return da - db;
      }
      default: return 0;
    }
  });
}

function parseActivityDate(str) {
  if (!str) return 0;
  const d = new Date(str);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function formatCompactNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return String(n);
}

function buildAccountListRow(d, type) {
  const isStrat = type === 'strategic';
  const stage = isStrat ? getStageInfo(d) : { cls: 'stage-customer', label: 'Customer', order: 99 };
  const enrollment = parseInt(isStrat ? d.enrollment : d.students) || 0;
  const acv = isStrat ? (Number(d.opp_acv) || 0) : 0;
  const arr = !isStrat ? (parseFloat(d.arr) || 0) : 0;
  const districtKey = d.name.replace(/[^a-zA-Z0-9]/g, '_');

  // Money column: ACV for strategic, ARR for customers
  const moneyText = (isStrat && acv > 0) ? '$' + formatCompactNumber(acv)
    : (!isStrat && arr > 0) ? '$' + formatCompactNumber(arr) : '';

  // Products column (opp_areas for strategic)
  const products = isStrat ? (d.opp_areas || '') : '';

  return `<div class="account-list-item" data-name="${d.name.replace(/"/g, '&quot;')}" data-key="${districtKey}"
    onmouseenter="highlightAccountMarker('${d.name.replace(/'/g, "\\'")}')"
    onmouseleave="unhighlightAccountMarker('${d.name.replace(/'/g, "\\'")}')"
    onclick="flyToAccount('${d.name.replace(/'/g, "\\'")}')"
    ondblclick="openAccountFromList('${districtKey}')">
    <span class="al-stage-dot ${stage.cls}" title="${stage.label}"></span>
    <span class="al-name" title="${d.name}">${d.name}</span>
    <span class="al-col al-col-state">${d.state || ''}</span>
    <span class="al-col al-col-enroll">${enrollment > 0 ? formatCompactNumber(enrollment) : ''}</span>
    <span class="al-col al-col-acv">${moneyText}</span>
    <span class="al-col al-col-products" title="${products}">${products}</span>
    <button class="al-expand-btn" onclick="event.stopPropagation();openAccountFromList('${districtKey}')" title="Open full view">&#x2197;</button>
  </div>`;
}

function highlightAccountMarker(name) {
  const entry = markerLookup[name];
  if (!entry || !entry.marker) return;
  const el = entry.marker.getElement();
  if (el) el.classList.add('marker-highlight');
}

function unhighlightAccountMarker(name) {
  const entry = markerLookup[name];
  if (!entry || !entry.marker) return;
  const el = entry.marker.getElement();
  if (el) el.classList.remove('marker-highlight');
}

function flyToAccount(name) {
  const entry = markerLookup[name];
  if (!entry || !entry.marker) return;
  const latLng = entry.marker.getLatLng();
  // Offset center north so the pin sits near the bottom and the popup is centered on screen
  const targetZoom = 7;
  const offsetLat = latLng.lat + 2.5;
  map.flyTo([offsetLat, latLng.lng], targetZoom, { duration: 0.6 });
  setTimeout(() => {
    entry.marker.openPopup();
  }, 650);
}

function openAccountFromList(districtKey) {
  let d = window.districtDataCache && window.districtDataCache[districtKey];
  if (!d) {
    // Fallback: search by key
    const name = Object.keys(markerLookup).find(n => n.replace(/[^a-zA-Z0-9]/g, '_') === districtKey);
    if (name && markerLookup[name]) d = markerLookup[name].data;
  }
  if (d) {
    openAccountModalWithData(d);
  }
}

function renderAccountList() {
  const body = document.getElementById('accountListBody');
  const countEl = document.getElementById('accountListCount');
  const sortBar = document.getElementById('accountListSortBar');
  // Count badge is updated by updateCountBadge, no separate trigger

  // Build unified list of items to show
  let items = [];
  const showStrat = currentView === 'strategic' || currentView === 'all';
  const showCust = currentView === 'customers' || currentView === 'all';

  if (showStrat) {
    filteredStratData.forEach(d => {
      if (d.lat && d.lng) items.push({ data: d, type: 'strategic' });
    });
  }
  if (showCust) {
    filteredCustData.forEach(d => {
      if (d.lat && d.lng) {
        // Avoid duplicates if already in strategic
        if (!showStrat || !markerLookup[d.name] || markerLookup[d.name].type !== 'strategic') {
          items.push({ data: d, type: 'customer' });
        }
      }
    });
  }

  // Total counts
  const totalCount = (showStrat ? STRATEGIC_DATA.length : 0) + (showCust ? CUSTOMER_DATA.length : 0);
  if (countEl) countEl.textContent = `Showing ${items.length} of ${totalCount} accounts`;

  // Only render full list if overlay is open
  if (!accountListOpen) return;

  // Render column header row (clickable to sort)
  const isCust = currentView === 'customers';
  function colSortArrow(colKey) {
    const baseKey = colKey.replace(/_(?:asc|desc)$/, '');
    const currentBase = accountListSort.replace(/_(?:asc|desc)$/, '');
    if (baseKey !== currentBase) return '';
    return accountListSort.endsWith('_desc') ? ' ↓' : ' ↑';
  }
  const moneyLabel = isCust ? 'ARR' : 'ACV';
  const moneyKey = isCust ? 'arr_desc' : 'acv_desc';
  let sortHtml = `<div class="al-header-row">`;
  sortHtml += `<span class="al-hdr-dot-spacer"></span>`;
  sortHtml += `<span class="al-hdr al-hdr-name" onclick="setAccountListSort('name_asc')">Name${colSortArrow('name_asc')}</span>`;
  sortHtml += `<span class="al-hdr al-hdr-state" onclick="setAccountListSort('state_asc')">State${colSortArrow('state_asc')}</span>`;
  sortHtml += `<span class="al-hdr al-hdr-enroll" onclick="setAccountListSort('enrollment_desc')">Students${colSortArrow('enrollment_desc')}</span>`;
  sortHtml += `<span class="al-hdr al-hdr-acv" onclick="setAccountListSort('${moneyKey}')">${moneyLabel}${colSortArrow(moneyKey)}</span>`;
  sortHtml += `<span class="al-hdr al-hdr-products" onclick="setAccountListSort('products_asc')">Products${colSortArrow('products_asc')}</span>`;
  sortHtml += `<span class="al-hdr-btn-spacer"></span>`;
  sortHtml += `</div>`;

  // Group buttons row
  sortHtml += `<div class="al-group-bar">`;
  sortHtml += `<span class="al-group-label">Group</span>`;
  sortHtml += `<button class="account-list-group-btn ${accountListGroupBy === 'state' ? 'active' : ''}" onclick="toggleAccountListGroup('state')">State</button>`;
  if (showStrat && currentView !== 'customers') {
    sortHtml += `<button class="account-list-group-btn ${accountListGroupBy === 'stage' ? 'active' : ''}" onclick="toggleAccountListGroup('stage')">Stage</button>`;
  }
  sortHtml += `</div>`;

  sortBar.innerHTML = sortHtml;

  // Sort items
  const sortedData = sortAccountListData(items.map(i => i.data));
  const itemTypeMap = {};
  items.forEach(i => { itemTypeMap[i.data.name] = i.type; });

  // Render body
  if (sortedData.length === 0) {
    body.innerHTML = '<div class="account-list-empty">No accounts match current filters</div>';
    return;
  }

  // Cap DOM rows to prevent browser slowdown with thousands of accounts.
  // Shows a "Show more" button to load additional batches.
  const ACCOUNT_LIST_PAGE_SIZE = 200;
  const displayLimit = accountListDisplayLimit || ACCOUNT_LIST_PAGE_SIZE;

  if (accountListGroupBy) {
    body.innerHTML = renderGroupedList(sortedData, itemTypeMap);
  } else {
    let html = '';
    const visible = sortedData.slice(0, displayLimit);
    visible.forEach(d => {
      html += buildAccountListRow(d, itemTypeMap[d.name] || 'strategic');
    });
    if (sortedData.length > displayLimit) {
      html += `<div class="account-list-show-more" onclick="showMoreAccounts()">Show more (${sortedData.length - displayLimit} remaining)</div>`;
    }
    body.innerHTML = html;
  }
}

function showMoreAccounts() {
  accountListDisplayLimit += 200;
  renderAccountList();
}

function renderGroupedList(sortedData, itemTypeMap) {
  const groups = {};
  const groupOrder = [];

  sortedData.forEach(d => {
    let groupKey;
    if (accountListGroupBy === 'state') {
      groupKey = d.state || 'Unknown';
    } else if (accountListGroupBy === 'stage') {
      const type = itemTypeMap[d.name];
      if (type === 'customer') {
        groupKey = 'Customer';
      } else {
        groupKey = getStageInfo(d).label;
      }
    } else {
      groupKey = 'All';
    }

    if (!groups[groupKey]) {
      groups[groupKey] = [];
      groupOrder.push(groupKey);
    }
    groups[groupKey].push(d);
  });

  let html = '';
  groupOrder.forEach(key => {
    const items = groups[key];
    const safeKey = key.replace(/[^a-zA-Z0-9]/g, '_');
    const isCollapsed = collapsedGroups[key];

    html += `<div class="account-list-group-header ${isCollapsed ? 'collapsed' : ''}" id="alg-header-${safeKey}" onclick="toggleGroupCollapse('${key.replace(/'/g, "\\'")}')">
      <span class="account-list-group-chevron">&#9660;</span>
      <span class="account-list-group-name">${key}</span>
      <span class="account-list-group-count">(${items.length})</span>
    </div>`;
    html += `<div class="account-list-group-items ${isCollapsed ? 'collapsed-group' : ''}" id="alg-items-${safeKey}">`;
    items.forEach(d => {
      html += buildAccountListRow(d, itemTypeMap[d.name] || 'strategic');
    });
    html += `</div>`;
  });

  return html;
}

// ============ UI HELPERS ============
function updateCountBadge(strat, cust) {
  const badge = document.getElementById('countBadge');
  if (currentView === 'strategic') {
    badge.innerHTML = `<span class="cb-num cb-strat">${strat}</span> accounts`;
  } else if (currentView === 'customers') {
    badge.innerHTML = `<span class="cb-num cb-cust">${cust}</span> customers`;
  } else {
    badge.innerHTML = `<span class="cb-num cb-strat">${strat}</span> strategic · <span class="cb-num cb-cust">${cust}</span> customers`;
  }
}

function updateLegend() {
  const legend = document.getElementById('legend');
  let items = '';
  items += `<div class="legend-item"><div class="legend-dot strat"></div>No Opp</div>`;
  items += `<div class="legend-item"><div class="legend-dot" style="background:#fdcb6e;"></div>Discovery</div>`;
  items += `<div class="legend-item"><div class="legend-dot" style="background:#74b9ff;"></div>Demo</div>`;
  items += `<div class="legend-item"><div class="legend-dot" style="background:#e17055;"></div>Scoping</div>`;
  items += `<div class="legend-item"><div class="legend-dot" style="background:#a29bfe;"></div>Proposal</div>`;
  items += `<div class="legend-item"><div class="legend-dot" style="background:#55efc4;"></div>Validation</div>`;
  items += `<div class="legend-item"><div class="legend-dot" style="background:#fd79a8;"></div>Procurement</div>`;
  items += `<div class="legend-item"><div class="legend-dot cust"></div>Customer</div>`;
  legend.innerHTML = items;
  legend.style.display = 'flex';
}

// ============ FULL-SCREEN ACCOUNT MODAL ============
let currentModalData = null;

function openAccountModalByKey(districtKey) {
  const d = window.districtDataCache && window.districtDataCache[districtKey];
  if (d) {
    openAccountModalWithData(d);
  } else {
    console.error('District data not found for key:', districtKey);
  }
}

function openAccountModal(encodedData) {
  try {
    const d = JSON.parse(decodeURIComponent(encodedData));
    openAccountModalWithData(d);
  } catch (e) {
    console.error('Error opening modal:', e);
  }
}

function openAccountModalWithData(d) {
  currentModalData = d;

  // Set header info
  document.getElementById('modalAccountName').textContent = d.name;
  document.getElementById('modalAccountSubtitle').textContent =
    `${d.state || ''} • ${d.region || ''} • ${d.enrollment ? parseInt(d.enrollment).toLocaleString() + ' students' : ''}`;

  // Set badge
  const badge = document.getElementById('modalAccountBadge');
  const holdoutAE = getHoldoutAE(d);
  if (d.is_customer) {
    badge.textContent = 'Strategic + Customer';
    badge.className = 'account-modal-badge both';
  } else {
    badge.textContent = 'Strategic Account';
    badge.className = 'account-modal-badge strategic';
  }
  // Show holdout indicator in modal header
  let holdoutEl = document.getElementById('modalHoldoutBadge');
  if (!holdoutEl) {
    holdoutEl = document.createElement('span');
    holdoutEl.id = 'modalHoldoutBadge';
    holdoutEl.className = 'holdout-badge modal-holdout';
    badge.parentNode.insertBefore(holdoutEl, badge.nextSibling);
  }
  if (holdoutAE) {
    holdoutEl.textContent = `Holdout — ${holdoutAE}`;
    holdoutEl.style.display = '';
  } else {
    holdoutEl.style.display = 'none';
  }

  // Populate tabs
  populateInfoTab(d);
  populateMathTab(d);
  populateAttendanceTab(d);

  // Reset to Info tab
  switchTab('info', document.querySelector('.account-tab'));

  // Show modal
  document.getElementById('accountModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeAccountModal() {
  document.getElementById('accountModal').classList.remove('show');
  document.body.style.overflow = '';
  currentModalData = null;
}

function switchTab(tabId, btnEl) {
  // Update tab buttons
  document.querySelectorAll('.account-tab').forEach(t => t.classList.remove('active', 'active-cust'));
  btnEl.classList.add('active');

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab' + tabId.charAt(0).toUpperCase() + tabId.slice(1)).classList.add('active');
}

function populateInfoTab(d) {
  const noteKey = 'edia_notes_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
  const notes = getAccountNotes(noteKey);
  const prepLinkKey = 'edia_prep_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
  const savedPrepLink = localStorage.getItem(prepLinkKey) || d.prep_doc_url || '';

  let html = '';
  html += `<div class="modal-grid">`;

  // Basic Info Section
  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">🏫</span> District Overview</div>
    ${modalRow('Enrollment', d.enrollment ? parseInt(d.enrollment).toLocaleString() : '—')}
    ${modalRow('State', d.state)}
    ${modalRow('Region', d.region)}
    ${modalRow('Account Executive', (() => { const tAE = getTerritoryAE(d); const hAE = getHoldoutAE(d); return tAE ? (hAE ? tAE + ' <span class="ae-role">(Assigned)</span><br>' + hAE + ' <span class="ae-role">(Holdout)</span>' : tAE) : '—'; })())}
    ${modalRow('ADA/ADM', d.ada_adm || '—')}
  </div>`;

  // Leadership Section
  const leaders = [
    ['Superintendent', d.superintendent],
    ['Asst Supt C&I', d.asst_supt_ci],
    ['Asst Supt Student Svcs', d.asst_supt_ss],
    ['Asst Supt Technology', d.asst_supt_tech],
    ['Director C&I', d.dir_ci],
  ].filter(([_, v]) => v);

  if (leaders.length) {
    html += `<div class="modal-section">
      <div class="modal-section-title"><span class="icon">👥</span> Leadership</div>`;
    leaders.forEach(([title, name]) => {
      html += `<div class="contact-card"><div class="name">${name}</div><div class="title">${title}</div></div>`;
    });
    html += `</div>`;
  }

  // Opportunity Section
  if (d.opp_stage) {
    let stageClass = 'discovery';
    if (d.opp_stage.includes('Demo')) stageClass = 'demo';
    else if (d.opp_stage.includes('Scoping')) stageClass = 'scoping';
    else if (d.opp_stage.includes('Proposal')) stageClass = 'proposal';
    else if (d.opp_stage.includes('Validation')) stageClass = 'validation';
    else if (d.opp_stage.includes('Procurement')) stageClass = 'procurement';

    html += `<div class="modal-section opp-card">
      <div class="modal-section-title"><span class="icon">💼</span> Opportunity</div>
      <span class="opp-stage-badge ${stageClass}">${d.opp_stage}</span>
      ${modalRow('Forecast', d.opp_forecast || '—')}
      ${modalRow('Areas', d.opp_areas || '—')}
      ${modalRow('Probability', d.opp_probability ? d.opp_probability + '%' : '—')}
      ${modalRow('Contact', d.opp_contact ? d.opp_contact + (d.opp_contact_title ? ' (' + d.opp_contact_title + ')' : '') : '—')}
      ${modalRow('Next Step', d.opp_next_step || '—')}
      ${modalRow('Last Activity', d.opp_last_activity || '—')}
      ${modalRow('SDR', d.opp_sdr || '—')}
    </div>`;
  }

  // Resources Section
  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">🔗</span> Resources</div>`;
  if (d.org_chart_url) {
    html += modalRow('Org Chart', `<a href="${d.org_chart_url}" target="_blank">View →</a>`);
  }
  if (d.strategic_plan_url) {
    html += modalRow('Strategic Plan', `<a href="${d.strategic_plan_url}" target="_blank">View →</a>`);
  }
  if (savedPrepLink) {
    html += modalRow('Meeting Prep', `<a href="${savedPrepLink}" target="_blank">View →</a>`);
  }
  if (!d.org_chart_url && !d.strategic_plan_url && !savedPrepLink) {
    html += `<div style="color:var(--text-muted);font-size:12px;">No resources linked</div>`;
  }
  html += `</div>`;

  // Notes Section
  html += `<div class="modal-section" style="grid-column: 1 / -1;">
    <div class="modal-section-title"><span class="icon">📝</span> Notes (${notes.length})</div>`;
  if (notes.length) {
    html += `<div class="modal-notes-thread">`;
    notes.forEach(n => {
      html += `<div class="modal-note-entry">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:11px;font-weight:600;color:#FFFF66;">${n.author}</span>
          <span style="font-size:10px;color:var(--text-muted);">${formatNoteTime(n.ts)}</span>
        </div>
        <div style="font-size:12px;line-height:1.5;color:var(--text);">${n.text}</div>
      </div>`;
    });
    html += `</div>`;
  } else {
    html += `<div style="color:var(--text-muted);font-size:12px;">No notes yet</div>`;
  }
  html += `</div>`;

  html += `</div>`; // Close grid
  document.getElementById('tabInfo').innerHTML = html;
}

function populateMathTab(d) {
  let html = `<div class="modal-grid">`;

  // Math Overview
  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">📐</span> Math Overview</div>`;

  if (d.math_products) {
    html += `<div class="product-highlight math">
      <div class="label">Current Math Products</div>
      <div class="value">${d.math_products}</div>
    </div>`;
  } else {
    html += `<div style="color:var(--text-muted);font-size:12px;margin-bottom:12px;">No math products recorded</div>`;
  }

  // Math-related opportunity info
  if (d.opp_areas && d.opp_areas.toLowerCase().includes('math')) {
    html += `<div class="product-highlight math" style="border-color:#55efc4;">
      <div class="label">Active Math Opportunity</div>
      <div class="value">${d.opp_stage || 'In Progress'}</div>
    </div>`;
  }
  html += `</div>`;

  // Math Contacts
  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">👤</span> Math Contacts</div>`;

  const mathContacts = [
    ['Dir Math', d.dir_math],
    ['Dir C&I', d.dir_ci],
    ['Asst Supt C&I', d.asst_supt_ci],
  ].filter(([_, v]) => v);

  if (mathContacts.length) {
    mathContacts.forEach(([title, name]) => {
      html += `<div class="contact-card"><div class="name">${name}</div><div class="title">${title}</div></div>`;
    });
  } else {
    html += `<div style="color:var(--text-muted);font-size:12px;">No math-specific contacts recorded</div>`;
  }

  // Opp contact if math-related
  if (d.opp_contact && d.opp_areas && d.opp_areas.toLowerCase().includes('math')) {
    html += `<div class="contact-card" style="border-left:3px solid #55efc4;">
      <div class="name">${d.opp_contact}</div>
      <div class="title">${d.opp_contact_title || 'Opportunity Contact'}</div>
    </div>`;
  }
  html += `</div>`;

  // Competition/Intel - only show if this is a Math opp
  const isMathOpp = d.opp_areas && d.opp_areas.toLowerCase().includes('math');
  if (isMathOpp && (d.opp_competition || d.opp_economic_buyer || d.opp_champion)) {
    html += `<div class="modal-section">
      <div class="modal-section-title"><span class="icon">🎯</span> Math Opp Intel</div>
      ${d.opp_stage ? modalRow('Stage', d.opp_stage) : ''}
      ${d.opp_acv ? modalRow('Year 1 ACV', '$' + Number(d.opp_acv).toLocaleString()) : ''}
      ${modalRow('Competition', d.opp_competition || '—')}
      ${modalRow('Economic Buyer', d.opp_economic_buyer || '—')}
      ${modalRow('Champion', d.opp_champion || '—')}
      ${d.opp_next_step ? modalRow('Next Step', d.opp_next_step) : ''}
    </div>`;
  }

  html += `</div>`;
  document.getElementById('tabMath').innerHTML = html;
}

function populateAttendanceTab(d) {
  let html = `<div class="modal-grid">`;

  // Attendance/SIS Overview
  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">📅</span> Attendance & SIS</div>`;

  if (d.sis) {
    html += `<div class="product-highlight attendance">
      <div class="label">SIS Platform</div>
      <div class="value">${d.sis}</div>
    </div>`;
  }

  if (d.attendance) {
    html += `<div class="product-highlight attendance">
      <div class="label">Attendance System</div>
      <div class="value">${d.attendance}</div>
    </div>`;
  }

  if (!d.sis && !d.attendance) {
    html += `<div style="color:var(--text-muted);font-size:12px;">No attendance/SIS info recorded</div>`;
  }

  // Attendance opportunity info
  if (d.opp_areas && d.opp_areas.toLowerCase().includes('attendance')) {
    html += `<div class="product-highlight attendance" style="border-color:#55efc4;margin-top:12px;">
      <div class="label">Active Attendance Opportunity</div>
      <div class="value">${d.opp_stage || 'In Progress'}</div>
    </div>`;
  }
  html += `</div>`;

  // Attendance Contacts
  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">👤</span> Attendance Contacts</div>`;

  const attendanceContacts = [
    ['Dir Attendance', d.dir_attendance],
    ['Asst Supt Student Svcs', d.asst_supt_ss],
    ['Asst Supt Technology', d.asst_supt_tech],
  ].filter(([_, v]) => v);

  if (attendanceContacts.length) {
    attendanceContacts.forEach(([title, name]) => {
      html += `<div class="contact-card"><div class="name">${name}</div><div class="title">${title}</div></div>`;
    });
  } else {
    html += `<div style="color:var(--text-muted);font-size:12px;">No attendance-specific contacts recorded</div>`;
  }

  // Opp contact if attendance-related
  if (d.opp_contact && d.opp_areas && d.opp_areas.toLowerCase().includes('attendance')) {
    html += `<div class="contact-card" style="border-left:3px solid #55efc4;">
      <div class="name">${d.opp_contact}</div>
      <div class="title">${d.opp_contact_title || 'Opportunity Contact'}</div>
    </div>`;
  }
  html += `</div>`;

  // Attendance Opp Intel - only show if this is an Attendance opp
  const isAttendanceOpp = d.opp_areas && d.opp_areas.toLowerCase().includes('attendance');
  if (isAttendanceOpp && (d.opp_competition || d.opp_economic_buyer || d.opp_champion || d.opp_stage)) {
    html += `<div class="modal-section">
      <div class="modal-section-title"><span class="icon">🎯</span> Attendance Opp Intel</div>
      ${d.opp_stage ? modalRow('Stage', d.opp_stage) : ''}
      ${d.opp_acv ? modalRow('Year 1 ACV', '$' + Number(d.opp_acv).toLocaleString()) : ''}
      ${modalRow('Competition', d.opp_competition || '—')}
      ${modalRow('Economic Buyer', d.opp_economic_buyer || '—')}
      ${modalRow('Champion', d.opp_champion || '—')}
      ${d.opp_next_step ? modalRow('Next Step', d.opp_next_step) : ''}
    </div>`;
  }

  // Additional Info
  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">📊</span> Additional Info</div>
    ${modalRow('ADA/ADM', d.ada_adm || '—')}
    ${modalRow('Enrollment', d.enrollment ? parseInt(d.enrollment).toLocaleString() : '—')}
  </div>`;

  html += `</div>`;
  document.getElementById('tabAttendance').innerHTML = html;
}

function modalRow(label, value) {
  return `<div class="modal-row"><span class="label">${label}</span><span class="value">${value}</span></div>`;
}

// Close modal on escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAccountModal();
    closeMergeModal();
  }
});

// Close modal on backdrop click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('account-modal')) {
    closeAccountModal();
  }
});

// ============ PREP LINK MANAGEMENT ============
function showPrepInput(key) {
  const addBtn = document.getElementById('prepAddBtn_' + key);
  const inputWrap = document.getElementById('prepInputWrap_' + key);
  if (addBtn) addBtn.style.display = 'none';
  if (inputWrap) {
    inputWrap.style.display = 'inline-flex';
    const input = document.getElementById('prepInput_' + key);
    if (input) input.focus();
  }
}

function hidePrepInput(key) {
  const addBtn = document.getElementById('prepAddBtn_' + key);
  const inputWrap = document.getElementById('prepInputWrap_' + key);
  if (addBtn) addBtn.style.display = 'inline-flex';
  if (inputWrap) inputWrap.style.display = 'none';
}

function showEditPrepInput(key, currentUrl) {
  const editWrap = document.getElementById('prepEditWrap_' + key);
  if (editWrap) {
    editWrap.style.display = 'flex';
    const input = document.getElementById('prepEditInput_' + key);
    if (input) {
      input.value = currentUrl;
      input.focus();
      input.select();
    }
  }
}

function hideEditPrepInput(key) {
  const editWrap = document.getElementById('prepEditWrap_' + key);
  if (editWrap) editWrap.style.display = 'none';
}

function savePrepLinkInline(key, districtName) {
  // Check both possible input IDs
  let input = document.getElementById('prepInput_' + key);
  if (!input || !input.value.trim()) {
    input = document.getElementById('prepEditInput_' + key);
  }
  if (!input) return;

  const url = input.value.trim();
  if (!url) {
    input.style.borderColor = '#e17055';
    setTimeout(() => input.style.borderColor = '', 1500);
    return;
  }

  // Validate URL
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    input.style.borderColor = '#e17055';
    input.placeholder = 'Enter valid URL';
    setTimeout(() => {
      input.style.borderColor = '';
      input.placeholder = 'Paste link...';
    }, 2000);
    return;
  }

  // Save to localStorage
  localStorage.setItem(key, url);

  // Update the UI directly without refresh
  const linksRow = document.getElementById('linksRow_' + key);
  if (linksRow) {
    // Hide add button and input
    const addBtn = document.getElementById('prepAddBtn_' + key);
    const inputWrap = document.getElementById('prepInputWrap_' + key);
    const editWrap = document.getElementById('prepEditWrap_' + key);
    if (addBtn) addBtn.remove();
    if (inputWrap) inputWrap.remove();
    if (editWrap) editWrap.remove();

    // Remove old prep link if exists
    const oldLink = document.getElementById('prepLink_' + key);
    if (oldLink) oldLink.parentElement.remove();

    // Add the new Meeting Prep link inline
    const linkHtml = `<a href="${url}" target="_blank" style="color:#55efc4;text-decoration:none;font-size:11px;" id="prepLink_${key}">📝 Meeting Prep</a>`;
    const buttonsHtml = `<span style="margin-left:8px;" id="prepButtons_${key}">
      <button onclick="showEditPrepInput('${key}', '${url.replace(/'/g, "\\'")}')"
        style="padding:2px 6px;font-size:9px;background:transparent;border:1px solid var(--panel-border);border-radius:3px;color:var(--text-muted);cursor:pointer;margin-right:4px;">Edit</button>
      <button onclick="removePrepLinkInline('${key}','${districtName.replace(/'/g, "\\'")}')"
        style="padding:2px 6px;font-size:9px;background:transparent;border:1px solid var(--panel-border);border-radius:3px;color:var(--text-muted);cursor:pointer;">×</button>
    </span>
    <span id="prepEditWrap_${key}" style="display:none;align-items:center;gap:4px;width:100%;margin-top:6px;">
      <input type="text" id="prepEditInput_${key}" placeholder="Paste link..."
        style="flex:1;padding:4px 8px;font-size:10px;background:var(--bg);border:1px solid var(--panel-border);border-radius:4px;color:var(--text);outline:none;">
      <button onclick="savePrepLinkInline('${key}','${districtName.replace(/'/g, "\\'")}')"
        style="padding:4px 8px;font-size:10px;background:var(--accent-cust);border:none;border-radius:4px;color:#fff;cursor:pointer;">Save</button>
      <button onclick="hideEditPrepInput('${key}')"
        style="padding:4px 6px;font-size:10px;background:transparent;border:1px solid var(--panel-border);border-radius:4px;color:var(--text-muted);cursor:pointer;">×</button>
    </span>`;

    // Insert before any existing buttons or at end
    const strategicLink = linksRow.querySelector('a[href*="strategic"]') || linksRow.querySelector('a');
    if (strategicLink) {
      strategicLink.insertAdjacentHTML('afterend', ' ' + linkHtml + buttonsHtml);
    } else {
      linksRow.insertAdjacentHTML('afterbegin', linkHtml + buttonsHtml);
    }
  }
}

function removePrepLinkInline(key, districtName) {
  localStorage.removeItem(key);

  // Update the UI directly
  const linksRow = document.getElementById('linksRow_' + key);
  if (linksRow) {
    // Remove the link and buttons
    const link = document.getElementById('prepLink_' + key);
    const buttons = document.getElementById('prepButtons_' + key);
    const editWrap = document.getElementById('prepEditWrap_' + key);
    if (link) link.remove();
    if (buttons) buttons.remove();
    if (editWrap) editWrap.remove();

    // Add back the "+ Add Meeting Prep" option
    const addHtml = `<span id="prepAddBtn_${key}" style="display:inline-flex;align-items:center;gap:4px;">
      <span style="color:#55efc4;text-decoration:none;font-size:11px;cursor:pointer;opacity:0.7;" onclick="showPrepInput('${key}')">+ Add Meeting Prep</span>
    </span>
    <span id="prepInputWrap_${key}" style="display:none;align-items:center;gap:4px;">
      <input type="text" id="prepInput_${key}" placeholder="Paste link..."
        style="padding:4px 8px;font-size:10px;background:var(--bg);border:1px solid var(--panel-border);border-radius:4px;color:var(--text);width:140px;outline:none;"
        onkeydown="if(event.key==='Enter')savePrepLinkInline('${key}','${districtName.replace(/'/g, "\\'")}')">
      <button onclick="savePrepLinkInline('${key}','${districtName.replace(/'/g, "\\'")}')"
        style="padding:4px 8px;font-size:10px;background:var(--accent-cust);border:none;border-radius:4px;color:#fff;cursor:pointer;">Save</button>
      <button onclick="hidePrepInput('${key}')"
        style="padding:4px 6px;font-size:10px;background:transparent;border:1px solid var(--panel-border);border-radius:4px;color:var(--text-muted);cursor:pointer;">×</button>
    </span>`;

    linksRow.insertAdjacentHTML('beforeend', addHtml);
  }
}

function findMarkerByDistrict(districtName) {
  let foundMarker = null;
  stratLayer.eachLayer(layer => {
    if (layer._popup) {
      const content = layer._popup.getContent();
      if (content && content.includes(districtName)) {
        foundMarker = layer;
      }
    }
  });
  return foundMarker;
}

// ============ MEETING PREP ============
const CHATGPT_PROJECT_URL = 'https://claude.ai/project/019c77bb-e463-765f-9c3f-487877c0d2fb';

function generateMeetingPrepByKey(districtKey) {
  const d = window.districtDataCache && window.districtDataCache[districtKey];
  if (!d) {
    console.error('District data not found for key:', districtKey);
    alert('Error: account data not found. Please try again.');
    return;
  }
  generateMeetingPrep(encodeURIComponent(JSON.stringify(d)));
}

function generateMeetingPrep(encodedData) {
  try {
    const d = JSON.parse(decodeURIComponent(encodedData));
    const prompt = formatMeetingPrepPrompt(d);

    // Copy to clipboard
    navigator.clipboard.writeText(prompt).then(() => {
      showMeetingPrepToast();
      // Open ChatGPT project in new tab
      setTimeout(() => {
        window.open(CHATGPT_PROJECT_URL, '_blank');
      }, 500);
    }).catch(err => {
      // Fallback for clipboard failure
      console.error('Clipboard failed:', err);
      fallbackCopy(prompt);
      showMeetingPrepToast();
      setTimeout(() => {
        window.open(CHATGPT_PROJECT_URL, '_blank');
      }, 500);
    });
  } catch (e) {
    console.error('Meeting prep error:', e);
    alert('Error generating meeting prep. Please try again.');
  }
}

function formatMeetingPrepPrompt(d) {
  // Get notes for this account
  const noteKey = 'edia_notes_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
  let notes = [];
  try {
    notes = JSON.parse(localStorage.getItem(noteKey) || '[]');
  } catch(e) { /* ignored */ }

  // Check if also a customer and get that data
  let customerData = null;
  if (d.is_customer) {
    customerData = CUSTOMER_DATA.find(c => c.name === d.customer_name);
  }

  let prompt = `Please generate detailed meeting prep for the following district:\n\n`;
  prompt += `=== DISTRICT INFORMATION ===\n`;
  prompt += `Name: ${d.name}\n`;
  prompt += `State: ${d.state || 'Unknown'}\n`;
  prompt += `Region: ${d.region || 'Unknown'}\n`;
  prompt += `Enrollment: ${d.enrollment ? parseInt(d.enrollment).toLocaleString() : 'Unknown'}\n`;
  prompt += `Account Executive: ${getTerritoryAE(d) || 'Unassigned'}${getHoldoutAE(d) ? ' (Assigned), ' + getHoldoutAE(d) + ' (Holdout)' : ''}\n`;
  prompt += `SIS Platform: ${d.sis || 'Unknown'}\n`;

  if (d.type) prompt += `Account Type: ${d.type}\n`;
  if (d.ada_adm) prompt += `ADA/ADM: ${d.ada_adm}\n`;

  // Opportunity info
  if (d.opp_stage) {
    prompt += `\n=== OPPORTUNITY ===\n`;
    prompt += `Stage: ${d.opp_stage}\n`;
    if (d.opp_amount) prompt += `Amount: $${parseFloat(d.opp_amount).toLocaleString()}\n`;
    if (d.opp_close_date) prompt += `Expected Close: ${d.opp_close_date}\n`;
  }

  // Leadership
  const leaders = [
    ['Superintendent', d.superintendent],
    ['Asst Supt C&I', d.asst_supt_ci],
    ['Asst Supt Student Services', d.asst_supt_ss],
    ['Asst Supt Technology', d.asst_supt_tech],
    ['Director C&I', d.dir_ci],
    ['Director Math', d.dir_math],
    ['Director Attendance', d.dir_attendance],
  ].filter(([_, v]) => v);

  if (leaders.length) {
    prompt += `\n=== LEADERSHIP ===\n`;
    leaders.forEach(([title, name]) => {
      prompt += `${title}: ${name}\n`;
    });
  }

  // Products/Curriculum
  const products = [
    ['Math Products', d.math_products],
    ['Attendance System', d.attendance],
  ].filter(([_, v]) => v);

  if (products.length) {
    prompt += `\n=== CURRENT PRODUCTS ===\n`;
    products.forEach(([type, product]) => {
      prompt += `${type}: ${product}\n`;
    });
  }

  // Links & Resources
  const prepLinkKey = 'edia_prep_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
  const savedPrepLink = localStorage.getItem(prepLinkKey) || d.prep_doc_url || '';

  if (d.org_chart_url || d.strategic_plan_url || savedPrepLink) {
    prompt += `\n=== RESOURCES ===\n`;
    if (d.org_chart_url) prompt += `Org Chart: ${d.org_chart_url}\n`;
    if (d.strategic_plan_url) prompt += `Strategic Plan: ${d.strategic_plan_url}\n`;
    if (savedPrepLink) prompt += `Previous Meeting Prep: ${savedPrepLink}\n`;
  }

  // Customer data if applicable
  if (customerData) {
    prompt += `\n=== EXISTING CUSTOMER DATA ===\n`;
    prompt += `Active ARR: $${parseFloat(customerData.arr || 0).toLocaleString()}\n`;
    if (customerData.arr_12mo_ago) prompt += `ARR 12mo Ago: $${parseFloat(customerData.arr_12mo_ago).toLocaleString()}\n`;
    if (customerData.gdr) prompt += `GDR: ${customerData.gdr}%\n`;
    if (customerData.ndr) prompt += `NDR: ${customerData.ndr}%\n`;
    if (customerData.csm) prompt += `CSM: ${customerData.csm}\n`;
    if (customerData.last_activity) prompt += `Last Activity: ${customerData.last_activity}\n`;
  }

  // Internal notes
  if (notes.length > 0) {
    prompt += `\n=== INTERNAL NOTES ===\n`;
    notes.forEach(n => {
      const date = new Date(n.ts).toLocaleDateString();
      prompt += `[${date}] ${n.author}: ${n.text}\n`;
    });
  }

  prompt += `\n=== REQUEST ===\n`;
  prompt += `Please generate comprehensive meeting prep including:\n`;
  prompt += `1. District background and key statistics\n`;
  prompt += `2. Leadership research and LinkedIn profiles if findable\n`;
  prompt += `3. Recent news and initiatives\n`;
  prompt += `4. Strategic priorities based on their strategic plan\n`;
  prompt += `5. Potential pain points and opportunities\n`;
  prompt += `6. Suggested talking points and questions\n`;
  prompt += `7. Competitive landscape\n`;

  return prompt;
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } catch (e) {
    console.error('Fallback copy failed:', e);
  }
  document.body.removeChild(textarea);
}

function showMeetingPrepToast() {
  // Remove existing toast if any
  const existing = document.querySelector('.meeting-prep-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'meeting-prep-toast';
  toast.innerHTML = `<span class="toast-icon">✓</span> District data copied! Opening Claude...`;
  document.body.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  // Remove after delay
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============ DATA REFRESH PANEL ============

function toggleDataRefreshPanel() {
  document.getElementById('dataRefreshPanel').classList.toggle('open');
}

function handleDataRefreshDrop(event) {
  const file = event.dataTransfer.files[0];
  if (!file) return;
  if (!/\.(csv|xlsx?|xls)$/i.test(file.name)) {
    alert('Please drop a CSV or Excel file.');
    return;
  }
  processUploadFile(file);
  toggleDataRefreshPanel();
}

function handleDataRefreshFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  processUploadFile(file);
  event.target.value = '';
  toggleDataRefreshPanel();
}

// ============ SPREADSHEET FILE READER (CSV + Excel) ============

function isExcelFile(filename) {
  return /\.(xlsx?|xls)$/i.test(filename);
}

function readSpreadsheetFile(file) {
  return new Promise((resolve, reject) => {
    if (isExcelFile(file.name)) {
      // Excel file — use SheetJS
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const workbook = XLSX.read(e.target.result, { type: 'array', cellDates: true });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          // Convert to array of objects with lowercase underscore keys
          const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
          const rows = rawRows.map(row => {
            const mapped = {};
            Object.keys(row).forEach(key => {
              const normKey = key.trim().toLowerCase().replace(/\s+/g, '_');
              const val = row[key];
              // Handle Date objects from Excel (cellDates: true)
              if (val instanceof Date && !isNaN(val.getTime())) {
                mapped[normKey] = (val.getMonth() + 1) + '/' + val.getDate() + '/' + val.getFullYear();
              } else {
                mapped[normKey] = String(val).trim();
              }
            });
            return mapped;
          });
          resolve(rows);
        } catch (err) {
          reject(new Error('Failed to parse Excel file: ' + err.message));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    } else {
      // CSV file — use existing parser
      const reader = new FileReader();
      reader.onload = e => {
        const parsed = parseCSV(e.target.result);
        resolve(parsed);
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    }
  });
}

// ============ SFDC DATA REFRESH ============
let sfdcDataType = 'strategic';
let pendingMergeData = null;
let pendingMergeStats = null;

function openSfdcModal() {
  document.getElementById('sfdcModal').classList.add('open');
}
function closeSfdcModal() {
  document.getElementById('sfdcModal').classList.remove('open');
}

function setSfdcType(type) {
  sfdcDataType = type;
  document.getElementById('sfdcTypeStrat').className = 'sfdc-type-btn' + (type === 'strategic' ? ' active-strat' : '');
  document.getElementById('sfdcTypeCust').className = 'sfdc-type-btn' + (type === 'customers' ? ' active-cust' : '');
}

// Setup drag-and-drop
document.addEventListener('DOMContentLoaded', () => {
  const dropzone = document.getElementById('sfdcDropzone');
  if (!dropzone) return;

  ['dragenter', 'dragover'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(evt => {
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', e => {
    const files = e.dataTransfer.files;
    if (files.length > 0 && /\.(csv|xlsx?|xls)$/i.test(files[0].name)) {
      processUploadFile(files[0]);
    }
  });

  // Load last refresh time
  const lastRefresh = localStorage.getItem('edia_sfdc_last_refresh');
  if (lastRefresh) {
    document.getElementById('sfdcLastRefresh').textContent = 'Last: ' + new Date(lastRefresh).toLocaleDateString();
  }
});

function handleSfdcFile(event) {
  const file = event.target.files[0];
  if (file && /\.(csv|xlsx?|xls)$/i.test(file.name)) {
    processUploadFile(file);
  }
  event.target.value = '';
}

function processUploadFile(file) {
  readSpreadsheetFile(file).then(parsed => {
    if (parsed.length === 0) {
      alert('No data found in file');
      return;
    }
    previewMerge(parsed);
  }).catch(err => {
    alert('Error reading file: ' + err.message);
  });
}

function parseCSV(text) {
  // Split into rows while respecting quoted fields that may contain newlines
  const rows = [];
  let currentRow = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      // Handle escaped quotes (doubled)
      if (inQuotes && text[i + 1] === '"') {
        currentRow += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        currentRow += char;
      }
    } else if ((char === '\n' || (char === '\r' && text[i + 1] === '\n')) && !inQuotes) {
      // End of row (only if not inside quotes)
      if (currentRow.trim()) {
        rows.push(currentRow);
      }
      currentRow = '';
      if (char === '\r') i++; // Skip the \n in \r\n
    } else if (char === '\r' && !inQuotes) {
      // Handle \r alone as line ending
      if (currentRow.trim()) {
        rows.push(currentRow);
      }
      currentRow = '';
    } else {
      currentRow += char;
    }
  }
  // Don't forget the last row
  if (currentRow.trim()) {
    rows.push(currentRow);
  }

  if (rows.length < 2) return [];

  // Parse header row
  const headers = parseCSVLine(rows[0]);
  const data = [];

  let skippedRows = [];
  for (let i = 1; i < rows.length; i++) {
    const values = parseCSVLine(rows[i]);
    if (values.length === headers.length) {
      const row = {};
      headers.forEach((h, idx) => {
        // Normalize header names (lowercase, trim, replace spaces with underscores)
        const key = h.trim().toLowerCase().replace(/\s+/g, '_');
        row[key] = values[idx].trim();
      });
      data.push(row);
    } else {
      // Log skipped rows - column count mismatch
      const preview = rows[i].substring(0, 100);
      skippedRows.push({ line: i + 1, expected: headers.length, got: values.length, preview });
      // Check if this might be Dallas
      if (rows[i].toLowerCase().includes('dallas')) {
        console.warn('[CSV Parse] DALLAS ROW SKIPPED! Row', i + 1, '- Expected', headers.length, 'columns, got', values.length);
        console.warn('[CSV Parse] Raw row:', rows[i].substring(0, 500));
      }
    }
  }
  if (skippedRows.length > 0) {
    console.warn('[CSV Parse] Skipped', skippedRows.length, 'rows due to column count mismatch:');
    skippedRows.slice(0, 5).forEach(r => {
      console.warn('  Row', r.line + ':', r.got, 'cols (expected', r.expected + '):', r.preview + '...');
    });
  }
  console.log('[CSV Parse] Successfully parsed', data.length, 'rows from', rows.length - 1, 'data rows');
  return data;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function previewMerge(csvData) {
  // Auto-detect data type from CSV columns.
  // Customer data has distinctive fields (arr, csm, segment, gdr, ndr)
  // that strategic data never has. If we find them, override the toggle.
  if (csvData.length > 0) {
    const cols = new Set(Object.keys(csvData[0]).map(k => k.toLowerCase().replace(/\s+/g, '_')));
    const customerSignals = ['arr', 'active_arr', 'annual_recurring_revenue', 'revenue',
                             'csm', 'csm_name', 'customer_success_manager',
                             'segment', 'gdr', 'ndr', 'lapsed_renewal', 'arr_12mo_ago'];
    const strategicSignals = ['superintendent', 'super', 'sis', 'sis_platform', 'sis_system',
                              'ada_adm', 'math_products', 'attendance'];
    const custHits = customerSignals.filter(s => cols.has(s)).length;
    const stratHits = strategicSignals.filter(s => cols.has(s)).length;
    if (custHits > stratHits && custHits >= 2) {
      console.log('[SFDC Merge] Auto-detected CUSTOMER data (matched columns:', customerSignals.filter(s => cols.has(s)).join(', '), ')');
      sfdcDataType = 'customers';
      setSfdcType('customers');
    } else if (stratHits > custHits && stratHits >= 2) {
      console.log('[SFDC Merge] Auto-detected STRATEGIC data (matched columns:', strategicSignals.filter(s => cols.has(s)).join(', '), ')');
      sfdcDataType = 'strategic';
      setSfdcType('strategic');
    } else {
      console.log('[SFDC Merge] Could not auto-detect type (cust signals:', custHits, ', strat signals:', stratHits, '). Using selected type:', sfdcDataType);
    }
  }

  const isStrategic = sfdcDataType === 'strategic';
  const existingData = isStrategic ? STRATEGIC_DATA : CUSTOMER_DATA;

  // Log CSV columns for debugging
  if (csvData.length > 0) {
    console.log('[SFDC Merge] CSV columns:', Object.keys(csvData[0]));
    console.log('[SFDC Merge] Sample row:', csvData[0]);
  }

  // Create a map of existing data by name for quick lookup
  // Use both exact name and normalized name for matching
  const existingByName = new Map();
  const existingByNormalized = new Map();
  const existingByState = new Map(); // Group by state for fuzzy matching
  existingData.forEach((item, idx) => {
    const exactKey = item.name.toLowerCase().trim();
    const normalizedKey = normalizeDistrictName(item.name);
    existingByName.set(exactKey, { item, idx });
    existingByNormalized.set(normalizedKey, { item, idx });
    // Group by state
    const state = (item.state || '').toUpperCase().trim();
    if (state) {
      if (!existingByState.has(state)) existingByState.set(state, []);
      existingByState.get(state).push({ item, idx, normalizedKey });
    }
  });
  console.log('[SFDC Merge] Existing exact keys:', Array.from(existingByName.keys()).slice(0, 10), '...');
  console.log('[SFDC Merge] Existing normalized keys:', Array.from(existingByNormalized.keys()).slice(0, 10), '...');
  console.log('[SFDC Merge] States indexed:', Array.from(existingByState.keys()).join(', '));

  // Fuzzy match by state + core name contains
  function findByStateAndName(csvName, csvState) {
    if (!csvState) return null;
    const stateKey = csvState.toUpperCase().trim();
    const stateRecords = existingByState.get(stateKey);
    if (!stateRecords) return null;

    const csvNormalized = normalizeDistrictName(csvName);

    for (const { item, idx, normalizedKey } of stateRecords) {
      // Check if either name contains the other (handles "Dallas" matching "Dallas ISD")
      if (csvNormalized.includes(normalizedKey) || normalizedKey.includes(csvNormalized)) {
        console.log('[SFDC Merge] State+Name match:', csvName, '→', item.name, '(state:', stateKey, ')');
        return { item, idx };
      }
    }
    return null;
  }
  // Log Dallas specifically if it exists - test with CORRECT keys
  const dallasExact = existingByName.get('dallas isd');
  const dallasNormalized = existingByNormalized.get('dallas'); // normalized key is "dallas", not "dallas isd"
  console.log('[SFDC Merge] Dallas in exact map ("dallas isd"):', dallasExact ? 'FOUND' : 'NOT FOUND');
  console.log('[SFDC Merge] Dallas in normalized map ("dallas"):', dallasNormalized ? 'FOUND' : 'NOT FOUND');

  // Count notes that exist in localStorage
  let notesCount = 0;
  existingData.forEach(d => {
    const noteKey = 'edia_notes_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
    try {
      const notes = JSON.parse(localStorage.getItem(noteKey) || '[]');
      if (notes.length > 0) notesCount++;
    } catch(e) { /* ignored */ }
  });

  // Analyze merge impact
  const stats = {
    total: csvData.length,
    newRecords: 0,
    updatedRecords: 0,
    notesPreserved: notesCount,
    changes: []
  };

  const mergedData = [];
  const processedNames = new Set();
  const mergedByName = new Map(); // Track already-merged records to handle duplicate CSV rows

  // Helper to get name from CSV row - checks all name field variations
  function getNameFromRow(row) {
    return row.name || row.district_name || row.account_name ||
           row.district || row.organization || row.org_name || row.account || '';
  }

  // Debug: Find all Dallas rows in CSV
  const dallasRows = csvData.filter(r => {
    const n = getNameFromRow(r);
    return n.toLowerCase().includes('dallas');
  });
  console.log('[SFDC Merge] CSV rows containing "dallas":', dallasRows.length);
  dallasRows.forEach(r => {
    console.log('  -', getNameFromRow(r));
  });

  csvData.forEach((csvRow, idx) => {
    const name = getNameFromRow(csvRow);
    if (!name) {
      console.log('[SFDC Merge] Row', idx, 'has no name field. Keys:', Object.keys(csvRow));
      return;
    }

    const nameKey = name.toLowerCase().trim();
    const normalizedKey = normalizeDistrictName(name);
    processedNames.add(nameKey);
    processedNames.add(normalizedKey);

    // Special logging for Dallas
    if (name.toLowerCase().includes('dallas')) {
      console.log('[SFDC Merge] DALLAS DEBUG:');
      console.log('  - CSV name:', name);
      console.log('  - Exact key:', nameKey);
      console.log('  - Normalized key:', normalizedKey);
      console.log('  - existingByName.has(exactKey):', existingByName.has(nameKey));
      console.log('  - existingByNormalized.has(normalizedKey):', existingByNormalized.has(normalizedKey));
    }

    // First check if we already merged this account from an earlier CSV row (handles multiple opps per account)
    let alreadyMerged = mergedByName.get(nameKey) || mergedByName.get(normalizedKey);

    // Try exact match first, then normalized match, then state+name fuzzy match
    let existing = existingByName.get(nameKey);
    if (!existing) {
      existing = existingByNormalized.get(normalizedKey);
      if (existing) {
        console.log('[SFDC Merge] Normalized match:', name, '→', existing.item.name);
        // Check if we already merged this existing record
        alreadyMerged = alreadyMerged || mergedByName.get(existing.item.name.toLowerCase().trim());
      }
    }
    // Fallback: try state + name contains match
    if (!existing) {
      const csvState = csvRow.state || '';
      existing = findByStateAndName(name, csvState);
      // If we found a match, also add to processedNames to avoid duplicates
      if (existing) {
        processedNames.add(existing.item.name.toLowerCase().trim());
        processedNames.add(normalizeDistrictName(existing.item.name));
        alreadyMerged = alreadyMerged || mergedByName.get(existing.item.name.toLowerCase().trim());
      }
    }
    if (!existing && !alreadyMerged && idx < 10) {
      console.log('[SFDC Merge] No match for:', name, '(exact:', nameKey, ', normalized:', normalizedKey, ')');
    }

    // If this account was already merged from a previous CSV row, update that record (multiple opps scenario)
    if (alreadyMerged) {
      console.log('[SFDC Merge] Multiple opps for:', name, '- updating existing merged record');
      // Update with this row's opp data (later row wins, or we could aggregate)
      Object.keys(csvRow).forEach(key => {
        const val = csvRow[key];
        if (val && val.trim()) {
          const mappedKey = mapFieldName(key);
          // Don't overwrite name with opportunity_name
          if (mappedKey !== 'name' || !alreadyMerged.name) {
            alreadyMerged[mappedKey] = val.trim();
          }
        }
      });
      parseNumericFields(alreadyMerged);
      return; // Skip to next CSV row (return in forEach acts like continue)
    }

    if (existing) {
      // Update existing record but preserve certain local fields
      const merged = { ...existing.item };

      // Debug: Log CSV columns for first few rows or Dallas
      if (idx < 2 || name.toLowerCase().includes('dallas')) {
        console.log('[SFDC Merge] Processing:', name);
        console.log('[SFDC Merge] CSV columns:', Object.keys(csvRow));
        console.log('[SFDC Merge] Key fields from CSV:');
        ['stage', 'opp_stage', 'year_1_acv', 'acv', 'probability'].forEach(k => {
          if (csvRow[k] !== undefined) console.log(`  ${k}: "${csvRow[k]}"`);
        });
      }

      // Update with CSV data, mapping common field variations
      Object.keys(csvRow).forEach(key => {
        const val = csvRow[key];
        if (val && val.trim()) {
          // Map common CSV column names to our field names
          const mappedKey = mapFieldName(key);
          merged[mappedKey] = val.trim();
        }
      });

      // Parse numeric fields
      parseNumericFields(merged);

      // Check if anything actually changed - compare key opp fields
      const keyFields = ['opp_stage', 'opp_acv', 'opp_probability', 'opp_forecast', 'opp_next_step'];
      const changedFields = [];

      const hasChanges = Object.keys(csvRow).some(key => {
        const mappedKey = mapFieldName(key);
        const oldVal = existing.item[mappedKey];
        const newVal = (csvRow[key] || '').trim();
        // Handle numeric comparisons
        if (oldVal === undefined || oldVal === null) {
          if (newVal !== '') {
            changedFields.push({ field: mappedKey, old: oldVal, new: newVal });
            return true;
          }
          return false;
        }
        if (oldVal.toString() !== newVal) {
          changedFields.push({ field: mappedKey, old: oldVal.toString(), new: newVal });
          return true;
        }
        return false;
      });

      // Debug logging for Dallas
      if (name.toLowerCase().includes('dallas') || name.toLowerCase().includes('kern')) {
        console.log('[SFDC Merge] Change detection for:', name);
        console.log('  hasChanges:', hasChanges);
        console.log('  changedFields:', changedFields);
        console.log('  existing opp_stage:', existing.item.opp_stage);
        console.log('  merged opp_stage:', merged.opp_stage);
      }

      if (hasChanges) {
        stats.updatedRecords++;
        stats.changes.push({ name, action: 'updated', oldData: existing.item, newData: merged });
      }

      mergedData.push(merged);
      // Track this merged record to handle duplicate CSV rows (multiple opps per account)
      mergedByName.set(nameKey, merged);
      mergedByName.set(normalizedKey, merged);
      mergedByName.set(existing.item.name.toLowerCase().trim(), merged);
    } else {
      // New record - check if name might be a partial match
      const possibleMatch = findPartialMatch(name, existingByName);
      if (possibleMatch) {
        stats.changes.push({ name, action: 'new', warning: `Similar to existing: "${possibleMatch}"` });
      }

      // Log ALL new records so we can debug matching issues
      console.log('[SFDC Merge] NEW RECORD (no match):', name);
      console.log('  - Normalized key tried:', normalizedKey);
      console.log('  - State:', csvRow.state || 'NOT SET');
      if (possibleMatch) {
        console.log('  - Possible match found:', possibleMatch);
      }

      const newRecord = {};
      Object.keys(csvRow).forEach(key => {
        const mappedKey = mapFieldName(key);
        newRecord[mappedKey] = (csvRow[key] || '').trim();
      });
      newRecord.name = name;

      // Parse numeric fields
      parseNumericFields(newRecord);

      stats.newRecords++;
      if (!possibleMatch) {
        stats.changes.push({ name, action: 'new' });
      }
      mergedData.push(newRecord);
      // Track this new record to handle duplicate CSV rows
      mergedByName.set(nameKey, newRecord);
      mergedByName.set(normalizedKey, newRecord);
    }
  });

  // Keep existing records not in CSV (preserve them)
  existingData.forEach(item => {
    const nameKey = item.name.toLowerCase().trim();
    const normalizedKey = normalizeDistrictName(item.name);
    if (!processedNames.has(nameKey) && !processedNames.has(normalizedKey)) {
      mergedData.push(item);
    }
  });

  pendingMergeData = mergedData;
  pendingMergeStats = stats;

  showMergeModal(stats);
}

function mapFieldName(csvField) {
  // Map common CSV field names to our internal field names
  const mappings = {
    // Name variations
    'district_name': 'name',
    'account_name': 'name',
    'district': 'name',
    'account': 'name',
    'organization': 'name',
    'org_name': 'name',
    // Location
    'latitude': 'lat',
    'longitude': 'lng',
    'long': 'lng',
    // People
    'account_executive': 'ae',
    'account_owner': 'ae',
    'owner': 'ae',
    'ae_name': 'ae',
    'csm_name': 'csm',
    'customer_success_manager': 'csm',
    'sdr_name': 'opp_sdr',
    'sales_develop': 'opp_sdr',
    'primary_contact': 'opp_contact',
    'contact_name': 'opp_contact',
    'contact_title': 'opp_contact_title',
    // Enrollment
    'enrollment_count': 'enrollment',
    'student_count': 'enrollment',
    'total_students': 'enrollment',
    'students': 'enrollment',
    'total_enrollment': 'enrollment',
    'students_in_d': 'enrollment',
    'students_in_district': 'enrollment',
    // SIS
    'sis_platform': 'sis',
    'sis_system': 'sis',
    'student_information_system': 'sis',
    // Opportunity fields
    'opportunity_stage': 'opp_stage',
    'stage': 'opp_stage',
    'forecast_category': 'opp_forecast',
    'forecast': 'opp_forecast',
    'active_forecast': 'opp_forecast',
    'probability': 'opp_probability',
    'probability_%': 'opp_probability',
    'probability_(%)': 'opp_probability',
    'acv': 'opp_acv',
    'amount': 'opp_acv',
    'opportunity_amount': 'opp_acv',
    'year_1_acv': 'opp_acv',
    'next_step': 'opp_next_step',
    'next_steps': 'opp_next_step',
    'intro_meeting_next_step': 'opp_next_step',
    'last_activity_date': 'opp_last_activity',
    'competition': 'opp_competition',
    'competitors': 'opp_competition',
    'economic_buyer': 'opp_economic_buyer',
    'champion': 'opp_champion',
    'opportunity_areas': 'opp_areas',
    'areas': 'opp_areas',
    'product_areas': 'opp_areas',
    'areas_of_interest': 'opp_areas',
    // Revenue
    'annual_recurring_revenue': 'arr',
    'active_arr': 'arr',
    'total_active_arr': 'arr',
    'revenue': 'arr',
    'total_active_arr_total_12_months_ago': 'arr_12mo_ago',
    // State / Address (SFDC column names)
    'billing_state_province': 'state',
    'billing_state': 'state',
    'shipping_state_province': 'state',
    'shipping_state': 'state',
    'billing_address_line_1': 'address',
    'billing_address': 'address',
    'shipping_address_line_1': 'address',
    'shipping_address': 'address',
    'billing_city': 'city',
    'shipping_city': 'city',
    // Customer fields
    'last_modified_date': 'last_modified',
    // Leadership
    'superintendent': 'superintendent',
    'super': 'superintendent'
  };

  const normalized = csvField.toLowerCase().replace(/[\/()]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return mappings[normalized] || normalized;
}

function normalizeDistrictName(name) {
  // Aggressively normalize district names by stripping ALL school-related suffixes
  // "Dallas Independent School District" -> "dallas"
  // "Dallas ISD" -> "dallas"
  // "DeSoto County School District" -> "desoto county"
  // "Desoto County Schools" -> "desoto county"
  let normalized = name.toLowerCase().trim();
  const original = normalized;

  // Remove all school-related suffixes (order matters - longer patterns first)
  const suffixPatterns = [
    /\s+independent school district$/i,
    /\s+unified school district$/i,
    /\s+consolidated school district$/i,
    /\s+central school district$/i,
    /\s+city school district$/i,
    /\s+union free school district$/i,
    /\s+public school district$/i,
    /\s+county school district$/i,
    /\s+school district$/i,
    /\s+county public schools$/i,
    /\s+county schools$/i,
    /\s+public schools$/i,
    /\s+city schools$/i,
    /\s+area schools$/i,
    /\s+schools$/i,
    /\s+parish school system$/i,
    /\s+parish school board$/i,
    /\s+school system$/i,
    /\s+isd$/i,
    /\s+usd$/i,
    /\s+csd$/i,
    /\s+sd$/i,
    /\s+ps$/i,
  ];

  suffixPatterns.forEach(pattern => {
    normalized = normalized.replace(pattern, '');
  });

  // Clean up extra spaces
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // Log normalization for debugging
  if (original !== normalized) {
    console.log('[Normalize]', `"${original}" → "${normalized}"`);
  }

  return normalized;
}

function parseNumericFields(record) {
  // Convert numeric fields from strings to numbers
  const numericFields = ['lat', 'lng', 'enrollment', 'students', 'opp_acv', 'opp_probability', 'arr', 'gdr', 'ndr', 'opp_count'];
  numericFields.forEach(field => {
    if (record[field] !== undefined && record[field] !== '') {
      const val = parseFloat(record[field]);
      if (!isNaN(val)) record[field] = val;
    }
  });
}

function findPartialMatch(name, existingByName) {
  // Check if there's a similar name in existing data
  const nameLower = name.toLowerCase().trim();
  const nameWords = nameLower.split(/\s+/);

  for (const [existingKey, data] of existingByName) {
    // Check if first word matches (e.g., "Dallas" matches "Dallas ISD")
    const existingWords = existingKey.split(/\s+/);
    if (nameWords[0] === existingWords[0] && nameWords[0].length > 3) {
      return data.item.name;
    }
    // Check for substring match
    if (existingKey.includes(nameLower) || nameLower.includes(existingKey)) {
      return data.item.name;
    }
  }
  return null;
}

function showMergeModal(stats) {
  document.getElementById('mergeModalTitle').textContent =
    `Merge Preview: ${sfdcDataType === 'strategic' ? 'Strategic Accounts' : 'Customers'}`;
  document.getElementById('mergeTotalRecords').textContent = stats.total;
  document.getElementById('mergeNewRecords').textContent = stats.newRecords;
  document.getElementById('mergeUpdatedRecords').textContent = stats.updatedRecords;
  document.getElementById('mergeNotesPreserved').textContent = stats.notesPreserved;

  // Count records needing geocoding
  const needsGeocode = pendingMergeData ? pendingMergeData.filter(r => !r.lat || !r.lng).length : 0;

  // Show change list
  const changesList = document.getElementById('mergeChangesList');
  if (stats.changes.length > 0 || needsGeocode > 0) {
    const maxShow = 30;
    let html = '';

    // Show geocoding notice if needed
    if (needsGeocode > 0) {
      html += `<div style="background:#E8853D22;border:1px solid #E8853D44;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:11px;">
        <strong style="color:#E8853D;">📍 ${needsGeocode} record${needsGeocode > 1 ? 's' : ''} will be geocoded</strong>
        <div style="color:var(--text-dim);margin-top:4px;">New pins will appear on map after merge</div>
      </div>`;
    }

    stats.changes.slice(0, maxShow).forEach(c => {
      const actionClass = c.action === 'new' ? 'new' : 'upd';
      const actionLabel = c.action === 'new' ? 'NEW' : 'UPD';
      let warningHtml = '';
      if (c.warning) {
        warningHtml = `<div style="font-size:10px;color:#e17055;margin-top:2px;">⚠ ${c.warning}</div>`;
      }
      // Add geocode indicator for new records
      const geoIcon = c.action === 'new' ? '<span style="margin-left:4px;" title="Will be geocoded">📍</span>' : '';
      html += `<div class="merge-change-item">
        <span class="name">${c.name}${geoIcon}</span>
        <span class="action ${actionClass}">${actionLabel}</span>
        ${warningHtml}
      </div>`;
    });
    if (stats.changes.length > maxShow) {
      html += `<div class="merge-change-item" style="color:var(--text-muted);font-style:italic;">
        ...and ${stats.changes.length - maxShow} more
      </div>`;
    }
    changesList.innerHTML = html;
    changesList.style.display = 'block';
  } else {
    changesList.innerHTML = '<div style="color:var(--text-muted);font-size:11px;">No changes detected - check that CSV column names match</div>';
    changesList.style.display = 'block';
  }

  document.getElementById('mergeModal').classList.add('show');
}

function closeMergeModal() {
  document.getElementById('mergeModal').classList.remove('show');
  pendingMergeData = null;
  pendingMergeStats = null;
}

// Geocode a district using OpenStreetMap Nominatim API
async function geocodeDistrict(name, state, record) {
  // Check for address fields in the record (most accurate if available)
  // CSV headers get normalized: "Billing Address Line 1" → "billing_address_line_1"
  const address = record?.billing_address_line_1 || record?.address || record?.street_address || record?.billing_address || record?.mailing_address || record?.billing_street || '';
  const city = record?.billing_city || record?.city || record?.mailing_city || '';

  // Build list of query variations to try
  const baseName = name.replace(/\s*(Independent School District|School District|Public Schools|County Schools|City Schools|Parish Schools|ISD|USD|CSD|Schools|District).*$/i, '').trim();

  const queries = [];

  // If we have address + city, try that first (most accurate)
  if (address && city && state) {
    queries.push(`${address}, ${city}, ${state}, USA`);
    console.log('[Geocode] Using address from CSV:', address, city, state);
  }
  // If we have just city, try that
  if (city && state) {
    queries.push(`${city}, ${state}, USA`);
  }

  // Add name-based fallback queries
  queries.push(
    // Try the base name as a city
    `${baseName}, ${state}, USA`,
    // Try as a county
    `${baseName} County, ${state}, USA`,
    // Try the full name
    `${name}, ${state}, USA`,
    // Try adding "city" explicitly
    `${baseName} city, ${state}, USA`,
    // For names that might be school districts, search for the school district HQ
    `${name} school district, ${state}, USA`
  );

  // Remove duplicates and empty queries
  const uniqueQueries = [...new Set(queries)].filter(q => q && !q.includes('undefined'));

  for (const query of uniqueQueries) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&countrycodes=us`;

    try {
      console.log('[Geocode] Trying:', query);
      const response = await fetch(url, {
        headers: { 'User-Agent': 'EdiaStratMap/1.0' }
      });
      const data = await response.json();
      if (data && data.length > 0) {
        console.log('[Geocode] Found:', name, '→', data[0].lat, data[0].lon, '(query:', query, ')');
        return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      }
      // Rate limit between query attempts
      await new Promise(resolve => setTimeout(resolve, 1100));
    } catch (err) {
      console.error('[Geocode] Error for:', query, err);
    }
  }

  // Last resort: try to at least place it somewhere in the state
  console.warn('[Geocode] Trying state-level fallback for:', name, state);
  try {
    const stateUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(state + ', USA')}&limit=1&countrycodes=us`;
    const response = await fetch(stateUrl, {
      headers: { 'User-Agent': 'EdiaStratMap/1.0' }
    });
    const data = await response.json();
    if (data && data.length > 0) {
      console.log('[Geocode] Using state center for:', name, '→', data[0].lat, data[0].lon);
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (err) {
    console.error('[Geocode] State fallback error:', err);
  }

  console.warn('[Geocode] No results for:', name, state);
  return null;
}

// Geocode all records missing lat/lng (with rate limiting)
async function geocodeMissingRecords(records) {
  const needsGeocoding = records.filter(r => !r.lat || !r.lng);
  if (needsGeocoding.length === 0) return;

  showGeocodeProgress('Geocoding accounts...');
  const total = needsGeocoding.length;

  let geocoded = 0;
  for (let i = 0; i < needsGeocoding.length; i++) {
    const record = needsGeocoding[i];
    updateGeocodeProgress(i + 1, total, (i + 1) + ' of ' + total + ' — ' + (record.name || '').substring(0, 30));

    if (!record.state) continue;

    const coords = await geocodeDistrict(record.name, record.state, record);
    if (coords) {
      record.lat = coords.lat;
      record.lng = coords.lng;
      geocoded++;
    }
  }
  hideGeocodeProgress();
  console.log('[Geocode] Completed - geocoded', geocoded, 'of', total, 'records');
}

async function confirmMerge() {
  if (!pendingMergeData) return;

  const confirmBtn = document.querySelector('.merge-btn-confirm');
  const originalBtnText = confirmBtn.textContent;
  let errors = [];
  let geocodedCount = 0;

  try {
    // Disable button and show loading state
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Processing...';

    const isStrategic = sfdcDataType === 'strategic';

    // Check for records needing geocoding
    const needsGeocoding = pendingMergeData.filter(r => !r.lat || !r.lng);
    if (needsGeocoding.length > 0) {
      showGeocodeProgress('Geocoding accounts...');

      // Geocode missing records
      for (let i = 0; i < needsGeocoding.length; i++) {
        const record = needsGeocoding[i];
        confirmBtn.textContent = `Geocoding ${i + 1}/${needsGeocoding.length}...`;
        updateGeocodeProgress(i + 1, needsGeocoding.length, (i + 1) + ' of ' + needsGeocoding.length + ' — ' + (record.name || '').substring(0, 30));

        if (!record.state) {
          errors.push(`No state for: ${record.name}`);
          continue;
        }

        try {
          const coords = await geocodeDistrict(record.name, record.state, record);
          if (coords) {
            record.lat = coords.lat;
            record.lng = coords.lng;
            geocodedCount++;
          } else {
            errors.push(`Could not geocode: ${record.name}`);
          }
        } catch (e) {
          errors.push(`Geocode error for ${record.name}: ${e.message}`);
        }
      }
      hideGeocodeProgress();
    }

    confirmBtn.textContent = 'Saving data...';

    // Apply the merge to in-memory arrays
    const filename = isStrategic ? 'strategic.json' : 'customers.json';
    if (isStrategic) {
      STRATEGIC_DATA.length = 0;
      pendingMergeData.forEach(item => STRATEGIC_DATA.push(item));
      console.log('[Merge] Updated', STRATEGIC_DATA.length, 'strategic accounts in memory');
    } else {
      CUSTOMER_DATA.length = 0;
      pendingMergeData.forEach(item => CUSTOMER_DATA.push(item));
      console.log('[Merge] Updated', CUSTOMER_DATA.length, 'customers in memory');
    }

    // Download the merged data as a JSON file so it can be committed to
    // the repo. This replaces localStorage persistence — the seed JSON
    // files (src/data/strategic.json and src/data/customers.json) are the
    // single source of truth, so all users see the same data.
    const jsonBlob = new Blob(
      [JSON.stringify(pendingMergeData, null, 2)],
      { type: 'application/json' }
    );
    const downloadLink = document.createElement('a');
    downloadLink.href = URL.createObjectURL(jsonBlob);
    downloadLink.download = filename;
    downloadLink.click();

    // Track when this user last ran a data refresh (per-user, informational only)
    localStorage.setItem('edia_sfdc_last_refresh', new Date().toISOString());

    // Close modal
    closeMergeModal();

    // Rebuild performance indices after data change
    buildIndices();
    _custGrid = null; // Invalidate spatial grid

    // Refresh map and UI in-place (no page reload needed)
    window.districtDataCache = {};
    STRATEGIC_DATA.forEach(d => {
      const key = d.name.replace(/[^a-zA-Z0-9]/g, '_');
      window.districtDataCache[key] = d;
    });
    renderFilters();
    applyFilters();

    // Show confirmation
    const recordCount = isStrategic ? STRATEGIC_DATA.length : CUSTOMER_DATA.length;
    let message = `✓ Merge complete!\n\n${recordCount} ${isStrategic ? 'strategic accounts' : 'customers'} updated on the map.`;
    message += `\n\nThe file "${filename}" has been downloaded.`;
    message += `\nReplace src/data/${filename} in the repo and redeploy so all users see the updated data.`;
    if (geocodedCount > 0) {
      message += `\n\n${geocodedCount} new records geocoded.`;
    }
    if (errors.length > 0) {
      message += `\n\n⚠ ${errors.length} warning(s):\n• ${errors.slice(0, 5).join('\n• ')}`;
      if (errors.length > 5) {
        message += `\n• ...and ${errors.length - 5} more`;
      }
    }

    alert(message);

  } catch (e) {
    console.error('[Merge] Error:', e);
    confirmBtn.disabled = false;
    confirmBtn.textContent = originalBtnText;
    alert(`❌ Merge failed!\n\nError: ${e.message}\n\nCheck console for details.`);
  }
}

function focusOnAccount(districtKey) {
  const d = window.districtDataCache && window.districtDataCache[districtKey];
  if (!d) return;
  const entry = markerLookup[d.name];
  if (entry && entry.marker) {
    const latLng = entry.marker.getLatLng();
    map.flyTo(latLng, 8, { duration: 0.6 });
    setTimeout(() => entry.marker.openPopup(), 400);
  } else {
    openAccountModalByKey(districtKey);
  }
}

// ============ CONFERENCE TRACKER ============

function toggleConferences(on) {
  conferencesOn = on;
  document.getElementById('confOptions').style.display = on ? '' : 'none';
  renderConferences();
  updateLegend();
}

function setConfRange(mode) {
  confRangeMode = mode;
  // Update quick button active states
  document.querySelectorAll('.conf-quick-btn').forEach(b => b.classList.remove('active'));
  const btns = document.querySelectorAll('.conf-quick-btn');
  btns.forEach(b => { if (b.textContent.toLowerCase().replace('d','') === mode || b.textContent.toLowerCase() === mode) b.classList.add('active'); });

  const customDates = document.getElementById('confCustomDates');
  if (mode === 'custom') {
    customDates.style.display = '';
  } else {
    customDates.style.display = 'none';
    confDateFrom = null;
    confDateTo = null;
  }
  renderConferences();
}

function applyConfDateFilter() {
  const fromEl = document.getElementById('confDateFrom');
  const toEl = document.getElementById('confDateTo');
  confDateFrom = fromEl.value ? new Date(fromEl.value + 'T00:00:00') : null;
  confDateTo = toEl.value ? new Date(toEl.value + 'T23:59:59') : null;
  renderConferences();
}

function getConfDateRange() {
  const now = new Date();
  now.setHours(0,0,0,0);
  let from, to;

  if (confRangeMode === 'custom') {
    from = confDateFrom;
    to = confDateTo;
  } else if (confRangeMode === 'all') {
    from = null;
    to = null;
  } else {
    const days = parseInt(confRangeMode) || 30;
    from = new Date(now);
    from.setDate(from.getDate() - 7); // Show conferences from 1 week ago
    to = new Date(now);
    to.setDate(to.getDate() + days);
  }
  return { from, to };
}

function filterConferences() {
  const { from, to } = getConfDateRange();

  return CONFERENCE_DATA.filter(c => {
    if (!c.lat || !c.lng) return false;
    const startDate = parseConfDate(c.start_date);
    const endDate = parseConfDate(c.end_date) || startDate;

    // If no parseable date, include the conference (we can't date-filter it)
    if (!startDate) return true;

    if (from && endDate < from) return false;
    if (to && startDate > to) return false;
    return true;
  });
}

function parseConfDate(str) {
  if (!str) return null;
  // Handle M/D/YYYY, MM/DD/YYYY, YYYY-MM-DD
  if (str.includes('-')) {
    const d = new Date(str + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }
  const parts = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!parts) return null;
  let year = parseInt(parts[3]);
  if (year < 100) year += 2000;
  const d = new Date(year, parseInt(parts[1]) - 1, parseInt(parts[2]));
  return isNaN(d.getTime()) ? null : d;
}

function formatConfDate(dateStr) {
  const d = parseConfDate(dateStr);
  if (!d) return dateStr || '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function isConfPast(c) {
  const endDate = parseConfDate(c.end_date) || parseConfDate(c.start_date);
  if (!endDate) return false;
  const now = new Date();
  now.setHours(0,0,0,0);
  return endDate < now;
}

function renderConferences() {
  confLayer.clearLayers();
  confProxLayer.clearLayers();
  filteredConfData = [];

  if (!conferencesOn || CONFERENCE_DATA.length === 0) {
    updateConfStats();
    return;
  }

  filteredConfData = filterConferences();
  console.log('[Conference] Rendering', filteredConfData.length, 'of', CONFERENCE_DATA.length, 'conferences. conferencesOn:', conferencesOn, 'rangeMode:', confRangeMode);
  if (filteredConfData.length === 0 && CONFERENCE_DATA.length > 0) {
    console.log('[Conference] All filtered out. Sample data:', JSON.stringify(CONFERENCE_DATA.slice(0, 2).map(c => ({ name: c.name, lat: c.lat, lng: c.lng, start_date: c.start_date }))));
  }

  filteredConfData.forEach(c => {
    const past = isConfPast(c);
    const icon = L.divIcon({
      className: `marker-conf${past ? ' conf-past' : ''}`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    const marker = L.marker([c.lat, c.lng], { icon }).addTo(confLayer);
    marker.bindPopup(buildConfPopup(c), { maxWidth: 340 });
    marker.on('click', function() {
      map.flyTo([c.lat, c.lng], Math.max(map.getZoom(), 8), { duration: 0.6 });
    });

    // Draw proximity ring (100mi)
    if (!past) {
      const radiusMeters = 100 * 1609.34;
      L.circle([c.lat, c.lng], {
        radius: radiusMeters,
        color: '#ff9f43',
        weight: 1,
        opacity: 0.2,
        fillColor: '#ff9f43',
        fillOpacity: 0.04,
        interactive: false,
      }).addTo(confProxLayer);
    }
  });

  updateConfStats();
}

function updateConfStats() {
  const statsEl = document.getElementById('confStats');
  if (!statsEl) return;
  if (CONFERENCE_DATA.length === 0) {
    statsEl.innerHTML = 'No conferences loaded — upload a CSV';
    return;
  }
  const showing = filteredConfData.length;
  const total = CONFERENCE_DATA.length;
  const upcoming = filteredConfData.filter(c => !isConfPast(c)).length;
  let nearbyAccounts = 0;
  filteredConfData.forEach(c => {
    if (isConfPast(c)) return;
    nearbyAccounts += countNearbyStrategic(c, 100);
  });
  statsEl.innerHTML = `<b>${showing}</b> of ${total} conferences · <b>${upcoming}</b> upcoming · <b>${nearbyAccounts}</b> strategic accounts nearby`;
}

function countNearbyStrategic(conf, radiusMiles) {
  let count = 0;
  STRATEGIC_DATA.forEach(s => {
    if (!s.lat || !s.lng) return;
    if (haversine(conf.lat, conf.lng, s.lat, s.lng) <= radiusMiles) count++;
  });
  return count;
}

function getNearbyStrategic(conf, radiusMiles) {
  const results = [];
  STRATEGIC_DATA.forEach(s => {
    if (!s.lat || !s.lng) return;
    const dist = haversine(conf.lat, conf.lng, s.lat, s.lng);
    if (dist <= radiusMiles) {
      results.push({ data: s, distance: dist });
    }
  });
  return results.sort((a, b) => a.distance - b.distance);
}

function buildConfPopup(c) {
  const past = isConfPast(c);
  const statusLabel = past ? 'Past' : 'Upcoming';
  const statusClass = past ? 'past' : 'upcoming';
  let html = `<div class="popup-card">`;

  // Header badge
  html += `<div class="popup-conf-header">`;
  html += `<span class="popup-conf-badge ${statusClass}">${statusLabel}</span>`;
  html += `</div>`;

  html += `<h3 style="margin-bottom:6px;">${c.name || 'Conference'}</h3>`;

  // Dates
  const startFmt = formatConfDate(c.start_date);
  const endFmt = formatConfDate(c.end_date);
  if (c.start_date && c.end_date) {
    html += `<div class="popup-conf-dates">${startFmt} — ${endFmt}</div>`;
  } else if (c.start_date) {
    html += `<div class="popup-conf-dates">${startFmt}</div>`;
  }

  // Speaking / Attendee List status indicators
  const speakingVal = (c.speaking || '').toLowerCase();
  const speakingChecked = speakingVal === 'yes' || speakingVal === 'y' || speakingVal === 'true' || speakingVal === '1' || speakingVal === 'x';
  const attendeeListVal = (c.attendee_list || '').toLowerCase();
  const attendeeListChecked = attendeeListVal === 'yes' || attendeeListVal === 'y' || attendeeListVal === 'true' || attendeeListVal === '1' || attendeeListVal === 'x';

  html += `<div style="margin:8px 0;display:flex;gap:16px;font-size:11px;">`;
  html += `<span class="conf-check-indicator ${speakingChecked ? 'checked' : ''}">`;
  html += `<span class="conf-check-box">${speakingChecked ? '&#10003;' : ''}</span> Speaking</span>`;
  html += `<span class="conf-check-indicator ${attendeeListChecked ? 'checked' : ''}">`;
  html += `<span class="conf-check-box">${attendeeListChecked ? '&#10003;' : ''}</span> Attendee List</span>`;
  html += `</div>`;

  html += `<div class="popup-row"><span class="pk">Edia Attendee</span><span class="pv">${c.edia_attendee || '—'}</span></div>`;
  if (c._fullAddress) {
    html += `<div class="popup-row"><span class="pk">Location</span><span class="pv">${c._fullAddress}</span></div>`;
  } else if (c.city || c.state) {
    html += `<div class="popup-row"><span class="pk">Location</span><span class="pv">${[c.city, c.state].filter(Boolean).join(', ')}</span></div>`;
  }

  // Nearby strategic accounts
  if (!past) {
    const nearby = getNearbyStrategic(c, 100);
    if (nearby.length > 0) {
      html += `<div class="popup-conf-nearby">`;
      html += `<div class="popup-conf-nearby-title">${nearby.length} strategic accounts within 100 mi</div>`;
      const shown = nearby.slice(0, 10);
      shown.forEach(n => {
        const districtKey = n.data.name.replace(/[^a-zA-Z0-9]/g, '_');
        const distMi = Math.round(n.distance);
        const stageLbl = n.data.opp_stage ? n.data.opp_stage.replace(/^\d+\s*-\s*/, '') : '';
        html += `<div class="popup-conf-nearby-item" onclick="focusOnAccount('${districtKey}')">`;
        html += `${n.data.name}`;
        if (stageLbl) html += ` <span style="font-size:9px;color:var(--text-dim);">(${stageLbl})</span>`;
        html += ` <span class="conf-dist">${distMi}mi</span>`;
        html += `</div>`;
      });
      if (nearby.length > 10) {
        html += `<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">+ ${nearby.length - 10} more</div>`;
      }
      html += `</div>`;
    }
  }

  html += `</div>`;
  return html;
}

// ============ CONFERENCE CSV IMPORT ============

function handleConfFile(event) {
  const file = event.target.files[0];
  if (file && /\.(csv|xlsx?|xls)$/i.test(file.name)) {
    processConfUpload(file);
  }
  event.target.value = '';
}

function processConfUpload(file) {
  readSpreadsheetFile(file).then(parsed => {
    if (parsed.length === 0) {
      alert('No data found in file');
      return;
    }
    processConfData(parsed);
  }).catch(err => {
    alert('Error reading file: ' + err.message);
  });
}

function processConfData(parsed) {

    // Map fields to conference schema
    // Columns: Conference, Conference Contact, Start Date, End Date, Registered, Paid,
    // Attendee Size, State, Edia Attendee, Actual Cost, Conference Location, Full Address,
    // Attendee List?, Speaking?, Booth, Table, Notes, etc.
    const conferences = parsed.map(row => {
      const mapped = {};
      Object.keys(row).forEach(key => {
        const val = row[key] ? String(row[key]).trim() : '';
        if (!val) return;
        const lk = key.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/_$/, '');

        // --- Conference name (exact match only — not "conference_location" etc) ---
        if (lk === 'conference' || lk === 'event' || lk === 'event_name' || lk === 'conference_name') {
          mapped.name = mapped.name || val;
        }
        // --- Full Address (for geocoding — pins come from this column) ---
        else if (lk === 'full_address' || lk === 'address') {
          mapped._fullAddress = mapped._fullAddress || val;
        }
        // --- Conference Location (display only, geocoding fallback) ---
        else if (lk.includes('location') || lk.includes('venue')) {
          mapped._location = mapped._location || val;
        }
        // Start date
        else if (lk === 'start_date' || lk === 'start' || lk === 'date' || lk === 'begin' || lk === 'begin_date') {
          mapped.start_date = mapped.start_date || val;
        }
        // End date
        else if (lk === 'end_date' || lk === 'end') {
          mapped.end_date = mapped.end_date || val;
        }
        // State
        else if (lk === 'state' || lk === 'st') {
          mapped.state = mapped.state || val;
        }
        // City
        else if (lk === 'city') {
          mapped.city = mapped.city || val;
        }
        // Speaking?
        else if (lk.includes('speaking')) {
          mapped.speaking = mapped.speaking || val;
        }
        // Attendee list? (check before generic attendee matches)
        else if (lk.includes('attendee_list') || lk === 'attendee_list') {
          mapped.attendee_list = mapped.attendee_list || val;
        }
        // Edia attendee (who from Edia is going)
        else if (lk === 'edia_attendee' || (lk.includes('edia') && lk.includes('attend'))) {
          mapped.edia_attendee = mapped.edia_attendee || val;
        }
        // Attendee size
        else if (lk.includes('attendee_size') || lk === 'attendee_size' || lk.includes('size') || lk.includes('expected')) {
          mapped.attendees = mapped.attendees || val;
        }
        // Booth
        else if (lk === 'booth') {
          mapped.booth = mapped.booth || val;
        }
        // Table
        else if (lk === 'table') {
          mapped.table = mapped.table || val;
        }
        // Registered / paid
        else if (lk === 'registered') {
          mapped.registered = mapped.registered || val;
        }
        else if (lk === 'paid') {
          mapped.paid = mapped.paid || val;
        }
        // Notes
        else if (lk === 'notes' || lk.includes('note') || lk.includes('comment')) {
          mapped.notes = mapped.notes || val;
        }
        // Cost (Actual Cost)
        else if (lk.includes('cost') || lk.includes('budget')) {
          mapped.cost = mapped.cost || val;
        }
        // Lat/lng (if pre-geocoded)
        else if (lk === 'lat' || lk === 'latitude') {
          mapped.lat = parseFloat(val) || null;
        }
        else if (lk === 'lng' || lk === 'lon' || lk === 'longitude') {
          mapped.lng = parseFloat(val) || null;
        }
        // Fallback: if key literally is just "name" or "title", use as conference name
        else if ((lk === 'name' || lk === 'title') && !mapped.name) {
          mapped.name = val;
        }
      });

      // Resolve address fields: Full Address is for geocoding, Conference Location for display
      // If only _location exists (no Full Address), use it for geocoding too
      if (!mapped._fullAddress && mapped._location) {
        mapped._fullAddress = mapped._location;
      }
      // Keep _location for display; if none, use _fullAddress
      if (!mapped._location && mapped._fullAddress) {
        mapped._location = mapped._fullAddress;
      }

      // Parse location for geocoding — extract city and state from address strings
      const US_STATES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);
      const addrSource = mapped._fullAddress || mapped._location || '';
      if (addrSource && (!mapped.city || !mapped.state)) {
        const parts = addrSource.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
        let stateIdx = -1;
        for (let pi = parts.length - 1; pi >= 0; pi--) {
          const token = parts[pi].replace(/\s*\d{5}(-\d{4})?$/, '').trim();
          if (US_STATES.has(token.toUpperCase())) {
            stateIdx = pi;
            break;
          }
        }
        if (stateIdx >= 0) {
          if (!mapped.state) mapped.state = parts[stateIdx].replace(/\s*\d{5}(-\d{4})?$/, '').trim();
          if (!mapped.city && stateIdx > 0) mapped.city = parts[stateIdx - 1];
        } else if (parts.length >= 2) {
          if (!mapped.state) mapped.state = parts[parts.length - 1];
          if (!mapped.city) mapped.city = parts[parts.length >= 3 ? parts.length - 2 : 0];
        } else if (parts.length === 1 && !mapped.city) {
          mapped.city = parts[0];
        }
      }

      // Clean up internal field
      mapped._fullAddress = mapped._fullAddress || '';
      mapped._displayLocation = mapped._location || '';
      delete mapped._location;

      return mapped;
    }).filter(c => {
      if (!c.name) return false;
      // Filter out quarter header rows (Q1, Q2, Q3, Q4, Q1 2025, etc.)
      if (/^Q[1-4]\b/i.test(c.name.trim())) return false;
      return true;
    });
    console.log('[Conference] Mapped', conferences.length, 'conferences. Sample:', JSON.stringify(conferences.slice(0, 2)));

    if (conferences.length === 0) {
      alert('Could not find conference names in the CSV. Make sure you have a "Name" or "Conference" column.');
      return;
    }

    // Geocode conferences that need it
    geocodeConferences(conferences).then(results => {
      CONFERENCE_DATA = results;
      console.log('[Conference] Loaded', CONFERENCE_DATA.length, 'conferences');

      // Auto-enable conference layer
      conferencesOn = true;
      document.getElementById('confCheck').checked = true;
      document.getElementById('confOptions').style.display = '';
      // Show all conferences on first upload so user sees everything
      setConfRange('all');

      alert(`✓ Loaded ${results.length} conferences!\n${results.filter(r => r.lat && r.lng).length} geocoded successfully.`);
    });
}

// ============ GEOCODE PROGRESS ============

function showGeocodeProgress(label) {
  const el = document.getElementById('geocodeProgress');
  document.getElementById('geocodeProgressLabel').textContent = label;
  document.getElementById('geocodeProgressFill').style.width = '0%';
  document.getElementById('geocodeProgressDetail').textContent = '';
  el.classList.add('show');
}

function updateGeocodeProgress(current, total, detail) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  document.getElementById('geocodeProgressFill').style.width = pct + '%';
  document.getElementById('geocodeProgressDetail').textContent = detail || (current + ' of ' + total);
}

function hideGeocodeProgress() {
  document.getElementById('geocodeProgress').classList.remove('show');
}

async function geocodeConferences(conferences) {
  const needGeocode = conferences.filter(c => !c.lat || !c.lng);
  if (needGeocode.length === 0) return conferences;

  showGeocodeProgress('Geocoding conferences...');
  let geocoded = 0;
  let skipped = 0;
  const total = needGeocode.length;

  for (let i = 0; i < needGeocode.length; i++) {
    const conf = needGeocode[i];
    updateGeocodeProgress(i + 1, total, (i + 1) + ' of ' + total + ' — ' + (conf.name || '').substring(0, 30));

    // Build list of query variations to try (most reliable first)
    const queries = [];

    // 1. City + State is the most reliable for US locations
    if (conf.city && conf.state) {
      queries.push(`${conf.city}, ${conf.state}, USA`);
    }
    // 2. Full address (may include venue name — less reliable but worth trying)
    if (conf._fullAddress) {
      queries.push(conf._fullAddress);
    }
    // 3. City alone
    if (conf.city && !conf.state) {
      queries.push(`${conf.city}, USA`);
    }
    // 4. Conference name + state
    if (conf.name && conf.state) {
      queries.push(`${conf.name}, ${conf.state}, USA`);
    }
    // 5. Conference name + USA (last resort)
    if (conf.name) {
      queries.push(`${conf.name}, USA`);
    }

    // Remove duplicates and empty queries
    const uniqueQueries = [...new Set(queries)].filter(q => q && q !== 'USA');

    if (uniqueQueries.length === 0) { skipped++; continue; }

    let found = false;
    for (const query of uniqueQueries) {
      try {
        console.log('[Conference Geocode] Trying:', conf.name, '→', query);
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1&countrycodes=us`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'EdiaStratMap/1.0' }
        });
        const data = await response.json();
        if (data && data.length > 0) {
          conf.lat = parseFloat(data[0].lat);
          conf.lng = parseFloat(data[0].lon);
          console.log('[Conference Geocode] Found:', conf.name, '→', conf.lat, conf.lng, '(query:', query, ')');
          geocoded++;
          found = true;
          break;
        }
        // Rate limit between query attempts
        await new Promise(r => setTimeout(r, 1100));
      } catch(e) {
        console.error('[Conference Geocode] Error for:', conf.name, query, e);
      }
    }
    if (!found) {
      console.warn('[Conference Geocode] No results for:', conf.name);
    }
    // Rate limit for Nominatim
    await new Promise(r => setTimeout(r, 1100));
  }
  hideGeocodeProgress();
  console.log('[Conference Geocode] Done:', geocoded, 'geocoded,', skipped, 'skipped (no location data)');

  return conferences;
}

// ============ THEME TOGGLE ============
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', next);
  localStorage.setItem('edia_theme', next);
}

// Restore saved theme on load (default dark)
(function() {
  const saved = localStorage.getItem('edia_theme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();

// ============ DATA REFRESH PASSWORD PROTECTION ============
const DATA_REFRESH_PASSWORD = 'edia2025';
let dataRefreshAuthed = false;

function promptDataRefreshPassword() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'pw-modal-backdrop';
    backdrop.innerHTML = `
      <div class="pw-modal">
        <h3>Data Refresh</h3>
        <p>Enter the password to access data refresh.</p>
        <input type="password" id="pwInput" placeholder="Password" autocomplete="off">
        <div class="pw-modal-btns">
          <button onclick="this.closest('.pw-modal-backdrop').remove()">Cancel</button>
          <button class="pw-confirm" id="pwConfirmBtn">Unlock</button>
        </div>
        <div class="pw-error" id="pwError">Incorrect password</div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const input = backdrop.querySelector('#pwInput');
    const confirmBtn = backdrop.querySelector('#pwConfirmBtn');
    const errorEl = backdrop.querySelector('#pwError');

    function tryPassword() {
      if (input.value === DATA_REFRESH_PASSWORD) {
        dataRefreshAuthed = true;
        backdrop.remove();
        resolve(true);
      } else {
        errorEl.style.display = 'block';
        input.value = '';
        input.focus();
      }
    }

    confirmBtn.addEventListener('click', tryPassword);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryPassword();
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { backdrop.remove(); resolve(false); }
    });

    input.focus();
  });
}

const _originalToggleDataRefreshPanel = toggleDataRefreshPanel;
function protectedToggleDataRefreshPanel() {
  if (dataRefreshAuthed) {
    _originalToggleDataRefreshPanel();
    return;
  }
  promptDataRefreshPassword().then(ok => {
    if (ok) _originalToggleDataRefreshPanel();
  });
}

function protectedOpenSfdcModal() {
  if (dataRefreshAuthed) {
    openSfdcModal();
    return;
  }
  promptDataRefreshPassword().then(ok => {
    if (ok) openSfdcModal();
  });
}

// ============ EXPOSE TO WINDOW (for HTML inline handlers) ============
// These functions are referenced by onclick/onchange/oninput attributes in index.html
Object.assign(window, {
  // Views
  setView,
  resetMapView,
  // Team / Rep selectors
  onTeamChange,
  onRepChange,
  // Search
  onSearchInput,
  onSearchKeydown,
  closeAutocomplete,
  selectAutocomplete,
  // Stage filter
  onStageChange,
  clearStages,
  // Filters
  toggleFiltersPanel,
  setFilter,
  toggleChip,
  clearFilter,
  resetFilters,
  // Proximity & ADA
  toggleProximity,
  updateProxRadius,
  setProxRadiusFromInput,
  toggleAdaFilter,
  // Pipeline
  togglePipelinePanel,
  toggleStageDropdown,
  // Action Dashboard
  toggleActionDashboard,
  // Notes
  copyAllNotes,
  exportNotes,
  importNotes,
  addNote,
  handleNoteKey,
  copyAccountNotes,
  copyText,
  // Theme
  toggleTheme,
  // Data Refresh (password protected)
  toggleDataRefreshPanel: protectedToggleDataRefreshPanel,
  handleDataRefreshDrop,
  handleDataRefreshFile,
  openSfdcModal: protectedOpenSfdcModal,
  closeSfdcModal,
  setSfdcType,
  handleSfdcFile,
  // Merge Modal
  closeMergeModal,
  confirmMerge,
  // Account List
  toggleAccountListOverlay,
  highlightAccountMarker,
  unhighlightAccountMarker,
  toggleAccountListGroup,
  setAccountListSort,
  toggleGroupCollapse,
  openAccountFromList,
  showMoreAccounts,
  // Account Modal
  openAccountModal,
  openAccountModalByKey,
  closeAccountModal,
  switchTab,
  // Prep Links
  showPrepInput,
  hidePrepInput,
  showEditPrepInput,
  hideEditPrepInput,
  savePrepLinkInline,
  removePrepLinkInline,
  // Meeting Prep
  generateMeetingPrep,
  generateMeetingPrepByKey,
  // Conference
  toggleConferences,
  setConfRange,
  applyConfDateFilter,
  handleConfFile,
  geocodeConferences,
  // Popups
  flyToAccount,
  focusOnAccount,
  // Init
  initMap,
});

// Export initMap for main.js
export { initMap };
