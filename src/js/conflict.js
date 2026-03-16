import S from './state.js';
import { districtKey, escapeHtml, escapeAttr } from './helpers.js';
import { STRATEGIC_ENROLLMENT_THRESHOLD, saveConflicts, buildIndices, ensurePopup } from './app.js';
import { formatCompactNumber } from './account-list.js';
import { downloadJsonFile } from './multi-opp.js';
import { openAccountModalWithData } from './account-modal.js';

// ============ CONFLICT MANAGEMENT ============
S.conflictsOverlayOpen = false;

/** Append newly detected conflicts, deduplicating by district name. */
export function storeNewConflicts(mergeStats) {
  const newConflicts = mergeStats && mergeStats.conflicts ? mergeStats.conflicts : [];
  if (newConflicts.length === 0) return;
  const existingNames = new Set(S.CONFLICTS.map(c => c.name));
  newConflicts.forEach(c => {
    if (existingNames.has(c.name)) {
      // Update existing conflict with new AE info
      const idx = S.CONFLICTS.findIndex(x => x.name === c.name);
      if (idx !== -1) S.CONFLICTS[idx] = c;
    } else {
      S.CONFLICTS.push(c);
    }
  });
  saveConflicts(S.CONFLICTS);
  console.log('[Conflicts] Stored', S.CONFLICTS.length, 'total conflicts');
}

/** Find active conflict for a given district name. */
export function getConflictForAccount(name) {
  return S.CONFLICTS.find(c => c.name === name) || null;
}

/** Toggle Conflicts overlay panel. */
export function toggleConflictsOverlay() {
  S.conflictsOverlayOpen = !S.conflictsOverlayOpen;
  const overlay = document.getElementById('conflictsOverlay');
  const trigger = document.getElementById('conflictsTrigger');
  if (overlay) overlay.classList.toggle('open', S.conflictsOverlayOpen);
  if (trigger) trigger.classList.toggle('active', S.conflictsOverlayOpen);
  if (S.conflictsOverlayOpen) renderConflictsOverlay();
}

/** Update the conflict count badge. */
export function updateConflictsBadge() {
  const wrap = document.getElementById('conflictsTriggerWrap');
  const badge = document.getElementById('conflictsCount');
  if (!wrap || !badge) return;
  const exportBtn = document.getElementById('conflictsExportBtn');
  if (S.CONFLICTS.length > 0) {
    wrap.style.display = '';
    badge.textContent = S.CONFLICTS.length;
    if (exportBtn) exportBtn.style.display = '';
  } else {
    wrap.style.display = 'none';
    S.conflictsOverlayOpen = false;
    const overlay = document.getElementById('conflictsOverlay');
    if (overlay) overlay.classList.remove('open');
    if (exportBtn) exportBtn.style.display = 'none';
  }
}

/** Derive a human-readable conflict type label from conflict context. */
export function getConflictTypeLabel(c) {
  const hasNewOpp = !!c.hasOpp;
  const hasExistingOpps = (c.existingOpps || []).length > 0;
  let label, description;
  if (hasNewOpp && hasExistingOpps) {
    label = 'Competing Opportunities';
    description = 'Both reps have active opps on this account.';
  } else if (hasNewOpp && !hasExistingOpps) {
    label = 'New Opp vs Existing Owner';
    description = 'Upload brings a new opp under a different rep.';
  } else if (!hasNewOpp && hasExistingOpps) {
    label = 'Account Owner Change';
    description = 'CSV reassigns the account away from a rep with active opps.';
  } else {
    label = 'Account Ownership';
    description = 'SFDC account owner mismatch — no opp data either side.';
  }
  // Append opp owner note if it differs from both AEs
  const oppOwner = (c.oppOwner || '').trim();
  if (oppOwner && oppOwner !== c.oldAE && oppOwner !== c.newAE) {
    label += ' (Opp Owner: ' + oppOwner + ')';
  }
  return { label, description };
}

