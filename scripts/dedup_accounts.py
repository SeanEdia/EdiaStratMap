#!/usr/bin/env python3
"""
Deduplicate accounts.json — merge enriched duplicates into baseline records.

Enriched records (no SFDC account_id, have leadership data) are matched to
baseline records (have account_id) using tiered name matching, then merged.
Remaining unmatched enriched records are removed as orphans.
"""

import json
import re
import os
import sys

DATA_PATH = os.path.join(os.path.dirname(__file__), '..', 'src', 'data', 'accounts.json')
REVIEW_PATH = os.path.join(os.path.dirname(__file__), 'dedup_review.txt')

LEADERSHIP_FIELDS = [
    'superintendent', 'asst_supt_ci', 'asst_supt_ss', 'asst_supt_tech',
    'dir_ci', 'dir_attendance',
]

# Fields to ALWAYS keep from baseline (never overwrite)
BASELINE_KEEP_FIELDS = {
    'name', 'account_id', 'parent_account_id', 'lat', 'lng',
    'address', 'city', '_schools',
    'active_arr_total', 'active_arr_total_12_months_ago', 'lapsed_renewal_amount',
}

# ── Manual mappings for hard cases (enriched_name, state) → baseline_name_substring ──
MANUAL_MAPPINGS = {
    ("Shelby County", "TN"): "Memphis-Shelby County Schools",
    ("Davidson County", "TN"): "Metro Nashville Public Schools",
    ("Montgomery County", "TN"): "Clarksville-Montgomery County School System",
    ("City Of Chicago School District 299", "IL"): "Chicago Public Schools",
    ("Va Beach City Public Schools", "VA"): "Virginia Beach City Public Schools",
    ("Cleveland Municipal", "OH"): "Cleveland Metropolitan School District",
    ("Epic One On One Charter School", "OK"): "Epic Charter District",
    ("Sd U-46", "IL"): "School District U-46",
    ("Winston Salem / Forsyth County Schools", "NC"): "Winston-Salem/Forsyth County Schools",
    ("State-Sponsored Charter Schools", "NV"): "State Sponsored Charter Schools",
    ("Salem-Keizer School District 24J", "OR"): "Salem-Keizer Public Schools, Oregon School District 24J",
}

# ── US state names for stripping ──
STATE_NAMES = [
    'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
    'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
    'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
    'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
    'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
    'new hampshire', 'new jersey', 'new mexico', 'new york',
    'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
    'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
    'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
    'west virginia', 'wisconsin', 'wyoming',
]

STATE_ABBREVS = [
    'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga',
    'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md',
    'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
    'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc',
    'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy',
]


