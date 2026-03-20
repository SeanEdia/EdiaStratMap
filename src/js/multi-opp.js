import S from './state.js';
import { districtKey, normalizeDistrictName, parseUSDate, normalizeOppArea, precomputeSearchFields } from './helpers.js';
import { saveOppsToLocalStorage, OPP_ENTRY_FIELDS, buildOppEntry, migrateToOppsArray,
  crossLinkCustomers, joinOppsToAccounts, buildIndices, TEAM_REP_DATA,
  getTerritoryAE, getHoldoutAE, hideWelcomeOverlay, updateDataSourceIndicator,
  renderTeamRepSelectors, renderFilters } from './app.js';
import { showGeocodeProgress, updateGeocodeProgress, hideGeocodeProgress } from './conference.js';
import { storeNewConflicts, renderConflictsOverlay, updateConflictsBadge } from './conflict.js';

// ============ MULTI-OPP HELPERS ============
// OPP_ENTRY_FIELDS, normalizeOppArea, buildOppEntry, and migrateToOppsArray
// are defined near the top of the file (before DATA INITIALIZATION) so they
// are available during the localStorage migration at startup.

// Upsert an opp entry into an account's opps array, keyed by product area
export function upsertOpp(record, oppEntry) {
  if (!record.opps) record.opps = [];
  if (!oppEntry.area && !oppEntry.stage) return; // nothing to add
  const areaKey = (oppEntry.area || 'Unknown').toLowerCase();
  const existingIdx = record.opps.findIndex(o => (o.area || '').toLowerCase() === areaKey);
  if (existingIdx >= 0) {
    record.opps[existingIdx] = oppEntry;
  } else {
    record.opps.push(oppEntry);
  }
  deriveOppSummary(record);
}

// Derive flat summary fields from the opps array for backwards compatibility
// (marker coloring, stage filter, sort by ACV, etc.)
export function deriveOppSummary(record) {
  const opps = record.opps || [];
  if (opps.length === 0) {
    record.opp_count = 0;
    record.opp_stage = '';
    record.opp_acv = 0;
    record.opp_areas = '';
    record.has_school_opps = false;
    return;
  }

  // Separate district-level and school-level opps
  const districtOpps = opps.filter(o => !o.school_name);
  const schoolOpps = opps.filter(o => o.school_name);

  // Totals include ALL opps (district + school) — these are real pipeline numbers
  record.opp_count = opps.length;
  record.opp_areas = opps.map(o => o.area).filter(Boolean).join(', ');
  record.opp_acv = opps.reduce((sum, o) => sum + (Number(o.acv) || 0), 0);
  record.has_school_opps = schoolOpps.length > 0;

  // Pin color and summary fields driven by DISTRICT-LEVEL opps only
  if (districtOpps.length > 0) {
    let maxStageNum = 0;
    let primaryOpp = districtOpps[0];
    districtOpps.forEach(o => {
      const num = parseInt(o.stage) || 0;
      if (num > maxStageNum) {
        maxStageNum = num;
        primaryOpp = o;
      }
    });
    record.opp_stage = primaryOpp.stage || '';
    record.opp_forecast = primaryOpp.forecast || '';
    record.opp_probability = primaryOpp.probability || '';
    record.opp_next_step = primaryOpp.next_step || '';
    record.opp_contact = primaryOpp.contact || '';
    record.opp_contact_title = primaryOpp.contact_title || '';
    record.opp_sdr = primaryOpp.sdr || '';
    record.opp_champion = primaryOpp.champion || '';
    record.opp_economic_buyer = primaryOpp.economic_buyer || '';
    record.opp_competition = primaryOpp.competition || '';
  } else {
    // Only school-level opps exist — don't drive pin color from these
    record.opp_stage = '';
    record.opp_forecast = '';
    record.opp_probability = '';
    record.opp_next_step = '';
    record.opp_contact = '';
    record.opp_contact_title = '';
    record.opp_sdr = '';
    record.opp_champion = '';
    record.opp_economic_buyer = '';
    record.opp_competition = '';
  }

  // Most recent last_activity across ALL opps (district + school)
  // This intentionally includes school-level opps — any activity is relevant for staleness
  let mostRecent = '';
  opps.forEach(o => {
    if (o.last_activity) {
      const parsedCurrent = parseUSDate(o.last_activity);
      const parsedMost = parseUSDate(mostRecent);
      if (parsedCurrent && (!parsedMost || parsedCurrent > parsedMost)) {
        mostRecent = o.last_activity;
      }
    }
  });
  record.opp_last_activity = mostRecent;
}

// normalizeDistrictName imported from helpers.js

export function parseNumericFields(record) {
  // Convert numeric fields from strings to numbers
  // Strip commas/currency symbols first (CSV exports often format "30,210" or "$1,500")
  const numericFields = ['lat', 'lng', 'enrollment', 'students', 'opp_acv', 'opp_probability', 'arr', 'gdr', 'ndr', 'opp_count'];
  numericFields.forEach(field => {
    if (record[field] !== undefined && record[field] !== '') {
      const cleaned = String(record[field]).replace(/[$,]/g, '');
      const val = parseFloat(cleaned);
      if (!isNaN(val)) record[field] = val;
    }
  });
}

export function findPartialMatch(name, existingByName) {
  // Check if there's a similar name in existing data
  // existingByName values are arrays of { item, idx } entries
  const nameLower = name.toLowerCase().trim();
  const nameWords = nameLower.split(/\s+/);

  for (const [existingKey, entries] of existingByName) {
    const first = entries[0]; // Use first entry for name comparison
    // Check if first word matches (e.g., "Dallas" matches "Dallas ISD")
    const existingWords = existingKey.split(/\s+/);
    if (nameWords[0] === existingWords[0] && nameWords[0].length > 3) {
      return first.item.name;
    }
    // Check for substring match
    if (existingKey.includes(nameLower) || nameLower.includes(existingKey)) {
      return first.item.name;
    }
  }
  return null;
}

