import S from './state.js';
import { normalizeDistrictName, clampFutureLastActivity, isDOE } from './helpers.js';
import { OPP_ENTRY_FIELDS, OPP_WRAPPER_FIELDS, buildOppEntry, migrateToOppsArray,
  getTeamForRep, ALL_ACTIVE_REPS, MANAGER_REPS, resolveOwner } from './app.js';
import { upsertOpp, deriveOppSummary, parseNumericFields, findPartialMatch, showMergeModal } from './multi-opp.js';

// ============ SPREADSHEET FILE READER (CSV + Excel) ============

export function isExcelFile(filename) {
  return /\.(xlsx?|xls)$/i.test(filename);
}

export function readSpreadsheetFile(file) {
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
              const normKey = key.trim().toLowerCase().replace(/[/()&:]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
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
S.sfdcDataType = 'accounts';
S._userSelectedType = false;
S.pendingMergeData = null;
S.pendingMergeStats = null;
// Type-split state: when CSV has a 'type' column, rows are split into accounts + customers
S.pendingAccountMerge = null;
S.pendingCustomerMerge = null;
S.mergeHasTypeSplit = false;

export function openSfdcModal() {
  document.getElementById('sfdcModal').classList.add('open');
}
export function closeSfdcModal() {
  document.getElementById('sfdcModal').classList.remove('open');
  S._userSelectedType = false;
}

export function setSfdcType(type) {
  S.sfdcDataType = type;
  S._userSelectedType = true;
  document.getElementById('sfdcTypeStrat').className = 'sfdc-type-btn' + (type === 'accounts' ? ' active-strat' : '');
  document.getElementById('sfdcTypeCust').className = 'sfdc-type-btn' + (type === 'customers' ? ' active-cust' : '');
  const oppsBtn = document.getElementById('sfdcTypeOpps');
  if (oppsBtn) oppsBtn.className = 'sfdc-type-btn' + (type === 'opps' ? ' active-strat' : '');
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

export function handleSfdcFile(event) {
  const file = event.target.files[0];
  if (file && /\.(csv|xlsx?|xls)$/i.test(file.name)) {
    processUploadFile(file);
  }
  event.target.value = '';
}

export function processUploadFile(file) {
  readSpreadsheetFile(file).then(parsed => {
    if (parsed.length === 0) {
      alert('No data found in file');
      return;
    }
    closeSfdcModal();
    previewMerge(parsed);
  }).catch(err => {
    alert('Error reading file: ' + err.message);
  });
}

export function parseCSV(text) {
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

  const skippedRows = [];
  for (let i = 1; i < rows.length; i++) {
    const values = parseCSVLine(rows[i]);
    if (values.length === headers.length) {
      const row = {};
      headers.forEach((h, idx) => {
        // Normalize header names to match mapFieldName format
        const key = h.trim().toLowerCase().replace(/[/()&:]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        row[key] = values[idx].trim();
      });
      data.push(row);
    } else if (values.length > headers.length) {
      // More fields than headers: join trailing fields into the last column
      const reconciled = values.slice(0, headers.length - 1);
      reconciled.push(values.slice(headers.length - 1).join(', '));
      const row = {};
      headers.forEach((h, idx) => {
        const key = h.trim().toLowerCase().replace(/[/()&:]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        row[key] = reconciled[idx].trim();
      });
      data.push(row);
    } else {
      // Fewer fields than headers — skip
      const preview = rows[i].substring(0, 100);
      skippedRows.push({ line: i + 1, expected: headers.length, got: values.length, preview });
    }
  }
  if (skippedRows.length > 0) {
    console.warn('[CSV Parse] Skipped', skippedRows.length, 'rows due to column count mismatch:');
    skippedRows.slice(0, 5).forEach(r => {
      console.warn('  Row', r.line + ':', r.got, 'cols (expected', r.expected + '):', r.preview + '...');
    });
  }
  console.log('[CSV Parse] Successfully parsed', data.length, 'rows from', rows.length - 1, 'data rows');
  data._skippedCount = skippedRows.length;
  return data;
}

export function parseCSVLine(line) {
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

// Helper to get name from CSV row - checks all name field variations.
// account_name is checked BEFORE name because Salesforce CSVs often have both
// a "Name" column (record/opp name) and "Account Name" — we want the account name.
export function getNameFromRow(row) {
  return row.account_name || row.district_name || row.district ||
         row.organization || row.org_name || row.account || row.name || '';
}

// Helper to get state from CSV row - checks all state field variations
export function getStateFromRow(row) {
  return row.state || row.billing_state_province || row.billing_state ||
         row.shipping_state_province || row.shipping_state || '';
}

// Consolidate parent/child account rows into district-level records.
// - Rows with no parent_account are districts → keep as-is with their enrollment.
// - Rows with a parent_account are schools → skip them. Enrollment comes from the parent row only.
// - If a child's parent doesn't have its own row, create a synthetic district row (no enrollment).
export function consolidateParentAccounts(csvData) {
  const parentRows = [];
  const childRows = [];

  csvData.forEach(row => {
    const parentAccount = (row.parent_account || '').trim();
    if (parentAccount) {
      childRows.push(row);
    } else {
      parentRows.push(row);
    }
  });

  if (childRows.length === 0) return { rows: csvData, consolidatedCount: 0 }; // no parent account relationships

  console.log('[SFDC Merge] Parent account consolidation:', parentRows.length, 'districts,', childRows.length, 'schools');

  // Build a set of parent row names (lowered) for quick lookup
  const parentNames = new Set();
  parentRows.forEach(row => {
    const name = getNameFromRow(row);
    if (name) parentNames.add(name.toLowerCase().trim());
  });

  // Group children by parent account name
  const childrenByParent = new Map();
  childRows.forEach(row => {
    const key = row.parent_account.trim().toLowerCase();
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(row);
  });

  // For children whose parent doesn't have its own row, create a synthetic district row
  childrenByParent.forEach((children, parentKeyLower) => {
    if (!parentNames.has(parentKeyLower)) {
      // Create a synthetic district from the first child but with parent's name and no enrollment
      const first = children[0];
      const synthetic = {};
      Object.keys(first).forEach(key => { synthetic[key] = first[key]; });

      // Use the parent account name as the account name
      const parentName = first.parent_account.trim();
      if (synthetic.account_name !== undefined) synthetic.account_name = parentName;
      if (synthetic.name !== undefined) synthetic.name = parentName;

      // Clear enrollment fields — we don't have a parent-level count
      ['students_in_district', 'enrollment', 'student_count', 'total_students', 'total_enrollment'].forEach(k => {
        if (synthetic[k] !== undefined) synthetic[k] = '';
      });

      // The synthetic district must carry the PARENT's Account ID, not the child school's.
      // parent_account_id IS the district's SFDC ID. The child's account_id is the school's ID.
      // IDs are king — getting this wrong causes cascading data corruption.
      const parentAccountId = (first.parent_account_id || '').trim();
      if (parentAccountId && parentAccountId !== '000000000000000') {
        synthetic.account_id = parentAccountId;
      } else {
        // No parent ID available — clear the child's ID so we don't contaminate the district record
        delete synthetic.account_id;
      }
      delete synthetic.parent_account;
      delete synthetic.parent_account_id;

      parentRows.push(synthetic);
      console.log('[SFDC Merge] Created synthetic district row for:', parentName, '(from', children.length, 'school records)');
    }
  });

  // Attach school names (_schools) to each parent row from their child rows,
  // and roll up any opp data from child rows into the parent district.
  parentRows.forEach(row => {
    const rowName = getNameFromRow(row);
    if (!rowName) return;
    const key = rowName.toLowerCase().trim();
    const children = childrenByParent.get(key);
    if (children && children.length > 0) {
      row._schools = children.map(c => getNameFromRow(c)).filter(Boolean).sort();
      console.log('[SFDC Merge] Attached', row._schools.length, 'schools to:', rowName);

      // Roll up opp data from child rows into the parent district.
      // This prevents school-level opps from being silently dropped during consolidation.
      children.forEach(child => {
        const childOppFields = {};
        Object.keys(child).forEach(k => {
          if (typeof child[k] !== 'string') return;
          const mapped = mapFieldName(k);
          if (OPP_ENTRY_FIELDS.has(mapped) && child[k].trim()) {
            childOppFields[mapped] = child[k].trim();
          }
        });
        if (Object.keys(childOppFields).length > 0) {
          // Tag with school name so the UI can distinguish school-level opps from district opps
          childOppFields.school_name = getNameFromRow(child);
          const oppEntry = buildOppEntry(childOppFields);
          upsertOpp(row, oppEntry);
          console.log('[SFDC Merge] Rolled up opp from school', getNameFromRow(child), 'to district:', rowName);
        }
      });
    }
  });

  // Number of child rows absorbed into parents (original CSV rows minus output rows)
  const consolidatedCount = csvData.length - parentRows.length;
  return { rows: parentRows, consolidatedCount };
}

// Core merge logic: merges csvData rows against an existing dataset.
// Returns { mergedData, stats }.
export function runMerge(csvData, existingData, source) {
  // Log CSV columns for debugging
  if (csvData.length > 0) {
    console.log('[SFDC Merge] CSV columns:', Object.keys(csvData[0]));
    console.log('[SFDC Merge] Sample row:', csvData[0]);
  }

  // Build set of reps who currently have data loaded in the system.
  // This reflects ALL data in S.ACCOUNT_DATA at call time, including earlier uploads
  // in the same session. Active reps NOT in this set will fall through to Opp Owner.
  const loadedReps = new Set();
  existingData.forEach(item => {
    if (item.ae) loadedReps.add(item.ae);
  });
  console.log('[SFDC Merge] Loaded reps (have data in system):', [...loadedReps].sort().join(', '));

  // Create a map of existing data by name for quick lookup
  // Use both exact name and normalized name for matching
  // Store ARRAYS of entries per key to handle same-name different-state accounts
  // (e.g., "Jefferson County" in KY and AL, "Arlington" in TX and NY)
  const existingByName = new Map();
  const existingByNormalized = new Map();
  const existingByState = new Map(); // Group by state for fuzzy matching
  existingData.forEach((item, idx) => {
    const exactKey = item.name.toLowerCase().trim();
    const normalizedKey = normalizeDistrictName(item.name);
    // Store arrays to handle multiple accounts with the same name in different states
    if (!existingByName.has(exactKey)) existingByName.set(exactKey, []);
    existingByName.get(exactKey).push({ item, idx });
    if (!existingByNormalized.has(normalizedKey)) existingByNormalized.set(normalizedKey, []);
    existingByNormalized.get(normalizedKey).push({ item, idx });
    // Group by state
    const state = (item.state || '').toUpperCase().trim();
    if (state) {
      if (!existingByState.has(state)) existingByState.set(state, []);
      existingByState.get(state).push({ item, idx, normalizedKey });
    }
  });
  // Index by SFDC Account ID for deterministic matching
  const existingById = new Map();
  existingData.forEach((item, idx) => {
    if (item.account_id) {
      existingById.set(item.account_id, { item, idx });
    }
  });
  // Index by normalized address + state for alias detection
  // (catches same entity with different names at the same physical address)
  const existingByAddress = new Map();
  existingData.forEach((item, idx) => {
    const addr = (item.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const state = (item.state || '').toUpperCase().trim();
    if (addr && state && addr.length >= 5) {
      const addrKey = addr + '|' + state;
      // Store array — multiple different entities can share an address (co-located schools)
      if (!existingByAddress.has(addrKey)) existingByAddress.set(addrKey, []);
      existingByAddress.get(addrKey).push({ item, idx });
    }
  });
  console.log('[SFDC Merge] Accounts with SFDC IDs:', existingById.size);
  console.log('[SFDC Merge] Existing exact keys:', Array.from(existingByName.keys()).slice(0, 10), '...');
  console.log('[SFDC Merge] Existing normalized keys:', Array.from(existingByNormalized.keys()).slice(0, 10), '...');
  console.log('[SFDC Merge] States indexed:', Array.from(existingByState.keys()).join(', '));
  console.log('[SFDC Merge] Address+state index entries:', existingByAddress.size);

  // Helper: check if two district names plausibly refer to the same entity.
  // Used by TIER 0 to detect corrupted Account IDs. Returns true if names are
  // exact matches, prefix-related, or share significant words with a prefix relationship.
  // Returns false for clearly different entities ("Bedford" vs "New Bedford",
  // "Hampton" vs "Southampton", "Clarke Elementary" vs "Swampscott Public Schools").
  function namesArePlausiblyRelated(name1, name2) {
    const a = normalizeDistrictName(name1);
    const b = normalizeDistrictName(name2);
    // Exact normalized match → same entity
    if (a === b) return true;
    // Prefix at word boundary → legitimate variation (e.g. "kearsarge" → "kearsarge regional")
    if (b.startsWith(a) && (a.length === b.length || b[a.length] === ' ')) return true;
    if (a.startsWith(b) && (b.length === a.length || a[b.length] === ' ')) return true;
    // No prefix relationship → different entities even if they share a word
    // ("bedford" is NOT a prefix of "new bedford", so Bedford ≠ New Bedford)
    return false;
  }

  // Cascading match: Name → State → Enrollment → Address/City
  // If any check finds a mismatch against ALL candidates, the CSV row is a new account.
  // Returns the best matching entry, or null if no match (→ new pin).
  function pickBestMatch(entries, csvRow, csvId) {
    if (!entries || entries.length === 0) return null;
    let candidates = entries;

    // ── ID FILTER (highest priority) ──
    // If the CSV row has an Account ID, only consider candidates with the same ID
    // or candidates with no ID (legacy data). Never match a candidate with a DIFFERENT ID.
    if (csvId && csvId !== '000000000000000') {
      const idFiltered = candidates.filter(e => !e.item.account_id || e.item.account_id === csvId);
      if (idFiltered.length > 0) {
        candidates = idFiltered;
      } else {
        // ALL candidates have different IDs — no match possible
        console.log('[SFDC Merge] pickBestMatch: all candidates have different IDs for:', candidates[0]?.item.name,
          '- CSV ID:', csvId, 'vs existing IDs:', candidates.map(e => e.item.account_id || '(none)').join(', '));
        return null;
      }
    }

    // --- Check 1: State ---
    const csvSt = getStateFromRow(csvRow).toUpperCase().trim();
    if (csvSt) {
      const sameState = candidates.filter(e => (e.item.state || '').toUpperCase().trim() === csvSt);
      if (sameState.length > 0) {
        candidates = sameState;
      } else {
        // CSV state doesn't match ANY candidate — different account, drop a new pin
        console.log('[SFDC Merge] State mismatch → new record:', candidates[0].item.name,
          '- CSV state', csvSt, 'vs existing', candidates.map(e => e.item.state || '?').join(', '));
        return null;
      }
    }
    if (candidates.length === 1) return candidates[0];

    // --- Check 2: Enrollment ---
    const csvEnrollmentRaw = csvRow.enrollment || csvRow.enrollment_count ||
      csvRow.student_count || csvRow.total_students || csvRow.students ||
      csvRow.total_enrollment || csvRow.students_in_d || csvRow.students_in_district || '';
    const csvEnrollment = parseInt(String(csvEnrollmentRaw).replace(/[$,]/g, '')) || 0;
    if (csvEnrollment > 0) {
      // Match if within 30% — handles year-to-year enrollment changes
      const closeEnrollment = candidates.filter(e => {
        const existing = parseInt(e.item.enrollment) || 0;
        if (existing === 0) return true; // Can't rule out if existing has no enrollment
        const diff = Math.abs(existing - csvEnrollment);
        const larger = Math.max(existing, csvEnrollment);
        return (diff / larger) <= 0.30;
      });
      if (closeEnrollment.length > 0) {
        candidates = closeEnrollment;
      } else {
        // Enrollment differs significantly from ALL candidates — different account
        console.log('[SFDC Merge] Enrollment mismatch → new record:', candidates[0].item.name,
          '- CSV enrollment', csvEnrollment, 'vs existing',
          candidates.map(e => (e.item.enrollment || '?')).join(', '));
        return null;
      }
    }
    if (candidates.length === 1) return candidates[0];

    // --- Check 3: Address / City ---
    const csvAddress = (csvRow.address || csvRow.billing_address_line_1 ||
      csvRow.billing_address || csvRow.shipping_address_line_1 ||
      csvRow.shipping_address || '').toLowerCase().trim();
    const csvCity = (csvRow.city || csvRow.billing_city || csvRow.shipping_city || '').toLowerCase().trim();
    if (csvAddress || csvCity) {
      const sameLocation = candidates.filter(e => {
        const existAddr = (e.item.address || '').toLowerCase().trim();
        const existCity = (e.item.city || '').toLowerCase().trim();
        // If existing has no address/city data, can't rule it out
        if (!existAddr && !existCity) return true;
        // Match on address if both have it, otherwise match on city
        if (csvAddress && existAddr) return existAddr === csvAddress;
        if (csvCity && existCity) return existCity === csvCity;
        return true; // Not enough data to distinguish
      });
      if (sameLocation.length > 0) {
        candidates = sameLocation;
      } else {
        // Address/city differs from ALL candidates — different account
        console.log('[SFDC Merge] Address mismatch → new record:', candidates[0].item.name,
          '- CSV address/city', csvAddress || csvCity, 'vs existing',
          candidates.map(e => e.item.address || e.item.city || '?').join(', '));
        return null;
      }
    }

    // Return best remaining candidate (pick closest enrollment if we have CSV enrollment)
    if (candidates.length > 1 && csvEnrollment > 0) {
      candidates.sort((a, b) => {
        const aDiff = Math.abs((parseInt(a.item.enrollment) || 0) - csvEnrollment);
        const bDiff = Math.abs((parseInt(b.item.enrollment) || 0) - csvEnrollment);
        return aDiff - bDiff;
      });
    }
    if (candidates.length > 1) {
      console.log('[SFDC Merge] Multiple candidates remain after all checks for:', candidates[0].item.name,
        '- using first match in', (candidates[0].item.state || '?'));
    }
    return candidates[0];
  }

  // Fuzzy match by state + core name prefix
  function findByStateAndName(csvName, csvState, csvId) {
    if (!csvState) return null;
    const stateKey = csvState.toUpperCase().trim();
    const stateRecords = existingByState.get(stateKey);
    if (!stateRecords) return null;

    const csvNormalized = normalizeDistrictName(csvName);

    for (const { item, idx, normalizedKey } of stateRecords) {
      // Check if one normalized name is a PREFIX of the other (with word boundary).
      // Previously used arbitrary substring containment (csvNormalized.includes(normalizedKey))
      // which caused false positives: "lake dallas".includes("dallas") matched Lake Dallas ISD
      // to Dallas ISD. Also matched "north little rock" to "little rock", "central union elementary"
      // to "union elementary", etc. Prefix-only matching prevents this class of error while still
      // catching legitimate variations like "kearsarge" → "kearsarge regional".
      const isPrefix = normalizedKey.startsWith(csvNormalized) || csvNormalized.startsWith(normalizedKey);
      if (isPrefix) {
        // Verify word boundary: the prefix must end at a space or end-of-string in the longer name
        const shorterStr = csvNormalized.length <= normalizedKey.length ? csvNormalized : normalizedKey;
        const longerStr = csvNormalized.length > normalizedKey.length ? csvNormalized : normalizedKey;
        if (shorterStr.length < longerStr.length && longerStr[shorterStr.length] !== ' ') {
          // Prefix ends mid-word (e.g. "spring" matching "springfield") — skip
          console.log('[SFDC Merge] State+Name SKIPPED (mid-word prefix):', csvName, '→', item.name,
            '(normalized:', csvNormalized, 'vs', normalizedKey + ')');
          continue;
        }
        // Guard against very short prefixes matching much longer names
        if (shorterStr.length < longerStr.length * 0.4) {
          console.log('[SFDC Merge] State+Name SKIPPED (length mismatch, ratio=' + (shorterStr.length/longerStr.length).toFixed(2) + '):', csvName, '→', item.name,
            '(normalized:', csvNormalized, 'vs', normalizedKey + ')');
          continue;
        }
        // ID validation: if both have Account IDs and they differ, skip this candidate
        if (csvId && csvId !== '000000000000000' && item.account_id && item.account_id !== csvId) {
          console.log('[SFDC Merge] State+Name SKIPPED (ID mismatch):', csvName, '→', item.name,
            '— CSV ID:', csvId, '≠ existing ID:', item.account_id);
          continue;
        }
        console.log('[SFDC Merge] State+Name match:', csvName, '→', item.name, '(state:', stateKey, ')');
        return { item, idx };
      }
    }
    return null;
  }
  // Count notes that exist in localStorage
  let notesCount = 0;
  existingData.forEach(d => {
    const noteKey = 'edia_notes_' + d.name.replace(/[^a-zA-Z0-9]/g, '_');
    try {
      const notes = JSON.parse(localStorage.getItem(noteKey) || '[]');
      if (notes.length > 0) notesCount++;
    } catch(_e) { /* ignored */ }
  });

  // Analyze merge impact
  const stats = {
    total: csvData.length,
    newRecords: 0,
    updatedRecords: 0,
    duplicateRows: 0,   // CSV rows for accounts already merged (multiple opps per account)
    notesPreserved: notesCount,
    changes: [],
    conflicts: [],
    resolutions: []  // Track every owner resolution: { name, csvOwner, resolvedAE, reason, oppOwner }
  };

  const mergedData = [];
  const matchedIndices = new Set(); // Track which existing-data indices were matched (by index, not name)
  const mergedByName = new Map(); // Track already-merged records to handle duplicate CSV rows

  csvData.forEach((csvRow, idx) => {
    const name = getNameFromRow(csvRow);
    if (!name) {
      console.log('[SFDC Merge] Row', idx, 'has no name field. Keys:', Object.keys(csvRow));
      return;
    }

    const nameKey = name.toLowerCase().trim();
    const normalizedKey = normalizeDistrictName(name);

    // Get CSV row state for state-aware matching
    const csvState = getStateFromRow(csvRow);
    // Use composite key (name + state) for already-merged lookup to avoid
    // folding same-name different-state accounts into each other
    const csvStateKey = (csvState || '').toUpperCase().trim();
    const compositeKey = nameKey + '|' + csvStateKey;
    const compositeNormKey = normalizedKey + '|' + csvStateKey;

    // First check if we already merged this account from an earlier CSV row (handles multiple opps per account).
    // PRIORITY: Account ID (king) → name+state composite → name-only (only when CSV has no state).
    const csvAccountId = (csvRow.account_id || '').trim();
    let alreadyMerged = null;
    if (csvAccountId && csvAccountId !== '000000000000000') {
      alreadyMerged = mergedByName.get('id:' + csvAccountId);
    }
    if (!alreadyMerged) {
      alreadyMerged = mergedByName.get(compositeKey) || mergedByName.get(compositeNormKey);
    }
    if (!alreadyMerged && !csvStateKey) {
      alreadyMerged = mergedByName.get(nameKey) || mergedByName.get(normalizedKey);
    }

    // ── TIER 0: Match by SFDC Account ID (deterministic, highest priority) ──
    // csvAccountId already extracted above for alreadyMerged lookup
    let existing = null;
    if (csvAccountId && csvAccountId !== '000000000000000') {
      const idMatch = existingById.get(csvAccountId);
      if (idMatch) {
        // Verify state consistency: if both have a state and they differ, the ID was
        // written to the wrong record in a previous corrupted merge. Skip the ID match
        // so the name+state cascade can find or create the correct record.
        const idMatchState = (idMatch.item.state || '').toUpperCase().trim();
        const csvSt = (getStateFromRow(csvRow) || '').toUpperCase().trim();
        const csvName = getNameFromRow(csvRow);

        // CHECK 1: State consistency
        if (csvSt && idMatchState && csvSt !== idMatchState) {
          console.warn('[SFDC Merge] TIER 0 STATE MISMATCH — ID', csvAccountId,
            'matched', idMatch.item.name, '(' + idMatchState + ') but CSV state is', csvSt,
            '— removing corrupted ID from existing record');
          delete idMatch.item.account_id;
          existingById.delete(csvAccountId);
          // Don't set existing — fall through to name+state matching

        // CHECK 2: Name consistency — if normalized names are not prefix-related
        // and share no significant words, the ID was written from a different entity
        // (e.g. a school's ID contaminating a district record via substring matching).
        } else if (!namesArePlausiblyRelated(csvName, idMatch.item.name)) {
          console.warn('[SFDC Merge] TIER 0 NAME MISMATCH — ID', csvAccountId,
            'matched', idMatch.item.name, 'but CSV name is', csvName,
            '— removing corrupted ID from existing record');
          delete idMatch.item.account_id;
          existingById.delete(csvAccountId);
          // Don't set existing — fall through to name+state matching

        } else {
          existing = idMatch;
          console.log('[SFDC Merge] ID match:', csvAccountId, '→', existing.item.name);
          // Update alreadyMerged via ID key (authoritative) then composite
          const existingComposite = existing.item.name.toLowerCase().trim() + '|' + (existing.item.state || '').toUpperCase().trim();
          alreadyMerged = alreadyMerged || mergedByName.get('id:' + csvAccountId) || mergedByName.get(existingComposite);
        }
      }
    }

    // ── TIER 0.5: Address + State + Name-overlap match (alias detection) ──
    // Catches same entity with different names (e.g., "SAU #65 Kearsarge" vs "Kearsarge Regional School District")
    // Only matches if names share a significant word (3+ chars, excluding generic school terms)
    if (!existing) {
      const csvAddr = (csvRow.address || csvRow.billing_address || csvRow.shipping_address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (csvAddr && csvAddr.length >= 5 && csvStateKey) {
        const addrKey = csvAddr + '|' + csvStateKey;
        const addrMatches = existingByAddress.get(addrKey);
        if (addrMatches && addrMatches.length > 0) {
          // Extract significant words from CSV name (3+ chars, exclude generic terms)
          const genericWords = new Set(['school', 'schools', 'high', 'middle', 'elementary', 'academy', 'the', 'and', 'for', 'public', 'district', 'charter', 'preparatory', 'regional', 'county', 'city', 'unified', 'independent', 'consolidated', 'free', 'union', 'area', 'community']);
          const csvWords = new Set(name.toLowerCase().match(/[a-z]{3,}/g)?.filter(w => !genericWords.has(w)) || []);
          for (const candidate of addrMatches) {
            if (matchedIndices.has(candidate.idx)) continue;
            const existingWords = new Set(candidate.item.name.toLowerCase().match(/[a-z]{3,}/g)?.filter(w => !genericWords.has(w)) || []);
            const shared = [...csvWords].filter(w => existingWords.has(w));
            if (shared.length > 0) {
              existing = candidate;
              console.log('[SFDC Merge] Address+name-overlap match:', name, '→', candidate.item.name, '(shared words:', shared.join(', '), ', address:', csvAddr, ')');
              const existingComposite = existing.item.name.toLowerCase().trim() + '|' + (existing.item.state || '').toUpperCase().trim();
              alreadyMerged = alreadyMerged || mergedByName.get(existingComposite) || mergedByName.get(existing.item.name.toLowerCase().trim());
              break;
            }
          }
        }
      }
    }

    // ── TIER 1: Exact name match ──
    if (!existing) {
      existing = pickBestMatch(existingByName.get(nameKey), csvRow, csvAccountId);
    }
    // ── TIER 2: Normalized name match ──
    if (!existing) {
      existing = pickBestMatch(existingByNormalized.get(normalizedKey), csvRow, csvAccountId);
      if (existing) {
        console.log('[SFDC Merge] Normalized match:', name, '→', existing.item.name);
        // Use ID key first (authoritative), then composite key. Never use name-only key.
        const existingComposite = existing.item.name.toLowerCase().trim() + '|' + (existing.item.state || '').toUpperCase().trim();
        alreadyMerged = alreadyMerged || mergedByName.get('id:' + (existing.item.account_id || '')) || mergedByName.get(existingComposite);
      }
    }
    // ── TIER 3: State + name contains match ──
    if (!existing) {
      existing = findByStateAndName(name, csvState, csvAccountId);
      if (existing) {
        const existingComposite = existing.item.name.toLowerCase().trim() + '|' + (existing.item.state || '').toUpperCase().trim();
        alreadyMerged = alreadyMerged || mergedByName.get('id:' + (existing.item.account_id || '')) || mergedByName.get(existingComposite);
      }
    }
    // ── ID VALIDATION GATE ──
    // IDs are king. If a name-based tier (1, 2, or 3) found a candidate but both the
    // CSV row and the candidate have Account IDs that DIFFER, reject the match.
    // They are different entities that happen to share a name.
    // (TIER 0 already matched by ID, so this only applies to name-based fallback matches.)
    if (existing && csvAccountId && csvAccountId !== '000000000000000') {
      const existingId = existing.item.account_id || '';
      if (existingId && existingId !== csvAccountId) {
        console.warn('[SFDC Merge] ID VALIDATION REJECTED name match:', name,
          '→', existing.item.name, '— CSV ID:', csvAccountId, '≠ existing ID:', existingId,
          '— these are different entities, treating CSV row as new record');
        existing = null;
      }
    }

    if (!existing && !alreadyMerged && idx < 10) {
      console.log('[SFDC Merge] No match for:', name, '(exact:', nameKey, ', normalized:', normalizedKey, ', state:', csvStateKey || 'none', ')');
    }

    // If this account was already merged from a previous CSV row, update that record (multiple opps scenario)
    if (alreadyMerged) {
      stats.duplicateRows++;
      console.log('[SFDC Merge] Multiple opps for:', name, '- updating existing merged record');
      // Pre-scan for opp fields so resolveOwner knows if this row has opp data
      const rowHasOppData = Object.keys(csvRow).some(key => {
        if (typeof csvRow[key] !== 'string') return false;
        return OPP_ENTRY_FIELDS.has(mapFieldName(key)) && csvRow[key].trim();
      });
      if (rowHasOppData) alreadyMerged._hasUploadedOpp = true;
      // Pre-extract Opp Owner from this row for resolveOwner fallback
      const rowOppOwner = Object.keys(csvRow).reduce((found, k) =>
        found || (mapFieldName(k) === 'opp_owner' ? (csvRow[k] || '').trim() : ''), '');
      // Separate opp fields from account fields, then upsert each opp by product area
      const csvOppFields = {};
      Object.keys(csvRow).forEach(key => {
        const val = csvRow[key];
        if (typeof val !== 'string') {
          if (val) alreadyMerged[key] = val;
          return;
        }
        if (val && val.trim()) {
          const mappedKey = mapFieldName(key);
          if (mappedKey === 'name') return;
          if (OPP_ENTRY_FIELDS.has(mappedKey)) {
            csvOppFields[mappedKey] = val.trim();
          } else if (mappedKey === 'ae') {
            // Don't blindly overwrite ae — it was already resolved on the first row.
            // Only update if the new CSV value resolves to a valid active rep.
            const result = resolveOwner(val.trim(), alreadyMerged.ae || '', {
              enrollment: alreadyMerged.enrollment,
              hasUploadedOpp: alreadyMerged._hasUploadedOpp,
              oppOwner: rowOppOwner,
              loadedReps,
              accountName: alreadyMerged.name || '',
              source: source || 'accounts',
            });
            if (result.ae) alreadyMerged.ae = result.ae;
            // Tag source team from the CSV AE
            const aeTeam = getTeamForRep(val.trim());
            if (aeTeam) alreadyMerged._source_team = aeTeam;
          } else {
            // For non-opp fields, update if the CSV has a value (e.g. region)
            alreadyMerged[mappedKey] = val.trim();
          }
        }
      });
      // Upsert this opp into the opps array (each product area gets its own entry)
      if (Object.keys(csvOppFields).length > 0) {
        const oppEntry = buildOppEntry(csvOppFields);
        upsertOpp(alreadyMerged, oppEntry);
      }
      clampFutureLastActivity(alreadyMerged);
      if (csvAccountId && csvAccountId !== '000000000000000') {
        if (!alreadyMerged.account_id) {
          // Only persist ID if states match — prevents writing a different entity's ID
          // onto a name-matched record from a different state
          const existSt = (alreadyMerged.state || '').toUpperCase().trim();
          const csvSt = csvStateKey;
          if (!existSt || !csvSt || existSt === csvSt) {
            alreadyMerged.account_id = csvAccountId;
            mergedByName.set('id:' + csvAccountId, alreadyMerged);
          } else {
            console.warn('[SFDC Merge] Blocked account_id write (state mismatch):',
              alreadyMerged.name, existSt, '≠ CSV', csvSt, 'ID:', csvAccountId);
          }
        } else if (alreadyMerged.account_id !== csvAccountId) {
          // DIFFERENT IDs = DIFFERENT ACCOUNTS. This CSV row should NOT be treated
          // as a duplicate of alreadyMerged. Log it — the name+state composite key
          // incorrectly matched a different entity.
          console.warn('[SFDC Merge] ID CONFLICT on alreadyMerged:', alreadyMerged.name,
            '- existing ID:', alreadyMerged.account_id, '≠ CSV ID:', csvAccountId,
            '— these are different accounts with the same name');
        }
      }
      parseNumericFields(alreadyMerged);
      (alreadyMerged.opps || []).forEach(o => {
        if (o.acv !== undefined && o.acv !== '') {
          const cleaned = String(o.acv).replace(/[$,]/g, '');
          const val = parseFloat(cleaned);
          if (!isNaN(val)) o.acv = val;
        }
        if (o.probability !== undefined && o.probability !== '') {
          const cleaned = String(o.probability).replace(/[$,]/g, '');
          const val = parseFloat(cleaned);
          if (!isNaN(val)) o.probability = val;
        }
      });
      return; // Skip to next CSV row (return in forEach acts like continue)
    }

    if (existing) {
      // Mark this existing account as matched so it won't be re-added in the preservation step
      matchedIndices.add(existing.idx);
      // Update existing record but preserve certain local fields
      const merged = { ...existing.item };

      // Debug: Log CSV columns for first few rows
      if (import.meta.env.DEV && idx < 2) {
        console.log('[SFDC Merge] Processing:', name);
        console.log('[SFDC Merge] CSV columns:', Object.keys(csvRow));
        console.log('[SFDC Merge] Key fields from CSV:');
        ['stage', 'opp_stage', 'year_1_acv', 'acv', 'probability'].forEach(k => {
          if (csvRow[k] !== undefined) console.log(`  ${k}: "${csvRow[k]}"`);
        });
      }

      // Update with CSV data, mapping common field variations
      // Separate opp fields from account fields — opp fields go into opps array
      const csvOppFields = {};
      Object.keys(csvRow).forEach(key => {
        const val = csvRow[key];
        if (typeof val !== 'string') {
          // Preserve non-string values (e.g. _schools array) as-is
          if (val) merged[key] = val;
          return;
        }
        if (val && val.trim()) {
          // Map common CSV column names to our field names
          const mappedKey = mapFieldName(key);
          // Never overwrite the existing account name — it's the source of truth.
          // CSV names may be sub-districts or alternate labels that shouldn't replace
          // the canonical name (e.g. "NYC Geographic District #16" overwriting "NYC Public Schools").
          if (mappedKey === 'name') return;
          if (OPP_ENTRY_FIELDS.has(mappedKey)) {
            csvOppFields[mappedKey] = val.trim();
          } else {
            merged[mappedKey] = val.trim();
          }
        }
      });

      // Migrate any existing flat opp data into opps array, then upsert new opp
      migrateToOppsArray(merged);
      if (Object.keys(csvOppFields).length > 0) {
        const oppEntry = buildOppEntry(csvOppFields);
        upsertOpp(merged, oppEntry);
      }
      clampFutureLastActivity(merged);

      // Persist SFDC Account ID for future ID-based matching
      if (csvAccountId && csvAccountId !== '000000000000000') {
        if (!merged.account_id) {
          const mergedSt = (merged.state || '').toUpperCase().trim();
          const csvSt = (getStateFromRow(csvRow) || '').toUpperCase().trim();
          if ((!mergedSt || !csvSt || mergedSt === csvSt) &&
              namesArePlausiblyRelated(name, merged.name)) {
            merged.account_id = csvAccountId;
          } else if (!mergedSt || !csvSt || mergedSt === csvSt) {
            // State matches but names are unrelated — don't write the ID
            console.warn('[SFDC Merge] Blocked account_id write (name mismatch):',
              merged.name, '≠ CSV name', name, 'ID:', csvAccountId);
          } else {
            console.warn('[SFDC Merge] Blocked account_id write (state mismatch):',
              merged.name, mergedSt, '≠ CSV', csvSt, 'ID:', csvAccountId);
          }
        } else if (merged.account_id !== csvAccountId) {
          // Existing record already has a DIFFERENT ID. This is a same-name collision.
          // The CSV row is for a different entity. Don't overwrite.
          console.warn('[SFDC Merge] ID CONFLICT on matched record:', merged.name,
            '- existing ID:', merged.account_id, '≠ CSV ID:', csvAccountId);
        }
      }

      // Persist parent_account_id for ID-based parent linking in crossLinkCustomers
      const csvParentAcctId = (csvRow.parent_account_id || '').trim();
      if (csvParentAcctId && csvParentAcctId !== '000000000000000') {
        merged.parent_account_id = csvParentAcctId;
      }

      // ID-based parent district linking for school-level records
      const csvParentAccountId = (csvRow.parent_account_id || '').trim();
      if (csvParentAccountId && csvParentAccountId !== '000000000000000') {
        const parentAccount = S.ACCOUNT_DATA.find(a => a.account_id === csvParentAccountId);
        if (parentAccount) {
          merged.parent_district = parentAccount.name;
          console.log('[SFDC Merge] ID-linked school record:', merged.name || name, '→ district:', parentAccount.name);
        }
      }

      // Parse numeric fields (account-level + opp acv/probability inside opps)
      parseNumericFields(merged);
      (merged.opps || []).forEach(o => {
        if (o.acv !== undefined && o.acv !== '') {
          const cleaned = String(o.acv).replace(/[$,]/g, '');
          const val = parseFloat(cleaned);
          if (!isNaN(val)) o.acv = val;
        }
        if (o.probability !== undefined && o.probability !== '') {
          const cleaned = String(o.probability).replace(/[$,]/g, '');
          const val = parseFloat(cleaned);
          if (!isNaN(val)) o.probability = val;
        }
      });

      // Strip ownership from DOE accounts
      if (isDOE(merged.name)) { delete merged.ae; delete merged.csm; }

      // Owner resolution: handle inactive/former reps, managers, reps with no data,
      // blank owners, and active-vs-active conflicts.
      if (!isDOE(merged.name)) {
        const csvAE = (merged.ae || '').trim();
        const priorAE = (existing.item.ae || '').trim();
        const hasUploadedOpp = Object.keys(csvOppFields).length > 0;
        const ownerResult = resolveOwner(csvAE, priorAE, {
          enrollment: merged.enrollment,
          hasUploadedOpp,
          oppOwner: (merged.opp_owner || '').trim(),
          loadedReps,
          accountName: merged.name || '',
          source: source || 'accounts',
        });
        merged.ae = ownerResult.ae;
        if (hasUploadedOpp) merged._hasUploadedOpp = true;
        // Tag source team from the CSV AE — used by "Unassigned Accounts" filter
        // to scope unowned accounts to the correct team.
        if (csvAE) {
          merged._source_team = getTeamForRep(csvAE) || getTeamForRep(priorAE) || merged._source_team || null;
        }
        // When an active rep's data isn't loaded yet, preserve them as the
        // territory owner so the popup can show the dual-assignment display
        // (Assigned = original Account Owner, Holdout = Opp Owner fallback).
        if (ownerResult.reason === 'no_data_loaded' && csvAE) {
          merged.territory_ae = csvAE;
        } else {
          // Clear stale territory_ae from a prior upload (rep's data now loaded)
          delete merged.territory_ae;
        }

        // Track resolution for post-upload summary
        if (csvAE) {
          stats.resolutions.push({
            name: merged.name,
            csvOwner: csvAE,
            resolvedAE: ownerResult.ae || '(unassigned)',
            reason: ownerResult.reason,
            oppOwner: (merged.opp_owner || '').trim(),
            isNew: false,
          });
          if (ownerResult.reason !== 'direct_assign') {
            console.log('[SFDC Merge] Owner resolved:', merged.name,
              '- CSV owner', csvAE, '→', ownerResult.ae || '(unassigned)',
              '(reason:', ownerResult.reason + ')');
          }
        }

        // Conflict: CSV brings a different active rep than the current active rep.
        // Only flag conflicts for opp uploads — account uploads are source of truth.
        if (source === 'opps' && csvAE && priorAE && csvAE !== priorAE
            && ALL_ACTIVE_REPS.has(csvAE) && ALL_ACTIVE_REPS.has(priorAE)
            && !MANAGER_REPS.get(priorAE)?.has(csvAE)) {
          console.log('[SFDC Merge] CONFLICT:', merged.name, '- was', priorAE, ', CSV says', csvAE);
          stats.conflicts.push({
            name: merged.name,
            enrollment: parseInt(merged.enrollment) || 0,
            state: merged.state || '',
            account_id: merged.account_id || csvAccountId || '',
            oldAE: priorAE,
            newAE: csvAE,
            source: source || 'accounts',
            // Context about the conflict
            isCustomer: !!merged.is_customer,
            isInactiveCustomer: merged.type === 'Inactive Customer',
            arr: merged.arr || null,
            // What the OLD rep (priorAE / existing owner) has
            oldSource: 'existing',
            oldTeam: getTeamForRep(priorAE) || null,
            // What the NEW rep (csvAE / from upload) brings
            newSource: 'csv',
            newTeam: getTeamForRep(csvAE) || null,
            // Opp context from CSV row
            hasOpp: Object.keys(csvOppFields).length > 0,
            oppStage: csvOppFields.opp_stage || merged.opp_stage || '',
            oppAcv: csvOppFields.opp_acv || '',
            oppAreas: csvOppFields.opp_areas || merged.opp_areas || '',
            oppOwner: (merged.opp_owner || '').trim(),
            // Existing record opps
            existingOpps: (existing.item.opps || []).map(o => ({
              area: o.area || '',
              stage: o.stage || '',
              acv: o.acv || '',
            })),
            // Resolution reason
            ownerResolution: ownerResult.reason,
          });
        }
      }

      // Check if anything actually changed - compare key opp fields
      const changedFields = [];

      const hasChanges = Object.keys(csvRow).some(key => {
        if (typeof csvRow[key] !== 'string') return false;
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

      if (import.meta.env.DEV) {
        // Debug logging for change detection
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
      // Track this merged record to handle duplicate CSV rows (multiple opps per account).
      // KEY HIERARCHY: Account ID (deterministic) → name+state (composite) → name-only (ONLY if no state).
      // Account ID is king — when present, it's the authoritative dedup key.
      if (merged.account_id) {
        mergedByName.set('id:' + merged.account_id, merged);
      }
      const mergedState = (merged.state || '').toUpperCase().trim();
      mergedByName.set(nameKey + '|' + mergedState, merged);
      mergedByName.set(normalizedKey + '|' + mergedState, merged);
      mergedByName.set(existing.item.name.toLowerCase().trim() + '|' + mergedState, merged);
      // Name-only keys ONLY when record has no state info (legacy data without state).
      // When state is present, composite keys are sufficient. Name-only keys cause
      // false collisions between same-name different-state accounts.
      if (!mergedState) {
        mergedByName.set(nameKey, merged);
        mergedByName.set(normalizedKey, merged);
        mergedByName.set(existing.item.name.toLowerCase().trim(), merged);
      }
    } else {
      // New record - check if name might be a partial match
      const possibleMatch = findPartialMatch(name, existingByName);
      if (possibleMatch) {
        stats.changes.push({ name, action: 'new', warning: `Similar to existing: "${possibleMatch}"` });
      }

      // Log ALL new records so we can debug matching issues
      console.log('[SFDC Merge] NEW RECORD (no match):', name);
      console.log('  - Normalized key tried:', normalizedKey);
      console.log('  - State:', getStateFromRow(csvRow) || 'NOT SET');
      if (possibleMatch) {
        console.log('  - Possible match found:', possibleMatch);
      }

      const newRecord = {};
      const newOppFields = {};
      Object.keys(csvRow).forEach(key => {
        if (typeof csvRow[key] !== 'string') {
          if (csvRow[key]) newRecord[key] = csvRow[key];
          return;
        }
        const trimmed = (csvRow[key] || '').trim();
        if (!trimmed) return; // Skip empty values so they don't overwrite non-empty ones (e.g. empty shipping overwrites billing)
        const mappedKey = mapFieldName(key);
        if (OPP_ENTRY_FIELDS.has(mappedKey)) {
          newOppFields[mappedKey] = trimmed;
        } else {
          newRecord[mappedKey] = trimmed;
        }
      });
      newRecord.name = name;
      if (csvAccountId && csvAccountId !== '000000000000000') {
        newRecord.account_id = csvAccountId;
      }

      // Persist parent_account_id for ID-based parent linking in crossLinkCustomers
      const csvNewParentAcctId = (csvRow.parent_account_id || '').trim();
      if (csvNewParentAcctId && csvNewParentAcctId !== '000000000000000') {
        newRecord.parent_account_id = csvNewParentAcctId;
      }

      // ID-based parent district linking for new school-level records
      const csvNewParentId = (csvRow.parent_account_id || '').trim();
      if (csvNewParentId && csvNewParentId !== '000000000000000') {
        const parentAccount = S.ACCOUNT_DATA.find(a => a.account_id === csvNewParentId);
        if (parentAccount) {
          newRecord.parent_district = parentAccount.name;
          console.log('[SFDC Merge] ID-linked new school record:', name, '→ district:', parentAccount.name);
        }
      }

      // Cross-reference: if this new record is missing location data, try to
      // find a match in the OTHER dataset (e.g. opp introduces a new account
      // that already exists as a customer, or vice versa). This is the primary
      // fix for the "data exists but no pin" issue.
      const otherDataset = (existingData === S.ACCOUNT_DATA) ? S.CUSTOMER_DATA
        : (existingData === S.CUSTOMER_DATA) ? S.ACCOUNT_DATA : null;
      if (otherDataset && (!newRecord.lat || !newRecord.lng)) {
        const newNorm = normalizeDistrictName(name);
        for (const other of otherDataset) {
          if (!other.lat || !other.lng) continue;
          const otherNorm = normalizeDistrictName(other.name);
          if (other.name.toLowerCase().trim() === name.toLowerCase().trim() || otherNorm === newNorm) {
            // Verify state if both records have it
            const nState = (newRecord.state || '').toUpperCase().trim();
            const oState = (other.state || '').toUpperCase().trim();
            if (nState && oState && nState !== oState) continue;
            console.log('[SFDC Merge] Cross-dataset match for new record:', name, '→ inherited coords from', other.name);
            newRecord.lat = other.lat;
            newRecord.lng = other.lng;
            // Also inherit missing location fields
            if (!newRecord.state && other.state) newRecord.state = other.state;
            if (!newRecord.city && other.city) newRecord.city = other.city;
            if (!newRecord.address && other.address) newRecord.address = other.address;
            if (!newRecord.region && other.region) newRecord.region = other.region;
            break;
          }
        }
      }

      // Build opps array for new record
      if (Object.keys(newOppFields).length > 0) {
        const oppEntry = buildOppEntry(newOppFields);
        upsertOpp(newRecord, oppEntry);
      }
      clampFutureLastActivity(newRecord);

      // Parse numeric fields
      parseNumericFields(newRecord);
      (newRecord.opps || []).forEach(o => {
        if (o.acv !== undefined && o.acv !== '') {
          const cleaned = String(o.acv).replace(/[$,]/g, '');
          const val = parseFloat(cleaned);
          if (!isNaN(val)) o.acv = val;
        }
        if (o.probability !== undefined && o.probability !== '') {
          const cleaned = String(o.probability).replace(/[$,]/g, '');
          const val = parseFloat(cleaned);
          if (!isNaN(val)) o.probability = val;
        }
      });

      // Strip ownership from DOE accounts
      if (isDOE(newRecord.name)) { delete newRecord.ae; delete newRecord.csm; }

      // Owner resolution for new records: inactive/former owners, managers,
      // reps with no data → Opp Owner fallback. Active reps with data → assigned normally.
      if (!isDOE(newRecord.name)) {
        const csvAE = (newRecord.ae || '').trim();
        const hasUploadedOpp = Object.keys(newOppFields).length > 0;
        const ownerResult = resolveOwner(csvAE, '', {
          enrollment: newRecord.enrollment,
          hasUploadedOpp,
          oppOwner: (newRecord.opp_owner || '').trim(),
          loadedReps,
          accountName: newRecord.name || '',
          source: source || 'accounts',
        });
        newRecord.ae = ownerResult.ae;
        if (hasUploadedOpp) newRecord._hasUploadedOpp = true;
        // Tag source team from the CSV AE — used by "Unassigned Accounts" filter
        if (csvAE) {
          newRecord._source_team = getTeamForRep(csvAE) || null;
        }
        // When an active rep's data isn't loaded yet, preserve them as the
        // territory owner so the popup can show the dual-assignment display.
        if (ownerResult.reason === 'no_data_loaded' && csvAE) {
          newRecord.territory_ae = csvAE;
        }

        // Track resolution for post-upload summary
        if (csvAE) {
          stats.resolutions.push({
            name: newRecord.name,
            csvOwner: csvAE,
            resolvedAE: ownerResult.ae || '(unassigned)',
            reason: ownerResult.reason,
            oppOwner: (newRecord.opp_owner || '').trim(),
            isNew: true,
          });
          if (ownerResult.reason !== 'direct_assign') {
            console.log('[SFDC Merge] New record owner resolved:', newRecord.name,
              '- CSV owner', csvAE, '→', ownerResult.ae || '(unassigned)',
              '(reason:', ownerResult.reason + ')');
          }
        }
      }

      stats.newRecords++;
      if (!possibleMatch) {
        stats.changes.push({ name, action: 'new' });
      }
      mergedData.push(newRecord);
      // Track this new record to handle duplicate CSV rows.
      // Account ID is king — deterministic dedup key when available.
      if (newRecord.account_id) {
        mergedByName.set('id:' + newRecord.account_id, newRecord);
      }
      const newState = (newRecord.state || '').toUpperCase().trim();
      mergedByName.set(nameKey + '|' + newState, newRecord);
      mergedByName.set(normalizedKey + '|' + newState, newRecord);
      // Name-only keys ONLY when no state info (legacy data)
      if (!newState) {
        mergedByName.set(nameKey, newRecord);
        mergedByName.set(normalizedKey, newRecord);
      }
      // Also track by address for alias detection within the same CSV upload
      const newAddr = (newRecord.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const newAddrState = (newRecord.state || '').toUpperCase().trim();
      if (newAddr && newAddrState && newAddr.length >= 5) {
        const newAddrKey = newAddr + '|' + newAddrState;
        if (!existingByAddress.has(newAddrKey)) existingByAddress.set(newAddrKey, []);
        existingByAddress.get(newAddrKey).push({ item: newRecord, idx: mergedData.length - 1 });
      }
    }
  });

  // Keep existing records that were NOT matched by any CSV row,
  // but skip stale duplicates whose name+state already exists in mergedData.
  // These are base-data records with corrupted IDs from prior merge sessions
  // that weren't matched by any CSV row because the ID filter rejected them.
  // The CSV already brought in the correct version of these records.
  const mergedNameState = new Set();
  mergedData.forEach(item => {
    const key = (item.name || '').toLowerCase().trim() + '|' + (item.state || '').toUpperCase().trim();
    mergedNameState.add(key);
  });

  let staleSkipped = 0;
  existingData.forEach((item, idx) => {
    if (!matchedIndices.has(idx)) {
      const key = (item.name || '').toLowerCase().trim() + '|' + (item.state || '').toUpperCase().trim();
      if (mergedNameState.has(key)) {
        // A record with this name+state was already added from CSV processing.
        // This unmatched record is a stale duplicate — skip it.
        staleSkipped++;
        console.log('[SFDC Merge] Skipping stale duplicate:', item.name,
          '(' + (item.state || '') + ')',
          item.account_id ? 'stale ID: ' + item.account_id : 'no ID',
          'enrollment:', item.enrollment || '?');
      } else {
        mergedData.push(item);
        // Track this key so subsequent unmatched records with the same
        // name+state are also skipped (handles base-data-only duplicates)
        mergedNameState.add(key);
      }
    }
  });

  if (staleSkipped > 0) {
    console.log('[SFDC Merge] Skipped', staleSkipped, 'stale duplicate records');
    stats.staleRecordsRemoved = staleSkipped;
  }

  return { mergedData, stats };
}

// ============ OPP-ONLY MERGE ============
// Dedicated merge path for Opportunity CSV uploads.
// Matches CSV rows to existing accounts and upserts opp data only.
// Does NOT create new accounts, geocode, or modify account-level fields.
export function runOppMerge(csvData) {
  if (csvData.length > 0) {
    console.log('[Opp Merge] CSV columns:', Object.keys(csvData[0]));
    console.log('[Opp Merge] Sample row:', csvData[0]);
  }

  // Build set of reps who currently have data loaded
  const loadedReps = new Set();
  S.ACCOUNT_DATA.forEach(item => {
    if (item.ae) loadedReps.add(item.ae);
  });
  console.log('[Opp Merge] Loaded reps:', [...loadedReps].sort().join(', '));

  // Build lookup for accounts by name+state
  const acctByKey = new Map();
  S.ACCOUNT_DATA.forEach((item, idx) => {
    const exactKey = (item.name || '').toLowerCase().trim() + '|' + (item.state || '').toUpperCase().trim();
    acctByKey.set(exactKey, { item, idx });
    const normKey = normalizeDistrictName(item.name) + '|' + (item.state || '').toUpperCase().trim();
    if (!acctByKey.has(normKey)) acctByKey.set(normKey, { item, idx });
  });

  const stats = {
    total: csvData.length,
    newRecords: 0,
    updatedRecords: 0,
    notesPreserved: 0,
    consolidatedRecords: 0,
    changes: [],
    conflicts: [],
    resolutions: [],
    orphans: [],
  };

  // Track which accounts have been touched (for full replacement on first CSV row)
  const touchedAccounts = new Set();

  // Deep-clone S.ACCOUNT_DATA for the merge result
  const mergedAccounts = S.ACCOUNT_DATA.map(a => JSON.parse(JSON.stringify(a)));
  // Rebuild lookup on cloned array
  const clonedByKey = new Map();
  mergedAccounts.forEach((item, idx) => {
    const exactKey = (item.name || '').toLowerCase().trim() + '|' + (item.state || '').toUpperCase().trim();
    clonedByKey.set(exactKey, { item, idx });
    const normKey = normalizeDistrictName(item.name) + '|' + (item.state || '').toUpperCase().trim();
    if (!clonedByKey.has(normKey)) clonedByKey.set(normKey, { item, idx });
  });

  // Index by SFDC Account ID for deterministic matching
  const clonedById = new Map();
  mergedAccounts.forEach((item, idx) => {
    if (item.account_id) {
      clonedById.set(item.account_id, { item, idx });
    }
  });

  // Build state-indexed lookup for fuzzy matching fallback
  const clonedByState = new Map();
  mergedAccounts.forEach((item, idx) => {
    const state = (item.state || '').toUpperCase().trim();
    if (state) {
      if (!clonedByState.has(state)) clonedByState.set(state, []);
      clonedByState.get(state).push({ item, idx, normalizedKey: normalizeDistrictName(item.name) });
    }
  });

  csvData.forEach((csvRow, _rowIdx) => {
    // Extract account name from the raw CSV row (before mapFieldName, which maps it to 'name')
    const rawName = (csvRow.account_name || csvRow.name || '').trim();
    if (!rawName) return;

    // Find the state from the CSV row
    const csvState = getStateFromRow(csvRow).toUpperCase().trim();

    // Look up matching account
    const exactKey = rawName.toLowerCase().trim() + '|' + csvState;
    const normKey = normalizeDistrictName(rawName) + '|' + csvState;
    // ── TIER 0: Match by SFDC Account ID ──
    // For school-level opps, prefer parent_account_id (the district) over
    // account_id (the school), since accounts.json stores districts.
    const csvAccountId = (csvRow.account_id || '').trim();
    const csvParentId = (csvRow.parent_account_id || '').trim();
    const lookupId = (csvParentId && csvParentId !== '000000000000000') ? csvParentId : csvAccountId;
    let match = null;
    if (lookupId && lookupId !== '000000000000000') {
      const idMatch = clonedById.get(lookupId);
      if (idMatch) {
        // Verify state consistency
        const idMatchState = (idMatch.item.state || '').toUpperCase().trim();
        if (csvState && idMatchState && csvState !== idMatchState) {
          console.warn('[Opp Merge] TIER 0 STATE MISMATCH — ID', lookupId,
            'matched', idMatch.item.name, '(' + idMatchState + ') but CSV state is', csvState,
            '— removing corrupted ID');
          delete idMatch.item.account_id;
          clonedById.delete(lookupId);
        } else {
          match = idMatch;
          console.log('[Opp Merge] ID match:', lookupId, '→', match.item.name,
            csvParentId && csvParentId !== '000000000000000' ? '(via parent ID)' : '');
        }
      }
    }

    // ── TIER 1-2: Exact + normalized name match ──
    if (!match) {
      match = clonedByKey.get(exactKey) || clonedByKey.get(normKey);
    }

    // ── TIER 3: State + name prefix match (fuzzy fallback) ──
    if (!match && csvState) {
      const stateRecords = clonedByState.get(csvState);
      if (stateRecords) {
        const csvNormalized = normalizeDistrictName(rawName);
        for (const candidate of stateRecords) {
          // Prefix match with word boundary (not substring containment)
          const isPrefix = candidate.normalizedKey.startsWith(csvNormalized) || csvNormalized.startsWith(candidate.normalizedKey);
          if (isPrefix) {
            const shorterStr = csvNormalized.length <= candidate.normalizedKey.length ? csvNormalized : candidate.normalizedKey;
            const longerStr = csvNormalized.length > candidate.normalizedKey.length ? csvNormalized : candidate.normalizedKey;
            // Word boundary check
            if (shorterStr.length < longerStr.length && longerStr[shorterStr.length] !== ' ') {
              continue;
            }
            // Length ratio guard
            if (shorterStr.length < longerStr.length * 0.4) {
              continue;
            }
            match = candidate;
            console.log('[Opp Merge] State+Name match:', rawName, '→', candidate.item.name, '(state:', csvState, ')');
            break;
          }
        }
      }
    }

    // ── ID VALIDATION GATE ──
    // If a name-based tier found a match but both sides have different Account IDs, reject it.
    if (match && lookupId && lookupId !== '000000000000000') {
      const matchId = match.item.account_id || '';
      if (matchId && matchId !== lookupId) {
        console.warn('[Opp Merge] ID VALIDATION REJECTED name match:', rawName,
          '→', match.item.name, '— CSV ID:', lookupId, '≠ existing ID:', matchId,
          '— different entities, treating as orphan');
        match = null;
      }
    }

    if (!match) {
      // ── SYNTHETIC ACCOUNT CREATION FOR ORPHANED OPPS ──
      // Instead of dropping the opp, create a minimal account record from the CSV data.
      // This handles school-level records, IU/AEA/ESC service centers, and small districts
      // that have opps but aren't in any account upload file.
      const syntheticKey = rawName.toLowerCase().trim() + '|' + csvState;
      const normSynKey = normalizeDistrictName(rawName) + '|' + csvState;

      // Check if we already created a synthetic for this name (multiple opps per account)
      let synthEntry = clonedByKey.get(syntheticKey) || clonedByKey.get(normSynKey);
      if (!synthEntry) {
        const synthetic = {
          name: rawName,
          state: csvState,
          ae: (csvRow.account_owner || csvRow.opportunity_owner || '').trim(),
          opp_owner: (csvRow.opportunity_owner || '').trim(),
          enrollment: csvRow.students_in_district || csvRow.enrollment || '',
          address: csvRow.billing_address_line_1 || csvRow.address || '',
          city: csvRow.billing_city || csvRow.city || '',
          zip: csvRow.billing_zip_postal_code || csvRow.zip || '',
          account_id: lookupId || '',
          parent_account_id: csvRow.parent_account_id || '',
          opps: [],
          _synthetic_from_opp: true,
          _nameLc: rawName.toLowerCase().trim(),
          _stateLc: (csvState || '').toLowerCase().trim(),
          _regionLc: '',
        };

        const newIdx = mergedAccounts.length;
        mergedAccounts.push(synthetic);
        synthEntry = { item: synthetic, idx: newIdx };
        clonedByKey.set(syntheticKey, synthEntry);
        clonedByKey.set(normSynKey, synthEntry);
        if (lookupId) clonedById.set(lookupId, synthEntry);

        if (!stats.orphans.includes(rawName)) {
          stats.orphans.push(rawName);
        }
        stats.newRecords++;
        console.log('[Opp Merge] Created synthetic account for orphaned opp:', rawName, csvState);
      }

      // Fall through to merge the opp data into the synthetic account
      match = synthEntry;
    }

    const acct = match.item;
    const acctKey = acct.name + '|' + (acct.state || '');

    // Map CSV fields through mapFieldName
    const oppFields = {};
    const wrapperFields = {};
    let csvAE = '';
    let oppOwner = '';

    Object.keys(csvRow).forEach(key => {
      const val = csvRow[key];
      if (typeof val !== 'string' || !val.trim()) return;
      const trimmed = val.trim();
      const mappedKey = mapFieldName(key);

      if (mappedKey === 'ae') {
        csvAE = trimmed;
      } else if (mappedKey === 'opp_owner') {
        oppOwner = trimmed;
      } else if (mappedKey === 'enrollment') {
        // CSV enrollment used for resolveOwner context only, NOT written to account
      } else if (OPP_ENTRY_FIELDS.has(mappedKey)) {
        oppFields[mappedKey] = trimmed;
      } else if (OPP_WRAPPER_FIELDS.has(mappedKey)) {
        wrapperFields[mappedKey] = trimmed;
      } else if (mappedKey === 'name') {
        // Skip — don't overwrite account name
      } else if (['state', 'address', 'city', 'zip'].includes(mappedKey)) {
        // Fill in MISSING values only, don't overwrite
        if (!acct[mappedKey] && trimmed) acct[mappedKey] = trimmed;
      }
    });

    // Persist SFDC Account ID on the account record (use district ID, not school)
    const persistId = (csvParentId && csvParentId !== '000000000000000') ? csvParentId : csvAccountId;
    if (persistId && persistId !== '000000000000000') {
      if (!acct.account_id) {
        // Only persist if states match
        const acctSt = (acct.state || '').toUpperCase().trim();
        if (!acctSt || !csvState || acctSt === csvState) {
          acct.account_id = persistId;
        } else {
          console.warn('[Opp Merge] Blocked account_id write (state mismatch):',
            acct.name, acctSt, '≠ CSV', csvState, 'ID:', persistId);
        }
      } else if (acct.account_id !== persistId) {
        console.warn('[Opp Merge] ID CONFLICT:', acct.name,
          '- existing ID:', acct.account_id, '≠ CSV ID:', persistId);
      }
    }

    // Store Opportunity ID on the opp entry
    const csvOppId = (csvRow.opportunity_id || '').trim();
    if (csvOppId) {
      oppFields.opportunity_id = csvOppId;
    }

    // FULL REPLACEMENT: On the first CSV row for this account, clear its opps array
    const isFirstTouch = !touchedAccounts.has(acctKey);
    let priorOpps = [];
    if (isFirstTouch) {
      touchedAccounts.add(acctKey);
      // Capture existing opps before clearing (used for conflict context)
      priorOpps = (acct.opps || []).map(o => ({ area: o.area || '', stage: o.stage || '', acv: o.acv || '' }));
      acct.opps = [];

      // Carry over school-level opps that were pre-rolled during consolidateParentAccounts().
      // These live on the CSV row object (csvRow.opps) and have school_name set.
      // Without this, they'd be lost because runOppMerge only reads flat CSV fields.
      if (csvRow.opps && csvRow.opps.length > 0) {
        csvRow.opps.forEach(preRolledOpp => {
          if (preRolledOpp.school_name) {
            acct.opps.push(preRolledOpp);
          }
        });
        if (acct.opps.length > 0) {
          console.log('[Opp Merge] Carried over', acct.opps.length, 'school-level opp(s) from consolidation for:', acct.name);
        }
      }

      // Apply wrapper fields on first row
      if (oppOwner) acct.opp_owner = oppOwner;
      if (wrapperFields.opportunity_name) acct.opportunity_name = wrapperFields.opportunity_name;
      if (wrapperFields.intro_meeting_date) acct.intro_meeting_date = wrapperFields.intro_meeting_date;
      if (wrapperFields.created_date) acct.created_date = wrapperFields.created_date;
      if (wrapperFields.last_modified) acct.last_modified = wrapperFields.last_modified;
      if (wrapperFields.age) acct.age = wrapperFields.age;
      // MEDDPICC fields
      if (wrapperFields.metric_improvement_goal) acct.metric_improvement_goal = wrapperFields.metric_improvement_goal;
      if (wrapperFields.decision_criteria) acct.decision_criteria = wrapperFields.decision_criteria;
      if (wrapperFields.decision_process) acct.decision_process = wrapperFields.decision_process;
      if (wrapperFields.paper_process) acct.paper_process = wrapperFields.paper_process;
      if (wrapperFields.implication_of_pain) acct.implication_of_pain = wrapperFields.implication_of_pain;
      acct._hasUploadedOpp = true;
    } else {
      // Subsequent rows: update MEDDPICC if provided (may come from different opp rows)
      if (wrapperFields.metric_improvement_goal) acct.metric_improvement_goal = wrapperFields.metric_improvement_goal;
      if (wrapperFields.decision_criteria) acct.decision_criteria = wrapperFields.decision_criteria;
      if (wrapperFields.decision_process) acct.decision_process = wrapperFields.decision_process;
      if (wrapperFields.paper_process) acct.paper_process = wrapperFields.paper_process;
      if (wrapperFields.implication_of_pain) acct.implication_of_pain = wrapperFields.implication_of_pain;
    }

    // Upsert opp entry
    if (Object.keys(oppFields).length > 0) {
      // Tag school-level opps: if csvParentId is set, this opp came from a school row
      // matched to its parent district — rawName is the school's account name
      if (csvParentId && csvParentId !== '000000000000000') {
        oppFields.school_name = rawName;
        const oppEntry = buildOppEntry(oppFields);
        upsertOpp(acct, oppEntry);
      } else if (csvRow.opps && csvRow.opps.some(o => o.school_name)) {
        // This is a synthetic/parent row whose flat CSV fields came from a child row
        // during consolidation. The school-level opps were already carried over above.
        // Skip the flat-field upsert to avoid creating a ghost district-level opp
        // from the child's inherited fields.
        console.log('[Opp Merge] Skipping flat-field upsert for synthetic parent row:', acct.name);
      } else {
        const oppEntry = buildOppEntry(oppFields);
        upsertOpp(acct, oppEntry);
      }
    }

    // Parse numeric fields within opps
    (acct.opps || []).forEach(o => {
      if (o.acv !== undefined && o.acv !== '') {
        const cleaned = String(o.acv).replace(/[$,]/g, '');
        const val = parseFloat(cleaned);
        if (!isNaN(val)) o.acv = val;
      }
      if (o.probability !== undefined && o.probability !== '') {
        const cleaned = String(o.probability).replace(/[$,]/g, '');
        const val = parseFloat(cleaned);
        if (!isNaN(val)) o.probability = val;
      }
    });

    // Owner resolution (only on first row per account — subsequent rows skip)
    if (isFirstTouch) {
      if (!isDOE(acct.name)) {
        const priorRecord = S.ACCOUNT_DATA[match.idx];
        const priorAE = (priorRecord ? priorRecord.ae || '' : '').trim();
        const ownerResult = resolveOwner(csvAE, priorAE, {
          enrollment: acct.enrollment, // Use account's existing enrollment
          hasUploadedOpp: true,
          oppOwner: oppOwner,
          loadedReps,
          accountName: acct.name || '',
          source: 'opps',
        });
        acct.ae = ownerResult.ae;
        // Tag source team
        if (csvAE) {
          acct._source_team = getTeamForRep(csvAE) || getTeamForRep(priorAE) || acct._source_team || null;
        }
        // territory_ae handling
        if (ownerResult.reason === 'no_data_loaded' && csvAE) {
          acct.territory_ae = csvAE;
        } else {
          delete acct.territory_ae;
        }

        // Track resolution
        if (csvAE) {
          stats.resolutions.push({
            name: acct.name,
            csvOwner: csvAE,
            resolvedAE: ownerResult.ae || '(unassigned)',
            reason: ownerResult.reason,
            oppOwner: oppOwner,
            isNew: false,
          });
          if (ownerResult.reason !== 'direct_assign') {
            console.log('[Opp Merge] Owner resolved:', acct.name,
              '- CSV owner', csvAE, '→', ownerResult.ae || '(unassigned)',
              '(reason:', ownerResult.reason + ')');
          }
        }

        // Conflict detection
        if (csvAE && priorAE && csvAE !== priorAE
            && ALL_ACTIVE_REPS.has(csvAE) && ALL_ACTIVE_REPS.has(priorAE)
            && !MANAGER_REPS.get(priorAE)?.has(csvAE)) {
          console.log('[Opp Merge] CONFLICT:', acct.name, '- was', priorAE, ', CSV says', csvAE);
          stats.conflicts.push({
            name: acct.name,
            enrollment: parseInt(acct.enrollment) || 0,
            state: acct.state || '',
            account_id: acct.account_id || lookupId || '',
            oldAE: priorAE,
            newAE: csvAE,
            source: 'opps',
            // Context about the conflict
            isCustomer: !!acct.is_customer,
            isInactiveCustomer: acct.type === 'Inactive Customer',
            arr: acct.arr || null,
            // What the OLD rep (priorAE / existing owner) has
            oldSource: 'existing',
            oldTeam: getTeamForRep(priorAE) || null,
            // What the NEW rep (csvAE / from upload) brings
            newSource: 'csv',
            newTeam: getTeamForRep(csvAE) || null,
            // Opp context from CSV row
            hasOpp: Object.keys(oppFields).length > 0,
            oppStage: oppFields.opp_stage || acct.opp_stage || '',
            oppAcv: oppFields.opp_acv || '',
            oppAreas: oppFields.opp_areas || acct.opp_areas || '',
            oppOwner: (oppOwner || '').trim(),
            // Existing record opps (captured before clearing)
            existingOpps: priorOpps,
            // Resolution reason
            ownerResolution: ownerResult.reason,
          });
        }
      } else {
        // DOE account — strip ownership
        delete acct.ae;
        delete acct.csm;
      }

      // Track the change
      stats.updatedRecords++;
      stats.changes.push({ name: acct.name, action: 'updated' });
    }
  });

  // ── STALE OPP CLEANUP: CLEAR UNTOUCHED ACCOUNTS ──────────────────────
  // The CSV represents the COMPLETE set of active opps. Accounts NOT in the
  // CSV no longer have active opportunities — clear their opp data so closed
  // opps don't linger as phantom active pipeline.
  let resetCount = 0;
  mergedAccounts.forEach(acct => {
    const acctKey = acct.name + '|' + (acct.state || '');
    if (touchedAccounts.has(acctKey)) return;            // Was in the CSV — already handled
    if (!acct.opps || acct.opps.length === 0) {
      if (!acct._hasUploadedOpp) return;                 // No opps and never had uploaded opps — skip
    }

    console.log('[Opp Merge] Clearing stale opps:', acct.name,
      '(had', (acct.opps || []).length, 'opp(s), stage:', acct.opp_stage || 'none', ')');

    // Clear opps array
    acct.opps = [];
    acct._hasUploadedOpp = false;

    // Clear wrapper fields
    acct.opp_owner = '';
    acct.opportunity_name = '';
    acct.intro_meeting_date = '';
    acct.created_date = '';
    acct.last_modified = '';
    acct.age = '';

    // Clear MEDDPICC fields
    acct.metric_improvement_goal = '';
    acct.decision_criteria = '';
    acct.decision_process = '';
    acct.paper_process = '';
    acct.implication_of_pain = '';

    // Re-derive summary fields (zeros out opp_stage, opp_acv, opp_count, etc.)
    deriveOppSummary(acct);
    resetCount++;
  });

  if (resetCount > 0) {
    console.log(`[Opp Merge] Cleared stale opps from ${resetCount} account(s) not in CSV`);
    stats.resetToBaselineCount = resetCount;
  }

  // Add orphan count to stats
  if (stats.orphans.length > 0) {
    console.log(`[Opp Merge] ${stats.orphans.length} orphaned opp(s) — no matching account`);
  }

  return { mergedAccounts, stats };
}

export function previewMerge(csvData) {
  // Track CSV parse skipped rows for display in merge modal
  const _csvSkippedCount = csvData._skippedCount || 0;

  // Opp-only merge path — skip type detection and auto-detection entirely
  if (S.sfdcDataType === 'opps') {
    S.mergeHasTypeSplit = false;
    S.pendingAccountMerge = null;
    S.pendingCustomerMerge = null;
    const consolidation = consolidateParentAccounts(csvData);
    const result = runOppMerge(consolidation.rows);
    S.pendingMergeData = result.mergedAccounts;
    S.pendingMergeStats = result.stats;
    S.pendingMergeStats.consolidatedRecords = consolidation.consolidatedCount;
    result.stats.csvSkippedRows = _csvSkippedCount;
    showMergeModal(result.stats);
    return;
  }

  // Check if CSV has a 'type' column for per-row customer/account splitting.
  // Type values: "Customer" → customer dataset, "Inactive Customer"/blank/"Prospect" → account dataset.
  const hasTypeColumn = csvData.length > 0 && Object.hasOwn(csvData[0], 'type');

  if (hasTypeColumn) {
    // Split rows by type
    const customerRows = [];
    const accountRows = [];
    csvData.forEach(row => {
      const rowType = (row.type || '').trim().toLowerCase();
      if (rowType === 'customer') {
        customerRows.push(row);
      } else {
        // Prospect, blank, or Inactive Customer → account dataset
        // The type field is preserved on each record for display purposes
        accountRows.push(row);
      }
    });

    console.log('[SFDC Merge] Type column detected — splitting:', customerRows.length, 'customer rows,', accountRows.length, 'account rows');

    S.mergeHasTypeSplit = true;
    const consolidation = consolidateParentAccounts(accountRows);
    const accountResult = runMerge(consolidation.rows, S.ACCOUNT_DATA, 'accounts');
    const customerResult = runMerge(customerRows, S.CUSTOMER_DATA, 'customers');

    S.pendingAccountMerge = accountResult.mergedData;
    S.pendingCustomerMerge = customerResult.mergedData;
    S.pendingMergeData = null; // Clear single-mode state

    // ── CUSTOMER → ACCOUNT PROMOTION ──
    // Promote customer records that have no matching account record into the account
    // dataset. This ensures existing customers with active expansion opps are visible
    // in the Accounts view, Pipeline Summary, and territory map.
    const _acctNormSet = new Set();
    S.pendingAccountMerge.forEach(a => {
      _acctNormSet.add(normalizeDistrictName(a.name));
    });
    let _promotedCount = 0;
    S.pendingCustomerMerge.forEach(c => {
      const norm = normalizeDistrictName(c.name);
      if (!_acctNormSet.has(norm)) {
        const promoted = { ...c, is_customer: true, _promoted_from_customer: true };
        S.pendingAccountMerge.push(promoted);
        _acctNormSet.add(norm);
        _promotedCount++;
      }
    });
    if (_promotedCount > 0) {
      console.log(`[SFDC Merge] Promoted ${_promotedCount} customer-only record(s) into account dataset`);
    }

    // Combined stats for the modal
    const combinedStats = {
      total: csvData.length,
      newRecords: accountResult.stats.newRecords + customerResult.stats.newRecords,
      updatedRecords: accountResult.stats.updatedRecords + customerResult.stats.updatedRecords,
      notesPreserved: accountResult.stats.notesPreserved + customerResult.stats.notesPreserved,
      consolidatedRecords: consolidation.consolidatedCount + (accountResult.stats.duplicateRows || 0) + (customerResult.stats.duplicateRows || 0),
      promotedRecords: _promotedCount,
      changes: [...accountResult.stats.changes, ...customerResult.stats.changes],
      conflicts: [...(accountResult.stats.conflicts || []), ...(customerResult.stats.conflicts || [])],
      resolutions: [...(accountResult.stats.resolutions || []), ...(customerResult.stats.resolutions || [])],
    };

    combinedStats.csvSkippedRows = _csvSkippedCount;
    S.pendingMergeStats = combinedStats;
    showMergeModal(combinedStats);
    return;
  }

  // No type column — use auto-detection (existing behavior)
  S.mergeHasTypeSplit = false;
  S.pendingAccountMerge = null;
  S.pendingCustomerMerge = null;

  // Auto-detect data type from CSV columns (only if user hasn't explicitly selected).
  // Customer data has distinctive fields (arr, csm, segment, gdr, ndr)
  // that account data never has. If we find them, override the toggle.
  if (!S._userSelectedType && csvData.length > 0) {
    const cols = new Set(Object.keys(csvData[0]).map(k => k.toLowerCase().replace(/\s+/g, '_')));
    const customerSignals = ['arr', 'active_arr', 'annual_recurring_revenue', 'revenue',
                             'csm', 'csm_name', 'customer_success_manager',
                             'segment', 'gdr', 'ndr', 'lapsed_renewal', 'arr_12mo_ago'];
    const accountSignals = ['superintendent', 'super', 'sis', 'sis_platform', 'sis_system',
                              'student_information_system_sis',
                              'ada_adm', 'math_products', 'math_curriculum', 'core_math_curriculum',
                              'math_supplemental', 'attendance', 'attendance_comms', 'attendance_comms_tools',
                              'parent_account', 'website', 'strategic_plan',
                              'enrollment', 'enrollment_count', 'student_count', 'total_enrollment', 'students_in_d', 'students_in_district',
                              'opp_stage', 'stage', 'opportunity_stage',
                              'opp_acv', 'acv', 'year_1_acv', 'amount',
                              'opp_forecast', 'forecast', 'forecast_category',
                              'opp_probability', 'probability',
                              'opp_areas', 'areas', 'product_areas', 'areas_of_interest',
                              'opp_next_step', 'next_step', 'next_steps',
                              'opp_contact', 'primary_contact', 'contact_name',
                              'opp_sdr', 'sdr_name',
                              'opp_champion', 'champion',
                              'opp_economic_buyer', 'economic_buyer',
                              'opp_competition', 'competition', 'competitors'];
    const oppSignals = ['opportunity_name', 'close_date', 'next_steps_digest',
                        'next_steps_update_date', 'age_in_days', 'push_count',
                        'loss_reason', 'loss_competitor_incumbent',
                        'intro_meeting_date', 'intro_meeting_status',
                        'paper_process', 'implication_of_pain',
                        'decision_criteria', 'decision_process',
                        'metric_kpi_to_improve', 'metric_-_improvement_goal',
                        'metric_improvement_goal',
                        'are_you_single_threaded', 'counterpart_meeting'];
    const oppHits = oppSignals.filter(s => cols.has(s)).length;
    const custHits = customerSignals.filter(s => cols.has(s)).length;
    const accountHits = accountSignals.filter(s => cols.has(s)).length;
    if (oppHits >= 2) {
      console.log('[SFDC Merge] Auto-detected OPPORTUNITY data (matched columns:', oppSignals.filter(s => cols.has(s)).join(', '), ')');
      S.sfdcDataType = 'opps';
      setSfdcType('opps');
    } else if (custHits > accountHits && custHits >= 2) {
      console.log('[SFDC Merge] Auto-detected CUSTOMER data (matched columns:', customerSignals.filter(s => cols.has(s)).join(', '), ')');
      S.sfdcDataType = 'customers';
      setSfdcType('customers');
    } else if (accountHits > custHits && accountHits >= 2) {
      console.log('[SFDC Merge] Auto-detected ACCOUNT data (matched columns:', accountSignals.filter(s => cols.has(s)).join(', '), ')');
      S.sfdcDataType = 'accounts';
      setSfdcType('accounts');
    } else {
      console.log('[SFDC Merge] Could not auto-detect type (opp signals:', oppHits, ', cust signals:', custHits, ', acct signals:', accountHits, '). Using selected type:', S.sfdcDataType);
    }
  }

  // If auto-detection resolved to opps, redirect to the opp merge path
  if (S.sfdcDataType === 'opps') {
    const consolidation = consolidateParentAccounts(csvData);
    const result = runOppMerge(consolidation.rows);
    S.pendingMergeData = result.mergedAccounts;
    S.pendingMergeStats = result.stats;
    S.pendingMergeStats.consolidatedRecords = consolidation.consolidatedCount;
    result.stats.csvSkippedRows = _csvSkippedCount;
    showMergeModal(result.stats);
    return;
  }

  let consolidatedCount = 0;
  let dataToMerge;
  if (S.sfdcDataType === 'accounts') {
    const consolidation = consolidateParentAccounts(csvData);
    dataToMerge = consolidation.rows;
    consolidatedCount = consolidation.consolidatedCount;
  } else {
    dataToMerge = csvData;
  }
  const result = runMerge(dataToMerge, S.sfdcDataType === 'accounts' ? S.ACCOUNT_DATA : S.CUSTOMER_DATA, S.sfdcDataType);
  result.stats.consolidatedRecords = consolidatedCount + (result.stats.duplicateRows || 0);
  S.pendingMergeData = result.mergedData;
  S.pendingMergeStats = result.stats;
  result.stats.csvSkippedRows = _csvSkippedCount;
  showMergeModal(result.stats);
}

export function mapFieldName(csvField) {
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
    'opportunity_owner': 'opp_owner',
    'csm_name': 'csm',
    'customer_success_manager': 'csm',
    'sdr_name': 'opp_sdr',
    'sales_develop': 'opp_sdr',
    'sales_development_representative_sdr': 'opp_sdr',
    'sales_development_representative': 'opp_sdr',
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
    'student_information_system_sis': 'sis',
    // New account fields
    'core_math_curriculum': 'math_curriculum',
    'math_supplemental': 'math_supplemental',
    'attendance_comms_tools': 'attendance_comms',
    'strategic_plan': 'strategic_plan_url',
    // Legacy field name aliases
    'math_products': 'math_curriculum',
    'attendance': 'attendance_comms',
    // Opportunity fields
    'opportunity_stage': 'opp_stage',
    'stage': 'opp_stage',
    'forecast_category': 'opp_forecast',
    'forecast': 'opp_forecast',
    'active_forecast': 'opp_forecast',
    'active_forecast_category': 'opp_forecast',
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
    'last_activity': 'opp_last_activity',
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
    // Zip / postal code (header "Billing Zip/Postal Code" normalizes to "billing_zip_postal_code")
    'billing_zip_postal_code': 'zip',
    'billing_zip': 'zip',
    'billing_zipcode': 'zip',
    'billing_postal_code': 'zip',
    'shipping_zip_postal_code': 'zip',
    'shipping_zip': 'zip',
    'zip_code': 'zip',
    'zipcode': 'zip',
    'postal_code': 'zip',
    // Customer fields
    'last_modified_date': 'last_modified',
    // Leadership
    'superintendent': 'superintendent',
    'super': 'superintendent',
    // Opp-specific CSV fields
    'opportunity_name': 'opportunity_name',
    'intro_meeting_date': 'intro_meeting_date',
    'age': 'age',
    'created_date': 'created_date',
    'metric_-_improvement_goal': 'metric_improvement_goal',
    'metric_improvement_goal': 'metric_improvement_goal',
    'decision_criteria': 'decision_criteria',
    'decision_process': 'decision_process',
    'paper_process': 'paper_process',
    'implication_of_pain': 'implication_of_pain',
    // SFDC IDs
    'account_id': 'account_id',
    'parent_account_id': 'parent_account_id',
    'opportunity_id': 'opportunity_id',
    'opp_id': 'opportunity_id',
  };

  const normalized = csvField.toLowerCase().replace(/[/()&:]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return mappings[normalized] || normalized;
}