def aggressive_normalize(name):
    """Aggressively normalize a district name for matching."""
    n = name.lower().strip()

    # Strip leading "the"
    n = re.sub(r'^the\s+', '', n)

    # Replace ? with empty string
    n = n.replace('?', '')

    # Normalize unicode dashes to hyphen
    n = re.sub(r'[\u2010-\u2015\u2212\u00AD]', '-', n)

    # Strip parenthetical content
    n = re.sub(r'\s*\([^)]*\)', '', n)

    # Strip trailing comma + state abbreviation
    n = re.sub(r',\s*[a-z]{2}$', '', n)

    # Strip embedded state names (e.g. ", Oregon" or "and State of CO")
    n = re.sub(r',\s*(?:' + '|'.join(STATE_NAMES) + r')\b', '', n)
    n = re.sub(r'\band\s+state\s+of\s+[a-z]+', '', n)
    n = re.sub(r'\bin\s+the\s+count(?:y|ies)\s+of\s+[a-z\s]+', '', n)

    # Normalize abbreviations early so suffix stripping catches expanded forms
    n = re.sub(r'\bst\.\s*', 'saint ', n)
    n = re.sub(r'\bdist\.?\b', 'district', n)
    n = re.sub(r'\bcomm\b', 'community', n)
    n = re.sub(r'\bva\b', 'virginia', n)

    # Strip trailing district/unit numbers BEFORE suffix stripping
    # (so "school district 24j" → "school district" → then suffix strip catches it)
    def _strip_trailing_numbers(s):
        s = re.sub(r'\s+\d+[a-z]?$', '', s, flags=re.IGNORECASE)   # "24j", "299"
        s = re.sub(r'\s+#\d+$', '', s, flags=re.IGNORECASE)         # "#80"
        s = re.sub(r'\s+no\.?\s*\d+$', '', s, flags=re.IGNORECASE)  # "no. 5"
        s = re.sub(r'\s+re[-\s]?\d+$', '', s, flags=re.IGNORECASE)  # "re-1"
        s = re.sub(r'\s*\(\d{4}\)$', '', s, flags=re.IGNORECASE)    # "(4237)"
        s = re.sub(r'\s+u-\d+$', '', s, flags=re.IGNORECASE)        # "u-46"
        return s

    n = _strip_trailing_numbers(n)

    # Strip suffix patterns (order: more specific first)
    suffix_patterns = [
        r'\s+independent school district$',
        r'\s+union free school district$',
        r'\s+public school system$',
        r'\s+public school district$',
        r'\s+county public schools$',
        r'\s+county schools$',
        r'\s+county district schools$',
        r'\s+public schools$',
        r'\s+city schools$',
        r'\s+area schools$',
        r'\s+school district$',
        r'\s+schools district$',
        r'\s+school system$',
        r'\s+parish school system$',
        r'\s+parish school board$',
        r'\s+schools$',
        r'\s+district$',
        r'\s+cusd$',
        r'\s+cisd$',
        r'\s+uhsd$',
        r'\s+juhsd$',
        r'\s+jusd$',
        r'\s+ufsd$',
        r'\s+unified$',
        r'\s+isd$',
        r'\s+usd$',
        r'\s+csd$',
        r'\s+sd$',
        r'\s+ps$',
        r'\s+metropolitan$',
        r'\s+municipal$',
        r'\s+consolidated$',
        r'\s+charter$',
    ]
    # Apply suffix patterns in a loop — restart from top after each match
    # so more-specific patterns (e.g. "public schools") get priority over
    # less-specific ones (e.g. "schools") after prior patterns fire.
    changed = True
    while changed:
        changed = False
        for pat in suffix_patterns:
            new_n = re.sub(pat, '', n, flags=re.IGNORECASE)
            if new_n != n:
                n = new_n
                changed = True
                break  # restart from most-specific pattern

    # Strip prefix patterns
    prefix_patterns = [
        r'^(?:unified|metropolitan|consolidated|special|city|joint(?:\s+union)?)\s+school\s+district\s+of\s+',
        r'^school\s+district\s+of\s+',
        r'^school\s+district\s+no\.\s*',
        r'^sd\s+',
    ]
    for pat in prefix_patterns:
        n = re.sub(pat, '', n, flags=re.IGNORECASE)

    # Strip trailing ", Oregon" style state references
    n = re.sub(r',\s*[a-z]+\s*$', '', n, flags=re.IGNORECASE)

    # Strip trailing numbers again (in case suffix/state stripping revealed new ones)
    n = _strip_trailing_numbers(n)

    # Strip any remaining suffix after number stripping (loop until stable)
    changed = True
    while changed:
        changed = False
        for pat in suffix_patterns:
            new_n = re.sub(pat, '', n, flags=re.IGNORECASE)
            if new_n != n:
                n = new_n
                changed = True

    # Strip "district" one more time
    n = re.sub(r'\s+district$', '', n)

    # Collapse whitespace
    n = re.sub(r'\s+', ' ', n).strip()

    # Normalize slashes and hyphens to spaces for consistent matching
    n = re.sub(r'\s*/\s*', ' ', n)
    n = n.replace('-', ' ')

    # Final whitespace collapse
    n = re.sub(r'\s+', ' ', n).strip()

    return n


def encoding_normalize(name):
    """Strip all non-alphanumeric characters except spaces, lowercase."""
    return re.sub(r'[^a-z0-9 ]', '', name.lower()).strip()


def enrollment_within(a, b, pct=0.20):
    """Check if enrollments are within pct of each other."""
    ea = a.get('enrollment', 0) or 0
    eb = b.get('enrollment', 0) or 0
    if ea == 0 or eb == 0:
        return True  # Can't compare, don't reject
    avg = (ea + eb) / 2
    return abs(ea - eb) / avg <= pct


