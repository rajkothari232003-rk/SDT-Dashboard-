// Loads the data layer first (which installs the google.script.run shim),
// then the original app logic — preserving the exact Apps Script behavior.
import './api.js';
const s = document.createElement('script');
s.src = 'js/app.js';
document.body.appendChild(s);