export function showMergeModal(stats) {
  // Reset confirm button state — it may still be disabled with stale text
  // from a previous successful merge (the success path never re-enables it
  // because closeMergeModal just hides the modal).
  const confirmBtn = document.querySelector('#mergeModal .merge-btn-confirm');
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Apply Changes';
  }

  const mergeTitle = S.mergeHasTypeSplit
    ? 'Merge Preview: Accounts + Customers (split by Type)'
    : `Merge Preview: ${S.sfdcDataType === 'accounts' ? 'Accounts' : S.sfdcDataType === 'opps' ? 'Opportunities' : 'Customers'}`;
  document.getElementById('mergeModalTitle').textContent = mergeTitle;
  document.getElementById('mergeTotalRecords').textContent = stats.total;
  document.getElementById('mergeNewRecords').textContent = stats.newRecords;
  document.getElementById('mergeUpdatedRecords').textContent = stats.updatedRecords;
  document.getElementById('mergeNotesPreserved').textContent = stats.notesPreserved;

  // Show consolidated/deduplicated count when records were absorbed
  const consolidatedEl = document.getElementById('mergeConsolidatedRecords');
  const consolidatedRow = document.getElementById('mergeConsolidatedRow');
  if (consolidatedEl && consolidatedRow) {
    const consolidated = stats.consolidatedRecords || 0;
    if (consolidated > 0) {
      consolidatedEl.textContent = consolidated;
      consolidatedRow.style.display = '';
    } else {
      consolidatedRow.style.display = 'none';
    }
  }

  // Count records needing geocoding
  const allPendingRecords = S.mergeHasTypeSplit
    ? [...(S.pendingAccountMerge || []), ...(S.pendingCustomerMerge || [])]
    : (S.pendingMergeData || []);
  const needsGeocode = allPendingRecords.filter(r => !r.lat || !r.lng).length;

  // Show change list
  const changesList = document.getElementById('mergeChangesList');
  const conflictCount = stats.conflicts ? stats.conflicts.length : 0;
  const orphanCount = stats.orphans ? stats.orphans.length : 0;
  if (stats.changes.length > 0 || needsGeocode > 0 || conflictCount > 0 || orphanCount > 0) {
    const maxShow = 30;
    let html = '';

    // Show conflict notice if needed
    if (conflictCount > 0) {
      html += `<div style="background:#d6336c22;border:1px solid #d6336c44;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:11px;">
        <strong style="color:#d6336c;">&#9888; ${conflictCount} ownership conflict${conflictCount > 1 ? 's' : ''} detected</strong>
        <div style="color:var(--text-dim);margin-top:4px;">Accounts assigned to multiple reps. Resolve via the Conflicts dropdown after merge.</div>
        ${stats.conflicts.slice(0, 5).map(c => `<div style="margin-top:4px;font-size:10px;color:var(--text-dim);">&bull; ${c.name}: ${c.oldAE} &rarr; ${c.newAE} <span style="opacity:0.6;">(${c.source === 'customers' ? 'Customer' : 'Account'})</span></div>`).join('')}
        ${conflictCount > 5 ? `<div style="margin-top:4px;font-size:10px;color:var(--text-muted);font-style:italic;">...and ${conflictCount - 5} more</div>` : ''}
      </div>`;
    }

    // Show orphaned opps notice (opp merge only)
    if (orphanCount > 0) {
      html += `<div style="background:#E8853D22;border:1px solid #E8853D44;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:11px;">
        <strong style="color:#E8853D;">${orphanCount} orphaned opp${orphanCount > 1 ? 's' : ''} (no matching account)</strong>
        <div style="color:var(--text-dim);margin-top:4px;">These opps will be skipped — add the account first via an Account upload.</div>
        ${stats.orphans.slice(0, 5).map(n => `<div style="margin-top:4px;font-size:10px;color:var(--text-dim);">&bull; ${n}</div>`).join('')}
        ${orphanCount > 5 ? `<div style="margin-top:4px;font-size:10px;color:var(--text-muted);font-style:italic;">...and ${orphanCount - 5} more</div>` : ''}
      </div>`;
    }

    // Show skipped CSV rows warning
    const csvSkipped = stats.csvSkippedRows || 0;
    if (csvSkipped > 0) {
      html += `<div style="background:#E8853D22;border:1px solid #E8853D44;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:11px;">
        <strong style="color:#E8853D;">⚠ ${csvSkipped} row${csvSkipped > 1 ? 's' : ''} skipped due to parse errors</strong>
        <div style="color:var(--text-dim);margin-top:4px;">These rows had fewer columns than the header and could not be parsed. Check the CSV file for formatting issues.</div>
      </div>`;
    }

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

export function closeMergeModal() {
  document.getElementById('mergeModal').classList.remove('show');
  S.pendingMergeData = null;
  S.pendingMergeStats = null;
  S.pendingAccountMerge = null;
  S.pendingCustomerMerge = null;
  S.mergeHasTypeSplit = false;
}

// State abbreviation to full name mapping (for validating geocode results)
const STATE_FULL_NAMES = {
  'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California',
  'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware', 'FL': 'Florida', 'GA': 'Georgia',
  'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa',
  'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
  'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi', 'MO': 'Missouri',
  'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey',
  'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio',
  'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina',
  'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont',
  'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming',
  'DC': 'District of Columbia'
};

// Check if a Nominatim result is in the expected state
export function isResultInState(result, expectedState) {
  if (!result || !expectedState) return true; // Can't validate, accept the result
  const displayName = (result.display_name || '').toLowerCase();
  const stateAbbr = expectedState.toUpperCase().trim();
  const stateFull = (STATE_FULL_NAMES[stateAbbr] || '').toLowerCase();
  // Check display_name contains either the abbreviation or full state name
  if (stateFull && displayName.includes(stateFull)) return true;
  // Also check addressdetails if available
  if (result.address) {
    const resultState = (result.address.state || '').toLowerCase();
    if (stateFull && resultState.includes(stateFull)) return true;
    if (resultState.includes(stateAbbr.toLowerCase())) return true;
  }
  return false;
}

// Cross-reference a record against all known datasets to inherit location data.
// Called before geocoding to avoid unnecessary API calls.
/** Build a Map of normalized names → location source records for O(1) inheritance lookups. */
export function buildLocationIndex() {
  const index = new Map(); // normalizedName -> [{source, state}]
  [S.ACCOUNT_DATA, S.CUSTOMER_DATA].forEach(dataset => {
    dataset.forEach(source => {
      if (!source.lat || !source.lng || !source.name) return;
      const norm = normalizeDistrictName(source.name);
      if (!index.has(norm)) index.set(norm, []);
      index.get(norm).push(source);
      // Also index by exact lowercase name for exact matching
      const lower = source.name.toLowerCase().trim();
      if (lower !== norm) {
        if (!index.has(lower)) index.set(lower, []);
        index.get(lower).push(source);
      }
    });
  });
  return index;
}

export function inheritLocationData(record, locationIndex) {
  if (record.lat && record.lng) return true; // Already has coordinates
  if (!record.name) return false;

  const nameLower = record.name.toLowerCase().trim();
  const normalizedName = normalizeDistrictName(record.name);

  // If a pre-built location index is available, use O(1) lookups
  if (locationIndex) {
    const candidates = locationIndex.get(normalizedName) || locationIndex.get(nameLower) || [];
    for (const source of candidates) {
      if (source === record) continue;
      const recState = (record.state || '').toUpperCase().trim();
      const srcState = (source.state || '').toUpperCase().trim();
      if (recState && srcState && recState !== srcState) continue;

      console.log('[LocationInherit] Inherited coords for:', record.name, '→', source.lat, source.lng, 'from', source.name);
      record.lat = source.lat;
      record.lng = source.lng;
      if (!record.state && source.state) record.state = source.state;
      if (!record.city && source.city) record.city = source.city;
      if (!record.address && source.address) record.address = source.address;
      if (!record.region && source.region) record.region = source.region;
      return true;
    }
    return false;
  }

  // Fallback: linear scan (for single-record calls)
  const allSources = [S.ACCOUNT_DATA, S.CUSTOMER_DATA];
  for (const dataset of allSources) {
    for (const source of dataset) {
      if (!source.lat || !source.lng) continue;
      if (source === record) continue;

      const sourceLower = source.name.toLowerCase().trim();
      const sourceNormalized = normalizeDistrictName(source.name);

      if (sourceLower === nameLower || sourceNormalized === normalizedName) {
        const recState = (record.state || '').toUpperCase().trim();
        const srcState = (source.state || '').toUpperCase().trim();
        if (recState && srcState && recState !== srcState) continue;

        console.log('[LocationInherit] Inherited coords for:', record.name, '→', source.lat, source.lng, 'from', source.name);
        record.lat = source.lat;
        record.lng = source.lng;
        if (!record.state && source.state) record.state = source.state;
        if (!record.city && source.city) record.city = source.city;
        if (!record.address && source.address) record.address = source.address;
        if (!record.region && source.region) record.region = source.region;
        return true;
      }
    }
  }
  return false;
}

// Geocode a district using OpenStreetMap Nominatim API
export async function geocodeDistrict(name, state, record) {
  // Check for address fields in the record (most accurate if available)
  // CSV headers get normalized: "Billing Address Line 1" → "address" via mapFieldName
  // "Billing Zip/Postal Code" → "zip" via mapFieldName (slash normalized to underscore)
  const address = record?.billing_address_line_1 || record?.address || record?.street_address || record?.billing_address || record?.mailing_address || record?.billing_street || '';
  const city = record?.billing_city || record?.city || record?.mailing_city || '';
  const zip = record?.zip || record?.billing_zip_postal_code || record?.postal_code || record?.zipcode || '';

  // Build list of query variations to try
  // Strip school-related suffixes and identifiers so Nominatim gets a clean city/region name.
  // Includes NH "SAU #XX", CA "CUSD", "UHSD", "JUSD", "JUHSD" etc.
  const baseName = name
    .replace(/\s*SAU\s*#?\d+$/i, '')    // NH: "Keene SAU #29" → "Keene"
    .replace(/\s*(Independent School District|Consolidated Unified School District|Unified High School District|Joint Union High School District|Joint Unified School District|Union Free School District|Central School District|Unified School District|School District|Public Schools|County Schools|City Schools|Parish Schools|CUSD|UHSD|JUHSD|JUSD|UFSD|ISD|USD|CSD|Schools|District).*$/i, '')
    .trim() || name; // Fallback to original if stripping empties it

  // Try structured search first (more accurate for address-based lookups)
  // Construct the fullest possible query: street + city + zip + state
  const structuredQueries = [];
  const stateFull = STATE_FULL_NAMES[(state || '').toUpperCase().trim()] || state;

  if (address && city && state) {
    structuredQueries.push({ street: address, city: city, state: stateFull, postalcode: zip, country: 'US' });
    console.log('[Geocode] Using address from CSV:', address, city, zip || '(no zip)', state);
  }
  if (city && state) {
    structuredQueries.push({ city: city, state: stateFull, postalcode: zip, country: 'US' });
  }

  // Try structured queries first
  for (const sq of structuredQueries) {
    const params = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'us', addressdetails: '1' });
    if (sq.street) params.set('street', sq.street);
    if (sq.city) params.set('city', sq.city);
    if (sq.state) params.set('state', sq.state);
    if (sq.postalcode) params.set('postalcode', sq.postalcode);
    if (sq.country) params.set('country', sq.country);
    const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;

    try {
      console.log('[Geocode] Structured query:', sq);
      const response = await fetch(url, { headers: { 'User-Agent': 'EdiaStratMap/1.0' } });
      if (!response.ok) {
        if (response.status === 429) {
          console.warn('[Geocode] Rate limited (429), waiting 5s before retry');
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }
        console.warn('[Geocode] HTTP error:', response.status, response.statusText);
        continue;
      }
      const data = await response.json();
      if (data && data.length > 0 && isResultInState(data[0], state)) {
        console.log('[Geocode] Found (structured):', name, '→', data[0].lat, data[0].lon);
        return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      }
      if (data && data.length > 0) {
        console.log('[Geocode] Structured result REJECTED (wrong state):', data[0].display_name, '- expected:', state);
      }
      await new Promise(resolve => setTimeout(resolve, 1100));
    } catch (err) {
      console.error('[Geocode] Structured query error:', err);
    }
  }

  // Fall back to free-text queries
  const queries = [];
  if (state) {
    // State-aware queries (preferred — can validate results)
    // Put the most likely-to-succeed queries first
    queries.push(
      `${baseName}, ${state}, USA`,
      `${baseName} County, ${state}, USA`,
      `${name}, ${state}, USA`,
      `${baseName} city, ${state}, USA`,
      `${name} school district, ${state}, USA`
    );
    // If we have city data, add it as a fallback (handles SAU/CUSD-style names where
    // baseName still includes identifiers Nominatim doesn't understand)
    if (city && city.toLowerCase() !== baseName.toLowerCase()) {
      queries.push(`${city}, ${state}, USA`);
    }
  } else {
    // No state available — use name-only queries (less accurate but better than nothing)
    console.log('[Geocode] No state for:', name, '- trying name-only queries');
    queries.push(
      `${name} school district, USA`,
      `${baseName} school district, USA`,
      `${name}, USA`,
      `${baseName}, USA`
    );
  }

  const uniqueQueries = [...new Set(queries)].filter(q => q && !q.includes('undefined'));

  for (const query of uniqueQueries) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=3&countrycodes=us&addressdetails=1`;

    try {
      console.log('[Geocode] Trying:', query);
      const response = await fetch(url, {
        headers: { 'User-Agent': 'EdiaStratMap/1.0' }
      });
      if (!response.ok) {
        if (response.status === 429) {
          console.warn('[Geocode] Rate limited (429), waiting 5s before retry');
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }
        console.warn('[Geocode] HTTP error:', response.status, response.statusText);
        continue;
      }
      const data = await response.json();
      if (data && data.length > 0) {
        if (state) {
          // Find the first result that's actually in the correct state
          const match = data.find(r => isResultInState(r, state));
          if (match) {
            console.log('[Geocode] Found:', name, '→', match.lat, match.lon, '(query:', query, ')');
            return { lat: parseFloat(match.lat), lng: parseFloat(match.lon) };
          }
          console.log('[Geocode] All results for', query, 'were in wrong state (expected:', state, ')');
        } else {
          // No state to validate against — accept best result and extract state from it
          const best = data[0];
          console.log('[Geocode] Found (no state validation):', name, '→', best.lat, best.lon, '(query:', query, ')');
          const result = { lat: parseFloat(best.lat), lng: parseFloat(best.lon) };
          // Try to extract state from the result to fill the record
          if (best.address && best.address.state && record) {
            const extractedState = best.address.state;
            // Reverse-lookup state abbreviation
            const stateAbbr = Object.entries(STATE_FULL_NAMES).find(
              ([abbr, full]) => full.toLowerCase() === extractedState.toLowerCase()
            );
            if (stateAbbr) {
              record.state = stateAbbr[0];
              console.log('[Geocode] Extracted state from result:', record.state);
            }
          }
          return result;
        }
      }
      // Rate limit between query attempts
      await new Promise(resolve => setTimeout(resolve, 1100));
    } catch (err) {
      console.error('[Geocode] Error for:', query, err);
    }
  }

  // Last resort: try to at least place it somewhere in the state (only if we have a state)
  if (state) {
    console.warn('[Geocode] Trying state-level fallback for:', name, state);
    try {
      const stateUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent((stateFull || state) + ', USA')}&limit=1&countrycodes=us`;
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
  }

  console.warn('[Geocode] No results for:', name, state || '(no state)');
  return null;
}

