import S from './state.js';
import { districtKey, parseUSDate, daysAgo, extractDatesFromText, isThisWeek, haversine } from './helpers.js';
import { buildOppEntry, getTerritoryAE } from './app.js';
import { formatCompactNumber } from './account-list.js';

// ============ DATA EXPORT ============

export function exportData() {
  if (!S.selectedTeam) {
    alert('Select a team first to export data.');
    return;
  }

  const scopeLabel = S.selectedRep && S.selectedRep !== '__unassigned__'
    ? S.selectedRep
    : S.selectedTeam;

  // Use the already-filtered arrays (respects team, rep, stage, and sidebar filters)
  const accounts = S.filteredAccountData || [];
  const customers = S.filteredCustData || [];

  const wb = XLSX.utils.book_new();
  let sheetCount = 0;

  // --- Sheet 1: Account Summary ---
  if (accounts.length > 0) {
    const headers = [
      'District Name', 'State', 'Region', 'Enrollment', 'Account Executive',
      'SIS Platform', 'Opp Stage', '# Opps', 'Product Areas',
      'Next Step', 'Last Activity', 'Is Customer',
      'Superintendent', 'Asst. Supt. of C&I', 'Asst. Supt. of Student Services',
      'CTO/Dir. of Technology', 'Dir. of C&I / CAO', 'Dir. of Attendance', 'Dir. of Math',
      'Opp Contact Name', 'Opp Contact Title',
      'Website', 'Strategic Plan URL', 'Org Chart URL', 'Has Notes'
    ];
    const proxActive = S.proximityOn;
    if (proxActive) {
      headers.push('Customer(s) within ' + S.PROXIMITY_MILES + ' mi');
    }
    const rows = [headers];
    accounts.forEach(d => {
      const opps = d.opps && d.opps.length > 0 ? d.opps : (d.opp_stage ? [buildOppEntry(d)] : []);
      const noteKey = 'edia_notes_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
      const hasNotes = S._accountsWithNotes.has(noteKey);
      const nextStep = (d.opp_next_step || '').substring(0, 500);
      const row = [
        d.name || '',
        d.state || '',
        d.region || '',
        parseInt(d.enrollment) || '',
        getTerritoryAE(d) || '',
        d.sis || '',
        d.opp_stage || '',
        opps.length,
        d.opp_areas || '',
        nextStep,
        d.opp_last_activity || '',
        d.is_customer ? 'Yes' : 'No',
        d.superintendent || '',
        d.asst_supt_ci || '',
        d.asst_supt_ss || '',
        d.asst_supt_tech || '',
        d.dir_ci || '',
        d.dir_attendance || '',
        d.dir_math || '',
        d.opp_contact || '',
        d.opp_contact_title || '',
        d.website || '',
        d.strategic_plan_url || '',
        d.org_chart_url || '',
        hasNotes ? 'Yes' : 'No'
      ];
      if (proxActive) {
        if (d.lat && d.lng) {
          const nearby = S.CUSTOMER_DATA.filter(c =>
            c.lat && c.lng && haversine(d.lat, d.lng, c.lat, c.lng) <= S.PROXIMITY_MILES
          ).map(c => c.name);
          row.push(nearby.length > 0 ? nearby.join('; ') : 'None');
        } else {
          row.push('N/A');
        }
      }
      rows.push(row);
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    // Set column widths for readability
    ws['!cols'] = [
      { wch: 35 }, // District Name
      { wch: 6 },  // State
      { wch: 14 }, // Region
      { wch: 12 }, // Enrollment
      { wch: 18 }, // Account Executive
      { wch: 18 }, // SIS Platform
      { wch: 18 }, // Opp Stage
      { wch: 7 },  // # Opps
      { wch: 30 }, // Product Areas
      { wch: 40 }, // Next Step
      { wch: 12 }, // Last Activity
      { wch: 12 }, // Is Customer
      { wch: 25 }, // Superintendent
      { wch: 28 }, // Asst. Supt. of C&I
      { wch: 30 }, // Asst. Supt. of Student Services
      { wch: 28 }, // CTO/Dir. of Technology
      { wch: 28 }, // Dir. of C&I / CAO
      { wch: 22 }, // Dir. of Attendance
      { wch: 22 }, // Dir. of Math
      { wch: 22 }, // Opp Contact Name
      { wch: 30 }, // Opp Contact Title
      { wch: 30 }, // Website
      { wch: 40 }, // Strategic Plan URL
      { wch: 40 }, // Org Chart URL
      { wch: 10 }  // Has Notes
    ];
    if (proxActive) {
      ws['!cols'].push({ wch: 40 });
    }
    XLSX.utils.book_append_sheet(wb, ws, 'Accounts');
    sheetCount++;
  }

  // --- Sheet 2: Pipeline (one row per opportunity) ---
  {
    const pHeaders = [
      'District Name', 'State', 'Enrollment', 'Account Executive',
      'Product Area', 'Stage', 'Forecast', 'ACV', 'Probability',
      'Contact', 'Contact Title', 'Next Step', 'Last Activity', 'SDR',
      'Champion', 'Economic Buyer', 'Competition'
    ];
    const pRows = [pHeaders];
    accounts.forEach(d => {
      const opps = d.opps && d.opps.length > 0 ? d.opps : (d.opp_stage ? [buildOppEntry(d)] : []);
      opps.forEach(opp => {
        if (!opp.stage) return; // skip empty opps
        pRows.push([
          d.name || '',
          d.state || '',
          parseInt(d.enrollment) || '',
          getTerritoryAE(d) || '',
          opp.area || '',
          opp.stage || '',
          opp.forecast || '',
          Number(opp.acv) || '',
          opp.probability || '',
          opp.contact || '',
          opp.contact_title || '',
          opp.next_step || '',
          opp.last_activity || '',
          opp.sdr || '',
          (opp.champion || '').substring(0, 300),
          (opp.economic_buyer || '').substring(0, 300),
          (opp.competition || '').substring(0, 300)
        ]);
      });
    });
    if (pRows.length > 1) {
      const ws = XLSX.utils.aoa_to_sheet(pRows);
      ws['!cols'] = [
        { wch: 35 }, { wch: 6 }, { wch: 12 }, { wch: 18 },
        { wch: 25 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
        { wch: 20 }, { wch: 28 }, { wch: 50 }, { wch: 12 }, { wch: 18 },
        { wch: 40 }, { wch: 40 }, { wch: 40 }
      ];
      XLSX.utils.book_append_sheet(wb, ws, 'Pipeline');
      sheetCount++;
    }
  }

  // --- Sheet 3: Action Items ---
  {
    const aHeaders = ['District Name', 'Category', 'Days Since Activity', 'Last Activity', 'Enrollment', 'Opp Stage', 'Next Step(s)'];
    const aRows = [aHeaders];

    // Gather all accounts with their action-relevant data
    const allForActions = [];
    accounts.forEach(d => {
      const opps = d.opps && d.opps.length > 0 ? d.opps : (d.opp_stage ? [buildOppEntry(d)] : []);
      const lastAct = d.opp_last_activity || '';
      const nextSteps = opps.map(o => {
        const ns = (o.next_step || '').trim();
        return o.area ? o.area + ': ' + ns : ns;
      }).filter(Boolean).join(' | ');
      allForActions.push({
        name: d.name,
        lastActivity: lastAct,
        enrollment: d.enrollment,
        oppStage: d.opp_stage || '',
        nextSteps: nextSteps,
        opps: opps
      });
    });

    // Stalest (have activity dates, sorted oldest first)
    const withActivity = allForActions
      .filter(a => a.lastActivity && parseUSDate(a.lastActivity))
      .map(a => ({ ...a, daysSince: daysAgo(a.lastActivity) }))
      .sort((a, b) => b.daysSince - a.daysSince);
    withActivity.forEach(a => {
      aRows.push([a.name, 'Stalest', a.daysSince, a.lastActivity, parseInt(a.enrollment) || '', a.oppStage, a.nextSteps]);
    });

    // Due This Week
    allForActions.forEach(a => {
      let isDue = false;
      a.opps.forEach(opp => {
        if (opp.next_step) {
          const dates = extractDatesFromText(opp.next_step);
          if (dates.some(d => isThisWeek(d))) isDue = true;
        }
      });
      if (isDue) {
        aRows.push([a.name, 'Due This Week', '', a.lastActivity, parseInt(a.enrollment) || '', a.oppStage, a.nextSteps]);
      }
    });

    // Untouched (no activity date)
    allForActions.filter(a => !a.lastActivity || !parseUSDate(a.lastActivity)).forEach(a => {
      aRows.push([a.name, 'Untouched', '', '', parseInt(a.enrollment) || '', a.oppStage, a.nextSteps]);
    });

    if (aRows.length > 1) {
      const ws = XLSX.utils.aoa_to_sheet(aRows);
      ws['!cols'] = [
        { wch: 35 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 60 }
      ];
      XLSX.utils.book_append_sheet(wb, ws, 'Action Items');
      sheetCount++;
    }
  }

  // --- Sheet 4: Conflicts ---
  {
    const conflicts = S.CONFLICTS || [];
    // Filter conflicts relevant to the selected team/rep
    const teamReps = S.selectedTeam ? S._teamRepsSet[S.selectedTeam] : null;
    const relevantConflicts = conflicts.filter(c => {
      if (S.selectedRep && S.selectedRep !== '__unassigned__') {
        return c.oldAE === S.selectedRep || c.newAE === S.selectedRep;
      }
      if (teamReps) {
        return teamReps.has(c.oldAE) || teamReps.has(c.newAE);
      }
      return true;
    });

    if (relevantConflicts.length > 0) {
      const cHeaders = ['District Name', 'Enrollment', 'State', 'Previous AE', 'New AE (from CSV)'];
      const cRows = [cHeaders];
      relevantConflicts.forEach(c => {
        cRows.push([c.name || '', c.enrollment || '', c.state || '', c.oldAE || '', c.newAE || '']);
      });
      const ws = XLSX.utils.aoa_to_sheet(cRows);
      ws['!cols'] = [{ wch: 35 }, { wch: 12 }, { wch: 6 }, { wch: 20 }, { wch: 20 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Conflicts');
      sheetCount++;
    }
  }

  // --- Sheet 5: Customer Book ---
  if (customers.length > 0) {
    const cuHeaders = [
      'District Name', 'State', 'Region', 'Segment', 'Students', 'ARR',
      'ARR 12mo Ago', 'GDR', 'NDR', 'Lapsed Renewal', 'CSM',
      'Account Executive', 'Last Activity', 'SIS', 'Math Supplemental',
      'Attendance/Comms', 'Also Strategic Account'
    ];
    const cuRows = [cuHeaders];
    customers.forEach(d => {
      cuRows.push([
        d.name || '',
        d.state || '',
        d.region || '',
        d.segment || '',
        parseInt(d.students || d.enrollment) || '',
        parseFloat(d.arr) || '',
        parseFloat(d.arr_12mo_ago) || '',
        d.gdr || '',
        d.ndr || '',
        d.lapsed_renewal || '',
        d.csm || '',
        d.ae || '',
        d.last_activity || '',
        d.sis || '',
        d.math_supplemental || '',
        d.attendance_comms || '',
        (d.also_account || d.also_strategic) ? 'Yes' : 'No'
      ]);
    });
    const ws = XLSX.utils.aoa_to_sheet(cuRows);
    ws['!cols'] = [
      { wch: 35 }, { wch: 6 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 12 },
      { wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 18 },
      { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 20 },
      { wch: 20 }, { wch: 20 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Customers');
    sheetCount++;
  }

  if (sheetCount === 0) {
    alert('No data to export for the current selection.');
    return;
  }

  // Generate filename
  const safeName = scopeLabel.replace(/[^a-zA-Z0-9]/g, '_');
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = 'edia_export_' + safeName + '_' + dateStr + '.xlsx';

  XLSX.writeFile(wb, filename);

  // Show confirmation toast
  showExportToast(sheetCount, scopeLabel);
}

export function showExportToast(sheetCount, scopeLabel) {
  const existing = document.querySelector('.export-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'export-toast';
  toast.innerHTML = '<span class="toast-icon">✓</span> Exported ' + sheetCount + ' sheet' + (sheetCount > 1 ? 's' : '') + ' for ' + scopeLabel;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/** Show/hide the export button based on whether a team is selected. */
export function updateExportButtonVisibility() {
  const exportBtn = document.getElementById('exportTrigger');
  if (exportBtn) exportBtn.style.display = S.selectedTeam ? '' : 'none';
}

