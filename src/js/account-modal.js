import S from './state.js';
import { districtKey, escapeHtml, escapeAttr, formatLastActivity, isDOE } from './helpers.js';
import { buildOppEntry, isManagerHeld, getTerritoryAE, getHoldoutAE } from './app.js';
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
  populateDistrictIntelTab(d);

  // Reset to Info tab
  switchTab('info', document.querySelector('.account-tab'));

  // Show modal
  document.getElementById('accountModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

export function closeAccountModal() {
  document.getElementById('accountModal').classList.remove('show');
  document.body.style.overflow = '';
  S.currentModalData = null;
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
    ${modalRow('Account Executive', (() => { if (isManagerHeld(d)) return '<span class="manager-held-badge">Unassigned</span> <span class="ae-role">(held by ' + d.ae + ')</span>'; const tAE = getTerritoryAE(d); const hAE = getHoldoutAE(d); return tAE ? (hAE ? tAE + ' <span class="ae-role">(Assigned)</span><br>' + hAE + ' <span class="ae-role">(Holdout)</span>' : tAE) : '—'; })())}
    ${modalRow('SIS Platform', d.sis || '—')}
    ${modalRow('Website', d.website ? `<a href="${d.website.startsWith('http') ? d.website : 'https://' + d.website}" target="_blank" style="color:var(--accent-cust);">${d.website}</a>` : '—')}
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

  // Opportunity Section — render one card per opp
  const infoOpps = d.opps && d.opps.length > 0 ? d.opps : (d.opp_stage ? [buildOppEntry(d)] : []);
  infoOpps.forEach(opp => {
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
      ${modalRow('Probability', opp.probability ? opp.probability + '%' : '—')}
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
  const mathOpp = (d.opps || []).find(o => (o.area || '').toLowerCase().includes('math'));
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
  const attendanceOpp = (d.opps || []).find(o => (o.area || '').toLowerCase().includes('attendance'));
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

export function populateDistrictIntelTab(d) {
  let html = `<div class="modal-grid">`;

  // District Intelligence opp from opps array
  const diOpp = (d.opps || []).find(o => (o.area || '').toLowerCase().includes('district intelligence'));

  html += `<div class="modal-section">
    <div class="modal-section-title"><span class="icon">📊</span> District Intelligence</div>`;

  if (diOpp) {
    let stageClass = 'discovery';
    if (diOpp.stage.includes('Demo')) stageClass = 'demo';
    else if (diOpp.stage.includes('Scoping')) stageClass = 'scoping';
    else if (diOpp.stage.includes('Proposal')) stageClass = 'proposal';
    else if (diOpp.stage.includes('Validation')) stageClass = 'validation';
    else if (diOpp.stage.includes('Procurement')) stageClass = 'procurement';

    html += `<div class="product-highlight" style="border-color:#a29bfe;">
      <div class="label">Active District Intelligence Opportunity</div>
      <div class="value"><span class="opp-stage-badge ${stageClass}">${diOpp.stage || 'In Progress'}</span></div>
    </div>`;
    html += modalRow('Forecast', diOpp.forecast || '—');
    html += modalRow('Year 1 ACV', diOpp.acv ? '$' + Number(diOpp.acv).toLocaleString() : '—');
    html += modalRow('Probability', diOpp.probability ? diOpp.probability + '%' : '—');
    html += modalRow('Next Step', diOpp.next_step || '—');
    html += modalRow('Last Activity', formatLastActivity(diOpp.last_activity));
  } else {
    html += `<div style="color:var(--text-muted);font-size:12px;">No District Intelligence opportunity recorded</div>`;
  }
  html += `</div>`;

  // DI Contacts
  if (diOpp && diOpp.contact) {
    html += `<div class="modal-section">
      <div class="modal-section-title"><span class="icon">👤</span> DI Contacts</div>`;
    html += `<div class="contact-card" style="border-left:3px solid #a29bfe;">
      <div class="name">${diOpp.contact}</div>
      <div class="title">${diOpp.contact_title || 'Opportunity Contact'}</div>
    </div>`;
    html += `</div>`;
  }

  // DI Opp Intel
  if (diOpp && (diOpp.competition || diOpp.economic_buyer || diOpp.champion)) {
    html += `<div class="modal-section">
      <div class="modal-section-title"><span class="icon">🎯</span> DI Opp Intel</div>
      ${modalRow('Competition', diOpp.competition || '—')}
      ${modalRow('Economic Buyer', diOpp.economic_buyer || '—')}
      ${modalRow('Champion', diOpp.champion || '—')}
      ${diOpp.sdr ? modalRow('SDR', diOpp.sdr) : ''}
    </div>`;
  }

  html += `</div>`;
  document.getElementById('tabDistrictIntel').innerHTML = html;
}

export function populateSchoolsTab(d) {
  const schools = d._schools || [];
  let html = '';
  if (schools.length === 0) {
    html = '<div style="color:var(--text-muted);font-size:13px;padding:20px;">No schools associated with this district.</div>';
  } else {
    html += '<div class="schools-list">';
    schools.forEach(name => {
      html += `<div class="school-list-item">${escapeHtml(name)}</div>`;
    });
    html += '</div>';
  }
  document.getElementById('tabSchools').innerHTML = html;
}

export function modalRow(label, value) {
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
  generateMeetingPrep(encodeURIComponent(JSON.stringify(d)));
}

export function generateMeetingPrep(encodedData) {
  try {
    const d = JSON.parse(decodeURIComponent(encodedData));
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

