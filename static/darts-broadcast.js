/* Match graphics are deliberately independent of the match page's rendering. */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'clubiq_darts_broadcast_seen_v1';
  const MAX_SEEN = 300;
  const MAX_AGE = 14 * 24 * 60 * 60 * 1000;
  const HIGHLIGHT_MS = 3000;
  const ROSTER_MS = 4000;
  const BARVER_TEAM = /^SV\s+Barver\s+Darts\s+[A-D]$/i;
  const TYPES = new Set(['180', 'high_finish', 'short_leg', 'leg', 'game', 'match']);
  const state = { enabled: true, tv: false, seen: new Map(), initialized: false, queue: [], active: null,
    highlightTimer: null, rosterTimer: null, roster: null, node: null, previousFocus: null };

  function text(value, limit = 120) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
  }
  function positive(value) {
    return (typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value)) && Number(value) > 0;
  }
  function teamCode(value) {
    const match = text(value).match(/^SV\s+Barver\s+Darts\s+([A-D])$/i);
    return match ? match[1].toUpperCase() : '';
  }
  function eventKey(event) {
    if (!event || !TYPES.has(event.type) || !positive(event.matchId)) return '';
    const type = event.type;
    const id = text(String(event.event_id || event.eventId || ''), 128);
    let detail = '';
    if (type === '180' || type === 'high_finish') {
      if (!text(event.player) || !positive(event.value)) return '';
      // The SSE and 3K report use different performance IDs. Their public
      // match/player/cumulative-count facts are the shared identity.
      detail = `${text(event.player).toLocaleLowerCase('de-DE')}|${event.count || 1}|${event.value}`;
    } else if (type === 'leg') {
      if (!positive(event.gameId) || !positive(event.legCount) || !['home', 'away', 'guest'].includes(event.winnerSide)) return '';
      detail = `${event.gameId}|${event.winnerSide}|${event.legCount}`;
    } else if (type === 'game') {
      if (!text(String(event.gameId || '')) && !id) return '';
      detail = `${event.gameId || id}|${event.homeLegs ?? ''}|${event.awayLegs ?? ''}`;
    } else if (type === 'short_leg') {
      if (!text(String(event.gameId || '')) || !positive(event.legCount) || !positive(event.darts)) return '';
      detail = `${event.gameId}|${event.legCount}|${event.darts}`;
    } else {
      if (!/^\d+\s*:\s*\d+$/.test(text(event.score))) return '';
      detail = event.score.replace(/\s/g, '');
    }
    return `${event.matchId}|${type}|${detail}`;
  }
  function authentic(event) {
    if (!event || !BARVER_TEAM.test(text(event.team)) || !eventKey(event)) return false;
    if (event.type === '180') return Number(event.value) === 180 && !!text(event.player);
    if (event.type === 'high_finish') return Number.isInteger(Number(event.value)) && Number(event.value) >= 100 && Number(event.value) <= 170 && !!text(event.player);
    if (event.type === 'leg') return event.barverWon === true || (['home', 'away', 'guest'].includes(event.winnerSide) && event.winnerSide === event.barverSide);
    if (event.type === 'game') return event.barverWon === true;
    if (event.type === 'short_leg') return event.barverWon === true && Number.isInteger(Number(event.darts)) && Number(event.darts) >= 1 && Number(event.darts) <= 18;
    return event.type === 'match';
  }
  function pruneSeen(now) {
    for (const [key, at] of state.seen) if (now - at > MAX_AGE) state.seen.delete(key);
    while (state.seen.size > MAX_SEEN) state.seen.delete(state.seen.keys().next().value);
  }
  function loadSeen() {
    if (state.initialized) return;
    state.initialized = true;
    try {
      const entries = JSON.parse(root.localStorage?.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(entries)) for (const pair of entries) {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && Number.isFinite(pair[1])) state.seen.set(pair[0], pair[1]);
      }
    } catch (_) { /* Storage is optional. */ }
    pruneSeen(Date.now());
  }
  function saveSeen() {
    try { root.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...state.seen])); } catch (_) { /* Private mode is supported. */ }
  }
  function safeImage(value) {
    const path = text(value, 240);
    return /^\/pics\/players\/[a-z0-9][a-z0-9._-]*\.(?:avif|jpe?g|png|webp)(?:\?v=\d+)?$/i.test(path)
      || /^\/api\/v1\/darts\/players\/\d{1,12}\/photo(?:\?v=\d+)?$/i.test(path) ? path : '';
  }
  function roleRank(role) {
    const value = text(role).toLocaleLowerCase('de-DE');
    return value.includes('stell') ? 1 : value.includes('kapit') ? 0 : 2;
  }
  function orderedPlayers(players) {
    return (Array.isArray(players) ? players : []).filter(player => player && text(player.name))
      .slice(0, 40).sort((a, b) => roleRank(a.role) - roleRank(b.role)
        || text(a.name).localeCompare(text(b.name), 'de', { sensitivity: 'base' }));
  }
  function graphic(event) {
    const player = text(event.player, 100);
    const team = text(event.team, 80);
    const score = text(event.score, 20);
    switch (event.type) {
      case '180': return { label: '180 GEWORFEN', headline: '180', detail: player, foot: team };
      case 'high_finish': return { label: 'HIGH FINISH', headline: String(event.value), detail: player, foot: team };
      case 'short_leg': return { label: 'SHORT LEG', headline: `${event.darts} DARTS`, detail: player, foot: team };
      case 'leg': return { label: 'LEG GEWONNEN', headline: player || 'BARVER', detail: text(event.text, 140), foot: team };
      case 'game': return { label: 'SPIEL GEWONNEN', headline: player || 'BARVER', detail: text(event.text, 140), foot: team };
      default: return { label: 'ENDSTAND', headline: score, detail: text(event.text, 140), foot: team };
    }
  }
  function element(tag, className, content) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function mount() {
    if (!root.document?.body) return null;
    if (!state.node) {
      state.node = element('div', 'darts-broadcast');
      state.node.setAttribute('aria-live', 'polite');
      state.node.setAttribute('aria-atomic', 'true');
      root.document.body.append(state.node);
      root.document.addEventListener('keydown', keydown);
    }
    state.node.classList.toggle('is-tv', state.tv);
    return state.node;
  }
  function clearHighlight() {
    if (state.highlightTimer) root.clearTimeout(state.highlightTimer);
    state.highlightTimer = null;
    state.active = null;
    if (state.node && !state.roster) state.node.replaceChildren();
  }
  function nextHighlight() {
    if (state.roster || state.active || !state.enabled || !state.queue.length) return;
    const event = state.queue.shift(), view = graphic(event), host = mount();
    if (!host) return;
    const card = element('section', `darts-broadcast-card type-${event.type.replace('_', '-')}`);
    card.append(element('span', 'darts-broadcast-kicker', view.label), element('strong', 'darts-broadcast-headline', view.headline));
    if (view.detail) card.append(element('span', 'darts-broadcast-detail', view.detail));
    if (view.foot) card.append(element('span', 'darts-broadcast-foot', view.foot));
    host.replaceChildren(card);
    state.active = event;
    state.highlightTimer = root.setTimeout(() => { clearHighlight(); nextHighlight(); }, HIGHLIGHT_MS);
  }
  function ingest(events, options = {}) {
    loadSeen();
    const baseline = options.baseline === true || !state.initializedIngest;
    state.initializedIngest = true;
    let changed = false, queued = 0;
    for (const event of Array.isArray(events) ? events : []) {
      if (!authentic(event)) continue;
      const key = eventKey(event);
      if (state.seen.has(key)) continue;
      state.seen.set(key, Date.now()); changed = true;
      if (!baseline && state.enabled && state.queue.length < 20) { state.queue.push(event); queued++; }
    }
    if (changed) { pruneSeen(Date.now()); saveSeen(); }
    nextHighlight();
    return queued;
  }
  function configure(options = {}) {
    if (typeof options.enabled === 'boolean') {
      state.enabled = options.enabled;
      if (!state.enabled) { state.queue.length = 0; clearHighlight(); }
    }
    if (typeof options.tv === 'boolean') state.tv = options.tv;
    if (state.node) state.node.classList.toggle('is-tv', state.tv);
    if (state.enabled) nextHighlight();
    return { enabled: state.enabled, tv: state.tv };
  }
  function closeRoster() {
    if (!state.roster) return;
    if (state.rosterTimer) root.clearTimeout(state.rosterTimer);
    state.rosterTimer = null;
    state.roster = null;
    state.node?.replaceChildren();
    state.node?.classList.remove('has-roster');
    if (state.previousFocus?.isConnected) state.previousFocus.focus();
    state.previousFocus = null;
    nextHighlight();
  }
  function keydown(event) {
    if (!state.roster) return;
    if (event.key === 'Escape') { event.preventDefault(); closeRoster(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); moveRoster(1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); moveRoster(-1); }
    else if (event.key === ' ' && !/BUTTON/.test(root.document.activeElement?.tagName || '')) { event.preventDefault(); toggleRosterPause(); }
    else if (event.key === 'Tab') {
      const controls = [...state.node.querySelectorAll('button')];
      if (!controls.length) return;
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && root.document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && root.document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
  function moveRoster(step) {
    if (!state.roster) return;
    if (state.rosterTimer) root.clearTimeout(state.rosterTimer);
    state.rosterTimer = null;
    const next = state.roster.index + step;
    if (next >= state.roster.players.length + 2) { closeRoster(); return; }
    state.roster.index = Math.max(0, next);
    renderRosterSlide();
  }
  function toggleRosterPause() {
    if (!state.roster) return;
    state.roster.paused = !state.roster.paused;
    if (state.rosterTimer) root.clearTimeout(state.rosterTimer);
    state.rosterTimer = null;
    const pause = state.node?.querySelector('.darts-roster-pause');
    if (pause) { pause.textContent = state.roster.paused ? 'Fortsetzen' : 'Pause'; pause.setAttribute('aria-pressed', String(state.roster.paused)); }
    if (!state.roster.paused) scheduleRoster();
  }
  function scheduleRoster() {
    if (!state.roster || state.roster.paused) return;
    state.rosterTimer = root.setTimeout(() => moveRoster(1), ROSTER_MS);
  }
  function renderRosterSlide() {
    const roster = state.roster, host = mount();
    if (!roster || !host) return;
    const total = roster.players.length + 2;
    const slide = element('section', 'darts-roster-slide');
    slide.setAttribute('role', 'dialog');
    slide.setAttribute('aria-modal', 'true');
    slide.setAttribute('aria-label', `Kaderpräsentation ${roster.name}`);
    const close = element('button', 'darts-roster-close', 'Schließen ×');
    close.type = 'button'; close.addEventListener('click', closeRoster);
    slide.append(close);
    if (roster.index === 0) {
      slide.append(element('span', 'darts-roster-eyebrow', 'SV BARVER DARTS'), element('strong', 'darts-roster-team', roster.name), element('span', 'darts-roster-caption', 'VEREINSKADER'));
    } else if (roster.index === total - 1) {
      slide.append(element('span', 'darts-roster-eyebrow', 'GEMEINSAM AM OCHE'), element('strong', 'darts-roster-team', roster.name));
      const names = element('div', 'darts-roster-names');
      for (const player of roster.players) names.append(element('span', '', text(player.name, 100)));
      slide.append(names);
    } else {
      const player = roster.players[roster.index - 1];
      const image = safeImage(player.image);
      if (image) {
        const visual = element('div', 'darts-roster-photo');
        const portrait = element('img'); portrait.src = image; portrait.alt = `Porträt von ${text(player.name, 100)}`;
        portrait.addEventListener('error', () => visual.remove(), { once: true });
        visual.append(portrait); slide.append(visual);
      }
      const copy = element('div', 'darts-roster-copy');
      copy.append(element('span', 'darts-roster-eyebrow', roster.name));
      if (text(player.alias)) copy.append(element('span', 'darts-roster-alias', `„${text(player.alias, 60)}“`));
      copy.append(element('strong', 'darts-roster-player', text(player.name, 100)));
      if (text(player.role)) copy.append(element('span', 'darts-roster-role', text(player.role, 80)));
      const stats = [];
      if (Number.isFinite(player.average) && player.average > 0) stats.push(`Ø ${player.average.toLocaleString('de-DE')}`);
      if (Number.isInteger(player.count180) && player.count180 > 0) stats.push(`${player.count180} × 180`);
      if (Number.isInteger(player.highFinish) && player.highFinish >= 100) stats.push(`Bestes Finish ${player.highFinish}`);
      if (stats.length) copy.append(element('span', 'darts-roster-stats', stats.join(' · ')));
      slide.append(copy);
    }
    const controls = element('div', 'darts-roster-controls');
    const previous = element('button', '', 'Zurück'); previous.type = 'button'; previous.disabled = roster.index === 0; previous.addEventListener('click', () => moveRoster(-1));
    const pause = element('button', 'darts-roster-pause', roster.paused ? 'Fortsetzen' : 'Pause'); pause.type = 'button'; pause.setAttribute('aria-pressed', String(roster.paused)); pause.addEventListener('click', toggleRosterPause);
    const next = element('button', '', 'Weiter'); next.type = 'button'; next.addEventListener('click', () => moveRoster(1));
    controls.append(previous, pause, next);
    slide.append(controls, element('span', 'darts-roster-progress', `${roster.index + 1} / ${total}`));
    host.classList.add('has-roster'); host.replaceChildren(slide);
    close.focus();
    scheduleRoster();
  }
  function presentRoster(input) {
    if (!input || !/^[A-D]$/i.test(text(input.code)) || !text(input.name)) return false;
    const players = orderedPlayers(input.players);
    if (!players.length || !mount()) return false;
    if (state.roster) {
      if (state.rosterTimer) root.clearTimeout(state.rosterTimer);
      state.rosterTimer = null; state.roster = null;
      state.node?.classList.remove('has-roster');
    }
    if (state.active) {
      state.queue.unshift(state.active);
      clearHighlight();
    }
    state.previousFocus = root.document.activeElement;
    state.roster = { name: text(input.name, 120), players, index: 0, paused: false };
    renderRosterSlide();
    return true;
  }

  const api = { configure, ingest, presentRoster, closeRoster };
  root.DartsBroadcast = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = { ...api, eventKey, authentic, orderedPlayers, graphic };
})(typeof window !== 'undefined' ? window : globalThis);
