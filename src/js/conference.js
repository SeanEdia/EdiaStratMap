import S from './state.js';
import { districtKey, haversine } from './helpers.js';

// ============ CONFERENCE TRACKER ============

export function toggleConferences(on) {
  S.conferencesOn = on;
  document.getElementById('confOptions').style.display = on ? '' : 'none';
  renderConferences();
  S._updateLegend();
}

export function setConfRange(mode) {
  S.confRangeMode = mode;
  // Update quick button active states
  document.querySelectorAll('.conf-quick-btn').forEach(b => b.classList.remove('active'));
  const btns = document.querySelectorAll('.conf-quick-btn');
  btns.forEach(b => { if (b.textContent.toLowerCase().replace('d','') === mode || b.textContent.toLowerCase() === mode) b.classList.add('active'); });

  const customDates = document.getElementById('confCustomDates');
  if (mode === 'custom') {
    customDates.style.display = '';
  } else {
    customDates.style.display = 'none';
    S.confDateFrom = null;
    S.confDateTo = null;
  }
  renderConferences();
}

export function applyConfDateFilter() {
  const fromEl = document.getElementById('S.confDateFrom');
  const toEl = document.getElementById('S.confDateTo');
  S.confDateFrom = fromEl.value ? new Date(fromEl.value + 'T00:00:00') : null;
  S.confDateTo = toEl.value ? new Date(toEl.value + 'T23:59:59') : null;
  renderConferences();
}

export function getConfDateRange() {
  const now = new Date();
  now.setHours(0,0,0,0);
  let from, to;

  if (S.confRangeMode === 'custom') {
    from = S.confDateFrom;
    to = S.confDateTo;
  } else if (S.confRangeMode === 'all') {
    from = null;
    to = null;
  } else {
    const days = parseInt(S.confRangeMode) || 30;
    from = new Date(now);
    from.setDate(from.getDate() - 7); // Show conferences from 1 week ago
    to = new Date(now);
    to.setDate(to.getDate() + days);
  }
  return { from, to };
}