// Geocode all records missing lat/lng (with rate limiting)
export async function geocodeMissingRecords(records) {
  // Phase 1: Try to inherit coordinates from existing datasets (no API calls)
  const locationIndex = buildLocationIndex();
  let inherited = 0;
  records.forEach(r => {
    if (!r.lat || !r.lng) {
      if (inheritLocationData(r, locationIndex)) inherited++;
    }
  });
  if (inherited > 0) {
    console.log('[Geocode] Inherited coordinates for', inherited, 'record(s) from existing data');
  }

  const needsGeocoding = records.filter(r => !r.lat || !r.lng);
  if (needsGeocoding.length === 0) return;

  showGeocodeProgress('Geocoding accounts...');
  const total = needsGeocoding.length;

  let geocoded = 0;
  for (let i = 0; i < needsGeocoding.length; i++) {
    const record = needsGeocoding[i];
    updateGeocodeProgress(i + 1, total, (i + 1) + ' of ' + total + ' — ' + (record.name || '').substring(0, 30));

    // Rate limit between records (Nominatim allows 1 req/sec)
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    // geocodeDistrict now handles missing state with name-only fallback queries
    const coords = await geocodeDistrict(record.name, record.state || '', record);
    if (coords) {
      record.lat = coords.lat;
      record.lng = coords.lng;
      geocoded++;
    }
  }
  hideGeocodeProgress();
  console.log('[Geocode] Completed - geocoded', geocoded, 'of', total, 'records');
}

