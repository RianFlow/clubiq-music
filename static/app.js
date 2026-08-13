"use strict";

const state = {
  token: localStorage.getItem("clubiq_music_token") || "",
  adminPassword: sessionStorage.getItem("clubiq_music_admin") || "",
  member: null,
  cycles: [],
  activeCycle: null,
  upcomingCycle: null,
  displayedCycle: null,
  budget: { remaining: 0, maximum: 0 },
  playlist: [],
  player: { available: false, queue: [], current_index: -1, volume: 70, repeat: "off", shuffle: false },
  soundboard: [],
  speakers: [],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>'"]/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

let toastTimer;
let countdownTransition = "";
function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = "toast"; }, 2800);
}

async function api(path, options = {}, admin = false) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (admin && state.adminPassword) headers.set("X-Admin-Password", state.adminPassword);
  if (!admin && state.token) headers.set("Authorization", `Bearer ${state.token}`);
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (_) {
    throw new Error("Die Kasse ist gerade nicht erreichbar.");
  }
  let payload = {};
  try { payload = await response.json(); } catch (_) { /* empty response */ }
  if (!response.ok) {
    if (response.status === 401 && !admin) clearMemberSession(false);
    throw new Error(payload.detail || payload.error || `Fehler ${response.status}`);
  }
  return payload;
}

function formatDate(value) {
  if (!value) return "–";
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function cyclePhase(cycle, now = Date.now()) {
  if (!cycle || cycle.status === "closed" || new Date(cycle.closes_at).getTime() <= now) return "closed";
  if (new Date(cycle.starts_at).getTime() > now) return "planned";
  return "active";
}

function durationParts(milliseconds) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [days ? `${days} T` : "", `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`]
    .filter(Boolean).join(" ");
}

async function refreshVotingState() {
  await loadCycles();
  await restoreMember();
  renderSession();
  await loadPlaylist();
}

function updateCountdown() {
  const cycle = state.displayedCycle;
  const root = $("#cycleCountdown");
  if (!cycle) { root.hidden = true; return; }
  const phase = cyclePhase(cycle);
  const transition = `${cycle.id}:${phase}`;

  if (phase === "closed") {
    root.hidden = true;
    if (countdownTransition && countdownTransition !== transition) {
      countdownTransition = transition;
      refreshVotingState().catch(error => toast(error.message, true));
    }
    return;
  }

  const target = phase === "planned" ? new Date(cycle.starts_at) : new Date(cycle.closes_at);
  $("#countdownLabel").textContent = phase === "planned" ? "Startet in" : "Endet in";
  $("#countdownValue").textContent = durationParts(target.getTime() - Date.now());
  root.dataset.phase = phase;
  root.hidden = false;

  if (countdownTransition && countdownTransition !== transition) {
    countdownTransition = transition;
    refreshVotingState().catch(error => toast(error.message, true));
    return;
  }
  countdownTransition = transition;
}

