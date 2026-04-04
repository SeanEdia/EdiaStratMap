#!/usr/bin/env node
/**
 * Pre-build script: joins opp data into accounts at build time so the browser
 * doesn't need to download opps.json separately and join at runtime.
 *
 * Usage:
 *   node scripts/prebuild-data.js
 *
 * Reads:  src/data/accounts.json, src/data/opps.json
 * Writes: src/data/accounts-with-opps.json (combined, used by the app in production)
 *
 * The original accounts.json and opps.json remain untouched.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = resolve(__dirname, '../src/data/accounts.json');
const OPPS_PATH = resolve(__dirname, '../src/data/opps.json');
const OUTPUT_PATH = resolve(__dirname, '../src/data/accounts-with-opps.json');
const SCHOOL_MAP_PATH = resolve(__dirname, '../src/data/school-map.json');

const accountsRaw = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf-8'));
const opps = JSON.parse(readFileSync(OPPS_PATH, 'utf-8'));

// Deduplicate: remove records with identical name+state (keep the first occurrence)
const seen = new Set();
const beforeCount = accountsRaw.length;
const accounts = accountsRaw.filter(d => {
  const key = (d.name || '') + '|' + (d.state || '');
  if (seen.has(key)) {
    console.warn('[Prebuild] Removing duplicate:', d.name, '(' + (d.state || '') + ')');
    return false;
  }
  seen.add(key);
  return true;
});
if (accounts.length < beforeCount) {
  console.log(`[Prebuild] Removed ${beforeCount - accounts.length} duplicate record(s)`);
}

// Full normalizeDistrictName — synced from src/js/helpers.js
function normalizeDistrictName(name) {
  let normalized = name.toLowerCase().trim();

  // ── STEP 0: Normalize encoding artifacts ──
  // CSV imports sometimes corrupt Unicode dashes/quotes to '?'
  normalized = normalized.replace(/\?/g, '');  // Strip stray ?
  // Normalize Unicode dashes (en-dash, em-dash, etc.) to ASCII hyphen
  normalized = normalized.replace(/[\u2010-\u2015\u2212\u00AD]/g, '-');
  // Normalize smart quotes to ASCII
  normalized = normalized.replace(/[\u2018\u2019\u201C\u201D]/g, "'");

  // ── STEP 1: Strip leading articles ──
  normalized = normalized.replace(/^the\s+/i, '');

  // ── STEP 2: Strip PREFIX structural patterns ──
  const prefixPatterns = [
    /^(?:unified|metropolitan|consolidated|special|city|joint(?:\s+union)?)\s+school\s+district\s+of\s+/i,
    /^school\s+district\s+of\s+/i,
  ];
  for (const pattern of prefixPatterns) {
    const before = normalized;
    normalized = normalized.replace(pattern, '');
    if (normalized !== before) break;
  }

  // ── STEP 3: Strip SUFFIX structural patterns ──
  const suffixPatterns = [
    /\s+sau\s*#?\d+$/i,
    /\s+independent school district$/i,
    /\s+union free school district$/i,
    /\s+public school system$/i,
    /\s+public school district$/i,
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

  // ── STEP 4: Strip trailing comma + state abbreviation ──
  normalized = normalized.replace(/,\s*[a-z]{2}$/i, '');

  // ── STEP 4.5: Strip trailing district/unit numbers ──
  normalized = normalized.replace(/\s+\d+[a-z]?$/i, '');        // trailing "24j", "299", "48j"
  normalized = normalized.replace(/\s+#\d+$/i, '');              // trailing "#80", "#271"
  normalized = normalized.replace(/\s+no\.?\s*\d+$/i, '');       // trailing "no. 5", "no 1"
  normalized = normalized.replace(/\s+re[-\s]?\d+$/i, '');       // trailing "re-1", "re 1"
  normalized = normalized.replace(/\s*\(\d{4}\)$/i, '');         // trailing "(4237)", "(4403)"
  // Strip embedded state names — ", Oregon" at end (after suffix strip)
  normalized = normalized.replace(/,\s*[a-z]+\s*$/i, '');

  // ── STEP 5: Collapse whitespace ──
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // ── STEP 6: Normalize common abbreviations ──
  normalized = normalized.replace(/\bst\.\s*/g, 'saint ');
  normalized = normalized.replace(/\bdist\.?\b/g, 'district');
  normalized = normalized.replace(/\bcomm\b/g, 'community');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

