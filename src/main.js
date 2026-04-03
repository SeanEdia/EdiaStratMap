// Main entry point — imports styles and initializes the application
import './styles/main.css';
import { initMap } from './js/app.js';

document.addEventListener('DOMContentLoaded', initMap);

// Register service worker for offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW registration failed — not critical, app works without it
    });
  });
}
