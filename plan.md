# Implementation Plan: Owner Reassignment Special Names + Parent Account Hierarchy

All changes are in `/home/user/EdiaStratMap/src/js/app.js`.

---

## PART 1: Special Name Handling in resolveOwner

### 1A. Add constants after INACTIVE_OWNERS (after line 371)

```js
// Ben Foley: still with company, NOT an account holder.
// Accounts >30k students → hard override to Sean Johnson (no holdout).
// Accounts ≤30k or missing enrollment → treat as inactive (run normal holdout logic).
const BEN_FOLEY = 'Ben Foley';

// CTO and SFDC Admin — not account holders.
// Only reassign their accounts when the account has opp data in the uploaded CSV.
// If opp exists → treat as inactive (run holdout/territory logic).
// If no opp → leave ownership as-is (do not reassign).
const CONDITIONAL_REASSIGN = new Set([
  'Iain Proctor',     // CTO
  'Nicholas Watson',  // SFDC Admin
]);
```

Ben Foley, Iain Proctor, and Nicholas Watson are NOT added to `INACTIVE_OWNERS`.

### 1B. Modify `resolveOwner` signature and logic (lines 424–452)

Add an optional third parameter `ctx` with shape `{ enrollment, hasUploadedOpp }`.

New order of evaluation inside resolveOwner:

1. **Blank CSV** → keep existing if active, else unassigned (unchanged)
2. **Ben Foley check** → if `csv === BEN_FOLEY`:
   - Parse enrollment from `ctx.enrollment` using `parseEnrollment()`
   - If enrollment > 30,000 → return `'Sean Johnson'` (hard override, no holdout)
   - If enrollment ≤ 30,000 OR missing → treat as inactive (return existing if active, else `''`)
3. **CONDITIONAL_REASSIGN check** → if `CONDITIONAL_REASSIGN.has(csv)`:
   - If `ctx.hasUploadedOpp` is true → treat as inactive (return existing if active, else `''`)
   - If no uploaded opp → return `csv` (leave ownership as-is)
4. **INACTIVE_OWNERS check** → unchanged
5. **Active rep check** → unchanged
6. **Unrecognized name** → unchanged

### 1C. Update all 3 call sites of resolveOwner to pass context

**Existing record match** (~line 4330):
- `csvOppFields` is already populated by this point
- Pass `{ enrollment: merged.enrollment, hasUploadedOpp: Object.keys(csvOppFields).length > 0 }`
- Set `merged._hasUploadedOpp = true` if opp data exists (for alreadyMerged lookups)

**New record** (~line 4492):
- `newOppFields` is already populated
- Pass `{ enrollment: newRecord.enrollment, hasUploadedOpp: Object.keys(newOppFields).length > 0 }`
- Set `newRecord._hasUploadedOpp = true` if opp data exists

**AlreadyMerged (duplicate CSV row)** (~line 4233):
- Pre-scan the CSV row for opp fields before the forEach loop
- If opp fields found, set `alreadyMerged._hasUploadedOpp = true`
- Pass `{ enrollment: alreadyMerged.enrollment, hasUploadedOpp: alreadyMerged._hasUploadedOpp }`

---

## PART 2: Parent Account / District Hierarchy

### 2A. Enhance `consolidateParentAccounts` (~line 3900)

Currently, child rows (schools) are removed and only their names go into the `_schools` array on the parent. Opp data from child rows is lost.

**Change**: After attaching school names, also merge any opp data from child rows into the parent district row. This prevents opp uploads from creating duplicate district-level records when the opps are on school-level CSV rows.

Logic:
- For each child row that has opp fields, extract them
- Upsert each child's opp into the parent row's opps array
- This ensures school-level opps roll up to their parent district

### 2B. Enhance `crossLinkCustomers` (~line 205)

Add a school-to-district lookup so customer records for schools get a `parent_district` field.

Logic:
- After building the account name lookup, iterate `ACCOUNT_DATA`
- For each account with `_schools`, map each school name (normalized) → district name
- Then, for each customer record, check if its name matches a school name
- If so, set `c.parent_district = districtName`
- Also check during forward link: if account match found, check if customer name matches a school (not the district itself) and set `parent_district`

### 2C. Show parent district in `buildStratPopup` (~line 2205)

After the `<h3>` name line:
- If `d.parent_district` exists and differs from `d.name`, add:
  `<div class="popup-parent-district">District: ${d.parent_district}</div>`

### 2D. Show parent district in `buildCustPopup` (~line 2393)

After the `<h3>` name line:
- If `d.parent_district` exists, add:
  `<div class="popup-parent-district">District: ${d.parent_district}</div>`

### 2E. Preserve parent_account through merge operations

In `runMerge`, when merging CSV fields into existing records:
- The `parent_account` field is already mapped by `mapFieldName` (passes through as-is)
- Ensure it's preserved in the merged record (already happens since all CSV fields are copied)
- For the consolidation step: `parent_account` is deliberately removed from synthetic records (correct behavior — synthetic records ARE districts)
- For child rows processed through consolidation: their `parent_account` info is used for grouping, then the child is folded into the parent. This is correct and preserves the hierarchy.

### 2F. Minimal CSS for parent district display

Add a `.popup-parent-district` style rule in the popup HTML (inline style) for the district subtitle:
- Smaller font, muted color, positioned below the school name

---

## Order of Operations Summary

In `resolveOwner(csvAE, existingAE, ctx)`:
```
1. Blank CSV → keep existing if active
2. Ben Foley → check enrollment for hard override vs holdout
3. CONDITIONAL_REASSIGN (Iain/Nicholas) → check hasUploadedOpp
4. INACTIVE_OWNERS → keep existing if active
5. Active rep → assign (with conflict detection)
6. Unrecognized → keep existing if active
```

## What does NOT change

- `getTerritoryAE` / `getHoldoutAE` logic — unchanged
- `INACTIVE_OWNERS` set — Ben Foley, Iain Proctor, Nicholas Watson are NOT added
- Existing consolidation behavior — schools still roll up into districts for account data
- `_schools` array format — remains string array
- Marker placement — pins already drop at record lat/lng (school customers already have their own coordinates)
- Conflict detection logic — unchanged