// Build lookup by name|state
const acctByKey = new Map();
accounts.forEach(d => {
  const key = (d.name || '').toLowerCase().trim() + '|' + (d.state || '').toUpperCase().trim();
  acctByKey.set(key, d);
  const normKey = normalizeDistrictName(d.name) + '|' + (d.state || '').toUpperCase().trim();
  if (!acctByKey.has(normKey)) acctByKey.set(normKey, d);
});

// Join opps into accounts
let joined = 0;
const orphans = [];
opps.forEach(opp => {
  const key = (opp.account_name || '').toLowerCase().trim() + '|' + (opp.state || '').toUpperCase().trim();
  const normKey = normalizeDistrictName(opp.account_name) + '|' + (opp.state || '').toUpperCase().trim();
  const acct = acctByKey.get(key) || acctByKey.get(normKey);
  if (acct) {
    acct.opp_owner = opp.opp_owner || '';
    acct.opportunity_name = opp.opportunity_name || '';
    acct.intro_meeting_date = opp.intro_meeting_date || '';
    acct.created_date = opp.created_date || '';
    acct.last_modified = opp.last_modified || '';
    acct.age = opp.age || '';
    acct._hasUploadedOpp = opp._hasUploadedOpp || false;
    if (opp.metric_improvement_goal) acct.metric_improvement_goal = opp.metric_improvement_goal;
    if (opp.decision_criteria) acct.decision_criteria = opp.decision_criteria;
    if (opp.decision_process) acct.decision_process = opp.decision_process;
    if (opp.paper_process) acct.paper_process = opp.paper_process;
    if (opp.implication_of_pain) acct.implication_of_pain = opp.implication_of_pain;
    acct.opps = opp.opps || [];
    joined++;
  } else {
    orphans.push(opp.account_name);
  }
});

// Ensure all accounts have opps array
accounts.forEach(d => {
  if (!d.opps) d.opps = [];
});

// Extract _schools arrays into separate school-map.json to reduce main payload
const schoolMap = {};
let schoolEntries = 0;
accounts.forEach(d => {
  if (d._schools && d._schools.length > 0) {
    const key = (d.name || '') + '|' + (d.state || '');
    schoolMap[key] = d._schools;
    schoolEntries += d._schools.length;
    delete d._schools;
  }
});

// Strip empty-string and null/undefined fields to reduce JSON size
let strippedFields = 0;
accounts.forEach(d => {
  for (const key of Object.keys(d)) {
    if (d[key] === '' || d[key] === null || d[key] === undefined) {
      delete d[key];
      strippedFields++;
    }
  }
});

// Write combined output (without _schools, with empty fields stripped)
writeFileSync(OUTPUT_PATH, JSON.stringify(accounts));
// Write school map
writeFileSync(SCHOOL_MAP_PATH, JSON.stringify(schoolMap));

console.log(`[Prebuild] Joined ${joined} opp records into accounts`);
if (orphans.length > 0) {
  console.warn(`[Prebuild] ${orphans.length} orphaned opp records (no matching account)`);
}
console.log(`[Prebuild] Stripped ${strippedFields} empty fields from accounts`);
console.log(`[Prebuild] Extracted ${schoolEntries} school entries into ${SCHOOL_MAP_PATH} (${(readFileSync(SCHOOL_MAP_PATH).length / 1024).toFixed(0)} KB)`);
console.log(`[Prebuild] Wrote ${OUTPUT_PATH} (${(readFileSync(OUTPUT_PATH).length / 1024 / 1024).toFixed(1)} MB)`);
