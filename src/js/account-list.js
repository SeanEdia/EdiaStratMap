import S from './state.js';
import { districtKey } from './helpers.js';
import { openAccountModalWithData } from './account-modal.js';

// ============ ACCOUNT LIST ============
export function toggleAccountListOverlay() {
  S.accountListOpen = !S.accountListOpen;
  const overlay = document.getElementById('alOverlay');
  if (overlay) overlay.classList.toggle('open', S.accountListOpen);
  if (S._elCountBadge) S._elCountBadge.classList.toggle('active', S.accountListOpen);
  // Close action dashboard if open
  if (S.accountListOpen && S.actionDashboardOpen) {
    S.actionDashboardOpen = false;
    if (S._elAdOverlay) S._elAdOverlay.classList.remove('open');
    if (S._elAdTrigger) S._elAdTrigger.classList.remove('active');
  }
  if (S.accountListOpen) renderAccountList();
}

export function getStageInfo(d) {
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

export function getAccountListDefaultSort() {
  if (S.currentView === 'customers') return 'arr_desc';
  return 'enrollment_desc';
}

export function setAccountListSort(sortKey) {
  // If clicking the same base sort, toggle direction
  const baseKey = sortKey.replace(/_(?:asc|desc)$/, '');
  const currentBase = S.accountListSort.replace(/_(?:asc|desc)$/, '');
  if (baseKey === currentBase) {
    // Flip direction
    if (S.accountListSort.endsWith('_desc')) S.accountListSort = baseKey + '_asc';
    else S.accountListSort = baseKey + '_desc';
  } else {
    S.accountListSort = sortKey;
  }
  renderAccountList();
}

export function toggleAccountListGroup(groupBy) {
  if (S.accountListGroupBy === groupBy) S.accountListGroupBy = null;
  else S.accountListGroupBy = groupBy;
  S.collapsedGroups = {};
  renderAccountList();
}

export function toggleGroupCollapse(groupKey) {
  S.collapsedGroups[groupKey] = !S.collapsedGroups[groupKey];
  const items = document.getElementById('alg-items-' + groupKey.replace(/[^a-zA-Z0-9]/g, '_'));
  const header = document.getElementById('alg-header-' + groupKey.replace(/[^a-zA-Z0-9]/g, '_'));
  if (items) items.classList.toggle('collapsed-group');
  if (header) header.classList.toggle('collapsed');
}

export function sortAccountListData(items) {
  const sort = S.accountListSort;
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

export function parseActivityDate(str) {
  if (!str) return 0;
  const d = new Date(str);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

export function formatCompactNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return String(n);
}

export function buildAccountListRow(d, type) {
  const isStrat = type === 'accounts';
  const stage = isStrat ? getStageInfo(d) : { cls: 'stage-customer', label: 'Customer', order: 99 };
  const enrollment = parseInt(isStrat ? d.enrollment : d.students) || 0;
  const acv = isStrat ? (Number(d.opp_acv) || 0) : 0;
  const arr = !isStrat ? (parseFloat(d.arr) || 0) : 0;
  const dKey = districtKey(d);

  // Money column: ACV for accounts, ARR for customers
  const moneyText = (isStrat && acv > 0) ? '$' + formatCompactNumber(acv)
    : (!isStrat && arr > 0) ? '$' + formatCompactNumber(arr) : '';

  // Products column (opp_areas for accounts)
  const products = isStrat ? (d.opp_areas || '') : '';

  const escapedName = d.name.replace(/'/g, "\\'");
  const escapedState = (d.state || '').replace(/'/g, "\\'");
  return `<div class="account-list-item" data-name="${d.name.replace(/"/g, '&quot;')}" data-key="${dKey}"
    onmouseenter="highlightAccountMarker('${escapedName}','${escapedState}')"
    onmouseleave="unhighlightAccountMarker('${escapedName}','${escapedState}')"
    onclick="flyToAccount('${escapedName}','${escapedState}'); openAccountFromList('${dKey}')">
    <span class="al-stage-dot ${stage.cls}" title="${stage.label}"></span>
    <span class="al-name" title="${d.name}">${d.name}${d.expand_opp ? '<span class="al-expand-opp-badge" title="District expansion opportunity">★</span>' : ''}</span>
    <span class="al-col al-col-state">${d.state || ''}</span>
    <span class="al-col al-col-enroll">${enrollment > 0 ? formatCompactNumber(enrollment) : ''}</span>
    <span class="al-col al-col-acv">${moneyText}</span>
    <span class="al-col al-col-products" title="${products}">${products}</span>
    <button class="al-expand-btn" onclick="event.stopPropagation();openAccountFromList('${dKey}')" title="Open full view">&#x2197;</button>
  </div>`;
}

export function highlightAccountMarker(name, state) {
  const entry = S.markerLookup[name + '|' + (state || '')];
  if (!entry || !entry.marker) return;
  const el = entry.marker.getElement();
  if (el) el.classList.add('marker-highlight');
}

export function unhighlightAccountMarker(name, state) {
  const entry = S.markerLookup[name + '|' + (state || '')];
  if (!entry || !entry.marker) return;
  const el = entry.marker.getElement();
  if (el) el.classList.remove('marker-highlight');
}

export function flyToAccount(name, state) {
  const entry = S.markerLookup[name + '|' + (state || '')];
  if (!entry || !entry.marker) return;
  const latLng = entry.marker.getLatLng();
  // Offset center north so the pin sits near the bottom and the popup is centered on screen
  const targetZoom = 7;
  const offsetLat = latLng.lat + 2.5;
  S._ensurePopup(entry.marker, entry.data, entry.type);
  S.map.flyTo([offsetLat, latLng.lng], targetZoom, { duration: 0.6 });
  setTimeout(() => { entry.marker.openPopup(); }, 50);
}

export function openAccountFromList(dKey) {
  let d = window.districtDataCache && window.districtDataCache[dKey];
  if (!d) {
    // Fallback: search S.markerLookup using districtKey for correct name+state matching
    const match = Object.entries(S.markerLookup).find(([k, v]) => districtKey(v.data) === dKey);
    if (match) d = match[1].data;
  }
  if (d) {
    openAccountModalWithData(d);
  }
}

export function renderAccountList() {
  // Early exit: skip all data processing when overlay is closed
  if (!S.accountListOpen) return;

  const body = document.getElementById('accountListBody');
  const countEl = document.getElementById('accountListCount');
  const sortBar = document.getElementById('accountListSortBar');
  // Count badge is updated by updateCountBadge, no separate trigger

  // Build unified list of items to show
  let items = [];
  const showStrat = S.currentView === 'accounts' || S.currentView === 'all';
  const showCust = S.currentView === 'customers' || S.currentView === 'all';

  if (showStrat) {
    S.filteredAccountData.forEach(d => {
      if (d.lat && d.lng) items.push({ data: d, type: 'accounts' });
    });
  }
  if (showCust) {
    S.filteredCustData.forEach(d => {
      if (d.lat && d.lng) {
        // Avoid duplicates if already in accounts
        const mlKeyDup = d.name + '|' + (d.state || '');
        if (!showStrat || !S.markerLookup[mlKeyDup] || S.markerLookup[mlKeyDup].type !== 'accounts') {
          items.push({ data: d, type: 'customer' });
        }
      }
    });
  }

  // Total counts
  const totalCount = (showStrat ? S.ACCOUNT_DATA.length : 0) + (showCust ? S.CUSTOMER_DATA.length : 0);
  if (countEl) countEl.textContent = `Showing ${items.length} of ${totalCount} accounts`;

  // Render column header row (clickable to sort)
  const isCust = S.currentView === 'customers';
  function colSortArrow(colKey) {
    const baseKey = colKey.replace(/_(?:asc|desc)$/, '');
    const currentBase = S.accountListSort.replace(/_(?:asc|desc)$/, '');
    if (baseKey !== currentBase) return '';
    return S.accountListSort.endsWith('_desc') ? ' ↓' : ' ↑';
  }
  const moneyLabel = isCust ? 'ARR' : 'ACV';
  const moneyKey = isCust ? 'arr_desc' : 'acv_desc';
  // Group buttons row (above column headers)
  let sortHtml = `<div class="al-group-bar">`;
  sortHtml += `<span class="al-group-label">Group</span>`;
  sortHtml += `<button class="account-list-group-btn ${S.accountListGroupBy === 'state' ? 'active' : ''}" onclick="toggleAccountListGroup('state')">State</button>`;
  if (showStrat && S.currentView !== 'customers') {
    sortHtml += `<button class="account-list-group-btn ${S.accountListGroupBy === 'stage' ? 'active' : ''}" onclick="toggleAccountListGroup('stage')">Stage</button>`;
  }
  sortHtml += `</div>`;

  // Column headers
  sortHtml += `<div class="al-header-row">`;
  sortHtml += `<span class="al-hdr-dot-spacer"></span>`;
  sortHtml += `<span class="al-hdr al-hdr-name" onclick="setAccountListSort('name_asc')">Name${colSortArrow('name_asc')}</span>`;
  sortHtml += `<span class="al-hdr al-hdr-state" onclick="setAccountListSort('state_asc')">State${colSortArrow('state_asc')}</span>`;
  sortHtml += `<span class="al-hdr al-hdr-enroll" onclick="setAccountListSort('enrollment_desc')">Students${colSortArrow('enrollment_desc')}</span>`;
  sortHtml += `<span class="al-hdr al-hdr-acv" onclick="setAccountListSort('${moneyKey}')">${moneyLabel}${colSortArrow(moneyKey)}</span>`;
  sortHtml += `<span class="al-hdr al-hdr-products" onclick="setAccountListSort('products_asc')">Products${colSortArrow('products_asc')}</span>`;
  sortHtml += `<span class="al-hdr-btn-spacer"></span>`;
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
  const displayLimit = S.accountListDisplayLimit || ACCOUNT_LIST_PAGE_SIZE;

  if (S.accountListGroupBy) {
    body.innerHTML = renderGroupedList(sortedData, itemTypeMap);
  } else {
    let html = '';
    const visible = sortedData.slice(0, displayLimit);
    visible.forEach(d => {
      html += buildAccountListRow(d, itemTypeMap[d.name] || 'accounts');
    });
    if (sortedData.length > displayLimit) {
      html += `<div class="account-list-show-more" onclick="showMoreAccounts()">Show more (${sortedData.length - displayLimit} remaining)</div>`;
    }
    body.innerHTML = html;
  }
}

export function showMoreAccounts() {
  S.accountListDisplayLimit += 200;
  renderAccountList();
}

export function renderGroupedList(sortedData, itemTypeMap) {
  const groups = {};
  const groupOrder = [];

  sortedData.forEach(d => {
    let groupKey;
    if (S.accountListGroupBy === 'state') {
      groupKey = d.state || 'Unknown';
    } else if (S.accountListGroupBy === 'stage') {
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
    const isCollapsed = S.collapsedGroups[key];

    html += `<div class="account-list-group-header ${isCollapsed ? 'collapsed' : ''}" id="alg-header-${safeKey}" onclick="toggleGroupCollapse('${key.replace(/'/g, "\\'")}')">
      <span class="account-list-group-chevron">&#9660;</span>
      <span class="account-list-group-name">${key}</span>
      <span class="account-list-group-count">(${items.length})</span>
    </div>`;
    html += `<div class="account-list-group-items ${isCollapsed ? 'collapsed-group' : ''}" id="alg-items-${safeKey}">`;
    items.forEach(d => {
      html += buildAccountListRow(d, itemTypeMap[d.name] || 'accounts');
    });
    html += `</div>`;
  });

  return html;
}

// ============ UI HELPERS ============
export function updateCountBadge(strat, cust) {
  const badge = S._elCountBadge;
  if (S.currentView === 'accounts') {
    badge.innerHTML = `<span class="cb-num cb-strat">${strat}</span> accounts`;
  } else if (S.currentView === 'customers') {
    badge.innerHTML = `<span class="cb-num cb-cust">${cust}</span> customers`;
  } else {
    badge.innerHTML = `<span class="cb-num cb-strat">${strat}</span> accounts · <span class="cb-num cb-cust">${cust}</span> customers`;
  }
}

export function updateLegend() {
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
  items += `<div class="legend-item"><div class="legend-dot cust expand-opp"></div>District expansion opp</div>`;
  legend.innerHTML = items;
  legend.style.display = 'flex';
}

