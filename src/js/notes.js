import S from './state.js';
import { districtKey, escapeHtml } from './helpers.js';

// ============ NOTES SYSTEM ============
export function getUserName() {
  let name = localStorage.getItem('edia_user_name');
  if (!name) {
    name = prompt('Enter your name (this tags your notes so teammates know who wrote them):');
    if (name && name.trim()) {
      name = name.trim();
      localStorage.setItem('edia_user_name', name);
    } else {
      name = 'Anonymous';
    }
  }
  return name;
}

export function getAccountNotes(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); }
  catch(e) { return []; }
}

export function addNote(key, el) {
  const text = el.value.trim();
  if (!text) return;
  const author = getUserName();
  const notes = getAccountNotes(key);
  notes.push({ author, text, ts: new Date().toISOString() });
  localStorage.setItem(key, JSON.stringify(notes));
  el.value = '';
  updateNoteCount();
  // Refresh the popup to show the new note
  const popup = el.closest('.leaflet-popup-content');
  if (popup) {
    const thread = popup.querySelector('.notes-thread');
    const label = popup.querySelector('.popup-section-label');
    if (thread) {
      thread.innerHTML += `<div class="note-entry"><div class="note-meta"><span class="note-author">${escapeHtml(author)}</span><span class="note-time">just now</span></div><div class="note-text">${escapeHtml(text)}</div></div>`;
    } else {
      // First note - insert thread before add-wrap
      const addWrap = popup.querySelector('.note-add-wrap');
      const threadDiv = document.createElement('div');
      threadDiv.className = 'notes-thread';
      threadDiv.innerHTML = `<div class="note-entry"><div class="note-meta"><span class="note-author">${escapeHtml(author)}</span><span class="note-time">just now</span></div><div class="note-text">${escapeHtml(text)}</div></div>`;
      addWrap.parentNode.insertBefore(threadDiv, addWrap);
    }
    // Update count in header
    if (label) label.innerHTML = label.innerHTML.replace(/Notes \(\d+\)/, 'Notes (' + notes.length + ')');
  }

  // Update last activity date to today (resets staleness clock)
  const districtName = key.replace('edia_notes_', '').replace(/_/g, ' ');
  const matchedAccount = S.ACCOUNT_DATA.find(d => d.name.replace(/[^a-zA-Z0-9]/g, '_') === key.replace('edia_notes_', ''));
  if (matchedAccount) {
    const today = new Date();
    const dateStr = (today.getMonth() + 1) + '/' + today.getDate() + '/' + today.getFullYear();
    matchedAccount.opp_last_activity = dateStr;
  }

  // Update note index cache so marker class updates without full localStorage scan
  S._accountsWithNotes.add(key);
}

export function handleNoteKey(e, key, el) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    addNote(key, el);
  }
}

export function formatNoteTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff/86400000) + 'd ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function copyAccountNotes(key, accountName) {
  const notes = getAccountNotes(key);
  if (!notes.length) return;
  const formatted = notes.map(n => `[${n.author} · ${new Date(n.ts).toLocaleDateString('en-US', {month:'short',day:'numeric'})}] ${n.text}`).join('\n');
  const text = accountName + '\n' + formatted;
  navigator.clipboard.writeText(text);
}

export function updateNoteCount() {
  let count = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('edia_notes_')) {
      try {
        const notes = JSON.parse(localStorage.getItem(key));
        if (notes.length) count++;
      } catch(e) { /* ignored */ }
    }
  }
  const el = document.getElementById('notesCount');
  if (el) el.textContent = count ? count + ' account' + (count > 1 ? 's' : '') + ' with notes' : 'No notes yet';
}

export function exportNotes() {
  const data = { _user: localStorage.getItem('edia_user_name') || 'Unknown' };
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('edia_notes_') || key === 'edia_user_name') {
      data[key] = localStorage.getItem(key);
    }
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'edia_notes_' + (data._user || 'export') + '_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
}

export function importNotes(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const imported = JSON.parse(e.target.result);
      let merged = 0;
      Object.entries(imported).forEach(([key, val]) => {
        if (!key.startsWith('edia_notes_')) return;
        try {
          const incoming = JSON.parse(val);
          const existing = getAccountNotes(key);
          // Merge: add incoming notes that don't already exist (by ts+author)
          const existingKeys = new Set(existing.map(n => n.ts + n.author));
          incoming.forEach(n => {
            if (!existingKeys.has(n.ts + n.author)) { existing.push(n); merged++; }
          });
          existing.sort((a, b) => new Date(a.ts) - new Date(b.ts));
          localStorage.setItem(key, JSON.stringify(existing));
        } catch(e2) { /* ignored */ }
      });
      updateNoteCount();
      S._rebuildNoteIndex();
      S._applyFilters();
      alert('Merged ' + merged + ' new note' + (merged !== 1 ? 's' : '') + '.');
    } catch(err) { alert('Invalid file format.'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

export function copyAllNotes() {
  let lines = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key.startsWith('edia_notes_')) continue;
    try {
      const notes = JSON.parse(localStorage.getItem(key));
      if (!notes.length) continue;
      const name = key.replace('edia_notes_', '').replace(/_/g, ' ');
      lines.push(name.toUpperCase());
      notes.forEach(n => {
        lines.push(`  [${n.author} · ${new Date(n.ts).toLocaleDateString('en-US', {month:'short',day:'numeric'})}] ${n.text}`);
      });
      lines.push('');
    } catch(e) { /* ignored */ }
  }
  if (lines.length) {
    navigator.clipboard.writeText(lines.join('\n'));
    alert('Copied all notes to clipboard.');
  } else {
    alert('No notes to copy.');
  }
}


export function copyText(text, el) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = el.innerHTML;
    el.classList.add('copied');
    el.setAttribute('data-tooltip', 'Copied!');
    setTimeout(() => { el.classList.remove('copied'); el.setAttribute('data-tooltip', 'Click to copy'); }, 1200);
  });
}
