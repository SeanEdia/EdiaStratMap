import S from './state.js';
import { districtKey, haversine, escapeHtml, escapeAttr, formatLastActivity, isDOE } from './helpers.js';
import { buildOppEntry, isManagerHeld, getTerritoryAE, getHoldoutAE, formatProbability } from './app.js';
import { getConflictForAccount, getConflictTypeLabel } from './conflict.js';
import { getAccountNotes, formatNoteTime } from './notes.js';
import { closeMergeModal } from './multi-opp.js';
import { processUploadFile } from './data-merge.js';

S.currentModalData = null;

export function openAccountModalByKey(dKey) {
  const d = window.districtDataCache && window.districtDataCache[dKey];
  if (d) {
    openAccountModalWithData(d);
  } else {
    console.error('District data not found for key:', dKey);
  }
}

export function openAccountModal(encodedData) {
  try {
    const d = JSON.parse(decodeURIComponent(encodedData));
    openAccountModalWithData(d);
  } catch (e) {
    console.error('Error opening modal:', e);
  }
}

export function openAccountModalWithData(d) {
  if (window.innerWidth <= 1024 && typeof window.closeMobileSidebar === 'function') window.closeMobileSidebar();
  if (window.innerWidth <= 1024) window.history.pushState({ overlay: true }, '');
  S.currentModalData = d;

  // Set header info
  document.getElementById('modalAccountName').textContent = d.name;
  document.getElementById('modalAccountSubtitle').textContent =
    `${d.state || ''} • ${d.region || ''} • ${d.enrollment ? parseInt(d.enrollment).toLocaleString() + ' students' : ''}`;

  // Set badge
  const badge = document.getElementById('modalAccountBadge');
  const holdoutAE = getHoldoutAE(d);
  if (isDOE(d.name)) {
    badge.textContent = 'Dept. of Education';
    badge.className = 'account-modal-badge doe';
  } else if (d.is_customer) {
    badge.textContent = 'Account + Customer';
    badge.className = 'account-modal-badge both';
  } else if (d.type === 'Inactive Customer') {
    badge.textContent = 'Inactive Customer';
    badge.className = 'account-modal-badge inactive';
  } else {
    badge.textContent = 'Account';
    badge.className = 'account-modal-badge accounts';
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

  // === OPP TYPE BADGES (one per opp) ===
  const oppBadgeContainer = document.getElementById('modalOppTypeBadges');
  if (oppBadgeContainer) {
    oppBadgeContainer.innerHTML = '';

    // Collect district-level opps
    const allOpps = d.opps && d.opps.length > 0 ? d.opps : (d.opp_stage ? [buildOppEntry(d)] : []);
    const districtOpps = allOpps.filter(o => !o.school_name);

    districtOpps.forEach(opp => {
      // Parse semicolon-delimited areas for this single opp
      const raw = opp.area || 'Opportunity';
      const areas = raw.split(';').map(a => a.trim()).filter(Boolean);

      // Build short label for this opp
      const SHORT_LABELS = {
        'math': 'Math',
        'attendance': 'Attendance',
        'district intelligence': 'DIP',
        'district bundle (all 3)': 'Bundle'
      };
      const label = areas.map(a => SHORT_LABELS[a.toLowerCase()] || a).join(' + ');

      // Determine color class based on primary area
      const primary = areas[0] ? areas[0].toLowerCase() : '';
      let colorClass = 'multi';
      if (areas.length === 1) {
        if (primary.includes('math')) colorClass = 'math';
        else if (primary.includes('attendance')) colorClass = 'attendance';
        else if (primary.includes('district intelligence')) colorClass = 'di';
        else if (primary.includes('bundle')) colorClass = 'multi';
      }

      const pill = document.createElement('span');
      pill.className = `opp-type-badge ${colorClass}`;
      pill.textContent = label;
      oppBadgeContainer.appendChild(pill);
    });
  }

  // Show conflict banner if this account has an active conflict
  let conflictBanner = document.getElementById('modalConflictBanner');
  if (!conflictBanner) {
    conflictBanner = document.createElement('div');
    conflictBanner.id = 'modalConflictBanner';
    conflictBanner.className = 'modal-conflict-banner';
    const tabsEl = document.querySelector('.account-tabs');
    if (tabsEl) tabsEl.parentNode.insertBefore(conflictBanner, tabsEl);
  }
  const conflict = getConflictForAccount(d.name);
  if (conflict) {
    const cidx = S.CONFLICTS.indexOf(conflict);
    const conflictTypeInfo = getConflictTypeLabel(conflict);
    conflictBanner.innerHTML = `
      <div class="modal-conflict-inner">
        <span class="modal-conflict-icon">&#9888;</span>
        <div class="modal-conflict-text">
          <strong>Ownership conflict &mdash; ${escapeHtml(conflictTypeInfo.label)}</strong>
          <div>${escapeHtml(conflict.oldAE)}${conflict.oldTeam ? ' (' + escapeHtml(conflict.oldTeam) + ')' : ''} vs ${escapeHtml(conflict.newAE)}${conflict.newTeam ? ' (' + escapeHtml(conflict.newTeam) + ')' : ''}</div>
        </div>
        <div class="modal-conflict-btns">
          <button onclick="resolveConflict(${cidx}, '${escapeAttr(conflict.oldAE)}');refreshModalConflictBanner('${escapeAttr(d.name)}')">Keep ${escapeHtml(conflict.oldAE.split(' ')[0])}</button>
          <button onclick="resolveConflict(${cidx}, '${escapeAttr(conflict.newAE)}');refreshModalConflictBanner('${escapeAttr(d.name)}')">Assign ${escapeHtml(conflict.newAE.split(' ')[0])}</button>
        </div>
      </div>`;
    conflictBanner.style.display = '';
  } else {
    conflictBanner.style.display = 'none';
  }

  // Show/hide Schools tab based on whether this district has schools
  const schoolsTabBtn = document.getElementById('schoolsTabBtn');
  if (schoolsTabBtn) {
    schoolsTabBtn.style.display = (d._schools && d._schools.length > 0) ? '' : 'none';
  }

  // Populate tabs
  populateInfoTab(d);
  populateSchoolsTab(d);
  populateMathTab(d);
  populateAttendanceTab(d);
  populateDipTab(d);
  populateDistrictIntelTab(d);

  // Reset to Info tab
  switchTab('info', document.querySelector('.account-tab'));

  // Show modal
  document.getElementById('accountModal').classList.add('show');
  document.body.style.overflow = 'hidden';

  // Mobile tab swiping
  if (window.innerWidth <= 1024) setupModalTabSwipe();
  if (window.innerWidth <= 1024) setupModalPullDown();
}

export function closeAccountModal() {
  document.getElementById('accountModal').classList.remove('show');
  document.body.style.overflow = '';
  S.currentModalData = null;
  // Don't reset map position — user should return to where they were
}

export function switchTab(tabId, btnEl) {
  // Update tab buttons
  document.querySelectorAll('.account-tab').forEach(t => t.classList.remove('active', 'active-cust'));
  btnEl.classList.add('active');

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab' + tabId.charAt(0).toUpperCase() + tabId.slice(1)).classList.add('active');
}

export function populateInfoTab(d) {
  const noteKey = 'edia_notes_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
  const notes = getAccountNotes(noteKey);
  const prepLinkKey = 'edia_prep_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
  const savedPrepLink = localStorage.getItem(prepLinkKey) || d.prep_doc_url || '';

  let html = '';
  html += `<div class="modal-grid">`;

  // Basic Info Section
  const schoolCount = (d._schools && d._schools.length) || 0;
  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">🏫</span> District Overview</div>
    ${modalRow('Enrollment', d.enrollment ? parseInt(d.enrollment).toLocaleString() : '—')}
    ${schoolCount > 0 ? modalRow('Schools', schoolCount.toLocaleString()) : ''}
    ${modalRow('State', d.state)}
    ${modalRow('Region', d.region)}
    ${modalRow('Account Executive', (() => { if (isManagerHeld(d)) return '<span class="manager-held-badge">Unassigned</span> <span class="ae-role">(held by ' + d.ae + ')</span>'; const tAE = getTerritoryAE(d); const hAE = getHoldoutAE(d); return tAE ? (hAE ? tAE + ' <span class="ae-role">(Assigned)</span><br>' + hAE + ' <span class="ae-role">(Holdout)</span>' : tAE) : '—'; })(), true)}
    ${modalRow('SIS Platform', d.sis || '—')}
    ${modalRow('Website', d.website ? `<a href="${d.website.startsWith('http') ? d.website : 'https://' + d.website}" target="_blank" style="color:var(--accent-cust);">${d.website}</a>` : '—', true)}
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

  // Opportunity Section — render one card per opp (district-level only)
  const allInfoOpps = d.opps && d.opps.length > 0 ? d.opps : (d.opp_stage ? [buildOppEntry(d)] : []);
  const districtInfoOpps = allInfoOpps.filter(o => !o.school_name);
  const hasSchoolInfoOpp = allInfoOpps.some(o => o.school_name);
  if (hasSchoolInfoOpp) {
    html += `<div style="font-size:11px;color:#e17055;margin:8px 0;font-weight:600;">🏫 This account has school-level opp(s) — see Schools tab for details</div>`;
  }
  districtInfoOpps.forEach(opp => {
    let stageClass = 'discovery';
    const stage = opp.stage || '';
    if (stage.includes('Demo')) stageClass = 'demo';
    else if (stage.includes('Scoping')) stageClass = 'scoping';
    else if (stage.includes('Proposal')) stageClass = 'proposal';
    else if (stage.includes('Validation')) stageClass = 'validation';
    else if (stage.includes('Procurement')) stageClass = 'procurement';

    const areaLabel = opp.area || 'Opportunity';
    html += `<div class="modal-section opp-card">
      <div class="modal-section-title"><span class="icon">💼</span> ${areaLabel}</div>
      <span class="opp-stage-badge ${stageClass}">${stage}</span>
      ${modalRow('Forecast', opp.forecast || '—')}
      ${modalRow('Probability', formatProbability(opp.probability) || '—')}
      ${modalRow('Year 1 ACV', opp.acv ? '$' + Number(opp.acv).toLocaleString() : '—')}
      ${modalRow('Contact', opp.contact ? opp.contact + (opp.contact_title ? ' (' + opp.contact_title + ')' : '') : '—')}
      ${modalRow('Next Step', opp.next_step || '—')}
      ${modalRow('Last Activity', formatLastActivity(opp.last_activity))}
      ${modalRow('SDR', opp.sdr || '—')}
    </div>`;
  });

  // Resources Section
  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">🔗</span> Resources</div>`;
  if (d.org_chart_url) {
    html += modalRow('Org Chart', `<a href="${d.org_chart_url}" target="_blank">View →</a>`, true);
  }
  if (d.strategic_plan_url) {
    html += modalRow('Strategic Plan', `<a href="${d.strategic_plan_url}" target="_blank">View →</a>`, true);
  }
  // SFDC base URL
  const SFDC_BASE = 'https://edialearninginc.lightning.force.com/lightning/r';

  // SFDC Account link
  if (d.account_id && d.account_id !== '000000000000000') {
    const sfdcAcctUrl = `${SFDC_BASE}/Account/${d.account_id}/view`;
    html += modalRow('SFDC Account', `<a href="${escapeAttr(sfdcAcctUrl)}" target="_blank" class="sfdc-resource-link">View →</a>`, true);
  }

  // SFDC Parent Account link
  if (d.parent_account_id && d.parent_account_id.trim() !== '' && d.parent_account_id.trim() !== '000000000000000') {
    const parentLabel = d.parent_account ? `SFDC Parent — ${d.parent_account}` : 'SFDC Parent Account';
    const sfdcParentUrl = `${SFDC_BASE}/Account/${d.parent_account_id.trim()}/view`;
    html += modalRow(parentLabel, `<a href="${escapeAttr(sfdcParentUrl)}" target="_blank" class="sfdc-resource-link">View →</a>`, true);
  }

  // SFDC Opportunity links (one per district-level opp)
  const resOpps = d.opps && d.opps.length > 0 ? d.opps : (d.opp_stage ? [buildOppEntry(d)] : []);
  const districtResOpps = resOpps.filter(o => !o.school_name && o.opportunity_id);
  districtResOpps.forEach(opp => {
    const sfdcOppUrl = `${SFDC_BASE}/Opportunity/${opp.opportunity_id}/view`;
    const label = opp.area ? `SFDC Opp — ${opp.area}` : 'SFDC Opp';
    html += modalRow(label, `<a href="${escapeAttr(sfdcOppUrl)}" target="_blank" class="sfdc-resource-link">View →</a>`, true);
  });

  // Gong Contacts link (keyed off SFDC Account ID, same as SFDC Account link)
  if (d.account_id && d.account_id !== '000000000000000') {
    const gongContactsUrl = `https://app.gong.io/engage/accounts/CRM/${d.account_id}/contacts`;
    html += modalRow('Gong Contacts', `<a href="${escapeAttr(gongContactsUrl)}" target="_blank" class="sfdc-resource-link">View →</a>`, true);
  }

  if (savedPrepLink) {
    html += modalRow('Meeting Prep', `<a href="${savedPrepLink}" target="_blank">View →</a>`, true);
  }
  if (!d.org_chart_url && !d.strategic_plan_url && !savedPrepLink && districtResOpps.length === 0 && !(d.account_id && d.account_id !== '000000000000000') && !(d.parent_account_id && d.parent_account_id.trim() !== '' && d.parent_account_id.trim() !== '000000000000000')) {
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
          <span style="font-size:11px;font-weight:600;color:var(--accent-strat);">${n.author}</span>
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

export function populateMathTab(d) {
  let html = `<div class="modal-grid">`;

  // Math Overview
  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">📐</span> Math Overview</div>`;

  if (d.math_curriculum) {
    html += `<div class="product-highlight math">
      <div class="label">Core Math Curriculum</div>
      <div class="value">${d.math_curriculum}</div>
    </div>`;
  } else {
    html += `<div style="color:var(--text-muted);font-size:12px;margin-bottom:12px;">No core math curriculum recorded</div>`;
  }

  if (d.math_supplemental) {
    html += `<div class="product-highlight math" style="border-color:#fdcb6e;">
      <div class="label">Math Supplemental</div>
      <div class="value">${d.math_supplemental}</div>
    </div>`;
  }

  // Math-related opportunity info — find Math opp from opps array
  const mathOpp = (d.opps || []).find(o => !o.school_name && (o.area || '').toLowerCase().includes('math'));
  if (mathOpp) {
    html += `<div class="product-highlight math" style="border-color:#55efc4;">
      <div class="label">Active Math Opportunity</div>
      <div class="value">${mathOpp.stage || 'In Progress'}</div>
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

  // Opp contact from Math opp entry
  if (mathOpp && mathOpp.contact) {
    html += `<div class="contact-card" style="border-left:3px solid #55efc4;">
      <div class="name">${mathOpp.contact}</div>
      <div class="title">${mathOpp.contact_title || 'Opportunity Contact'}</div>
    </div>`;
  }
  html += `</div>`;

  // Competition/Intel - only show if Math opp exists
  if (mathOpp && (mathOpp.competition || mathOpp.economic_buyer || mathOpp.champion)) {
    html += `<div class="modal-section">
      <div class="modal-section-title"><span class="icon">🎯</span> Math Opp Intel</div>
      ${mathOpp.stage ? modalRow('Stage', mathOpp.stage) : ''}
      ${mathOpp.acv ? modalRow('Year 1 ACV', '$' + Number(mathOpp.acv).toLocaleString()) : ''}
      ${modalRow('Competition', mathOpp.competition || '—')}
      ${modalRow('Economic Buyer', mathOpp.economic_buyer || '—')}
      ${modalRow('Champion', mathOpp.champion || '—')}
      ${mathOpp.next_step ? modalRow('Next Step', mathOpp.next_step) : ''}
    </div>`;
  }

  html += `</div>`;
  document.getElementById('tabMath').innerHTML = html;
}

export function populateAttendanceTab(d) {
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

  if (d.attendance_comms) {
    html += `<div class="product-highlight attendance">
      <div class="label">Attendance & Comms Tools</div>
      <div class="value">${d.attendance_comms}</div>
    </div>`;
  }

  if (!d.sis && !d.attendance_comms) {
    html += `<div style="color:var(--text-muted);font-size:12px;">No attendance/SIS info recorded</div>`;
  }

  // Attendance opportunity info — find Attendance opp from opps array
  const attendanceOpp = (d.opps || []).find(o => !o.school_name && (o.area || '').toLowerCase().includes('attendance'));
  if (attendanceOpp) {
    html += `<div class="product-highlight attendance" style="border-color:#55efc4;margin-top:12px;">
      <div class="label">Active Attendance Opportunity</div>
      <div class="value">${attendanceOpp.stage || 'In Progress'}</div>
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

  // Opp contact from Attendance opp entry
  if (attendanceOpp && attendanceOpp.contact) {
    html += `<div class="contact-card" style="border-left:3px solid #55efc4;">
      <div class="name">${attendanceOpp.contact}</div>
      <div class="title">${attendanceOpp.contact_title || 'Opportunity Contact'}</div>
    </div>`;
  }
  html += `</div>`;

  // Attendance Opp Intel - only show if Attendance opp exists
  if (attendanceOpp && (attendanceOpp.competition || attendanceOpp.economic_buyer || attendanceOpp.champion || attendanceOpp.stage)) {
    html += `<div class="modal-section">
      <div class="modal-section-title"><span class="icon">🎯</span> Attendance Opp Intel</div>
      ${attendanceOpp.stage ? modalRow('Stage', attendanceOpp.stage) : ''}
      ${attendanceOpp.acv ? modalRow('Year 1 ACV', '$' + Number(attendanceOpp.acv).toLocaleString()) : ''}
      ${modalRow('Competition', attendanceOpp.competition || '—')}
      ${modalRow('Economic Buyer', attendanceOpp.economic_buyer || '—')}
      ${modalRow('Champion', attendanceOpp.champion || '—')}
      ${attendanceOpp.next_step ? modalRow('Next Step', attendanceOpp.next_step) : ''}
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

export function populateDipTab(d) {
  let html = `<div class="modal-grid">`;

  // DIP opp from opps array
  const diOpp = (d.opps || []).find(o => !o.school_name && (o.area || '').toLowerCase().includes('district intelligence'));

  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">🔮</span> DIP Opportunity</div>`;

  if (diOpp) {
    let stageClass = 'discovery';
    if (diOpp.stage.includes('Demo')) stageClass = 'demo';
    else if (diOpp.stage.includes('Scoping')) stageClass = 'scoping';
    else if (diOpp.stage.includes('Proposal')) stageClass = 'proposal';
    else if (diOpp.stage.includes('Validation')) stageClass = 'validation';
    else if (diOpp.stage.includes('Procurement')) stageClass = 'procurement';

    html += `<div class="product-highlight dip">
      <div class="label">Active DIP Opportunity</div>
      <div class="value"><span class="opp-stage-badge ${stageClass}">${diOpp.stage || 'In Progress'}</span></div>
    </div>`;
    html += modalRow('Forecast', diOpp.forecast || '—');
    html += modalRow('Year 1 ACV', diOpp.acv ? '$' + Number(diOpp.acv).toLocaleString() : '—');
    html += modalRow('Probability', formatProbability(diOpp.probability) || '—');
    html += modalRow('Next Step', diOpp.next_step || '—');
    html += modalRow('Last Activity', formatLastActivity(diOpp.last_activity));
  } else {
    html += `<div style="color:var(--text-muted);font-size:12px;">No DIP opportunity recorded</div>`;
  }
  html += `</div>`;

  // DIP Contacts
  if (diOpp && diOpp.contact) {
    html += `<div class="modal-section">
      <div class="modal-section-title"><span class="icon">👤</span> DIP Contacts</div>`;
    html += `<div class="contact-card" style="border-left:3px solid #a29bfe;">
      <div class="name">${diOpp.contact}</div>
      <div class="title">${diOpp.contact_title || 'Opportunity Contact'}</div>
    </div>`;
    html += `</div>`;
  }

  // DIP Opp Intel
  if (diOpp && (diOpp.competition || diOpp.economic_buyer || diOpp.champion)) {
    html += `<div class="modal-section">
      <div class="modal-section-title"><span class="icon">🎯</span> DIP Opp Intel</div>
      ${modalRow('Competition', diOpp.competition || '—')}
      ${modalRow('Economic Buyer', diOpp.economic_buyer || '—')}
      ${modalRow('Champion', diOpp.champion || '—')}
      ${diOpp.sdr ? modalRow('SDR', diOpp.sdr) : ''}
    </div>`;
  }

  html += `</div>`;
  document.getElementById('tabDip').innerHTML = html;
}

export function populateDistrictIntelTab(d) {
  let html = `<div class="modal-grid">`;

  // ── SECTION 1: Cross-Product Snapshot ──
  html += `<div class="modal-section" style="grid-column: 1 / -1;">
    <div class="modal-section-title"><span class="icon">📊</span> Cross-Product Snapshot</div>
    <div class="cross-product-grid">`;

  const productAreas = [
    { key: 'math', label: 'Math', icon: '📐', color: '#FFFF66' },
    { key: 'attendance', label: 'Attendance', icon: '📅', color: '#74b9ff' },
    { key: 'district intelligence', label: 'DIP', icon: '🔮', color: '#a29bfe' },
  ];

  const allOpps = d.opps && d.opps.length > 0 ? d.opps : [];
  const districtOpps = allOpps.filter(o => !o.school_name);

  productAreas.forEach(p => {
    const opp = districtOpps.find(o => (o.area || '').toLowerCase().includes(p.key));
    let status, statusClass;
    if (d.is_customer && p.key === 'math') {
      status = 'Customer';
      statusClass = 'cust';
    }
    if (opp) {
      status = opp.stage || 'In Progress';
      statusClass = 'active';
    }
    if (!status) {
      status = 'No opp';
      statusClass = 'none';
    }

    html += `<div class="cross-product-card">
      <div class="cross-product-icon" style="border-color:${p.color};">${p.icon}</div>
      <div class="cross-product-label">${p.label}</div>
      <div class="cross-product-status ${statusClass}">${status}</div>
    </div>`;
  });

  // Bundle check
  const bundleOpp = districtOpps.find(o => (o.area || '').toLowerCase().includes('bundle'));
  if (bundleOpp) {
    html += `<div class="cross-product-card">
      <div class="cross-product-icon" style="border-color:#fd79a8;">🎁</div>
      <div class="cross-product-label">Bundle</div>
      <div class="cross-product-status active">${bundleOpp.stage || 'In Progress'}</div>
    </div>`;
  }

  html += `</div></div>`;

  // ── SECTION 2: Active Next Steps (across all opps) ──
  const oppsWithNextSteps = districtOpps.filter(o => o.next_step && o.next_step.trim());
  if (oppsWithNextSteps.length) {
    html += `<div class="modal-section" style="grid-column: 1 / -1;">
      <div class="modal-section-title"><span class="icon">⚡</span> Active Next Steps</div>`;
    oppsWithNextSteps.forEach(opp => {
      const areaLabel = opp.area || 'Opportunity';
      const areaColor = areaLabel.toLowerCase().includes('math') ? '#FFFF66' :
                         areaLabel.toLowerCase().includes('attendance') ? '#74b9ff' :
                         areaLabel.toLowerCase().includes('district intelligence') ? '#a29bfe' :
                         areaLabel.toLowerCase().includes('bundle') ? '#fd79a8' : '#55efc4';
      html += `<div class="next-step-card" style="border-left:3px solid ${areaColor};">
        <div class="next-step-area">${escapeHtml(areaLabel)}</div>
        <div class="next-step-text">${escapeHtml(opp.next_step)}</div>
        ${opp.last_activity ? `<div class="next-step-meta">Last activity: ${formatLastActivity(opp.last_activity)}</div>` : ''}
      </div>`;
    });
    html += `</div>`;
  }

  // ── SECTION 3: MEDDPIC Intelligence ──
  const meddpicFields = [
    ['Metric / Improvement Goal', d.metric_improvement_goal],
    ['Implication of Pain', d.implication_of_pain],
    ['Decision Criteria', d.decision_criteria],
    ['Decision Process', d.decision_process],
    ['Paper Process', d.paper_process],
  ];
  const populatedMeddpic = meddpicFields.filter(([_, v]) => v && v.trim());

  if (populatedMeddpic.length) {
    html += `<div class="modal-section" style="grid-column: 1 / -1;">
      <div class="modal-section-title"><span class="icon">🧠</span> MEDDPIC Intelligence</div>`;
    populatedMeddpic.forEach(([label, value]) => {
      const formatted = escapeHtml(value).replace(/\n/g, '<br>');
      html += `<div class="meddpic-field">
        <div class="meddpic-label">${label}</div>
        <div class="meddpic-value">${formatted}</div>
      </div>`;
    });
    html += `</div>`;
  }

  // ── SECTION 4: Full Contact Map ──
  const allContacts = [];

  const leadershipRoles = [
    ['Superintendent', d.superintendent],
    ['Asst Supt C&I', d.asst_supt_ci],
    ['Asst Supt Student Svcs', d.asst_supt_ss],
    ['Asst Supt Technology', d.asst_supt_tech],
    ['Director C&I', d.dir_ci],
    ['Director Math', d.dir_math],
    ['Director Attendance', d.dir_attendance],
  ];
  leadershipRoles.forEach(([title, name]) => {
    if (name) allContacts.push({ name, title, source: 'leadership', color: 'var(--accent-strat)' });
  });

  const seenContactNames = new Set(allContacts.map(c => c.name.toLowerCase()));
  districtOpps.forEach(opp => {
    if (opp.contact && !seenContactNames.has(opp.contact.toLowerCase())) {
      const areaLabel = opp.area || 'Opportunity';
      const areaColor = areaLabel.toLowerCase().includes('math') ? '#FFFF66' :
                         areaLabel.toLowerCase().includes('attendance') ? '#74b9ff' :
                         areaLabel.toLowerCase().includes('district intelligence') ? '#a29bfe' : '#55efc4';
      allContacts.push({
        name: opp.contact,
        title: opp.contact_title || `${areaLabel} Contact`,
        source: areaLabel,
        color: areaColor,
      });
      seenContactNames.add(opp.contact.toLowerCase());
    }
    if (opp.champion && !seenContactNames.has(opp.champion.toLowerCase())) {
      allContacts.push({ name: opp.champion, title: `Champion (${opp.area || 'Opp'})`, source: 'opp-intel', color: '#55efc4' });
      seenContactNames.add(opp.champion.toLowerCase());
    }
    if (opp.economic_buyer && !seenContactNames.has(opp.economic_buyer.toLowerCase())) {
      allContacts.push({ name: opp.economic_buyer, title: `Economic Buyer (${opp.area || 'Opp'})`, source: 'opp-intel', color: '#fdcb6e' });
      seenContactNames.add(opp.economic_buyer.toLowerCase());
    }
  });

  if (allContacts.length) {
    html += `<div class="modal-section">
      <div class="modal-section-title"><span class="icon">👥</span> Full Contact Map (${allContacts.length})</div>`;
    allContacts.forEach(c => {
      html += `<div class="contact-card" style="border-left:3px solid ${c.color};">
        <div class="name">${escapeHtml(c.name)}</div>
        <div class="title">${escapeHtml(c.title)}</div>
      </div>`;
    });
    html += `</div>`;
  } else {
    html += `<div class="modal-section">
      <div class="modal-section-title"><span class="icon">👥</span> Full Contact Map</div>
      <div style="color:var(--text-muted);font-size:12px;">No contacts recorded</div>
    </div>`;
  }

  // ── SECTION 5: Engagement Summary ──
  const noteKey = 'edia_notes_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
  const notes = getAccountNotes(noteKey);
  const prepLinkKey = 'edia_prep_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
  const savedPrepLink = localStorage.getItem(prepLinkKey) || d.prep_doc_url || '';

  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">📈</span> Engagement Summary</div>`;

  if (notes.length) {
    const lastNote = notes[notes.length - 1];
    const lastNoteDate = lastNote.ts ? new Date(lastNote.ts).toLocaleDateString() : '—';
    html += modalRow('Notes', `${notes.length} note${notes.length !== 1 ? 's' : ''}`, false);
    html += modalRow('Last Note', lastNoteDate, false);
  } else {
    html += modalRow('Notes', '<span style="color:var(--text-muted);">None</span>', true);
  }

  if (d.created_date) html += modalRow('Opp Created', d.created_date);
  if (d.intro_meeting_date) html += modalRow('Intro Meeting', d.intro_meeting_date);
  if (d.age) html += modalRow('Opp Age', d.age + ' days');

  if (savedPrepLink) {
    html += modalRow('Meeting Prep', `<a href="${savedPrepLink}" target="_blank" style="color:var(--accent-cust);">View →</a>`, true);
  }
  if (d.org_chart_url) {
    html += modalRow('Org Chart', `<a href="${d.org_chart_url}" target="_blank" style="color:var(--accent-cust);">View →</a>`, true);
  }
  if (d.strategic_plan_url) {
    html += modalRow('Strategic Plan', `<a href="${d.strategic_plan_url}" target="_blank" style="color:var(--accent-cust);">View →</a>`, true);
  }

  if (!notes.length && !d.created_date && !savedPrepLink && !d.org_chart_url && !d.strategic_plan_url) {
    html += `<div style="color:var(--text-muted);font-size:12px;">No engagement data recorded</div>`;
  }
  html += `</div>`;

  // ── SECTION 6: Nearby Customers ──
  if (d.lat && d.lng && S.CUSTOMER_DATA && S.CUSTOMER_DATA.length > 0) {
    const nearby = [];
    for (let i = 0; i < S.CUSTOMER_DATA.length; i++) {
      const c = S.CUSTOMER_DATA[i];
      if (!c.lat || !c.lng) continue;
      if (c.name === d.name && c.state === d.state) continue;
      const dist = haversine(d.lat, d.lng, c.lat, c.lng);
      if (dist <= 100) {
        nearby.push({ ...c, _distance: dist });
      }
    }
    nearby.sort((a, b) => a._distance - b._distance);
    const top5 = nearby.slice(0, 5);

    if (top5.length) {
      html += `<div class="modal-section">
        <div class="modal-section-title"><span class="icon">📍</span> Nearby Customers (within 100 mi)</div>`;
      top5.forEach(c => {
        const distMi = Math.round(c._distance);
        const arrDisplay = c.arr ? '$' + Number(c.arr).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ARR' : '';
        const enrollDisplay = c.enrollment || c.students ? (c.enrollment || c.students).toLocaleString() + ' students' : '';
        const details = [enrollDisplay, arrDisplay].filter(Boolean).join(' · ');
        html += `<div class="nearby-customer-card">
          <div class="nearby-customer-name">${escapeHtml(c.name)}</div>
          <div class="nearby-customer-meta">
            <span class="nearby-distance">${distMi} mi</span>
            ${details ? `<span class="nearby-details">${details}</span>` : ''}
          </div>
        </div>`;
      });
      html += `</div>`;
    }
  }

  html += `</div>`;
  document.getElementById('tabDistrictIntel').innerHTML = html;
}

export function populateSchoolsTab(d) {
  const schools = d._schools || [];
  let html = '';

  // Gather all school-level opps
  const opps = d.opps || [];
  const schoolOpps = opps.filter(o => o.school_name);

  if (schools.length === 0 && schoolOpps.length === 0) {
    html = '<div style="color:var(--text-muted);font-size:13px;padding:20px;">No schools associated with this district.</div>';
  } else {
    // Build a map of opp school_name (from SFDC) → opps array
    const oppsByRawName = new Map();
    schoolOpps.forEach(opp => {
      const key = opp.school_name;
      if (!oppsByRawName.has(key)) oppsByRawName.set(key, []);
      oppsByRawName.get(key).push(opp);
    });

    // Match each opp school name to a _schools entry, or mark as unmatched.
    // schoolOppMap is keyed by the DISPLAY name (either NCES name if matched, or SFDC name if not).
    const schoolOppMap = new Map();
    const matchedRawNames = new Set();

    // For each NCES school, check if any opp school name matches it
    for (const ncesName of schools) {
      const ncesNorm = ncesName.toLowerCase().trim();
      for (const [rawName, rawOpps] of oppsByRawName) {
        if (matchedRawNames.has(rawName)) continue; // Already matched
        const rawNorm = rawName.toLowerCase().trim();

        // Exact normalized match
        if (rawNorm === ncesNorm) {
          schoolOppMap.set(ncesName, rawOpps);
          matchedRawNames.add(rawName);
          break;
        }

        // Substring match: shorter name contained in longer (min 8 chars to avoid false positives)
        const shorter = rawNorm.length <= ncesNorm.length ? rawNorm : ncesNorm;
        const longer = rawNorm.length <= ncesNorm.length ? ncesNorm : rawNorm;
        if (shorter.length >= 8 && longer.includes(shorter)) {
          schoolOppMap.set(ncesName, rawOpps);
          matchedRawNames.add(rawName);
          break;
        }
      }
    }

    // Build the full display list: start with NCES schools, then append unmatched opp schools
    const displaySchools = [...schools];
    for (const [rawName] of oppsByRawName) {
      if (!matchedRawNames.has(rawName)) {
        // This opp school isn't in the NCES list — add it so it still shows up
        displaySchools.push(rawName);
        schoolOppMap.set(rawName, oppsByRawName.get(rawName));
      }
    }

    // Sort: schools with opps first (alphabetical within each group)
    const sorted = [...displaySchools].sort((a, b) => {
      const aHas = schoolOppMap.has(a) ? 0 : 1;
      const bHas = schoolOppMap.has(b) ? 0 : 1;
      if (aHas !== bHas) return aHas - bHas;
      return a.localeCompare(b);
    });

    html += '<div class="schools-list">';
    sorted.forEach(name => {
      const schoolOppsForName = schoolOppMap.get(name);
      const hasOpp = !!schoolOppsForName;
      const borderColor = hasOpp ? '#e17055' : 'var(--accent-strat)';
      const clickAttr = hasOpp
        ? `onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none';this.querySelector('[data-arrow]').textContent=this.nextElementSibling.style.display==='none'?'▾':'▴'" style="border-left-color:${borderColor};display:flex;align-items:center;cursor:pointer;"`
        : `style="border-left-color:${borderColor};display:flex;align-items:center;"`;

      html += `<div class="school-list-item" ${clickAttr}>${escapeHtml(name)}${hasOpp ? '<span style="font-size:10px;color:#e17055;margin-left:auto;font-weight:600;">ACTIVE OPP <span data-arrow>▾</span></span>' : ''}</div>`;

      if (hasOpp) {
        html += `<div style="display:none;padding:8px 12px 12px 18px;background:var(--surface);border-left:3px solid #e17055;margin-bottom:2px;border-radius:0 0 var(--radius-sm) var(--radius-sm);">`;
        schoolOppsForName.forEach(opp => {
          let stageClass = 'discovery';
          const stage = opp.stage || '';
          if (stage.includes('Demo')) stageClass = 'demo';
          else if (stage.includes('Scoping')) stageClass = 'scoping';
          else if (stage.includes('Proposal')) stageClass = 'proposal';
          else if (stage.includes('Validation')) stageClass = 'validation';
          else if (stage.includes('Procurement')) stageClass = 'procurement';

          const areaLabel = opp.area || 'Opportunity';
          html += `<div style="margin-bottom:8px;">`;
          html += `<div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px;">${escapeHtml(areaLabel)} <span class="opp-stage-badge ${stageClass}" style="font-size:10px;padding:2px 8px;">${escapeHtml(stage)}</span></div>`;
          html += `<div style="font-size:11px;color:var(--text-secondary);">`;
          if (opp.forecast) html += `Forecast: ${escapeHtml(opp.forecast)} · `;
          if (opp.probability) html += `Prob: ${formatProbability(opp.probability)} · `;
          if (opp.acv) html += `ACV: $${Number(opp.acv).toLocaleString()} · `;
          if (opp.next_step) html += `Next: ${escapeHtml(opp.next_step)}`;
          html += `</div>`;
          html += `</div>`;
        });
        html += `</div>`;
      }
    });
    html += '</div>';
  }
  document.getElementById('tabSchools').innerHTML = html;
}

export function modalRow(label, value, raw = false) {
  const safeValue = raw ? value : escapeHtml(String(value || ''));
  return `<div class="modal-row"><span class="label">${label}</span><span class="value">${safeValue}</span></div>`;
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
export function showPrepInput(key) {
  const addBtn = document.getElementById('prepAddBtn_' + key);
  const inputWrap = document.getElementById('prepInputWrap_' + key);
  if (addBtn) addBtn.style.display = 'none';
  if (inputWrap) {
    inputWrap.style.display = 'inline-flex';
    const input = document.getElementById('prepInput_' + key);
    if (input) input.focus();
  }
}

export function hidePrepInput(key) {
  const addBtn = document.getElementById('prepAddBtn_' + key);
  const inputWrap = document.getElementById('prepInputWrap_' + key);
  if (addBtn) addBtn.style.display = 'inline-flex';
  if (inputWrap) inputWrap.style.display = 'none';
}

export function showEditPrepInput(key, currentUrl) {
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

export function hideEditPrepInput(key) {
  const editWrap = document.getElementById('prepEditWrap_' + key);
  if (editWrap) editWrap.style.display = 'none';
}

export function savePrepLinkInline(key, districtName) {
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

export function removePrepLinkInline(key, districtName) {
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

export function findMarkerByDistrict(districtName) {
  let foundMarker = null;
  S.stratLayer.eachLayer(layer => {
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
const MEETING_PREP_URL = 'https://claude.ai/project/019c77bb-e463-765f-9c3f-487877c0d2fb';

export function generateMeetingPrepByKey(dKey) {
  const d = window.districtDataCache && window.districtDataCache[dKey];
  if (!d) {
    console.error('District data not found for key:', dKey);
    alert('Error: account data not found. Please try again.');
    return;
  }
  generateMeetingPrep(d);
}

export function generateMeetingPrep(d) {
  try {
    // Legacy support: if called with an encoded string, decode it
    if (typeof d === 'string') {
      d = JSON.parse(decodeURIComponent(d));
    }
    const prompt = formatMeetingPrepPrompt(d);

    // Copy to clipboard
    navigator.clipboard.writeText(prompt).then(() => {
      showMeetingPrepToast();
      // Open ChatGPT project in new tab
      setTimeout(() => {
        window.open(MEETING_PREP_URL, '_blank');
      }, 500);
    }).catch(err => {
      // Fallback for clipboard failure
      console.error('Clipboard failed:', err);
      fallbackCopy(prompt);
      showMeetingPrepToast();
      setTimeout(() => {
        window.open(MEETING_PREP_URL, '_blank');
      }, 500);
    });
  } catch (e) {
    console.error('Meeting prep error:', e);
    alert('Error generating meeting prep. Please try again.');
  }
}

export function formatMeetingPrepPrompt(d) {
  // Get notes for this account
  const noteKey = 'edia_notes_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
  let notes = [];
  try {
    notes = JSON.parse(localStorage.getItem(noteKey) || '[]');
  } catch(e) { /* ignored */ }

  // Check if also a customer and get that data
  let customerData = null;
  if (d.is_customer) {
    customerData = S._custByName.get(d.customer_name);
  }

  let prompt = `Meeting With: (Enter name and title)\n\n`;
  prompt += `Please generate detailed meeting prep for the following district:\n\n`;
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
  const promptOpps = d.opps && d.opps.length > 0 ? d.opps : (d.opp_stage ? [buildOppEntry(d)] : []);
  if (promptOpps.length > 0) {
    promptOpps.forEach(opp => {
      prompt += `\n=== OPPORTUNITY: ${opp.area || 'Unknown'} ===\n`;
      prompt += `Stage: ${opp.stage}\n`;
      if (opp.acv) prompt += `Year 1 ACV: $${parseFloat(opp.acv).toLocaleString()}\n`;
      if (opp.forecast) prompt += `Forecast: ${opp.forecast}\n`;
      if (opp.next_step) prompt += `Next Step: ${opp.next_step}\n`;
      if (opp.competition) prompt += `Competition: ${opp.competition}\n`;
    });
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
    ['Core Math Curriculum', d.math_curriculum],
    ['Math Supplemental', d.math_supplemental],
    ['Attendance & Comms', d.attendance_comms],
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

export function fallbackCopy(text) {
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

export function showMeetingPrepToast() {
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

export function toggleDataRefreshPanel() {
  document.getElementById('dataRefreshPanel').classList.toggle('open');
}

export function handleDataRefreshDrop(event) {
  const file = event.dataTransfer.files[0];
  if (!file) return;
  if (!/\.(csv|xlsx?|xls)$/i.test(file.name)) {
    alert('Please drop a CSV or Excel file.');
    return;
  }
  processUploadFile(file);
  toggleDataRefreshPanel();
}

export function handleDataRefreshFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  processUploadFile(file);
  event.target.value = '';
  toggleDataRefreshPanel();
}

function setupModalTabSwipe() {
  const body = document.querySelector('.account-modal-body');
  if (!body || !('ontouchstart' in window)) return;

  let startX = 0;
  let startY = 0;
  let moved = false;

  body.addEventListener('touchstart', function(e) {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    moved = false;
  }, { passive: true });

  body.addEventListener('touchend', function(e) {
    if (moved) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    // Only trigger if horizontal swipe is dominant and > 60px
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const tabs = Array.from(document.querySelectorAll('.account-tab'))
        .filter(t => t.style.display !== 'none' && t.offsetParent !== null);
      const activeIdx = tabs.findIndex(t => t.classList.contains('active') || t.classList.contains('active-cust'));
      let nextIdx;
      if (dx < 0 && activeIdx < tabs.length - 1) {
        nextIdx = activeIdx + 1; // swipe left → next tab
      } else if (dx > 0 && activeIdx > 0) {
        nextIdx = activeIdx - 1; // swipe right → prev tab
      }
      if (nextIdx !== undefined && tabs[nextIdx]) {
        tabs[nextIdx].click(); // triggers the existing onclick handler
        tabs[nextIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }
  }, { passive: true });

  body.addEventListener('touchmove', function(e) {
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dy > 15) moved = true; // User is scrolling vertically, not swiping
  }, { passive: true });
}

function setupModalPullDown() {
  const header = document.querySelector('.account-modal-header');
  const content = document.querySelector('.account-modal-content');
  if (!header || !content || !('ontouchstart' in window)) return;

  let startY = 0;
  let deltaY = 0;

  header.addEventListener('touchstart', function(e) {
    startY = e.touches[0].clientY;
    deltaY = 0;
    content.classList.add('dragging');
  }, { passive: true });

  header.addEventListener('touchmove', function(e) {
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) {
      deltaY = dy;
      content.style.transform = `scale(1) translateY(${dy}px)`;
      content.style.opacity = Math.max(0.5, 1 - dy / 400);
    }
  }, { passive: true });

  header.addEventListener('touchend', function() {
    content.classList.remove('dragging');
    if (deltaY > 120) {
      closeAccountModal();
    } else {
      content.style.transform = '';
      content.style.opacity = '';
    }
  }, { passive: true });
}

