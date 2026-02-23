# Diagnosis & Fix Plan: Account Owner Fallback Logic

## Root Cause Analysis

### Pattern 1: Managers treated as valid account holders

**The bug is NOT in the "unrecognized" path (step 6) — Samantha Santucci never reaches step 6.**

Samantha Santucci is the **manager** of ENT East (`ent-east.json` line 3). When `ALL_ACTIVE_REPS` is built (`app.js:380-384`), managers are included:

```js
if (info.manager) ALL_ACTIVE_REPS.add(info.manager);
```

So when `resolveOwner("Samantha Santucci", "", { oppOwner: "Victoria Macoul" })` runs:
- Step 5 (`app.js:512`): `ALL_ACTIVE_REPS.has("Samantha Santucci")` → **TRUE**
- She's treated as a valid active rep assignee
- The account gets `ae = "Samantha Santucci"`
- The `oppOwner` fallback to Victoria Macoul **never fires**

The account then appears under Samantha Santucci in the ENT East manager view, but is invisible when browsing by Victoria Macoul or any other rep. The pin exists but is filtered to the wrong person.

**This affects all managers**: Brad Halsey (ENT West), Christina Ceballos (SMB), and any future managers added to team configs. None of them hold accounts, but `resolveOwner` treats them as valid assignees.

### Pattern 2: Active reps with no data loaded yet

Ally McCready and Daniel Way are both in `ALL_ACTIVE_REPS` (reps in ENT East and SMB respectively). When Victoria's opp CSV has an account owned by Ally:

- Step 5 (`app.js:512`): `ALL_ACTIVE_REPS.has("Ally McCready")` → TRUE
- Account gets `ae = "Ally McCready"`
- Since Ally's data hasn't been uploaded, the account lands under Ally's index
- When browsing Victoria's view → account is invisible
- When browsing Ally's view → the account shows, but none of Ally's own data is there yet

This will happen for **every rep** whose data hasn't been uploaded yet. With incremental uploads, this is the common case.

### Pattern 3: The Opp Owner fallback itself

The `fallback()` function (`app.js:475-478`) is correct:
```js
const fallback = () => {
  if (oppOwner && ALL_ACTIVE_REPS.has(oppOwner)) return oppOwner;
  return (existing && ALL_ACTIVE_REPS.has(existing)) ? existing : '';
};
```

Step 6 (unrecognized path, `app.js:524`) correctly calls `fallback()`. The problem for Huber Heights is that Samantha Santucci **never reaches step 6** — she hits step 5 instead.

The Stafford County success case (John Tyrrell → Victoria Macoul) worked because John Tyrrell IS in `INACTIVE_OWNERS`, so he correctly hit step 4 → `fallback()` → Victoria.

## Proposed Fixes

### Fix 1: Distinguish managers from account-holding reps

Build a `MANAGERS` set from team config managers. In `resolveOwner`, add a check before step 5: if the CSV AE is a manager, treat them like an unrecognized name and fall through to Opp Owner.

**Location**: `app.js` after line 384 (after `ALL_ACTIVE_REPS` is built)

```js
const MANAGERS = new Set();
Object.values(TEAM_REP_DATA).forEach(info => {
  if (info.manager) MANAGERS.add(info.manager);
});
```

New step in `resolveOwner` between steps 4 and 5:
```js
// 4b. CSV AE is a manager (not an account holder) → fallback
if (MANAGERS.has(csv)) {
  return fallback();
}
```

Auto-adapts when managers change in team config. No hardcoded name list.

### Fix 2: Active reps with no loaded data fall through to Opp Owner

Build a `loadedReps` set at the start of `runMerge` by scanning which reps actually have accounts in the existing dataset. Pass it through `ctx` to `resolveOwner`.

**In `runMerge`** (after building existingByName):
```js
const loadedReps = new Set();
existingData.forEach(item => {
  if (item.ae) loadedReps.add(item.ae);
});
```

**In `resolveOwner`** step 5 — before accepting the CSV rep:
```js
if (ALL_ACTIVE_REPS.has(csv)) {
  // Active rep with no data loaded yet → fall through to Opp Owner
  if (ctx && ctx.loadedReps && !ctx.loadedReps.has(csv)) {
    return fallback();
  }
  // existing conflict logic unchanged...
}
```

When that rep's data is eventually uploaded, the holdout/conflict logic will naturally reconcile.

### Fix 3: Track resolution reasons in merge stats

Add a `resolutions` array to the merge stats object that records every owner resolution with the reason:
- `"inactive_owner"` — Account Owner in INACTIVE_OWNERS
- `"manager_fallback"` — Account Owner is a manager
- `"no_data_loaded"` — Account Owner is active rep with no data in system
- `"unrecognized"` — Account Owner not in any known list
- `"ben_foley"` — Ben Foley special case
- `"conditional_reassign"` — Iain/Nicholas special case
- `"direct_assign"` — Account Owner is active rep with data, assigned normally
- `"conflict_kept_existing"` — Active rep conflict, kept existing owner

### Fix 4: Post-upload summary modal

Replace the `alert(buildMergeMessage(...))` in `confirmMerge` with a styled summary modal showing:
- Total accounts processed / new / updated
- Per-account resolution details (AE assigned, method used)
- Opp Owner fallback usage (with reason per account)
- Geocoding failures (with address attempted)
- Records missing coordinates (hidden from map)

## Implementation Steps

1. Add `MANAGERS` set after `ALL_ACTIVE_REPS` construction (~line 384)
2. Add manager check in `resolveOwner` between steps 4 and 5
3. Build `loadedReps` set at start of `runMerge`
4. Pass `loadedReps` through `ctx` to all `resolveOwner` call sites
5. Add no-data-loaded check in `resolveOwner` step 5
6. Add `resolutions` tracking to merge stats in all three merge paths (existing match, new record, already-merged)
7. Build summary modal HTML/CSS
8. Replace `alert()` calls with summary modal in `confirmMerge`
9. Add console logging for manager and no-data-loaded fallback paths