def merge_records(baseline, enriched):
    """Merge enriched data onto baseline record. Returns list of fields copied."""
    fields_copied = []
    for key, value in enriched.items():
        if key in BASELINE_KEEP_FIELDS:
            continue
        if key.startswith('_'):
            continue  # computed fields like _nameLc
        # Only copy if baseline field is empty/missing
        baseline_val = baseline.get(key)
        if not baseline_val and value:
            baseline[key] = value
            fields_copied.append(key)
    # Special: update enrollment only if baseline is 0 or missing
    if (not baseline.get('enrollment') or baseline['enrollment'] == 0) and enriched.get('enrollment'):
        baseline['enrollment'] = enriched['enrollment']
        if 'enrollment' not in fields_copied:
            fields_copied.append('enrollment')
    return fields_copied


def fix_encoding(name):
    """Fix ? encoding artifacts in a name."""
    RSQUOTE = '\u2019'  # '
    ENDASH = '\u2013'   # –
    EMDASH = '\u2014'   # —

    fixed = name
    changes = 0

    # Contraction prefix (O', D', L') + ? + capital → smart apostrophe (O'Fallon, D'Alene)
    def _apostrophe(m):
        return m.group(1) + RSQUOTE + m.group(2)
    new = re.sub(r"\b([ODLodl])\?([A-Z])", _apostrophe, fixed)
    if new != fixed:
        changes += 1
        fixed = new

    # " ? " with spaces on both sides → em-dash " — "
    new = fixed.replace(' ? ', f' {EMDASH} ')
    if new != fixed:
        changes += 1
        fixed = new

    # Word?Word (no spaces) → en-dash (compound district names)
    def _endash(m):
        return m.group(1) + ENDASH + m.group(2)
    new = re.sub(r'(\w)\?(\w)', _endash, fixed)
    if new != fixed:
        changes += 1
        fixed = new

    # Remaining ? → en-dash
    new = fixed.replace('?', ENDASH)
    if new != fixed:
        changes += 1
        fixed = new

    return fixed, changes > 0