/** Get account type badge text for a conflict. */
export function getConflictAccountType(c) {
  if (c.isInactiveCustomer) return 'Inactive Customer';
  if (c.isCustomer) {
    if (c.arr) return 'Customer \u2022 $' + formatCompactNumber(c.arr) + ' ARR';
    return 'Account + Customer';
  }
  return 'Account';
}

/** Render the conflicts list in the overlay panel. */
export function renderConflictsOverlay() {
  const body = document.getElementById('conflictsBody');
  if (!body) return;

  if (S.CONFLICTS.length === 0) {
    body.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:12px;">No conflicts to resolve</div>';
    return;
  }

  let html = `<div style="font-size:10px;color:var(--text-dim);margin-bottom:10px;">
    ${S.CONFLICTS.length} account${S.CONFLICTS.length !== 1 ? 's' : ''} with conflicting ownership. Click to navigate, then resolve.
  </div>`;
  S.CONFLICTS.forEach((c, idx) => {
    const enrollment = c.enrollment ? parseInt(c.enrollment).toLocaleString() : '—';
    const isStrategic = (parseInt(c.enrollment) || 0) >= STRATEGIC_ENROLLMENT_THRESHOLD;
    const stratBadge = isStrategic ? '<span class="conflict-strategic-badge">Strategic</span>' : '';
    const accountType = getConflictAccountType(c);
    const conflictType = getConflictTypeLabel(c);

    // Old rep detail card
    const oldTeamStr = c.oldTeam ? ' (' + escapeHtml(c.oldTeam) + ')' : '';
    const existingOpps = c.existingOpps || [];
    let oldOppHtml = '';
    if (existingOpps.length > 0) {
      const showOpps = existingOpps.slice(0, 2);
      oldOppHtml = '<div class="conflict-opp-list">Has ' + existingOpps.length + ' existing opp' + (existingOpps.length !== 1 ? 's' : '') + ':';
      showOpps.forEach(o => {
        const acvStr = o.acv ? ' &mdash; $' + formatCompactNumber(o.acv) : '';
        oldOppHtml += '<div class="conflict-opp-item">\u2022 ' + escapeHtml(o.area || 'Unknown') + ' &mdash; ' + escapeHtml(o.stage || 'No stage') + acvStr + '</div>';
      });
      if (existingOpps.length > 2) oldOppHtml += '<div class="conflict-opp-item" style="opacity:0.6;">and ' + (existingOpps.length - 2) + ' more</div>';
      oldOppHtml += '</div>';
    } else {
      oldOppHtml = '<div class="conflict-opp-list" style="opacity:0.5;">No opportunity data</div>';
    }

    // New rep detail card
    const newTeamStr = c.newTeam ? ' (' + escapeHtml(c.newTeam) + ')' : '';
    let newOppHtml = '';
    if (c.hasOpp) {
      newOppHtml = '<div class="conflict-opp-list">CSV row includes opp:';
      const areaStr = c.oppAreas || 'Unknown';
      const stageStr = c.oppStage || 'No stage';
      const acvStr = c.oppAcv ? '<div class="conflict-opp-item">\u2022 ACV: $' + formatCompactNumber(c.oppAcv) + '</div>' : '';
      newOppHtml += '<div class="conflict-opp-item">\u2022 ' + escapeHtml(areaStr) + ' &mdash; ' + escapeHtml(stageStr) + '</div>' + acvStr;
      newOppHtml += '</div>';
    } else {
      newOppHtml = '<div class="conflict-opp-list" style="opacity:0.5;">No opportunity data</div>';
    }

    // Opp owner callout
    const oppOwner = (c.oppOwner || '').trim();
    const oppOwnerNote = (oppOwner && oppOwner !== c.oldAE && oppOwner !== c.newAE)
      ? '<div class="conflict-opp-owner-note">Opp Owner in SFDC: ' + escapeHtml(oppOwner) + '</div>' : '';

    html += `<div class="conflict-item">
      <div class="conflict-item-header" onclick="navigateToConflict(${idx})">
        <div class="conflict-name">${escapeHtml(c.name)} ${stratBadge}</div>
        <div class="conflict-detail">${c.state || '—'} &bull; ${enrollment} students &bull; <span class="conflict-account-type">${escapeHtml(accountType)}</span></div>
      </div>
      <div class="conflict-type-label">\u26A1 ${escapeHtml(conflictType.label)}</div>
      <div class="conflict-type-desc">${escapeHtml(conflictType.description)}</div>
      <div class="conflict-rep-card conflict-rep-old">
        <div class="conflict-rep-card-title">Current Owner</div>
        <div class="conflict-rep-card-name">${escapeHtml(c.oldAE)}${oldTeamStr}</div>
        ${oldOppHtml}
      </div>
      <div class="conflict-rep-card conflict-rep-new">
        <div class="conflict-rep-card-title">From SFDC Upload</div>
        <div class="conflict-rep-card-name">${escapeHtml(c.newAE)}${newTeamStr}</div>
        ${newOppHtml}
      </div>
      ${oppOwnerNote}
      <div class="conflict-actions">
        <button class="conflict-resolve-btn" onclick="resolveConflict(${idx}, '${escapeAttr(c.oldAE)}')">Keep ${escapeHtml(c.oldAE.split(' ')[0])}</button>
        <button class="conflict-resolve-btn conflict-resolve-new" onclick="resolveConflict(${idx}, '${escapeAttr(c.newAE)}')">Assign ${escapeHtml(c.newAE.split(' ')[0])}</button>
      </div>
    </div>`;
  });
  body.innerHTML = html;
}

