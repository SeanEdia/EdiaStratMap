const fs = require('fs');
const path = require('path');

const ACCOUNTS_PATH = path.join(__dirname, '..', 'src', 'data', 'accounts.json');

const PAIRS = [
  { keep: 'Oakland Unified School District', remove: 'Oakland Unified', state: 'CA' },
  { keep: 'Clovis Unified School District', remove: 'Clovis Unified', state: 'CA' },
  { keep: 'Cobb County School District', remove: 'Cobb County', state: 'GA' },
  { keep: 'Poway Unified School District', remove: 'Poway Unified', state: 'CA' },
  { keep: 'DeKalb County School District', remove: 'Dekalb County', state: 'GA' },
  { keep: 'Fremont Unified School District', remove: 'Fremont Unified', state: 'CA' },
  { keep: 'Irvine Unified School District', remove: 'Irvine Unified', state: 'CA' },
  { keep: 'Alvord Unified School District', remove: 'Alvord Unified', state: 'CA' },
  { keep: 'School District of Philadelphia', remove: 'Philadelphia City School District', state: 'PA' },
];

function isEmpty(val) {
  return val === undefined || val === null || val === '' || val === 0 ||
         (Array.isArray(val) && val.length === 0);
}

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
console.log('Loaded', accounts.length, 'accounts');

const indicesToRemove = new Set();
let totalFieldsCopied = 0;

for (const pair of PAIRS) {
  const keepRec = accounts.find(a => a.name === pair.keep && a.state === pair.state);
  const removeRec = accounts.find(a => a.name === pair.remove && a.state === pair.state);
  if (!keepRec) { console.error('MISSING KEEP:', pair.keep, pair.state); continue; }
  if (!removeRec) { console.error('MISSING REMOVE:', pair.remove, pair.state); continue; }

  const removeIdx = accounts.indexOf(removeRec);
  console.log('\n--- Merging:', pair.remove, '→', pair.keep, '(' + pair.state + ') ---');

  let copied = 0;
  for (const [key, val] of Object.entries(removeRec)) {
    if (key === 'name') continue;
    if (isEmpty(val)) continue;
    const keepVal = keepRec[key];
    if (isEmpty(keepVal)) {
      keepRec[key] = val;
      console.log('  COPIED:', key, '=', JSON.stringify(val).substring(0, 60));
      copied++;
    } else if (JSON.stringify(keepVal) !== JSON.stringify(val)) {
      if (key === 'enrollment') {
        const keepNum = parseInt(keepVal) || 0;
        const removeNum = parseInt(val) || 0;
        if (removeNum > keepNum) {
          keepRec[key] = val;
          console.log('  ENROLLMENT UPDATED:', keepNum, '→', removeNum);
          copied++;
        } else {
          console.log('  ENROLLMENT KEPT:', keepNum, '(duplicate had', removeNum + ')');
        }
      } else if (key === 'is_customer' && val === true) {
        keepRec[key] = true;
        console.log('  COPIED: is_customer = true');
        copied++;
      } else {
        console.log('  CONFLICT (kept baseline):', key);
      }
    }
  }
  indicesToRemove.add(removeIdx);
  totalFieldsCopied += copied;
  console.log('  Fields copied:', copied, '| Removing index', removeIdx);
}

const sortedIndices = [...indicesToRemove].sort((a, b) => b - a);
for (const idx of sortedIndices) { accounts.splice(idx, 1); }

fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 4) + '\n');
console.log('\n=== SUMMARY ===');
console.log('Records before:', accounts.length + indicesToRemove.size);
console.log('Records after:', accounts.length);
console.log('Duplicates removed:', indicesToRemove.size);
console.log('Fields copied:', totalFieldsCopied);