// Helper: download a JSON array as a file
export function downloadJsonFile(data, filename) {
  const jsonBlob = new Blob(
    [JSON.stringify(data, null, 2)],
    { type: 'application/json' }
  );
  const downloadLink = document.createElement('a');
  downloadLink.href = URL.createObjectURL(jsonBlob);
  downloadLink.download = filename;
  downloadLink.click();
}

// Extract opp data from accounts for opps.json download (reverse of joinOppsToAccounts)
export function extractOppsFromAccounts(accounts) {
  const opps = [];
  for (const acct of accounts) {
    const hasOpps = acct.opps && acct.opps.length > 0;
    const hasOppWrapper = acct.opp_owner || acct.opportunity_name || acct._hasUploadedOpp;
    if (!hasOpps && !hasOppWrapper) continue;

    const oppRecord = {
      account_name: acct.name,
      state: acct.state || '',
      opp_owner: acct.opp_owner || '',
      opportunity_name: acct.opportunity_name || '',
      intro_meeting_date: acct.intro_meeting_date || '',
      created_date: acct.created_date || '',
      last_modified: acct.last_modified || '',
      age: acct.age || '',
      opps: acct.opps || [],
    };
    if (acct._hasUploadedOpp) oppRecord._hasUploadedOpp = true;
    if (acct.metric_improvement_goal) oppRecord.metric_improvement_goal = acct.metric_improvement_goal;
    if (acct.decision_criteria) oppRecord.decision_criteria = acct.decision_criteria;
    if (acct.decision_process) oppRecord.decision_process = acct.decision_process;
    if (acct.paper_process) oppRecord.paper_process = acct.paper_process;
    if (acct.implication_of_pain) oppRecord.implication_of_pain = acct.implication_of_pain;
    opps.push(oppRecord);
  }
  return opps;
}

// Strip opp fields from accounts for clean accounts.json download
export function stripOppsFromAccounts(accounts) {
  const OPP_STRIP_FIELDS = new Set([
    'opp_owner', 'opportunity_name', 'intro_meeting_date',
    'created_date', 'last_modified', 'age', '_hasUploadedOpp',
    'metric_improvement_goal', 'metric_-_improvement_goal',
    'decision_criteria', 'decision_process', 'paper_process', 'implication_of_pain',
    'opp_count', 'opp_stage', 'opp_forecast', 'opp_areas', 'opp_acv',
    'opp_probability', 'opp_next_step', 'opp_contact', 'opp_contact_title',
    'opp_sdr', 'opp_champion', 'opp_economic_buyer', 'opp_competition',
    'opp_last_activity', 'opps',
  ]);
  return accounts.map(acct => {
    const cleaned = {};
    for (const key of Object.keys(acct)) {
      if (!OPP_STRIP_FIELDS.has(key)) cleaned[key] = acct[key];
    }
    return cleaned;
  });
}

