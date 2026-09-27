const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const frontend = fs.readFileSync(path.join(root, 'static', 'darts.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'main.py'), 'utf8');
const live = fs.readFileSync(path.join(root, 'darts_live.py'), 'utf8');

assert.match(frontend, /new EventSource\('\/api\/v1\/darts\/live\/stream'\)/);
assert.doesNotMatch(frontend, /live\.3k-darts\.com.*websocket/i);
assert.match(backend, /@app\.get\("\/api\/v1\/darts\/live\/stream"\)/);
assert.match(live, /destination:\/topic\/\{self\.database\}-\{self\.group_key\}/);
assert.match(live, /REST_FALLBACK_SECONDS = 7/);
console.log('Darts live frontend architecture checks passed.');