def main():
    # Load data
    with open(DATA_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)

    total_before = len(data)
    log = []

    # Index records
    has_id = [d for d in data if d.get('account_id')]
    no_id_with_leadership = [d for d in data if not d.get('account_id') and
                              any(d.get(f) for f in LEADERSHIP_FIELDS)]

    # Build lookup for baseline records by state
    baseline_by_state = {}
    for d in has_id:
        state = d.get('state', '')
        baseline_by_state.setdefault(state, []).append(d)

    merged_indices = set()  # indices of enriched records that got merged
    merge_stats = {'encoding': 0, 'name_variant': 0, 'prefix': 0, 'manual': 0}

    for enriched in no_id_with_leadership:
        e_state = enriched.get('state', '')
        e_name = enriched.get('name', '')
        candidates = baseline_by_state.get(e_state, [])
        if not candidates:
            continue

        matched = None
        tier = None

        # ── TIER D: Manual mapping (check first since these are definitive) ──
        manual_key = (e_name, e_state)
        if manual_key in MANUAL_MAPPINGS:
            target_name = MANUAL_MAPPINGS[manual_key]
            for c in candidates:
                if c['name'] == target_name:
                    matched = c
                    tier = 'D-manual'
                    break

        # ── TIER A: Encoding normalization match ──
        if not matched:
            e_enc = encoding_normalize(e_name)
            for c in candidates:
                c_enc = encoding_normalize(c['name'])
                if e_enc == c_enc:
                    matched = c
                    tier = 'A-encoding'
                    break

        # ── TIER B: Aggressive normalized name match ──
        if not matched:
            e_norm = aggressive_normalize(e_name)
            best_match = None
            for c in candidates:
                c_norm = aggressive_normalize(c['name'])
                if e_norm == c_norm:
                    if best_match is None or enrollment_within(enriched, c):
                        best_match = c
            if best_match:
                matched = best_match
                tier = 'B-name-variant'

        # ── TIER C: Prefix match + enrollment proximity ──
        if not matched:
            e_norm = aggressive_normalize(e_name)
            e_words = e_norm.split()
            for c in candidates:
                c_norm = aggressive_normalize(c['name'])
                # Check if one is a prefix of the other at word boundary
                if (c_norm.startswith(e_norm) or e_norm.startswith(c_norm)):
                    if enrollment_within(enriched, c, 0.20):
                        matched = c
                        tier = 'C-prefix'
                        break

        if matched:
            fields_copied = merge_records(matched, enriched)
            merged_indices.add(id(enriched))
            tier_category = tier.split('-')[0]
            if tier_category == 'A':
                merge_stats['encoding'] += 1
            elif tier_category == 'B':
                merge_stats['name_variant'] += 1
            elif tier_category == 'C':
                merge_stats['prefix'] += 1
            elif tier_category == 'D':
                merge_stats['manual'] += 1
            msg = f"MERGED: '{e_name}' → '{matched['name']}' ({e_state}, tier={tier}, fields={', '.join(fields_copied)})"
            log.append(msg)
            print(msg)

    # Remove merged enriched records from data
    data = [d for d in data if id(d) not in merged_indices]

    # ── Remove orphaned enriched records (leadership data but no account_id) ──
    orphan_count = 0
    new_data = []
    for d in data:
        if not d.get('account_id') and any(d.get(f) for f in LEADERSHIP_FIELDS):
            fields_present = [f for f in LEADERSHIP_FIELDS if d.get(f)]
            msg = f"REMOVED ORPHAN: '{d['name']}' ({d.get('state', '??')}, fields lost: {', '.join(fields_present)})"
            log.append(msg)
            print(msg)
            orphan_count += 1
        else:
            new_data.append(d)
    data = new_data

    # ── Fix encoding artifacts in remaining records ──
    encoding_fixes = 0
    for d in data:
        name = d.get('name', '')
        if '?' in name:
            fixed_name, changed = fix_encoding(name)
            if changed:
                msg = f"ENCODING FIX: '{name}' → '{fixed_name}' ({d.get('state', '??')})"
                log.append(msg)
                print(msg)
                d['name'] = fixed_name
                # Also update computed lowercase fields
                d['_nameLc'] = fixed_name.lower()
                encoding_fixes += 1

    total_after = len(data)

    # Write cleaned data
    with open(DATA_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    # Write review log
    with open(REVIEW_PATH, 'w', encoding='utf-8') as f:
        f.write("DEDUP ACCOUNTS REVIEW LOG\n")
        f.write("=" * 60 + "\n\n")
        f.write(f"Total records before: {total_before}\n")
        f.write(f"Total records after:  {total_after}\n")
        f.write(f"Records removed:      {total_before - total_after}\n\n")
        f.write(f"Encoding dupes merged:     {merge_stats['encoding']}\n")
        f.write(f"Name variant dupes merged: {merge_stats['name_variant']}\n")
        f.write(f"Prefix match dupes merged: {merge_stats['prefix']}\n")
        f.write(f"Manual mapping merges:     {merge_stats['manual']}\n")
        f.write(f"Orphaned records removed:  {orphan_count}\n")
        f.write(f"Encoding fixes applied:    {encoding_fixes}\n\n")
        f.write("-" * 60 + "\n")
        f.write("DETAILED LOG\n")
        f.write("-" * 60 + "\n\n")
        for entry in log:
            f.write(entry + "\n")

    # Print summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Total records before: {total_before}")
    print(f"Total records after:  {total_after}")
    print(f"Records removed:      {total_before - total_after}")
    print(f"  Encoding dupes merged:     {merge_stats['encoding']}")
    print(f"  Name variant dupes merged: {merge_stats['name_variant']}")
    print(f"  Prefix match dupes merged: {merge_stats['prefix']}")
    print(f"  Manual mapping merges:     {merge_stats['manual']}")
    print(f"  Orphaned records removed:  {orphan_count}")
    print(f"  Encoding fixes applied:    {encoding_fixes}")
    print(f"\nReview log written to: {REVIEW_PATH}")


if __name__ == '__main__':
    main()