// escapeHtml and escapeAttr imported from helpers.js

/** Export all conflicts as a rich CSV download. */
export function exportConflicts() {
  if (S.CONFLICTS.length === 0) {
    alert('No conflicts to export.');
    return;
  }

  const headers = [
    'Account Name', 'State', 'Enrollment', 'Strategic', 'Account Type',
    'Conflict Type', 'Conflict Description', 'Current Owner (Kept)',
    'Current Owner Team', 'Conflicting Owner (From CSV)', 'Conflicting Owner Team',
    'Opp Owner (SFDC)', 'Existing Opps', 'CSV Opp Area', 'CSV Opp Stage',
    'CSV Opp ACV', 'Region', 'City', 'Is Customer', 'ARR'
  ];

  function csvEscape(val) {
    const s = String(val == null ? '' : val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  const rows = [headers.map(csvEscape).join(',')];

  S.CONFLICTS.forEach(c => {
    const acct = S.ACCOUNT_DATA.find(a => a.name === c.name);
    const isStrategic = (parseInt(c.enrollment) || 0) >= STRATEGIC_ENROLLMENT_THRESHOLD;
    const conflictType = getConflictTypeLabel(c);
    const existingOpps = (c.existingOpps || []).length > 0
      ? c.existingOpps.map(o => (o.area || 'Unknown') + ' \u2014 ' + (o.stage || 'No stage')).join(', ')
      : 'None';

    const row = [
      c.name,
      c.state,
      c.enrollment,
      isStrategic ? 'Yes' : 'No',
      getConflictAccountType(c),
      conflictType.label,
      conflictType.description,
      c.oldAE,
      c.oldTeam || '\u2014',
      c.newAE,
      c.newTeam || '\u2014',
      c.oppOwner || '\u2014',
      existingOpps,
      c.oppAreas || '\u2014',
      c.oppStage || '\u2014',
      c.oppAcv || '\u2014',
      (acct && acct.region) || '\u2014',
      (acct && acct.city) || '\u2014',
      c.isCustomer ? 'Yes' : 'No',
      c.arr || '\u2014'
    ];
    rows.push(row.map(csvEscape).join(','));
  });

  const csv = rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = 'edia_conflicts_all_' + today + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Refresh the conflict banner in the account modal after resolving a conflict. */
export function refreshModalConflictBanner(accountName) {
  const banner = document.getElementById('modalConflictBanner');
  if (!banner) return;
  const conflict = getConflictForAccount(accountName);
  if (!conflict) {
    banner.style.display = 'none';
  }
}

/** Navigate map to a conflicted account. */
export function navigateToConflict(idx) {
  const c = S.CONFLICTS[idx];
  if (!c) return;
  const dKey = districtKey(c);
  // Try markerLookup first (visible pins)
  const entry = S.markerLookup[c.name + '|' + (c.state || '')];
  if (entry && entry.marker) {
    const latLng = entry.marker.getLatLng();
    S.map.flyTo(latLng, 8, { duration: 0.6 });
    setTimeout(() => { ensurePopup(entry.marker, entry.data, entry.type); entry.marker.openPopup(); }, 400);
  } else {
    // Account may not be visible with current filters — open modal directly
    const d = S.ACCOUNT_DATA.find(a => a.name === c.name) || (window.districtDataCache && window.districtDataCache[dKey]);
    if (d) openAccountModalWithData(d);
  }
}

/** Resolve a conflict — password-protected (independent from data refresh). */
const CONFLICT_RESOLVE_PASSWORD = 'EdiaManager26';
S.conflictResolveAuthed = false;

export function promptConflictPassword() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'pw-modal-backdrop';
    backdrop.innerHTML = `
      <div class="pw-modal">
        <h3>Conflict Resolution</h3>
        <p>Enter the password to resolve account conflicts.</p>
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
      if (input.value === CONFLICT_RESOLVE_PASSWORD) {
        S.conflictResolveAuthed = true;
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

export function resolveConflict(idx, chosenAE) {
  if (!S.conflictResolveAuthed) {
    promptConflictPassword().then(ok => {
      if (ok) resolveConflictConfirmed(idx, chosenAE);
    });
    return;
  }
  resolveConflictConfirmed(idx, chosenAE);
}

/** Flag to prevent click-outside handler from closing overlay during resolve re-render. */
let _conflictResolving = false;

/** Apply conflict resolution after authentication. */
async function resolveConflictConfirmed(idx, chosenAE) {
  _conflictResolving = true;
  const c = S.CONFLICTS[idx];
  if (!c) return;

  // Update account in S.ACCOUNT_DATA
  const account = S.ACCOUNT_DATA.find(a => a.name === c.name);
  if (account) {
    account.ae = chosenAE;
    console.log('[Conflicts] Resolved:', c.name, '→', chosenAE);
  }

  // Remove from conflicts
  S.CONFLICTS.splice(idx, 1);
  saveConflicts(S.CONFLICTS);

  // Persist updated account data
  S._saveDataToLocalStorage(S.ACCOUNT_DATA, null);

  // Update district data cache
  if (account) {
    const key = districtKey(account);
    window.districtDataCache[key] = account;
  }

  // Refresh UI
  buildIndices();
  renderConflictsOverlay();
  updateConflictsBadge();
  S._applyFilters();

  // Auto-download updated JSON files when all conflicts are resolved
  if (S.CONFLICTS.length === 0) {
    console.log('[Conflicts] All conflicts resolved — downloading updated JSON files');
    downloadJsonFile(S.ACCOUNT_DATA, 'accounts.json');
    await new Promise(resolve => setTimeout(resolve, 500));
    downloadJsonFile(S.CUSTOMER_DATA, 'customers.json');
  }
}

// Close conflicts overlay when clicking outside
document.addEventListener('click', function(e) {
  if (!S.conflictsOverlayOpen) return;
  // Skip close if a conflict was just resolved (the clicked button was removed from DOM by re-render)
  if (_conflictResolving) {
    _conflictResolving = false;
    return;
  }
  const overlay = document.getElementById('conflictsOverlay');
  const trigger = document.getElementById('conflictsTrigger');
  if (overlay && trigger && !overlay.contains(e.target) && !trigger.contains(e.target)) {
    S.conflictsOverlayOpen = false;
    overlay.classList.remove('open');
    trigger.classList.remove('active');
  }
});

