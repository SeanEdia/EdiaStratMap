import S from './state.js';
import { toggleDataRefreshPanel, closeAccountModal } from './account-modal.js';
import { openSfdcModal } from './data-merge.js';

// ============ THEME TOGGLE ============
export function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  html.setAttribute('data-theme', next);
  localStorage.setItem('edia_theme', next);
}

// Restore saved theme on load (default dark)
(function() {
  const saved = localStorage.getItem('edia_theme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();


// ============ DATA REFRESH PASSWORD PROTECTION ============
const DATA_REFRESH_PASSWORD = 'edia2025';
S.dataRefreshAuthed = false;

export function promptDataRefreshPassword() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'pw-modal-backdrop';
    backdrop.innerHTML = `
      <div class="pw-modal">
        <h3>Data Refresh</h3>
        <p>Enter the password to access data refresh.</p>
        <input type="password" id="pwInput" placeholder="Password" autocomplete="off">
        <div class="pw-modal-btns">
          <button onclick="this.closest('.pw-modal-backdrop').remove()">Cancel</button>
          <button class="pw-confirm" id="pwConfirmBtn">Unlock</button>
        </div>
        <div class="pw-error" id="pwError">Incorrect password</div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const input = backdrop.querySelector('#pwInput');
    const confirmBtn = backdrop.querySelector('#pwConfirmBtn');
    const errorEl = backdrop.querySelector('#pwError');

    function tryPassword() {
      if (input.value === DATA_REFRESH_PASSWORD) {
        S.dataRefreshAuthed = true;
        backdrop.remove();
        resolve(true);
      } else {
        errorEl.style.display = 'block';
        input.value = '';
        input.focus();
      }
    }

    confirmBtn.addEventListener('click', tryPassword);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryPassword();
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { backdrop.remove(); resolve(false); }
    });

    input.focus();
  });
}

// Reference the imported function
const _originalToggleDataRefreshPanel = toggleDataRefreshPanel;
export function protectedToggleDataRefreshPanel() {
  if (S.dataRefreshAuthed) {
    _originalToggleDataRefreshPanel();
    return;
  }
  promptDataRefreshPassword().then(ok => {
    if (ok) _originalToggleDataRefreshPanel();
  });
}

export function protectedOpenSfdcModal() {
  function openWithCleanup() {
    // Close any open popup card or account modal
    if (S.map) S.map.closePopup();
    closeAccountModal();
    openSfdcModal();
  }

  if (S.dataRefreshAuthed) {
    openWithCleanup();
    return;
  }
  promptDataRefreshPassword().then(ok => {
    if (ok) openWithCleanup();
  });
}

