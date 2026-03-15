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