// Helper: geocode records missing lat/lng, updating confirmBtn text. Returns { geocodedCount, errors, inheritedCount }.
export async function geocodePendingRecords(records, confirmBtn) {
  const errors = [];
  let geocodedCount = 0;
  let inheritedCount = 0;

  // Phase 1: Cross-reference existing datasets to inherit coordinates (no API calls needed)
  confirmBtn.textContent = 'Cross-referencing location data...';
  const locationIndex = buildLocationIndex();
  records.forEach(r => {
    if (!r.lat || !r.lng) {
      if (inheritLocationData(r, locationIndex)) inheritedCount++;
    }
  });
  if (inheritedCount > 0) {
    console.log('[Geocode] Inherited coordinates for', inheritedCount, 'record(s) from existing data');
  }

  const needsGeocoding = records.filter(r => !r.lat || !r.lng);
  if (needsGeocoding.length === 0) return { geocodedCount, errors, inheritedCount };

  showGeocodeProgress('Geocoding accounts...');
  const failedRecords = [];

  for (let i = 0; i < needsGeocoding.length; i++) {
    const record = needsGeocoding[i];
    confirmBtn.textContent = `Geocoding ${i + 1}/${needsGeocoding.length}...`;
    updateGeocodeProgress(i + 1, needsGeocoding.length, (i + 1) + ' of ' + needsGeocoding.length + ' — ' + (record.name || '').substring(0, 30));

    // Rate limit between records (Nominatim allows 1 req/sec)
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    try {
      // geocodeDistrict now handles missing state with name-only fallback queries
      const coords = await geocodeDistrict(record.name, record.state || '', record);
      if (coords) {
        record.lat = coords.lat;
        record.lng = coords.lng;
        geocodedCount++;
      } else {
        failedRecords.push(record);
      }
    } catch (e) {
      failedRecords.push(record);
    }
  }

  // Retry pass for failed records (rate limiting may have caused empty results)
  if (failedRecords.length > 0) {
    console.log('[Geocode] Retrying', failedRecords.length, 'failed records after cooldown...');
    confirmBtn.textContent = `Retrying ${failedRecords.length} failed...`;
    updateGeocodeProgress(0, failedRecords.length, 'Cooling down before retry...');
    // Wait 5 seconds before retry pass to reset any rate limiting
    await new Promise(resolve => setTimeout(resolve, 5000));

    for (let i = 0; i < failedRecords.length; i++) {
      const record = failedRecords[i];
      confirmBtn.textContent = `Retry ${i + 1}/${failedRecords.length}...`;
      updateGeocodeProgress(i + 1, failedRecords.length, 'Retry ' + (i + 1) + ' of ' + failedRecords.length + ' — ' + (record.name || '').substring(0, 30));

      // Longer delay between retries
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      try {
        const coords = await geocodeDistrict(record.name, record.state || '', record);
        if (coords) {
          record.lat = coords.lat;
          record.lng = coords.lng;
          geocodedCount++;
        } else {
          errors.push(`Could not geocode: ${record.name}${record.state ? ' (' + record.state + ')' : ' (no state)'}`);
        }
      } catch (e) {
        errors.push(`Geocode error for ${record.name}: ${e.message}`);
      }
    }
  }

  hideGeocodeProgress();
  return { geocodedCount, errors, inheritedCount };
}

// Post-merge validation: count records still missing coordinates and log them
export function auditMissingCoordinates(datasetName, records) {
  const missing = records.filter(r => !r.lat || !r.lng);
  if (missing.length === 0) {
    console.log(`[Audit] All ${datasetName} records have coordinates`);
    return [];
  }
  console.warn(`[Audit] ${missing.length} ${datasetName} record(s) still missing coordinates:`);
  missing.forEach(r => {
    console.warn(`  - ${r.name || '(no name)'}${r.state ? ' (' + r.state + ')' : ' (no state)'}`);
  });
  return missing;
}

// Common post-merge UI refresh logic (DRY — used by both merge paths)
export function postMergeRefresh() {
  // Ensure welcome overlay is dismissed so pins actually render
  if (S.welcomeActive) {
    S.welcomeActive = false;
    hideWelcomeOverlay();
  }

  // Catch-up inheritance pass: now that both S.ACCOUNT_DATA and S.CUSTOMER_DATA
  // are fully committed, cross-reference again so newly-added records in one
  // dataset can inherit coordinates from newly-added records in the other.
  let catchUpInherited = 0;
  const catchUpLocationIndex = buildLocationIndex();
  [...S.ACCOUNT_DATA, ...S.CUSTOMER_DATA].forEach(r => {
    if (!r.lat || !r.lng) {
      if (inheritLocationData(r, catchUpLocationIndex)) catchUpInherited++;
    }
  });
  if (catchUpInherited > 0) {
    console.log(`[PostMerge] Catch-up inheritance resolved coords for ${catchUpInherited} record(s)`);
    S._saveDataToLocalStorage(S.ACCOUNT_DATA, S.CUSTOMER_DATA);
  }

  // Cross-link customer ↔ account flags after merge
  crossLinkCustomers();

  // Re-compute lowercase search fields after merge
  precomputeSearchFields(S.ACCOUNT_DATA);
  precomputeSearchFields(S.CUSTOMER_DATA);

  // Rebuild performance indices after data change
  buildIndices();
  S._custGrid = null;

  // Rebuild district data cache for modal/popup access
  window.districtDataCache = {};
  S.ACCOUNT_DATA.forEach(d => {
    const key = districtKey(d);
    window.districtDataCache[key] = d;
  });

  // Rebuild note index and marker pool after data change
  S._rebuildNoteIndex();
  S._rebuildMarkerPool();

  // Refresh all UI components
  renderTeamRepSelectors();
  renderFilters();
  S._applyFilters();
  updateDataSourceIndicator();
  renderConflictsOverlay();
  updateConflictsBadge();
}

