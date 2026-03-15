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

const accounts = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf-8'));
const opps = JSON.parse(readFileSync(OPPS_PATH, 'utf-8'));

// Replicate normalizeDistrictName from app.js (simplified for build)
function normalizeDistrictName(name) {
  let normalized = name.toLowerCase().trim();
  const suffixPatterns = [
    /\s+sau\s*#?\d+$/i,
    /\s+independent school district$/i,
    /\s+consolidated unified school district$/i,
    /\s+unified high school district$/i,
    /\s+joint union high school district$/i,
    /\s+joint unified school district$/i,
    /\s+union free school district$/i,
    /\s+central school district$/i,
    /\s+unified school district$/i,
    /\s+school district$/i,
    /\s+public schools$/i,
    /\s+county schools$/i,
    /\s+city schools$/i,
    /\s+parish schools$/i,
    /\s+schools$/i,
    /\s+district$/i,
    /\s+cusd$/i, /\s+uhsd$/i, /\s+juhsd$/i, /\s+jusd$/i, /\s+ufsd$/i,
    /\s+isd$/i, /\s+usd$/i, /\s+csd$/i,
  ];
  for (const pattern of suffixPatterns) {
    normalized = normalized.replace(pattern, '');
  }
  return normalized.trim();
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

// Write combined output
writeFileSync(OUTPUT_PATH, JSON.stringify(accounts));

console.log(`[Prebuild] Joined ${joined} opp records into accounts`);
if (orphans.length > 0) {
  console.warn(`[Prebuild] ${orphans.length} orphaned opp records (no matching account)`);
}
console.log(`[Prebuild] Wrote ${OUTPUT_PATH} (${(readFileSync(OUTPUT_PATH).length / 1024 / 1024).toFixed(1)} MB)`);