export function filterConferences() {
  const { from, to } = getConfDateRange();

  return S.CONFERENCE_DATA.filter(c => {
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

export function parseConfDate(str) {
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

export function formatConfDate(dateStr) {
  const d = parseConfDate(dateStr);
  if (!d) return dateStr || '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function isConfPast(c) {
  const endDate = parseConfDate(c.end_date) || parseConfDate(c.start_date);
  if (!endDate) return false;
  const now = new Date();
  now.setHours(0,0,0,0);
  return endDate < now;
}

export function renderConferences() {
  S.confLayer.clearLayers();
  S.confProxLayer.clearLayers();
  S.filteredConfData = [];

  if (!S.conferencesOn || S.CONFERENCE_DATA.length === 0) {
    updateConfStats();
    return;
  }

  S.filteredConfData = filterConferences();
  console.log('[Conference] Rendering', S.filteredConfData.length, 'of', S.CONFERENCE_DATA.length, 'conferences. S.conferencesOn:', S.conferencesOn, 'rangeMode:', S.confRangeMode);
  if (S.filteredConfData.length === 0 && S.CONFERENCE_DATA.length > 0) {
    console.log('[Conference] All filtered out. Sample data:', JSON.stringify(S.CONFERENCE_DATA.slice(0, 2).map(c => ({ name: c.name, lat: c.lat, lng: c.lng, start_date: c.start_date }))));
  }

  S.filteredConfData.forEach(c => {
    const past = isConfPast(c);
    const icon = L.divIcon({
      className: `marker-conf${past ? ' conf-past' : ''}`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    const marker = L.marker([c.lat, c.lng], { icon }).addTo(S.confLayer);
    marker.bindPopup(buildConfPopup(c), { maxWidth: 340 });
    marker.on('click', function() {
      S.map.flyTo([c.lat, c.lng], Math.max(S.map.getZoom(), 8), { duration: 0.6 });
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
      }).addTo(S.confProxLayer);
    }
  });

  updateConfStats();
}

export function updateConfStats() {
  const statsEl = document.getElementById('confStats');
  if (!statsEl) return;
  if (S.CONFERENCE_DATA.length === 0) {
    statsEl.innerHTML = 'No conferences loaded — upload a CSV';
    return;
  }
  const showing = S.filteredConfData.length;
  const total = S.CONFERENCE_DATA.length;
  const upcoming = S.filteredConfData.filter(c => !isConfPast(c)).length;
  let nearbyAccounts = 0;
  S.filteredConfData.forEach(c => {
    if (isConfPast(c)) return;
    nearbyAccounts += countNearbyAccounts(c, 100);
  });
  statsEl.innerHTML = `<b>${showing}</b> of ${total} conferences · <b>${upcoming}</b> upcoming · <b>${nearbyAccounts}</b> accounts nearby`;
}

export function countNearbyAccounts(conf, radiusMiles) {
  let count = 0;
  S.ACCOUNT_DATA.forEach(s => {
    if (!s.lat || !s.lng) return;
    if (haversine(conf.lat, conf.lng, s.lat, s.lng) <= radiusMiles) count++;
  });
  return count;
}

export function getNearbyAccounts(conf, radiusMiles) {
  const results = [];
  S.ACCOUNT_DATA.forEach(s => {
    if (!s.lat || !s.lng) return;
    const dist = haversine(conf.lat, conf.lng, s.lat, s.lng);
    if (dist <= radiusMiles) {
      results.push({ data: s, distance: dist });
    }
  });
  return results.sort((a, b) => a.distance - b.distance);
}

export function buildConfPopup(c) {
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

  // Nearby accounts
  if (!past) {
    const nearby = getNearbyAccounts(c, 100);
    if (nearby.length > 0) {
      html += `<div class="popup-conf-nearby">`;
      html += `<div class="popup-conf-nearby-title">${nearby.length} accounts within 100 mi</div>`;
      const shown = nearby.slice(0, 10);
      shown.forEach(n => {
        const dKey = districtKey(n.data);
        const distMi = Math.round(n.distance);
        const stageLbl = n.data.opp_stage ? n.data.opp_stage.replace(/^\d+\s*-\s*/, '') : '';
        html += `<div class="popup-conf-nearby-item" onclick="focusOnAccount('${dKey}')">`;
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

export function handleConfFile(event) {
  const file = event.target.files[0];
  if (file && /\.(csv|xlsx?|xls)$/i.test(file.name)) {
    processConfUpload(file);
  }
  event.target.value = '';
}

export function processConfUpload(file) {
  S._readSpreadsheetFile(file).then(parsed => {
    if (parsed.length === 0) {
      alert('No data found in file');
      return;
    }
    processConfData(parsed);
  }).catch(err => {
    alert('Error reading file: ' + err.message);
  });
}

export function processConfData(parsed) {

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
      S.CONFERENCE_DATA = results;
      console.log('[Conference] Loaded', S.CONFERENCE_DATA.length, 'conferences');

      // Auto-enable conference layer
      S.conferencesOn = true;
      document.getElementById('confCheck').checked = true;
      document.getElementById('confOptions').style.display = '';
      // Show all conferences on first upload so user sees everything
      setConfRange('all');

      alert(`✓ Loaded ${results.length} conferences!\n${results.filter(r => r.lat && r.lng).length} geocoded successfully.`);
    });
}

// ============ GEOCODE PROGRESS ============

export function showGeocodeProgress(label) {
  const el = document.getElementById('geocodeProgress');
  document.getElementById('geocodeProgressLabel').textContent = label;
  document.getElementById('geocodeProgressFill').style.width = '0%';
  document.getElementById('geocodeProgressDetail').textContent = '';
  el.classList.add('show');
}

export function updateGeocodeProgress(current, total, detail) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  document.getElementById('geocodeProgressFill').style.width = pct + '%';
  document.getElementById('geocodeProgressDetail').textContent = detail || (current + ' of ' + total);
}

export function hideGeocodeProgress() {
  document.getElementById('geocodeProgress').classList.remove('show');
}

export async function geocodeConferences(conferences) {
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