// Build the merge completion message
export function buildMergeMessage({ dataLabel, recordCount, geocodedCount, inheritedCount, conflicts, errors, filenames, missingCoords, hiddenByFilter }) {
  let message = `Merge complete!\n\n${recordCount} ${dataLabel} updated on the S.map.`;
  message += `\n\nData saved to this browser — it will persist across page refreshes.`;
  if (filenames.length === 1) {
    message += `\n\nThe file "${filenames[0]}" has been downloaded.`;
    message += `\nReplace src/data/${filenames[0]} in the repo and redeploy so ALL users see the updated data.`;
  } else {
    message += `\n\n${filenames.length} files downloaded: ${filenames.join(' and ')}`;
    message += `\nReplace both in src/data/ and redeploy so ALL users see the updated data.`;
  }
  if (inheritedCount > 0) {
    message += `\n\n${inheritedCount} record(s) matched to existing location data.`;
  }
  if (geocodedCount > 0) {
    message += `\n${geocodedCount} new record(s) geocoded via address lookup.`;
  }
  if (conflicts && conflicts.length > 0) {
    message += `\n\n${conflicts.length} ownership conflict(s) detected — review in the Conflicts dropdown.`;
  }
  if (hiddenByFilter && hiddenByFilter > 0) {
    message += `\n\n⚠ ${hiddenByFilter} new record(s) are hidden by your current Team/Rep filter (assigned to a different rep or unassigned).`;
    message += `\nClear the Team/Rep filter to see all new pins.`;
  }
  if (missingCoords && missingCoords.length > 0) {
    message += `\n\n${missingCoords.length} record(s) could not be placed on the map (missing coordinates):`;
    missingCoords.slice(0, 5).forEach(r => {
      message += `\n  - ${r.name || '(no name)'}${r.state ? ' (' + r.state + ')' : ''}`;
    });
    if (missingCoords.length > 5) {
      message += `\n  ...and ${missingCoords.length - 5} more`;
    }
    message += `\n\nThese records are in the data but need state/address info to appear on the S.map.`;
  }
  if (errors.length > 0) {
    message += `\n\n${errors.length} warning(s):\n${errors.slice(0, 5).map(e => '  ' + e).join('\n')}`;
    if (errors.length > 5) {
      message += `\n  ...and ${errors.length - 5} more`;
    }
  }
  return message;
}

// Readable reason labels for the upload summary
const REASON_LABELS = {
  direct_assign: 'Account Owner (direct)',
  inactive_owner: 'Opp Owner fallback — inactive owner',
  inactive_reassign: 'Reassigned — departing rep',
  manager_fallback: 'Opp Owner fallback — manager (not account holder)',
  no_data_loaded: 'Opp Owner fallback — rep has no data loaded yet',
  unrecognized: 'Opp Owner fallback — unrecognized name',
  ben_foley_strategic: 'Ben Foley rule — strategic override to Sean Johnson',
  ben_foley_nyc_holdout: 'Ben Foley rule — NYC holdout, Opp Owner assigned',
  ben_foley_fallback: 'Ben Foley rule — below threshold, Opp Owner fallback',
  conditional_reassign: 'Conditional reassign — has opp, Opp Owner fallback',
  conditional_no_opp: 'Conditional reassign — no opp, kept existing',
  conflict_kept_existing: 'Conflict — kept existing owner',
  blank_owner: 'Blank Account Owner — Opp Owner fallback',
};

export function showUploadSummary({ stats, geocodedCount, inheritedCount, errors, missingCoords, hiddenByFilter }) {
  const body = document.getElementById('uploadSummaryBody');
  let html = '';

  // ── Overview stats ──
  html += `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px;">`;
  html += `<div style="background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:6px;padding:10px;text-align:center;">
    <div style="font-size:20px;font-weight:700;color:var(--text-primary);">${stats.total}</div>
    <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;">Processed</div></div>`;
  html += `<div style="background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:6px;padding:10px;text-align:center;">
    <div style="font-size:20px;font-weight:700;color:#51cf66;">${stats.newRecords}</div>
    <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;">New</div></div>`;
  html += `<div style="background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:6px;padding:10px;text-align:center;">
    <div style="font-size:20px;font-weight:700;color:#339af0;">${stats.updatedRecords}</div>
    <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;">Updated</div></div>`;
  html += `</div>`;

  // Show consolidated count when records were absorbed (schools → parents, multi-opp rows)
  const consolidated = stats.consolidatedRecords || 0;
  if (consolidated > 0) {
    html += `<div style="font-size:11px;color:var(--text-dim);margin-bottom:10px;text-align:center;">${consolidated} row${consolidated > 1 ? 's' : ''} consolidated (schools rolled into parent districts / multiple opps per account)</div>`;
  }

  // ── Geocoding summary ──
  if (geocodedCount > 0 || inheritedCount > 0) {
    html += `<div style="background:#E8853D15;border:1px solid #E8853D33;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:11px;">`;
    if (geocodedCount > 0) html += `<div>📍 <strong>${geocodedCount}</strong> record${geocodedCount > 1 ? 's' : ''} geocoded via address lookup</div>`;
    if (inheritedCount > 0) html += `<div>📍 <strong>${inheritedCount}</strong> record${inheritedCount > 1 ? 's' : ''} matched to existing location data</div>`;
    html += `</div>`;
  }

  // ── Hidden by filter ──
  if (hiddenByFilter > 0) {
    html += `<div style="background:#fab00522;border:1px solid #fab00544;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:11px;">
      <strong style="color:#fab005;">&#9888; ${hiddenByFilter} new record${hiddenByFilter > 1 ? 's' : ''} hidden by current Team/Rep filter</strong>
      <div style="color:var(--text-dim);margin-top:3px;">Clear the filter to see all new pins.</div>
    </div>`;
  }

  // ── Missing coordinates ──
  if (missingCoords && missingCoords.length > 0) {
    html += `<div style="background:#d6336c15;border:1px solid #d6336c33;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:11px;">
      <strong style="color:#d6336c;">${missingCoords.length} record${missingCoords.length > 1 ? 's' : ''} could not be placed on the map</strong>
      <div style="color:var(--text-dim);margin-top:3px;">Missing state/address info for geocoding.</div>`;
    missingCoords.slice(0, 8).forEach(r => {
      html += `<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">&bull; ${r.name || '(no name)'}${r.state ? ' (' + r.state + ')' : ''} — ${r.address || r.city || 'no address'}</div>`;
    });
    if (missingCoords.length > 8) html += `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;font-style:italic;">...and ${missingCoords.length - 8} more</div>`;
    html += `</div>`;
  }

  // ── Geocoding errors ──
  if (errors && errors.length > 0) {
    html += `<div style="background:#d6336c15;border:1px solid #d6336c33;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:11px;">
      <strong style="color:#d6336c;">${errors.length} geocoding error${errors.length > 1 ? 's' : ''}</strong>`;
    errors.slice(0, 5).forEach(e => {
      html += `<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">&bull; ${e}</div>`;
    });
    if (errors.length > 5) html += `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;font-style:italic;">...and ${errors.length - 5} more</div>`;
    html += `</div>`;
  }

  // ── Owner resolutions ──
  const resolutions = stats.resolutions || [];
  if (resolutions.length > 0) {
    // Group by reason
    const byReason = {};
    resolutions.forEach(r => {
      if (!byReason[r.reason]) byReason[r.reason] = [];
      byReason[r.reason].push(r);
    });

    // Show fallback resolutions first (most interesting), then direct assigns
    const fallbackReasons = Object.keys(byReason).filter(r => r !== 'direct_assign').sort();
    const directCount = (byReason['direct_assign'] || []).length;

    html += `<div style="margin-top:12px;margin-bottom:6px;font-size:11px;font-weight:600;color:var(--text-primary);text-transform:uppercase;letter-spacing:0.5px;">Owner Resolutions</div>`;

    if (directCount > 0) {
      html += `<div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;">${directCount} account${directCount > 1 ? 's' : ''} assigned directly to Account Owner (no fallback needed)</div>`;
    }

    fallbackReasons.forEach(reason => {
      const items = byReason[reason];
      const label = REASON_LABELS[reason] || reason;
      html += `<div style="background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:11px;">
        <div style="font-weight:600;color:var(--accent-strat);margin-bottom:4px;">${label} (${items.length})</div>`;
      items.slice(0, 10).forEach(r => {
        html += `<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">
          ${r.isNew ? '<span style="color:#51cf66;font-weight:600;">NEW</span>' : '<span style="color:#339af0;font-weight:600;">UPD</span>'}
          <strong>${r.name}</strong>: ${r.csvOwner} → ${r.resolvedAE}${r.oppOwner ? ' <span style="color:var(--text-muted);">(Opp Owner: ' + r.oppOwner + ')</span>' : ''}
        </div>`;
      });
      if (items.length > 10) {
        html += `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;font-style:italic;">...and ${items.length - 10} more</div>`;
      }
      html += `</div>`;
    });
  }

  // ── Conflicts ──
  const conflicts = stats.conflicts || [];
  if (conflicts.length > 0) {
    html += `<div style="background:#d6336c15;border:1px solid #d6336c33;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:11px;">
      <strong style="color:#d6336c;">&#9888; ${conflicts.length} ownership conflict${conflicts.length > 1 ? 's' : ''}</strong>
      <div style="color:var(--text-dim);margin-top:3px;">Resolve via the Conflicts dropdown.</div>`;
    conflicts.slice(0, 5).forEach(c => {
      html += `<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">&bull; ${c.name}: ${c.oldAE} → ${c.newAE} <span style="opacity:0.6;">(${c.source === 'customers' ? 'Customer' : 'Account'})</span></div>`;
    });
    if (conflicts.length > 5) html += `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;font-style:italic;">...and ${conflicts.length - 5} more</div>`;
    html += `</div>`;
  }

  body.innerHTML = html;
  document.getElementById('uploadSummaryModal').classList.add('show');
}