function localDateTimeValue(date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

function setCycleFormDefaults() {
  if ($("#cycleStartsAt").value && $("#cycleClosesAt").value) return;
  const start = new Date(Date.now() + 5 * 60 * 1000);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  $("#cycleStartsAt").value = localDateTimeValue(start);
  $("#cycleClosesAt").value = localDateTimeValue(end);
}

function setTab(name) {
  $$(".tab").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
  $$(".tab-panel").forEach(panel => panel.classList.toggle("active", panel.id === `tab-${name}`));
  if (name === "mine") renderMyVotes();
  if (name === "player") Promise.all([loadPlayerState(), loadSoundboard()]).catch(error => toast(error.message, true));
}

function setAdminTab(name) {
  $$(".subtab").forEach(button => button.classList.toggle("active", button.dataset.adminTab === name));
  $$(".admin-panel").forEach(panel => panel.classList.toggle("active", panel.id === `admin-${name}`));
}

function renderSession() {
  const loggedIn = Boolean(state.member);
  $("#loginHint").hidden = loggedIn;
  $$('[data-member-only]').forEach(node => { node.hidden = !loggedIn; });
  $$('[data-guest-only]').forEach(node => { node.hidden = loggedIn; });
  $("#memberOpen").textContent = loggedIn ? `${state.member.display_name} · Abmelden` : "Anmelden";
  $("#budgetRemaining").textContent = loggedIn ? state.budget.remaining : "–";
  $("#budgetMeta").textContent = loggedIn
    ? `${state.budget.maximum - state.budget.remaining} von ${state.budget.maximum} Punkten vergeben`
    : "Zum Abstimmen anmelden";
  const percent = loggedIn && state.budget.maximum
    ? ((state.budget.maximum - state.budget.remaining) / state.budget.maximum) * 100
    : 0;
  $("#budgetBar").style.width = `${Math.min(100, percent)}%`;
}

function clearMemberSession(showMessage = true) {
  localStorage.removeItem("clubiq_music_token");
  state.token = "";
  state.member = null;
  state.budget = { remaining: 0, maximum: 0 };
  state.playlist = state.playlist.map(song => ({ ...song, my_points: 0, suggested_by_me: false }));
  renderSession();
  renderPlaylist();
  if (showMessage) toast("Du bist abgemeldet.");
}

async function loadMembers() {
  try {
    const data = await api("/api/v1/music/members");
    $("#memberNames").innerHTML = data.members.map(name => `<option value="${esc(name)}"></option>`).join("");
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadCycles() {
  const data = await api("/api/v1/music/cycles");
  state.cycles = data.cycles || [];
  state.activeCycle = state.cycles.find(cycle => cyclePhase(cycle) === "active") || null;
  state.upcomingCycle = state.cycles
    .filter(cycle => cyclePhase(cycle) === "planned")
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0] || null;
  state.displayedCycle = state.activeCycle || state.upcomingCycle;
  $("#cycleName").textContent = state.displayedCycle?.name || "Keine Abstimmung geplant";
  $("#cycleMeta").textContent = state.activeCycle
    ? `Geöffnet bis ${formatDate(state.activeCycle.closes_at)} · ${state.activeCycle.max_budget} Punkte pro Mitglied`
    : state.upcomingCycle
      ? `Voting von ${formatDate(state.upcomingCycle.starts_at)} bis ${formatDate(state.upcomingCycle.closes_at)}`
      : "Die Verwaltung kann eine neue Abstimmung planen.";
  updateCountdown();
}

async function restoreMember() {
  if (!state.token) return;
  try {
    const data = await api("/api/v1/music/auth/me");
    state.member = data.member;
    state.budget = data.budget;
    if (data.active_cycle_id) {
      state.activeCycle = state.cycles.find(cycle => cycle.id === data.active_cycle_id) || state.activeCycle;
    }
  } catch (_) {
    clearMemberSession(false);
  }
}

async function loadPlaylist() {
  if (!state.activeCycle) {
    state.playlist = [];
    renderPlaylist();
    return;
  }
  try {
    const data = await api(`/api/v1/music/cycles/${state.activeCycle.id}/playlist`);
    state.playlist = data.playlist || [];
    renderPlaylist();
  } catch (error) {
    toast(error.message, true);
  }
}

function songCard(song, mine = false) {
  const controls = state.member ? `
    <div class="points">
      <button type="button" data-vote="-1" aria-label="Einen Punkt entfernen">−</button>
      <strong>${song.my_points}</strong>
      <button type="button" data-vote="1" aria-label="Einen Punkt hinzufügen">+</button>
    </div>` : '<button class="button ghost small login-to-vote" type="button" data-login-to-vote>Zum Abstimmen anmelden</button>';
  return `
    <article class="song-card" data-song-id="${song.suggestion_id}">
      <div class="song-visual">${song.thumbnail_url ? `<img class="song-cover" src="${esc(song.thumbnail_url)}" alt="" loading="lazy">` : '<span class="song-cover song-fallback">♪</span>'}<span class="song-rank">${mine ? "♪" : song.rank}</span></div>
      <div class="song-copy">
        <strong>${esc(song.title)}</strong>
        <span>${esc(song.channel_title || "Unbekannter Interpret")}${song.suggested_by_me ? " · <em>von dir vorgeschlagen</em>" : ""}</span>
      </div>
      ${controls}
      ${mine ? "" : `
        <div class="total"><strong>${song.total_points}</strong><small>gesamt</small></div>`}
    </article>`;
}

function wireVoteButtons(root) {
  $$('[data-login-to-vote]', root).forEach(button => button.addEventListener("click", () => openMemberDialog()));
  $$('[data-vote]', root).forEach(button => button.addEventListener("click", async () => {
    const card = button.closest("[data-song-id]");
    const song = state.playlist.find(item => item.suggestion_id === Number(card.dataset.songId));
    const next = song.my_points + Number(button.dataset.vote);
    if (next < 0) return;
    if (next > song.my_points && state.budget.remaining < 1) {
      toast("Du hast bereits alle Punkte vergeben.", true);
      return;
    }
    button.disabled = true;
    try {
      const result = await api(`/api/v1/music/cycles/${state.activeCycle.id}/votes`, {
        method: "POST",
        body: JSON.stringify({ suggestion_id: song.suggestion_id, points: next }),
      });
      state.budget.remaining = result.budget_remaining;
      await loadPlaylist();
      renderSession();
      toast(next ? `${next} Punkt${next === 1 ? "" : "e"} für „${song.title}“` : "Stimme entfernt");
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }));
}

function renderPlaylist() {
  const root = $("#playlist");
  if (!state.activeCycle) {
    root.innerHTML = state.upcomingCycle
      ? `<div class="empty">Die Rangliste öffnet am ${formatDate(state.upcomingCycle.starts_at)}.</div>`
      : '<div class="empty">Derzeit ist keine Abstimmung geöffnet.</div>';
  } else if (!state.playlist.length) {
    root.innerHTML = '<div class="empty">Noch keine Songs vorhanden. Mach den ersten Vorschlag.</div>';
  } else {
    root.innerHTML = state.playlist.map(song => songCard(song)).join("");
    wireVoteButtons(root);
  }
  $("#mineCount").textContent = state.playlist.filter(song => song.my_points > 0).length;
  $("#playlistSummary").textContent = state.activeCycle
    ? `${state.playlist.length} Song${state.playlist.length === 1 ? "" : "s"} · ${state.playlist.reduce((sum, song) => sum + song.total_points, 0)} Punkte`
    : "";
  renderMyVotes();
}

function renderMyVotes() {
  const root = $("#myVotes");
  const mine = state.playlist.filter(song => song.my_points > 0);
  if (!state.member) {
    root.innerHTML = '<div class="empty">Melde dich an, um deine Auswahl zu sehen.</div>';
  } else if (!mine.length) {
    root.innerHTML = '<div class="empty">Du hast noch keine Punkte vergeben.</div>';
  } else {
    root.innerHTML = mine.map(song => songCard(song, true)).join("");
    wireVoteButtons(root);
  }
}

async function login(event) {
  event.preventDefault();
  const errorNode = $("#loginError");
  errorNode.hidden = true;
  try {
    const data = await api("/api/v1/music/auth/login", {
      method: "POST",
      body: JSON.stringify({
        display_name: $("#memberName").value.trim(),
        pin: $("#memberPin").value,
      }),
    });
    state.token = data.token;
    localStorage.setItem("clubiq_music_token", data.token);
    state.member = data.member;
    state.budget = data.budget;
    $("#memberPin").value = "";
    $("#memberDialog").close();
    renderSession();
    await loadPlaylist();
    toast(data.pin_created ? "PIN gespeichert. Du bist angemeldet." : `Hallo ${data.member.display_name}!`);
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  }
}

function setAuthMode(mode) {
  const registering = mode === "register";
  $("#loginForm").hidden = registering;
  $("#registerForm").hidden = !registering;
  $("#memberDialogTitle").textContent = registering ? "Neu registrieren" : "Mitglied anmelden";
  $("#loginMode").classList.toggle("active", !registering);
  $("#registerMode").classList.toggle("active", registering);
  $("#loginMode").setAttribute("aria-selected", String(!registering));
  $("#registerMode").setAttribute("aria-selected", String(registering));
  $("#loginError").hidden = true;
  $("#registerError").hidden = true;
}

function openMemberDialog(mode = "login") {
  setAuthMode(mode);
  $("#memberDialog").showModal();
}

async function register(event) {
  event.preventDefault();
  const errorNode = $("#registerError");
  errorNode.hidden = true;
  const pin = $("#registerPin").value;
  if (pin !== $("#registerPinRepeat").value) {
    errorNode.textContent = "Die beiden PIN-Eingaben stimmen nicht überein.";
    errorNode.hidden = false;
    return;
  }
  try {
    const data = await api("/api/v1/music/auth/register", {
      method: "POST",
      body: JSON.stringify({
        display_name: $("#registerName").value.trim(),
        pin,
      }),
    });
    state.token = data.token;
    localStorage.setItem("clubiq_music_token", data.token);
    state.member = data.member;
    state.budget = data.budget;
    event.target.reset();
    $("#memberDialog").close();
    await loadMembers();
    renderSession();
    await loadPlaylist();
    toast(`Willkommen ${data.member.display_name}! Dein Konto ist bereit.`);
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  }
}

async function logout() {
  if (!state.member) return;
  try { await api("/api/v1/music/auth/logout", { method: "POST" }); } catch (_) { /* local logout still works */ }
  clearMemberSession();
  await loadPlaylist();
}

async function searchSongs(event) {
  event.preventDefault();
  if (!state.member) {
    openMemberDialog();
    return;
  }
  if (!state.activeCycle) {
    toast(state.upcomingCycle
      ? `Das Voting startet am ${formatDate(state.upcomingCycle.starts_at)}.`
      : "Derzeit ist keine Abstimmung geöffnet.", true);
    return;
  }
  const query = $("#searchInput").value.trim();
  const root = $("#searchResults");
  root.innerHTML = '<div class="empty">Suche läuft …</div>';
  try {
    const data = await api(`/api/v1/music/provider/search?q=${encodeURIComponent(query)}`);
    const results = data.results || [];
    root.innerHTML = results.length ? results.map((song, index) => `
      <article class="song-card">
        <div class="song-visual">${song.thumbnail_url ? `<img class="song-cover" src="${esc(song.thumbnail_url)}" alt="" loading="lazy">` : '<span class="song-cover song-fallback">♪</span>'}<span class="song-rank">${index + 1}</span></div>
        <div class="song-copy"><strong>${esc(song.title)}</strong><span>${esc(song.channel_title || "")}</span></div>
        <button class="button primary small" type="button" data-suggest="${esc(song.external_id)}"
          data-title="${esc(song.title)}" data-channel="${esc(song.channel_title || "")}">Vorschlagen</button>
      </article>`).join("") : '<div class="empty">Keine Treffer gefunden.</div>';
    $$('[data-suggest]', root).forEach(button => button.addEventListener("click", () => suggestSong(button)));
  } catch (error) {
    root.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

async function suggestSong(button) {
  if (!state.activeCycle) return toast("Es gibt keine aktive Abstimmung.", true);
  button.disabled = true;
  try {
    await api(`/api/v1/music/cycles/${state.activeCycle.id}/suggestions`, {
      method: "POST",
      body: JSON.stringify({
        provider: "youtube",
        external_id: button.dataset.suggest,
        title: button.dataset.title,
        channel_title: button.dataset.channel,
      }),
    });
    await loadPlaylist();
    setTab("voting");
    toast("Song wurde zur Abstimmung hinzugefügt.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function mediaTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function renderPlayer() {
  const player = state.player || {};
  const current = player.current;
  const speaker = player.speaker;
  const connected = Boolean(speaker?.connected);
  $("#speakerBadge").textContent = connected ? `🔊 ${speaker.name}` : "Keine Box verbunden";
  $("#speakerBadge").classList.toggle("offline", !connected);
  $("#playerIndicator").textContent = connected ? (player.playing ? "▶" : "✓") : "–";
  $("#playerTitle").textContent = player.sound_active ? "Soundboard läuft" : current?.title || "Noch kein Song gewählt";
  $("#playerArtist").textContent = player.sound_active ? "Danach wird der Song automatisch fortgesetzt" : current?.artist || (connected
    ? "Rangliste in die Warteschlange übernehmen"
    : "Die Verwaltung verbindet zuerst eine Bluetooth-Box");
  $("#playerCover").src = current?.thumbnail || "/pics/logo.png";
  $("#playerCover").onerror = () => { $("#playerCover").src = "/pics/logo.png"; };
  $("#playerProgress").max = Math.max(1, Number(player.duration) || 1);
  if (!$("#playerProgress").matches(":active")) $("#playerProgress").value = Number(player.position) || 0;
  $("#playerPosition").textContent = mediaTime(player.position);
  $("#playerDuration").textContent = mediaTime(player.duration);
  $("#playerPlay").textContent = player.playing ? "❚❚" : "▶";
  $("#playerPlay").title = player.playing ? "Pause" : "Wiedergabe";
  $("#playerVolume").value = Number(player.volume ?? 70);
  $("#playerVolumeValue").textContent = `${Number(player.volume ?? 70)} %`;
  $("#playerMute").textContent = player.muted ? "🔇" : "🔊";
  $('[data-player-action="shuffle"]').classList.toggle("active", Boolean(player.shuffle));
  $("#playerRepeat").classList.toggle("active", player.repeat !== "off");
  $("#playerRepeat").textContent = player.repeat === "one" ? "↻¹" : "↻";

  const queue = player.queue || [];
  $("#queueCount").textContent = `${queue.length} Song${queue.length === 1 ? "" : "s"}`;
  $("#playerQueue").innerHTML = queue.length ? queue.map((item, index) => `
    <div class="queue-row${index === player.current_index ? " current" : ""}">
      <span>${index === player.current_index && player.playing ? "▶" : index + 1}</span>
      <div><strong>${esc(item.title)}</strong><small>${esc(item.artist || "Unbekannter Interpret")}</small></div>
    </div>`).join("") : '<div class="empty">Noch keine Songs geladen.</div>';
}

async function loadPlayerState(silent = false) {
  try {
    state.player = await api("/api/v1/music/player/state");
    renderPlayer();
  } catch (error) {
    state.player = { available: false, queue: [], current_index: -1, volume: 70, repeat: "off", shuffle: false };
    renderPlayer();
    if (!silent) toast(error.message, true);
  }
}

async function playerCommand(action, value = null) {
  if (!state.member) return openMemberDialog();
  try {
    state.player = await api("/api/v1/music/player/command", {
      method: "POST", body: JSON.stringify({ action, value }),
    });
    renderPlayer();
  } catch (error) { toast(error.message, true); }
}

async function handlePlayerAction(button) {
  let action = button.dataset.playerAction;
  let value = null;
  if (action === "play" && state.player.playing) action = "pause";
  if (action === "shuffle") value = !state.player.shuffle;
  if (action === "repeat") {
    value = state.player.repeat === "off" ? "all" : state.player.repeat === "all" ? "one" : "off";
  }
  if (action === "mute") value = !state.player.muted;
  await playerCommand(action, value);
}

async function queueRanking() {
  if (!state.member) return openMemberDialog();
  const button = $("#queueFromRanking");
  button.disabled = true;
  try {
    state.player = await api("/api/v1/music/player/queue/current", { method: "POST" });
    renderPlayer();
    toast(`${state.player.queue.length} Songs sind im Player bereit.`);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}

async function loadSoundboard() {
  const data = await api("/api/v1/music/player/soundboard");
  state.soundboard = data.items || [];
  $("#soundboard").innerHTML = state.soundboard.length ? state.soundboard.map(item => `
    <button class="sound-button ${esc(item.color)}" data-play-sound="${item.id}" type="button">${esc(item.name)}</button>
  `).join("") : '<div class="empty">Noch keine Sounds eingerichtet.</div>';
  $$('[data-play-sound]').forEach(button => button.addEventListener("click", async () => {
    if (!state.member) return openMemberDialog();
    button.disabled = true;
    try {
      state.player = await api(`/api/v1/music/player/soundboard/${button.dataset.playSound}/play`, { method: "POST" });
      renderPlayer();
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  }));
  renderAdminSoundboard();
}

function renderAdminSoundboard() {
  const root = $("#adminSoundboard");
  if (!root) return;
  root.innerHTML = state.soundboard.length ? state.soundboard.map(item => `
    <div class="admin-row"><div><strong>${esc(item.name)}</strong><span>Soundboard · ${esc(item.color)}</span></div>
      <button class="button ghost small" data-delete-sound="${item.id}" type="button">Löschen</button></div>
  `).join("") : '<div class="empty">Noch keine Soundboard-Sounds gespeichert.</div>';
  $$('[data-delete-sound]', root).forEach(button => button.addEventListener("click", async () => {
    if (!window.confirm("Diesen Sound wirklich löschen?")) return;
    try {
      await api(`/api/v1/music/admin/soundboard/${button.dataset.deleteSound}`, { method: "DELETE" }, true);
      await loadSoundboard();
      toast("Sound wurde gelöscht.");
    } catch (error) { toast(error.message, true); }
  }));
}

async function loadSpeakers(silent = false) {
  try {
    const data = await api("/api/v1/music/player/bluetooth/devices", {}, true);
    state.speakers = data.devices || [];
    renderSpeakers();
  } catch (error) {
    state.speakers = [];
    $("#speakerList").innerHTML = `<div class="empty">${esc(error.message)} Starte auf dem Raspberry einmal das Player-Installationsskript.</div>`;
    if (!silent) toast(error.message, true);
  }
}

function renderSpeakers() {
  const root = $("#speakerList");
  root.innerHTML = state.speakers.length ? state.speakers.map(device => `
    <div class="admin-row">
      <div><strong>${esc(device.name)}</strong><span>${device.connected ? "Verbunden" : device.paired ? "Gekoppelt" : "Gefunden"}<i class="device-address">${esc(device.address)}</i></span></div>
      <div class="row-actions">
        ${device.connected
          ? `<button class="button ghost small" data-speaker-action="disconnect" data-address="${device.address}" type="button">Trennen</button>`
          : `<button class="button primary small" data-speaker-action="connect" data-address="${device.address}" type="button">Verbinden</button>`}
        ${device.paired ? `<button class="button ghost small" data-speaker-action="forget" data-address="${device.address}" type="button">Vergessen</button>` : ""}
      </div>
    </div>`).join("") : '<div class="empty">Noch keine Box gefunden. Box in den Kopplungsmodus setzen und „Boxen suchen“ wählen.</div>';
  $$('[data-speaker-action]', root).forEach(button => button.addEventListener("click", () => speakerAction(button)));
}

async function scanSpeakers() {
  const button = $("#scanSpeakers");
  button.disabled = true;
  button.textContent = "Suche läuft …";
  try {
    const data = await api("/api/v1/music/player/bluetooth/scan", { method: "POST" }, true);
    state.speakers = data.devices || [];
    renderSpeakers();
    toast(`${state.speakers.length} Bluetooth-Gerät${state.speakers.length === 1 ? "" : "e"} gefunden.`);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = "Boxen suchen"; }
}

async function speakerAction(button) {
  const operation = button.dataset.speakerAction;
  button.disabled = true;
  try {
    await api(`/api/v1/music/player/bluetooth/${operation}`, {
      method: "POST", body: JSON.stringify({ address: button.dataset.address }),
    }, true);
    await Promise.all([loadSpeakers(), loadPlayerState(true)]);
    toast(operation === "connect" ? "Bluetooth-Box ist verbunden." : "Bluetooth-Box wurde aktualisiert.");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}

async function uploadSound(event) {
  event.preventDefault();
  const form = event.target;
  const button = $("button[type=submit]", form);
  button.disabled = true;
  try {
    await api("/api/v1/music/admin/soundboard", { method: "POST", body: new FormData(form) }, true);
    form.reset();
    await loadSoundboard();
    toast("Soundboard-Sound wurde gespeichert.");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}

function adminHeadersBody(payload) {
  return { body: JSON.stringify(payload) };
}

async function openAdmin() {
  $("#adminDialog").showModal();
  if (!state.adminPassword) return;
  try {
    await api("/api/v1/music/admin/verify", {}, true);
    await showAdminArea();
  } catch (_) {
    state.adminPassword = "";
    sessionStorage.removeItem("clubiq_music_admin");
  }
}

async function adminLogin(event) {
  event.preventDefault();
  state.adminPassword = $("#adminPassword").value;
  const errorNode = $("#adminLoginError");
  try {
    await api("/api/v1/music/admin/verify", {}, true);
    sessionStorage.setItem("clubiq_music_admin", state.adminPassword);
    errorNode.hidden = true;
    await showAdminArea();
  } catch (error) {
    state.adminPassword = "";
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  }
}

async function showAdminArea() {
  $("#adminLogin").hidden = true;
  $("#adminArea").hidden = false;
  $("#adminLogout").hidden = false;
  setCycleFormDefaults();
  await Promise.all([
    loadAdminStats(), loadAdminCycles(), loadAdminMembers(), loadVoteHistory(),
    loadSpeakers(true), loadSoundboard(),
  ]);
}

function adminLogout() {
  state.adminPassword = "";
  sessionStorage.removeItem("clubiq_music_admin");
  $("#adminPassword").value = "";
  $("#adminLogin").hidden = false;
  $("#adminArea").hidden = true;
  $("#adminLogout").hidden = true;
}

async function loadAdminStats() {
  const data = await api("/api/v1/music/admin/overview", {}, true);
  $("#adminStats").innerHTML = [
    ["Mitglieder", data.members], ["Songs", data.songs], ["Stimmen", data.votes],
  ].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join("");
}

async function loadAdminCycles() {
  await loadCycles();
  const root = $("#cycleList");
  root.innerHTML = state.cycles.map(cycle => `
    <div class="admin-row">
      <div><strong>${esc(cycle.name)}</strong><span>${cyclePhase(cycle) === "active" ? "Aktiv" : cyclePhase(cycle) === "closed" ? "Beendet" : "Geplant"} · ${formatDate(cycle.starts_at)} bis ${formatDate(cycle.closes_at)} · ${cycle.max_budget} Punkte</span></div>
      <div class="row-actions">
        ${cyclePhase(cycle) === "planned" && !state.activeCycle ? `<button class="button ghost small" data-cycle-action="active" data-cycle-id="${cycle.id}">Jetzt starten</button>` : ""}
        ${cycle.status === "active" ? `<button class="button ghost small" data-cycle-action="closed" data-cycle-id="${cycle.id}">Beenden</button>` : ""}
      </div>
    </div>`).join("") || '<div class="empty">Noch keine Abstimmung vorhanden.</div>';
  $$('[data-cycle-action]', root).forEach(button => button.addEventListener("click", async () => {
    try {
      await api(`/api/v1/music/admin/cycles/${button.dataset.cycleId}`, {
        method: "PATCH", ...adminHeadersBody({ status: button.dataset.cycleAction }),
      }, true);
      await loadAdminCycles();
      await refreshVotingState();
      toast("Abstimmung aktualisiert.");
    } catch (error) { toast(error.message, true); }
  }));
}

async function createCycle(event) {
  event.preventDefault();
  const startsAt = new Date($("#cycleStartsAt").value);
  const closesAt = new Date($("#cycleClosesAt").value);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(closesAt.getTime()) || closesAt <= startsAt) {
    return toast("Bitte eine gültige Start- und Endzeit wählen.", true);
  }
  try {
    await api("/api/v1/music/admin/cycles", {
      method: "POST", ...adminHeadersBody({
        name: $("#cycleTitle").value.trim(),
        starts_at: startsAt.toISOString(),
        closes_at: closesAt.toISOString(),
        max_budget: Number($("#cycleBudget").value),
      }),
    }, true);
    event.target.reset();
    $("#cycleBudget").value = "10";
    setCycleFormDefaults();
    await Promise.all([loadAdminCycles(), loadAdminStats()]);
    await refreshVotingState();
    toast(startsAt <= new Date() ? "Abstimmung gestartet." : "Abstimmung wurde geplant.");
  } catch (error) { toast(error.message, true); }
}

async function loadAdminMembers() {
  const data = await api("/api/v1/music/admin/members", {}, true);
  const root = $("#memberList");
  root.innerHTML = (data.members || []).map(member => `
    <div class="admin-row">
      <div><strong>${esc(member.display_name)}</strong><span>${member.active ? "Aktiv" : "Deaktiviert"} · ${member.pin_ready ? "PIN eingerichtet" : "PIN beim ersten Login festlegen"}</span></div>
      <div class="row-actions">
        <button class="button ghost small" data-reset-pin="${esc(member.member_id)}">PIN ändern</button>
        <button class="button ghost small" data-toggle-member="${esc(member.member_id)}" data-active="${member.active}">${member.active ? "Deaktivieren" : "Aktivieren"}</button>
      </div>
    </div>`).join("") || '<div class="empty">Noch keine Mitglieder angelegt.</div>';
  $$('[data-reset-pin]', root).forEach(button => button.addEventListener("click", async () => {
    const pin = window.prompt("Neue PIN mit 4 bis 8 Ziffern:");
    if (pin === null) return;
    if (!/^\d{4,8}$/.test(pin)) return toast("Die PIN muss 4 bis 8 Ziffern haben.", true);
    try {
      await api(`/api/v1/music/admin/members/${encodeURIComponent(button.dataset.resetPin)}`, {
        method: "PATCH", ...adminHeadersBody({ pin }),
      }, true);
      await loadAdminMembers();
      toast("PIN geändert. Bestehende Anmeldung wurde beendet.");
    } catch (error) { toast(error.message, true); }
  }));
  $$('[data-toggle-member]', root).forEach(button => button.addEventListener("click", async () => {
    try {
      await api(`/api/v1/music/admin/members/${encodeURIComponent(button.dataset.toggleMember)}`, {
        method: "PATCH", ...adminHeadersBody({ active: button.dataset.active !== "true" }),
      }, true);
      await Promise.all([loadAdminMembers(), loadAdminStats(), loadMembers()]);
      toast("Mitglied aktualisiert.");
    } catch (error) { toast(error.message, true); }
  }));
}

async function createMember(event) {
  event.preventDefault();
  try {
    await api("/api/v1/music/admin/members", {
      method: "POST", ...adminHeadersBody({
        display_name: $("#newMemberName").value.trim(),
        pin: $("#newMemberPin").value,
      }),
    }, true);
    event.target.reset();
    await Promise.all([loadAdminMembers(), loadAdminStats(), loadMembers()]);
    toast("Mitglied wurde angelegt.");
  } catch (error) { toast(error.message, true); }
}

async function loadVoteHistory() {
  const data = await api("/api/v1/music/admin/all-votes", {}, true);
  $("#voteHistory").innerHTML = (data.votes || []).map(vote => `
    <div class="admin-row"><div><strong>${esc(vote.member)} · ${esc(vote.title)}</strong><span>${formatDate(vote.created_at)}</span></div><strong>${vote.points} Punkte</strong></div>
  `).join("") || '<div class="empty">Noch keine Stimmen abgegeben.</div>';
}

function bindEvents() {
  $$(".tab").forEach(button => button.addEventListener("click", () => setTab(button.dataset.tab)));
  $$(".subtab").forEach(button => button.addEventListener("click", () => setAdminTab(button.dataset.adminTab)));
  $$('[data-open-member]').forEach(button => button.addEventListener("click", () => openMemberDialog()));
  $("#memberOpen").addEventListener("click", () => state.member ? logout() : openMemberDialog());
  $("#adminOpen").addEventListener("click", openAdmin);
  $$('[data-close]').forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  $$("dialog").forEach(dialog => dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  }));
  $("#loginForm").addEventListener("submit", login);
  $("#registerForm").addEventListener("submit", register);
  $("#loginMode").addEventListener("click", () => setAuthMode("login"));
  $("#registerMode").addEventListener("click", () => setAuthMode("register"));
  $("#searchForm").addEventListener("submit", searchSongs);
  $("#refreshPlaylist").addEventListener("click", loadPlaylist);
  $("#adminLogin").addEventListener("submit", adminLogin);
  $("#adminLogout").addEventListener("click", adminLogout);
  $("#cycleForm").addEventListener("submit", createCycle);
  $("#memberCreateForm").addEventListener("submit", createMember);
  $$('[data-player-action]').forEach(button => button.addEventListener("click", () => handlePlayerAction(button)));
  $("#queueFromRanking").addEventListener("click", queueRanking);
  $("#refreshPlayer").addEventListener("click", () => loadPlayerState());
  $("#playerProgress").addEventListener("change", event => playerCommand("seek", Number(event.target.value)));
  $("#playerVolume").addEventListener("change", event => playerCommand("volume", Number(event.target.value)));
  $("#scanSpeakers").addEventListener("click", scanSpeakers);
  $("#soundUploadForm").addEventListener("submit", uploadSound);
  window.addEventListener("online", () => { $("#connectionState").innerHTML = "<i></i> Lokal bereit"; });
  window.addEventListener("offline", () => { $("#connectionState").innerHTML = "<i></i> Offline im Kassen-WLAN"; });
}

async function start() {
  bindEvents();
  try {
    await Promise.all([loadCycles(), loadMembers(), loadPlayerState(true), loadSoundboard()]);
    await restoreMember();
    renderSession();
    await loadPlaylist();
  } catch (error) {
    toast(error.message, true);
  }
}

start();
setInterval(updateCountdown, 1000);
setInterval(() => loadPlaylist().catch(() => {}), 30000);
setInterval(() => {
  if (!document.hidden) loadPlayerState(true).catch(() => {});
}, 3000);
