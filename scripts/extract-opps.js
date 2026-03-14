#!/usr/bin/env node
/**
 * One-time extraction script: splits opp data out of accounts.json into opps.json.
 *
 * Usage:
 *   node scripts/extract-opps.js
 *
 * Reads:  src/data/accounts.json
 * Writes: src/data/opps.json       (new — opp-only records)
 *         src/data/accounts.json    (cleaned — opp fields removed)
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = resolve(__dirname, '../src/data/accounts.json');

const accounts = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf-8'));

// Fields that move to opps.json (per-account opp wrapper level)
const OPP_WRAPPER_FIELDS = new Set([
  'opp_owner', 'opportunity_name', 'intro_meeting_date',
  'created_date', 'last_modified', 'age',
  '_hasUploadedOpp',
  'metric_improvement_goal', 'metric_-_improvement_goal',
  'decision_criteria', 'decision_process', 'paper_process', 'implication_of_pain',
]);

// Flat opp summary fields (derived at runtime — also strip from accounts.json)
const OPP_SUMMARY_FIELDS = new Set([
  'opp_count', 'opp_stage', 'opp_forecast', 'opp_areas', 'opp_acv',
  'opp_probability', 'opp_next_step', 'opp_contact', 'opp_contact_title',
  'opp_sdr', 'opp_champion', 'opp_economic_buyer', 'opp_competition',
  'opp_last_activity',
]);

const opps = [];

for (const acct of accounts) {
  const hasOppsArray = acct.opps && acct.opps.length > 0;
  const hasOppWrapper = acct.opp_owner || acct.opportunity_name || acct._hasUploadedOpp;

  if (!hasOppsArray && !hasOppWrapper) continue;

  // Build the opp record
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

  // MEDDPICC fields — handle both key variants
  const metricGoal = acct.metric_improvement_goal || acct['metric_-_improvement_goal'] || '';
  if (metricGoal) oppRecord.metric_improvement_goal = metricGoal;
  if (acct.decision_criteria) oppRecord.decision_criteria = acct.decision_criteria;
  if (acct.decision_process) oppRecord.decision_process = acct.decision_process;
  if (acct.paper_process) oppRecord.paper_process = acct.paper_process;
  if (acct.implication_of_pain) oppRecord.implication_of_pain = acct.implication_of_pain;

  opps.push(oppRecord);
}

// Strip opp fields from accounts
for (const acct of accounts) {
  // Remove opp wrapper fields
  for (const field of OPP_WRAPPER_FIELDS) {
    delete acct[field];
  }
  // Remove flat opp summary fields
  for (const field of OPP_SUMMARY_FIELDS) {
    delete acct[field];
  }
  // Remove the opps array
  delete acct.opps;
}

// Write outputs
writeFileSync(resolve(__dirname, '../src/data/opps.json'), JSON.stringify(opps, null, 2) + '\n');
writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2) + '\n');

console.log(`Extracted ${opps.length} opp records to src/data/opps.json`);
console.log(`Cleaned ${accounts.length} account records in src/data/accounts.json`);