export function closeUploadSummary() {
  document.getElementById('uploadSummaryModal').classList.remove('show');
}

// Count how many new records (with lat/lng) are hidden by the active team/rep filter.
// Includes unassigned records (no AE) which are now filtered out when a team/rep is selected.
export function countNewRecordsHiddenByFilter(newRecordNames) {
  if (!newRecordNames || newRecordNames.size === 0) return 0;
  if (!S.selectedTeam && !S.selectedRep) return 0; // No team/rep filter active
  let hidden = 0;
  S.ACCOUNT_DATA.forEach(d => {
    if (!newRecordNames.has(d.name)) return; // Only check new records
    if (!d.lat || !d.lng) return; // Already counted as missing coords
    const territoryAE = getTerritoryAE(d);
    const holdoutAE = getHoldoutAE(d);
    if (S.selectedRep) {
      const isManager = S.selectedTeam && TEAM_REP_DATA[S.selectedTeam] &&
        TEAM_REP_DATA[S.selectedTeam].manager === S.selectedRep;
      if (isManager) {
        const teamReps = S._teamRepsSet[S.selectedTeam];
        if (!teamReps || (!teamReps.has(territoryAE) && !(holdoutAE && teamReps.has(holdoutAE)))) hidden++;
      } else {
        if (territoryAE !== S.selectedRep && holdoutAE !== S.selectedRep) hidden++;
      }
    } else if (S.selectedTeam) {
      const teamReps = S._teamRepsSet[S.selectedTeam];
      if (!teamReps || (!teamReps.has(territoryAE) && !(holdoutAE && teamReps.has(holdoutAE)))) hidden++;
    }
  });
  return hidden;
}

