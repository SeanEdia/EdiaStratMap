// Pure utility functions — no state dependencies

export function districtKey(d) {
  return (d.name + '_' + (d.state || '')).replace(/[^a-zA-Z0-9]/g, '_');
}

export function haversine(lat1, lng1, lat2, lng2) {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function escapeAttr(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function parseUSDate(str) {
  if (!str) return null;
  const parts = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!parts) return null;
  let year = parseInt(parts[3]);
  if (year < 100) year += 2000;
  return new Date(year, parseInt(parts[1]) - 1, parseInt(parts[2]));
}

export function precomputeSearchFields(records) {
  records.forEach(d => {
    d._nameLc = (d.name || '').toLowerCase();
    d._stateLc = (d.state || '').toLowerCase();
    d._regionLc = (d.region || '').toLowerCase();
  });
}

export function normalizeDistrictName(name) {
  let normalized = name.toLowerCase().trim();
  const suffixPatterns = [
    /\s+sau\s*#?\d+$/i,
    /\s+independent school district$/i,
    /\s+consolidated unified school district$/i,
    /\s+unified high school district$/i,
    /\s+joint union high school district$/i,
    /\s+joint unified school district$/i,
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
    /\s+cusd$/i,
    /\s+uhsd$/i,
    /\s+juhsd$/i,
    /\s+jusd$/i,
    /\s+ufsd$/i,
    /\s+isd$/i,
    /\s+usd$/i,
    /\s+csd$/i,
    /\s+sd$/i,
    /\s+ps$/i,
  ];
  suffixPatterns.forEach(pattern => {
    normalized = normalized.replace(pattern, '');
  });
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

export function daysAgo(dateStr) {
  const d = parseUSDate(dateStr);
  if (!d) return Infinity;
  const now = new Date();
  now.setHours(0,0,0,0);
  d.setHours(0,0,0,0);
  const diff = Math.floor((now - d) / 86400000);
  if (diff < 0) return Infinity; // Future dates treated as no activity
  return diff;
}

export function extractDatesFromText(text) {
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

export function isThisWeek(date) {
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

export function formatLastActivity(dateStr) {
  if (!dateStr) return '—';
  const parsed = parseUSDate(dateStr);
  if (!parsed) return dateStr;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (parsed > today) return '—';
  return dateStr;
}

export function clampFutureLastActivity(record) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  (record.opps || []).forEach(o => {
    if (o.last_activity) {
      const parsed = parseUSDate(o.last_activity);
      if (parsed && parsed > today) {
        o.last_activity = '';
      }
    }
  });
}

export function normalizeOppArea(area) {
  if (!area) return '';
  return area.replace(/\bMTSS\b/gi, 'District Intelligence').trim();
}

export function isDOE(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return n.includes('department of education') || /\bdoe\b/.test(n);
}