export async function confirmMerge() {
  if (!S.pendingMergeData && !S.mergeHasTypeSplit) return;

  const confirmBtn = document.querySelector('.merge-btn-confirm');
  const originalBtnText = confirmBtn.textContent;
  let errors = [];
  let geocodedCount = 0;
  let inheritedCount = 0;

  try {
    // Disable button and show loading state
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Processing...';

    // Opp-only merge path — no geocoding needed
    if (S.sfdcDataType === 'opps') {
      confirmBtn.textContent = 'Saving data...';

      // Apply to in-memory array
      S.ACCOUNT_DATA.length = 0;
      S.pendingMergeData.forEach(item => S.ACCOUNT_DATA.push(item));

      // Persist to localStorage
      S._saveDataToLocalStorage(S.ACCOUNT_DATA, null);
      S._dataSource = 'localStorage';

      // Download opps.json (extracted from merged S.ACCOUNT_DATA)
      const extractedOpps = extractOppsFromAccounts(S.ACCOUNT_DATA);
      downloadJsonFile(extractedOpps, 'opps.json');
      await new Promise(resolve => setTimeout(resolve, 500));
      // Also download accounts.json (may have AE changes from holdout resolution)
      const strippedAccounts = stripOppsFromAccounts(S.ACCOUNT_DATA);
      downloadJsonFile(strippedAccounts, 'accounts.json');

      // Also persist extracted opps to localStorage for the opp-only path
      saveOppsToLocalStorage(extractedOpps);

      localStorage.setItem('edia_sfdc_last_refresh', new Date().toISOString());
      // Capture stats BEFORE closeMergeModal() nulls S.pendingMergeStats
      const savedStats = S.pendingMergeStats;
      storeNewConflicts(savedStats);
      closeMergeModal();
      postMergeRefresh();

      showUploadSummary({
        stats: savedStats,
        geocodedCount: 0,
        inheritedCount: 0,
        errors: [],
        missingCoords: [],
        hiddenByFilter: 0,
      });
      return;
    }

    if (S.mergeHasTypeSplit) {
      // Type-split merge: process both accounts and customers
      // Geocode account records
      const acctGeo = await geocodePendingRecords(S.pendingAccountMerge, confirmBtn);
      geocodedCount += acctGeo.geocodedCount;
      inheritedCount += acctGeo.inheritedCount || 0;
      errors.push(...acctGeo.errors);

      // Geocode customer records
      const custGeo = await geocodePendingRecords(S.pendingCustomerMerge, confirmBtn);
      geocodedCount += custGeo.geocodedCount;
      inheritedCount += custGeo.inheritedCount || 0;
      errors.push(...custGeo.errors);

      confirmBtn.textContent = 'Saving data...';

      // Update in-memory arrays
      S.ACCOUNT_DATA.length = 0;
      S.pendingAccountMerge.forEach(item => S.ACCOUNT_DATA.push(item));
      console.log('[Merge] Updated', S.ACCOUNT_DATA.length, 'accounts in memory');

      S.CUSTOMER_DATA.length = 0;
      S.pendingCustomerMerge.forEach(item => S.CUSTOMER_DATA.push(item));
      console.log('[Merge] Updated', S.CUSTOMER_DATA.length, 'customers in memory');

      // Persist merged data to localStorage so it survives page refreshes
      S._saveDataToLocalStorage(S.ACCOUNT_DATA, S.CUSTOMER_DATA);
      S._dataSource = 'localStorage';

      // Download both files (for committing to repo so all users get the update)
      downloadJsonFile(S.pendingAccountMerge, 'accounts.json');
      // Small delay so browser handles both downloads
      await new Promise(resolve => setTimeout(resolve, 500));
      downloadJsonFile(S.pendingCustomerMerge, 'customers.json');

      // Track refresh
      localStorage.setItem('edia_sfdc_last_refresh', new Date().toISOString());

      // Store detected conflicts (append to existing, deduplicate by name)
      const mergeConflicts = S.pendingMergeStats && S.pendingMergeStats.conflicts ? S.pendingMergeStats.conflicts : [];
      storeNewConflicts(S.pendingMergeStats);

      // Capture stats before closeMergeModal() nulls S.pendingMergeStats
      const savedStats = S.pendingMergeStats;

      // Close modal and refresh UI
      closeMergeModal();
      postMergeRefresh();

      // Post-merge audit
      const missingAcct = auditMissingCoordinates('account', S.ACCOUNT_DATA);
      const missingCust = auditMissingCoordinates('customer', S.CUSTOMER_DATA);
      const allMissing = [...missingAcct, ...missingCust];

      // Check if new records are hidden by the active team/rep filter
      const newNames = new Set(
        (savedStats?.changes || []).filter(c => c.action === 'new').map(c => c.name)
      );
      const hiddenByFilter = countNewRecordsHiddenByFilter(newNames);

      // Show post-upload summary modal
      showUploadSummary({
        stats: savedStats,
        geocodedCount,
        inheritedCount,
        errors,
        missingCoords: allMissing,
        hiddenByFilter,
      });

    } else {
      // Single-dataset merge (no type column)
      const isAccountType = S.sfdcDataType === 'accounts';

      // Geocode missing records
      const geo = await geocodePendingRecords(S.pendingMergeData, confirmBtn);
      geocodedCount = geo.geocodedCount;
      inheritedCount = geo.inheritedCount || 0;
      errors = geo.errors;

      confirmBtn.textContent = 'Saving data...';

      // Apply the merge to in-memory arrays
      const filename = isAccountType ? 'accounts.json' : 'customers.json';
      if (isAccountType) {
        S.ACCOUNT_DATA.length = 0;
        S.pendingMergeData.forEach(item => S.ACCOUNT_DATA.push(item));
        console.log('[Merge] Updated', S.ACCOUNT_DATA.length, 'accounts in memory');
      } else {
        S.CUSTOMER_DATA.length = 0;
        S.pendingMergeData.forEach(item => S.CUSTOMER_DATA.push(item));
        console.log('[Merge] Updated', S.CUSTOMER_DATA.length, 'customers in memory');
      }

      // Persist merged data to localStorage so it survives page refreshes
      S._saveDataToLocalStorage(
        isAccountType ? S.ACCOUNT_DATA : null,
        isAccountType ? null : S.CUSTOMER_DATA
      );
      S._dataSource = 'localStorage';

      // Download the merged data as a JSON file (for committing to repo so all users get the update)
      downloadJsonFile(S.pendingMergeData, filename);

      // Track when this user last ran a data refresh
      localStorage.setItem('edia_sfdc_last_refresh', new Date().toISOString());

      // Store detected conflicts (append to existing, deduplicate by name)
      const mergeConflicts2 = S.pendingMergeStats && S.pendingMergeStats.conflicts ? S.pendingMergeStats.conflicts : [];
      storeNewConflicts(S.pendingMergeStats);

      // Capture stats before closeMergeModal() nulls S.pendingMergeStats
      const savedStats2 = S.pendingMergeStats;

      // Close modal and refresh UI
      closeMergeModal();
      postMergeRefresh();

      // Post-merge audit
      const targetData = isAccountType ? S.ACCOUNT_DATA : S.CUSTOMER_DATA;
      const missingCoords = auditMissingCoordinates(isAccountType ? 'account' : 'customer', targetData);

      // Check if new records are hidden by the active team/rep filter
      const newNames2 = new Set(
        (savedStats2?.changes || []).filter(c => c.action === 'new').map(c => c.name)
      );
      const hiddenByFilter2 = isAccountType ? countNewRecordsHiddenByFilter(newNames2) : 0;

      // Show post-upload summary modal
      showUploadSummary({
        stats: savedStats2,
        geocodedCount,
        inheritedCount,
        errors,
        missingCoords,
        hiddenByFilter: hiddenByFilter2,
      });
    }

  } catch (e) {
    console.error('[Merge] Error:', e);
    confirmBtn.disabled = false;
    confirmBtn.textContent = originalBtnText;
    alert(`Merge failed!\n\nError: ${e.message}\n\nCheck console for details.`);
  }
}

export function focusOnAccount(dKey) {
  const d = window.districtDataCache && window.districtDataCache[dKey];
  if (!d) return;
  const mlKey = d.name + '|' + (d.state || '');
  const entry = S.markerLookup[mlKey];
  if (entry && entry.marker) {
    const latLng = entry.marker.getLatLng();
    S.map.flyTo(latLng, 8, { duration: 0.6 });
    setTimeout(() => { S._ensurePopup(entry.marker, entry.data, entry.type); entry.marker.openPopup(); }, 400);
  } else {
    S._openAccountModalByKey(dKey);
  }
}

