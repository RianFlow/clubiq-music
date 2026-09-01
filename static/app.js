"use strict";

const state = {
  token: localStorage.getItem("clubiq_music_token") || "",
  adminPassword: sessionStorage.getItem("clubiq_music_admin") || "",
  member: null,
  cycles: [],
  activeCycle: null,
  upcomingCycle: null,
  displayedCycle: null,
  selectedCycleId: null,
  budget: { remaining: 0, maximum: 0 },
  playlist: [],
  previousPlaylist: { cycle: null, songs: [] },
  player: { available: false, queue: [], current_index: -1, volume: 70, repeat: "off", shuffle: false },
  soundboard: [],
  soundCategory: "Alle",
  radioStations: [],
  savedRadioStations: [],
  speakers: [],
  savedSpeakers: [],
  activity: [],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>'"]/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

let toastTimer;
let countdownTransition = "";
let deferredInstallPrompt = null;
let queueRankingPending = false;
let reconnectPending = false;
let previewVideoId = "";
function toast(message, error = false) {
  const node = $("#toast");
  // A modal dialog lives in the browser's top layer, above every body z-index.
  const host = $$("dialog[open]").at(-1) || document.body;
  if (node.parentElement !== host) host.append(node);
  node.textContent = message;
  node.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = "toast"; }, error ? 10000 : 2800);
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

function canVoteInDisplayedCycle() {
  return Boolean(state.displayedCycle && state.displayedCycle.id === state.activeCycle?.id
    && cyclePhase(state.displayedCycle) === "active");
}

function renderCycleSelection() {
  const cycle = state.displayedCycle;
  const phase = cyclePhase(cycle);
  $("#cycleName").textContent = cycle?.name || "Keine Abstimmung vorhanden";
  $("#cycleMeta").textContent = !cycle ? "Die Verwaltung kann eine neue Abstimmung planen."
    : phase === "active" ? `Geöffnet bis ${formatDate(cycle.closes_at)} · ${cycle.max_budget} Punkte pro Mitglied`
    : phase === "planned" ? `Voting von ${formatDate(cycle.starts_at)} bis ${formatDate(cycle.closes_at)}`
    : "Abstimmung beendet · Ergebnis bleibt sichtbar und die Playlist kann weiter abgespielt werden.";
  const groups = [["active", "Laufende Abstimmung"], ["closed", "Abgeschlossene Abstimmungen"], ["planned", "Geplante Abstimmungen"]];
  $("#cycleSelect").innerHTML = groups.map(([value, label]) => {
    const cycles = state.cycles.filter(item => cyclePhase(item) === value);
    return cycles.length ? `<optgroup label="${label}">${cycles.map(item =>
      `<option value="${item.id}"${item.id === cycle?.id ? " selected" : ""}>${esc(item.name)} · ${esc(formatDate(item.closes_at))}</option>`
    ).join("")}</optgroup>` : "";
  }).join("") || '<option value="">Keine Abstimmung vorhanden</option>';
  $("#cycleSelect").disabled = !state.cycles.length;
  $("#budgetCard").hidden = !canVoteInDisplayedCycle();
  $("#loginHint").hidden = Boolean(state.member) || !canVoteInDisplayedCycle();
  $("#queueCycleName").textContent = cycle ? `Ausgewählte Abstimmung: ${cycle.name}` : "Oben eine Abstimmung auswählen.";
  [$("#queueFromRanking"), $("#queueSelectedPlaylist")].forEach(button => {
    button.disabled = queueRankingPending || !cycle || phase === "planned";
  });
  // Selecting a different archive is not a countdown transition.
  countdownTransition = cycle ? `${cycle.id}:${phase}` : "";
  updateCountdown();
}

async function selectCycle(cycleId) {
  state.displayedCycle = state.cycles.find(cycle => cycle.id === cycleId) || null;
  state.selectedCycleId = state.displayedCycle?.id ?? null;
  state.playlist = [];
  state.previousPlaylist = { cycle: null, songs: [] };
  renderCycleSelection();
  renderPlaylist();
  await loadPlaylist();
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
  if (name === "voting") loadActivity(true).catch(() => {});
  if (name === "player") Promise.all([loadPlayerState(), loadSoundboard(), loadRadioStations(), loadSavedSpeakers()]).catch(error => toast(error.message, true));
}

function setAdminTab(name) {
  $$(".subtab").forEach(button => button.classList.toggle("active", button.dataset.adminTab === name));
  $$(".admin-panel").forEach(panel => panel.classList.toggle("active", panel.id === `admin-${name}`));
}

function renderSession() {
  const loggedIn = Boolean(state.member);
  const canControlPlayer = Boolean(state.member?.can_control_player);
  $("#loginHint").hidden = loggedIn;
  $$('[data-member-only]').forEach(node => { node.hidden = !loggedIn; });
  $$('[data-guest-only]').forEach(node => { node.hidden = loggedIn; });
  $$('[data-player-control]').forEach(node => { node.hidden = !canControlPlayer; });
  const playerGate = $("#playerLoginGate");
  playerGate.hidden = canControlPlayer;
  playerGate.querySelector("span").textContent = loggedIn
    ? "Die Verwaltung muss dich für die Player-Bedienung freigeben."
    : "Zum Steuern des Players bitte einmal anmelden.";
  playerGate.querySelector("button").hidden = loggedIn;
  $("#memberOpen").textContent = loggedIn ? `${state.member.display_name} · Abmelden` : "Anmelden";
  $("#budgetRemaining").textContent = loggedIn ? state.budget.remaining : "–";
  $("#budgetMeta").textContent = loggedIn
    ? `${state.budget.maximum - state.budget.remaining} von ${state.budget.maximum} Punkten vergeben`
    : "Zum Abstimmen anmelden";
  const percent = loggedIn && state.budget.maximum
    ? ((state.budget.maximum - state.budget.remaining) / state.budget.maximum) * 100
    : 0;
  $("#budgetBar").style.width = `${Math.min(100, percent)}%`;
  $("#loginHint").hidden = loggedIn || !canVoteInDisplayedCycle();
  if (canControlPlayer) loadSavedSpeakers().catch(error => toast(error.message, true));
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
  const latestClosed = state.cycles.filter(cycle => cyclePhase(cycle) === "closed")
    .sort((a, b) => new Date(b.closes_at) - new Date(a.closes_at) || b.id - a.id)[0];
  state.displayedCycle = state.cycles.find(cycle => cycle.id === state.selectedCycleId)
    || state.activeCycle || latestClosed || state.upcomingCycle || null;
  state.selectedCycleId = state.displayedCycle?.id ?? null;
  renderCycleSelection();
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
  const cycleId = state.displayedCycle?.id;
  if (!cycleId) {
    state.playlist = [];
    state.previousPlaylist = { cycle: null, songs: [] };
    renderPlaylist();
    return;
  }
  try {
    const [data, previous] = await Promise.all([
      api(`/api/v1/music/cycles/${cycleId}/playlist`),
      api(`/api/v1/music/cycles/${cycleId}/previous-playlist`),
    ]);
    if (state.displayedCycle?.id !== cycleId) return;
    state.playlist = data.playlist || [];
    state.previousPlaylist = previous;
    renderPlaylist();
  } catch (error) {
    toast(error.message, true);
  }
}

function songCard(song, mine = false) {
  const controls = !canVoteInDisplayedCycle() ? (mine ? `<span class="muted">${song.my_points} Punkte von dir</span>` : "") : state.member ? `
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
        ${previewButton(song)}
      </div>
      ${controls}
      ${mine ? "" : `
        <div class="total"><strong>${song.total_points}</strong><small>gesamt</small></div>`}
    </article>`;
}

function wireVoteButtons(root) {
  wirePreviewButtons(root);
  $$('[data-login-to-vote]', root).forEach(button => button.addEventListener("click", () => openMemberDialog()));
  $$('[data-vote]', root).forEach(button => button.addEventListener("click", async () => {
    if (!canVoteInDisplayedCycle()) return toast("Diese Abstimmung ist nicht mehr geöffnet.", true);
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
  const cycle = state.displayedCycle;
  const phase = cyclePhase(cycle);
  if (!cycle || phase === "planned") {
    root.innerHTML = cycle
      ? `<div class="empty">Die Rangliste öffnet am ${formatDate(cycle.starts_at)}.</div>`
      : '<div class="empty">Derzeit ist keine Abstimmung vorhanden.</div>';
  } else if (!state.playlist.length) {
    root.innerHTML = phase === "closed"
      ? '<div class="empty">Für diese Abstimmung wurden keine Songs vorgeschlagen. Beim Laden der Playlist gelten weiterhin die eingestellten Auffüllregeln.</div>'
      : state.previousPlaylist?.songs?.length
        ? '<div class="empty">Noch keine neuen Vorschläge. Wähle unten einen Song aus der letzten Playlist oder suche unter „Song vorschlagen“.</div>'
        : '<div class="empty">Noch keine Songs vorhanden. Mach den ersten Vorschlag.</div>';
  } else {
    root.innerHTML = state.playlist.map(song => songCard(song)).join("");
    wireVoteButtons(root);
  }
  $("#mineCount").textContent = state.playlist.filter(song => song.my_points > 0).length;
  $("#playlistSummary").textContent = cycle
    ? `${phase === "closed" ? "Endergebnis · " : ""}${state.playlist.length} Song${state.playlist.length === 1 ? "" : "s"} · ${state.playlist.reduce((sum, song) => sum + song.total_points, 0)} Punkte`
    : "";
  renderMyVotes();
  renderPreviousPlaylist();
}

function previewButton(song) {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(song.external_id || "")) return "";
  return `<button type="button" class="button ghost small preview-button" data-preview="${esc(song.external_id)}" data-preview-title="${esc(song.title)}">▶ Hörprobe</button>`;
}

function wirePreviewButtons(root) {
  $$('[data-preview]', root).forEach(button => button.addEventListener("click", () => {
    previewVideoId = button.dataset.preview;
    $("#previewTitle").textContent = button.dataset.previewTitle || "Hörprobe";
    $("#previewFrame").replaceChildren();
    $("#previewStart").hidden = false;
    $("#previewYoutubeLink").href = `https://www.youtube.com/watch?v=${encodeURIComponent(previewVideoId)}`;
    $("#previewDialog").showModal();
  }));
}

function startPreview() {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(previewVideoId)) return;
  const iframe = document.createElement("iframe");
  iframe.title = "YouTube-Hörprobe";
  iframe.allow = "autoplay; encrypted-media; fullscreen";
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.src = `https://www.youtube-nocookie.com/embed/${previewVideoId}?autoplay=1&playsinline=1&start=0&end=30&rel=0`;
  $("#previewFrame").replaceChildren(iframe);
  $("#previewStart").hidden = true;
}

function renderPreviousPlaylist() {
  const { cycle, songs = [] } = state.previousPlaylist || {};
  const panel = $("#previousPlaylistPanel");
  panel.hidden = !state.displayedCycle || cyclePhase(state.displayedCycle) === "closed" || !cycle;
  if (panel.hidden) return;
  $("#previousPlaylistMeta").textContent = `Aus „${cycle.name}“ · ${songs.length} Songs`;
  const root = $("#previousPlaylist");
  root.innerHTML = songs.map((song, index) => {
    const present = state.playlist.some(item => item.external_id === song.external_id);
    return `<article class="song-card">
      <div class="song-visual"><img class="song-cover" src="${esc(song.thumbnail_url)}" alt="" loading="lazy"><span class="song-rank">${index + 1}</span></div>
      <div class="song-copy"><strong>${esc(song.title)}</strong><span>${esc(song.channel_title || "")}</span>${previewButton(song)}</div>
      <button class="button ghost small" type="button" data-reuse-song="${index}"${present || !canVoteInDisplayedCycle() ? " disabled" : ""}>${present ? "Schon in Abstimmung" : "Wieder vorschlagen"}</button>
    </article>`;
  }).join("") || '<div class="empty">In der letzten Abstimmung waren noch keine Songs vorhanden.</div>';
  wirePreviewButtons(root);
  $$('[data-reuse-song]', root).forEach(button => button.addEventListener("click", async () => {
    if (!state.member) return openMemberDialog();
    const song = songs[Number(button.dataset.reuseSong)];
    button.dataset.suggest = song.external_id;
    button.dataset.title = song.title;
    button.dataset.channel = song.channel_title || "";
    await suggestSong(button);
  }));
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
  if (!canVoteInDisplayedCycle()) {
    toast("Bitte oben eine laufende Abstimmung auswählen, um Songs vorzuschlagen.", true);
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
        <div class="song-copy"><strong>${esc(song.title)}</strong><span>${esc(song.channel_title || "")}</span>${previewButton(song)}</div>
        <button class="button primary small" type="button" data-suggest="${esc(song.external_id)}"
          data-title="${esc(song.title)}" data-channel="${esc(song.channel_title || "")}">Vorschlagen</button>
      </article>`).join("") : '<div class="empty">Keine Treffer gefunden.</div>';
    $$('[data-suggest]', root).forEach(button => button.addEventListener("click", () => suggestSong(button)));
    wirePreviewButtons(root);
  } catch (error) {
    root.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

async function suggestSong(button) {
  if (!canVoteInDisplayedCycle()) return toast("Bitte oben eine laufende Abstimmung auswählen.", true);
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

async function loadSavedSpeakers() {
  if (!state.member?.can_control_player || reconnectPending) return;
  const previous = $("#savedSpeakerSelect").value;
  const data = await api("/api/v1/music/player/bluetooth/saved");
  state.savedSpeakers = data.devices || [];
  $("#savedSpeakerSelect").innerHTML = state.savedSpeakers.map(device =>
    `<option value="${esc(device.address)}">${esc(device.name)}${device.connected ? " · verbunden" : ""}</option>`
  ).join("") || '<option value="">Noch keine Box gespeichert</option>';
  const preferred = state.savedSpeakers.find(device => device.address === previous)
    || state.savedSpeakers.find(device => device.address === data.selected_address)
    || state.savedSpeakers[0];
  $("#savedSpeakerSelect").value = preferred?.address || "";
  $("#reconnectSpeaker").disabled = !preferred || reconnectPending;
  $("#savedSpeakerStatus").textContent = preferred
    ? "Box einschalten, auswählen und verbinden. Keine neue Suche oder Kopplung nötig."
    : "Eine neue Box muss die Verwaltung zuerst unter Player & Box koppeln.";
}

async function reconnectSpeaker() {
  if (!state.member?.can_control_player || reconnectPending) return;
  const address = $("#savedSpeakerSelect").value;
  if (!state.savedSpeakers.some(device => device.address === address)) return;
  reconnectPending = true;
  $("#reconnectSpeaker").disabled = true;
  $("#reconnectSpeaker").textContent = "Verbinde …";
  $("#savedSpeakerStatus").textContent = "Gespeicherte Box wird verbunden. Bitte eingeschaltet und in Reichweite lassen …";
  try {
    await api("/api/v1/music/player/bluetooth/reconnect", {method: "POST", body: JSON.stringify({address})});
    await loadPlayerState();
    $("#savedSpeakerStatus").textContent = "Bluetooth-Box verbunden. Mit ▶ kannst du die Musik starten.";
    toast("Gespeicherte Box ist verbunden.");
  } catch (error) {
    $("#savedSpeakerStatus").textContent = error.message;
    toast(error.message, true);
  } finally {
    reconnectPending = false;
    $("#reconnectSpeaker").disabled = false;
    $("#reconnectSpeaker").textContent = "Verbinden";
  }
}

function mediaTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function queueSourceLabel(source) {
  return ({ votes: "Abstimmung", previous: "vorherige Playlist", genre: "Genre-Auffüllung", dj: "manuell vom DJ" })[source] || "Playlist";
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
    ? "Playlist aus Abstimmung und Fallback-Regeln erstellen"
    : "Die Verwaltung verbindet zuerst eine Bluetooth-Box");
  const playbackStatus = $("#playerPlaybackStatus");
  playbackStatus.textContent = player.last_error || (player.loading ? "Titel wird geladen …"
    : player.buffering ? "Audio wird gepuffert …"
    : player.next_prepared ? "Nächster Titel ist vorbereitet." : "");
  playbackStatus.hidden = !playbackStatus.textContent;
  playbackStatus.classList.toggle("error", Boolean(player.last_error));
  setMediaImage($("#playerCover"), current?.thumbnail, player.source_mode === "radio");
  $("#playerProgress").max = Math.max(1, Number(player.duration) || 1);
  if (!$("#playerProgress").matches(":active")) $("#playerProgress").value = Number(player.position) || 0;
  $("#playerPosition").textContent = mediaTime(player.position);
  $("#playerDuration").textContent = mediaTime(player.duration);
  $("#playerPlay").textContent = player.playing || player.loading ? "❚❚" : "▶";
  $("#playerPlay").title = player.playing || player.loading ? "Pause" : "Wiedergabe";
  $("#playerVolume").value = Number(player.volume ?? 70);
  $("#playerVolumeValue").textContent = `${Number(player.volume ?? 70)} %`;
  $("#playerMute").textContent = player.muted ? "🔇" : "🔊";
  $('[data-player-action="shuffle"]').classList.toggle("active", Boolean(player.shuffle));
  $("#playerRepeat").classList.toggle("active", player.repeat !== "off");
  $("#playerRepeat").textContent = player.repeat === "one" ? "↻¹" : "↻";

  const queue = player.queue || [];
  const remaining = queue.filter((_, index) => index >= player.current_index).length;
  $("#queueCount").textContent = `${remaining} offen · ${queue.length} gesamt`;
  $("#playerQueue").innerHTML = queue.length ? queue.map((item, index) => `
    <div class="queue-row${index === player.current_index ? " current" : ""}${index < player.current_index ? " played" : ""}">
      <span>${index === player.current_index && player.playing ? "▶" : index + 1}</span>
      <div><strong>${esc(item.title)}</strong><small>${index < player.current_index ? "Gespielt · " : index === player.current_index ? "Jetzt · " : index === player.current_index + 1 ? "Als Nächstes · " : ""}${esc(item.artist || "Unbekannter Interpret")} · ${queueSourceLabel(item.source)}</small></div>
    </div>`).join("") : '<div class="empty">Noch keine Songs geladen.</div>';
  renderDjQueue();
  $("#stopRadio").hidden = player.source_mode !== "radio" || !state.member?.can_control_player;
  const radioMode = player.source_mode === "radio";
  const canControl = Boolean(state.member?.can_control_player);
  $("#playerProgress").disabled = radioMode || !canControl;
  $$('[data-player-action="next"], [data-player-action="previous"]').forEach(button => {
    button.disabled = radioMode || !canControl;
  });
  $$(".radio-playback-status").forEach(node => {
    node.hidden = !radioMode;
    node.textContent = player.last_error || (player.playing
      ? `Live: ${player.radio_station?.name || "Internetradio"}`
      : player.paused ? "Internetradio pausiert." : "Sender wird verbunden …");
  });
  if (state.radioStations.length) renderRadioStations();
}

async function loadRadioStations() {
  const data = await api("/api/v1/music/player/radio/stations");
  state.radioStations = data.stations || [];
  renderRadioStations();
}

function renderRadioStations() {
  const root = $("#radioStations");
  root.innerHTML = state.radioStations.length ? state.radioStations.map(station => `
    <button class="radio-card${state.player.radio_station?.id === station.id ? " active" : ""}" data-radio-play="${station.id}" type="button">
      <img data-radio-logo src="${esc(station.logo_image_url || '/static/radio-placeholder.svg')}" alt="" loading="lazy">
      <span><strong>${esc(station.name)}</strong><small>${esc(station.genre || "Internetradio")}</small></span>
    </button>`).join("") : '<div class="empty">Noch keine Radiosender eingerichtet.</div>';
  $$('[data-radio-play]', root).forEach(button => button.addEventListener("click", async () => {
    if (!state.member) return openMemberDialog();
    if (!state.member.can_control_player) return toast("Du bist für die Player-Bedienung nicht freigegeben.", true);
    button.disabled = true;
    try {
      state.player = await api(`/api/v1/music/player/radio/${button.dataset.radioPlay}/play`, { method: "POST" });
      renderPlayer(); renderRadioStations(); toast(state.player.playing ? "Internetradio läuft." : "Sender wird verbunden …");
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  }));
}

async function stopRadio() {
  try {
    state.player = await api("/api/v1/music/player/radio/stop", { method: "POST" });
    renderPlayer(); renderRadioStations(); toast("Zur Playlist gewechselt.");
  } catch (error) { toast(error.message, true); }
}

async function loadAdminRadioStations() {
  const data = await api("/api/v1/music/admin/radio/stations", {}, true);
  state.savedRadioStations = data.stations || [];
  state.radioStations = (data.stations || []).filter(station => station.active);
  renderRadioStations();
  $("#adminRadioStations").innerHTML = (data.stations || []).map(station => `
    <div class="admin-row"><div class="radio-row-identity"><img class="radio-logo" data-radio-logo src="${esc(station.logo_image_url || '/static/radio-placeholder.svg')}" alt="" loading="lazy"><div><strong>${esc(station.name)}</strong><span>${esc(station.genre || "Ohne Genre")} · ${station.active ? "Aktiv" : "Deaktiviert"}</span></div></div>
      <div class="row-actions"><button class="button primary small" data-admin-radio-play="${station.id}" ${station.active ? "" : "disabled"}>Abspielen</button><button class="button ghost small" data-radio-toggle="${station.id}" data-active="${station.active}">${station.active ? "Deaktivieren" : "Aktivieren"}</button><button class="button ghost small" data-radio-delete="${station.id}">Löschen</button></div></div>`).join("") || '<div class="empty">Noch keine Sender gespeichert.</div>';
  $$('[data-admin-radio-play]').forEach(button => button.addEventListener("click", async () => {
    try {
      state.player = await api(`/api/v1/music/admin/radio/stations/${button.dataset.adminRadioPlay}/play`, { method: "POST" }, true);
      renderPlayer(); toast(state.player.playing ? "Internetradio läuft." : "Sender wird verbunden …");
    } catch (error) { toast(error.message, true); }
  }));
  $$('[data-radio-toggle]').forEach(button => button.addEventListener("click", async () => {
    await api(`/api/v1/music/admin/radio/stations/${button.dataset.radioToggle}`, { method: "PATCH", ...adminHeadersBody({ active: button.dataset.active !== "true" }) }, true);
    await loadAdminRadioStations();
  }));
  $$('[data-radio-delete]').forEach(button => button.addEventListener("click", async () => {
    if (!confirm("Diesen Radiosender wirklich löschen?")) return;
    await api(`/api/v1/music/admin/radio/stations/${button.dataset.radioDelete}`, { method: "DELETE" }, true);
    await loadAdminRadioStations();
  }));
}

async function searchRadioStations(event) {
  event.preventDefault();
  const query = $("#radioSearchInput").value.trim();
  if (query.length < 2) return;
  const button = $("#radioSearchButton");
  const status = $("#radioSearchStatus");
  const root = $("#radioSearchResults");
  button.disabled = true;
  button.textContent = "Suche läuft …";
  root.replaceChildren();
  status.textContent = `Suche nach „${query}“ …`;
  try {
    const data = await api(`/api/v1/music/admin/radio/search?q=${encodeURIComponent(query)}`, {}, true);
    const stations = data.stations || [];
    status.textContent = stations.length
      ? `${stations.length} Treffer · „Hinzufügen“ speichert den Sender in deiner Liste.`
      : "Keine passenden Sender gefunden. Versuche einen anderen Namen oder eine Musikrichtung.";
    root.innerHTML = stations.map((station, index) => {
      const saved = state.savedRadioStations.some(item => item.stream_url === station.stream_url);
      return `<div class="admin-row radio-result"><div><strong>${esc(station.name)}</strong><span>${esc([station.country, station.genre, station.codec].filter(Boolean).join(" · "))}</span></div>
        <div class="row-actions"><button class="button primary small" type="button" data-radio-import="${index}" ${saved ? "disabled" : ""}>${saved ? "Gespeichert" : "Hinzufügen"}</button></div></div>`;
    }).join("");
    $$('[data-radio-import]', root).forEach(addButton => addButton.addEventListener("click", async () => {
      const station = stations[Number(addButton.dataset.radioImport)];
      addButton.disabled = true;
      addButton.textContent = "Wird gespeichert …";
      try {
        const result = await api("/api/v1/music/admin/radio/import", {
          method: "POST", ...adminHeadersBody({ station_uuid: station.station_uuid }),
        }, true);
        addButton.textContent = "Gespeichert";
        status.textContent = result.status === "existing"
          ? `${station.name} ist bereits in deiner Senderliste. Du kannst den Sender unten aktivieren und abspielen.`
          : `${station.name} wurde hinzugefügt. Unten in der Senderliste auf „Abspielen“ tippen.`;
        await loadAdminRadioStations();
      } catch (error) {
        status.textContent = error.message;
        addButton.disabled = false;
        addButton.textContent = "Erneut hinzufügen";
      }
    }));
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Sender suchen";
  }
}

async function createRadioStation(event) {
  event.preventDefault();
  try {
    await api("/api/v1/music/admin/radio/stations", { method: "POST", ...adminHeadersBody({
      name: $("#radioName").value.trim(), genre: $("#radioGenre").value.trim() || null,
      stream_url: $("#radioStreamUrl").value.trim(), fallback_url: $("#radioFallbackUrl").value.trim() || null,
      logo_url: $("#radioLogoUrl").value.trim() || null,
    }) }, true);
    event.target.reset(); await loadAdminRadioStations(); toast("Radiosender gespeichert.");
  } catch (error) { toast(error.message, true); }
}

async function loadActivity(silent = false) {
  try {
    const data = await api("/api/v1/music/activity?limit=8");
    state.activity = data.leaders || [];
    const root = $("#activityLeaderboard");
    root.innerHTML = state.activity.length ? state.activity.map(member => `
      <div class="activity-row${member.rank <= 3 ? ` top-${member.rank}` : ""}">
        <span class="activity-rank">${member.rank}</span>
        <div><strong>${esc(member.display_name)}</strong><small>${member.voted_songs} Songs bewertet · ${member.suggestions} Vorschläge · ${member.player_actions} Player-Aktionen</small></div>
        <b>${member.activity_score}<small> Aktivität</small></b>
      </div>`).join("") : '<div class="empty">In dieser Abstimmung gibt es noch keine Aktivität.</div>';
    root.title = data.formula || "";
  } catch (error) {
    if (!silent) toast(error.message, true);
  }
}

function renderDjQueue() {
  const root = $("#djQueue");
  if (!root || !state.adminPassword) return;
  const player = state.player || {};
  const queue = player.queue || [];
  root.innerHTML = queue.length ? queue.map((item, index) => `
    <div class="dj-queue-row${index === player.current_index ? " current" : ""}${index < player.current_index ? " played" : ""}">
      <span class="queue-position">${index + 1}</span>
      <div><strong>${esc(item.title)}</strong><small>${esc(item.artist || "Unbekannter Interpret")} · ${queueSourceLabel(item.source)}</small></div>
      <div class="row-actions">
        <button class="button ghost tiny" data-dj-play="${index}" type="button">Jetzt</button>
        <button class="button ghost tiny" data-dj-move="${index}" data-target="${index - 1}" type="button" ${index === 0 ? "disabled" : ""} aria-label="Nach oben">↑</button>
        <button class="button ghost tiny" data-dj-move="${index}" data-target="${index + 1}" type="button" ${index === queue.length - 1 ? "disabled" : ""} aria-label="Nach unten">↓</button>
        <button class="button ghost tiny danger" data-dj-remove="${index}" type="button">Entfernen</button>
      </div>
    </div>`).join("") : '<div class="empty">Noch keine Songs geladen.</div>';
  $$('[data-dj-play]', root).forEach(button => button.addEventListener("click", () => djQueueAction("play", Number(button.dataset.djPlay))));
  $$('[data-dj-move]', root).forEach(button => button.addEventListener("click", () => djMoveSong(Number(button.dataset.djMove), Number(button.dataset.target))));
  $$('[data-dj-remove]', root).forEach(button => button.addEventListener("click", () => djQueueAction("remove", Number(button.dataset.djRemove))));
}

async function searchDjSongs(event) {
  event.preventDefault();
  const query = $("#djSearchInput").value.trim();
  const root = $("#djSearchResults");
  root.innerHTML = '<div class="empty">Suche läuft …</div>';
  try {
    const data = await api(`/api/v1/music/admin/player/search?q=${encodeURIComponent(query)}`, {}, true);
    root.innerHTML = (data.results || []).map(song => `
      <div class="dj-result">
        <img src="${esc(song.thumbnail_url || "/pics/logo.png")}" alt="" loading="lazy">
        <div><strong>${esc(song.title)}</strong><small>${esc(song.channel_title || "Unbekannter Interpret")}</small></div>
        <div class="row-actions">
          <button class="button primary tiny" data-dj-add="${esc(song.external_id)}" data-position="next" data-title="${esc(song.title)}" data-channel="${esc(song.channel_title || "")}" type="button">Als Nächstes</button>
          <button class="button ghost tiny" data-dj-add="${esc(song.external_id)}" data-position="end" data-title="${esc(song.title)}" data-channel="${esc(song.channel_title || "")}" type="button">Ans Ende</button>
        </div>
      </div>`).join("") || '<div class="empty">Keine Treffer gefunden.</div>';
    $$('[data-dj-add]', root).forEach(button => button.addEventListener("click", () => djAddSong(button)));
  } catch (error) { root.innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
}

async function djAddSong(button) {
  button.disabled = true;
  try {
    state.player = await api("/api/v1/music/admin/player/queue", {
      method: "POST", body: JSON.stringify({
        external_id: button.dataset.djAdd,
        title: button.dataset.title,
        channel_title: button.dataset.channel,
        position: button.dataset.position,
      }),
    }, true);
    renderPlayer();
    toast(button.dataset.position === "next" ? "Song spielt als Nächstes." : "Song wurde ans Ende gesetzt.");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}

async function djMoveSong(sourceIndex, targetIndex) {
  try {
    state.player = await api(`/api/v1/music/admin/player/queue/${sourceIndex}`, {
      method: "PATCH", body: JSON.stringify({ target_index: targetIndex }),
    }, true);
    renderPlayer();
  } catch (error) { toast(error.message, true); }
}

async function djQueueAction(action, index) {
  if (action === "remove" && !window.confirm("Diesen Song aus der Warteschlange entfernen?")) return;
  try {
    state.player = await api(`/api/v1/music/admin/player/queue/${index}${action === "play" ? "/play" : ""}`, {
      method: action === "play" ? "POST" : "DELETE",
    }, true);
    renderPlayer();
    toast(action === "play" ? "Song wird jetzt abgespielt." : "Song wurde entfernt.");
  } catch (error) { toast(error.message, true); }
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
  if (!state.member.can_control_player) return toast("Du bist für die Player-Bedienung nicht freigegeben.", true);
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
  if (action === "play" && (state.player.playing || state.player.loading)) action = "pause";
  if (action === "shuffle") value = !state.player.shuffle;
  if (action === "repeat") {
    value = state.player.repeat === "off" ? "all" : state.player.repeat === "all" ? "one" : "off";
  }
  if (action === "mute") value = !state.player.muted;
  await playerCommand(action, value);
}

async function queueRanking() {
  if (!state.member) return openMemberDialog();
  if (!state.member.can_control_player) return toast("Du bist für die Player-Bedienung nicht freigegeben.", true);
  const cycle = state.displayedCycle;
  if (!cycle || cyclePhase(cycle) === "planned") return toast("Bitte eine laufende oder abgeschlossene Abstimmung auswählen.", true);
  if (queueRankingPending) return;
  queueRankingPending = true;
  renderCycleSelection();
  try {
    state.player = await api(`/api/v1/music/player/queue/cycles/${cycle.id}`, { method: "POST" });
    renderPlayer();
    const build = state.player.playlist_build;
    setTab("player");
    toast(build
      ? `„${cycle.name}“: ${build.total} Songs geladen. Mit ▶ starten.`
      : `${state.player.queue.length} Songs sind im Player bereit. Mit ▶ starten.`);
  } catch (error) { toast(error.message, true); }
  finally { queueRankingPending = false; renderCycleSelection(); }
}

async function loadSoundboard() {
  const data = await api("/api/v1/music/player/soundboard");
  state.soundboard = data.items || [];
  renderSoundboard();
  renderAdminSoundboard();
}

function soundDuration(item) {
  return item.duration_ms ? `${(item.duration_ms / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} s` : "Eigener Clip";
}

function renderSoundboard() {
  const categories = ["Alle", "Darts", "Jubel", "Spaß", "Eigene"].filter(category =>
    category === "Alle" || state.soundboard.some(item => (item.category || "Eigene") === category));
  if (!categories.includes(state.soundCategory)) state.soundCategory = "Alle";
  $("#soundboardFilters").innerHTML = categories.map(category => {
    const count = state.soundboard.filter(item => category === "Alle" || (item.category || "Eigene") === category).length;
    return `<button class="button ghost small" type="button" data-sound-category="${esc(category)}" aria-pressed="${state.soundCategory === category}">${esc(category)} <span>${count}</span></button>`;
  }).join("");
  $$('[data-sound-category]').forEach(button => button.addEventListener("click", () => {
    state.soundCategory = button.dataset.soundCategory;
    renderSoundboard();
    $$("[data-sound-category]").find(item => item.dataset.soundCategory === state.soundCategory)?.focus();
  }));
  const items = state.soundboard.filter(item => state.soundCategory === "Alle" || (item.category || "Eigene") === state.soundCategory);
  $("#soundboard").innerHTML = items.length ? items.map(item => `
    <button class="sound-button ${esc(item.color)}" data-play-sound="${item.id}" type="button"><strong>${esc(item.name)}</strong><small>${esc(soundDuration(item))}</small></button>
  `).join("") : '<div class="empty">Noch keine Sounds eingerichtet.</div>';
  $$('[data-play-sound]').forEach(button => button.addEventListener("click", async () => {
    if (!state.member) return openMemberDialog();
    if (!state.member.can_control_player) return toast("Du bist für die Player-Bedienung nicht freigegeben.", true);
    button.disabled = true;
    try {
      state.player = await api(`/api/v1/music/player/soundboard/${button.dataset.playSound}/play`, { method: "POST" });
      renderPlayer();
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  }));
}

function renderAdminSoundboard() {
  const root = $("#adminSoundboard");
  if (!root) return;
  root.innerHTML = state.soundboard.length ? state.soundboard.map(item => `
    <div class="admin-row"><div><strong>${esc(item.name)}</strong><span>${esc(item.category || "Eigene")} · ${esc(soundDuration(item))}${item.builtin ? " · ClubIQ-Paket" : ""}</span></div>
      <button class="button ghost small" data-delete-sound="${item.id}" type="button">Entfernen</button></div>
  `).join("") : '<div class="empty">Noch keine Soundboard-Sounds gespeichert.</div>';
  $$('[data-delete-sound]', root).forEach(button => button.addEventListener("click", async () => {
    if (!window.confirm("Diesen Sound aus dem Soundboard entfernen? Er bleibt auch nach einem Update ausgeblendet.")) return;
    try {
      await api(`/api/v1/music/admin/soundboard/${button.dataset.deleteSound}`, { method: "DELETE" }, true);
      await loadSoundboard();
      toast("Sound wurde entfernt.");
    } catch (error) { toast(error.message, true); }
  }));
}

async function loadSpeakers(silent = false) {
  try {
    const data = await api("/api/v1/music/player/bluetooth/devices", {}, true);
    state.speakers = data.devices || [];
    renderSpeakers();
    return true;
  } catch (error) {
    state.speakers = [];
    $("#speakerList").innerHTML = `<div class="empty">${esc(error.message)} Starte auf dem Raspberry einmal das Player-Installationsskript.</div>`;
    speakerMessage(error.message, true);
    if (!silent) toast(error.message, true);
    return false;
  }
}

function speakerMessage(message, error = false) {
  const node = $("#speakerStatus");
  node.textContent = message;
  node.hidden = !message;
  node.className = `speaker-status${error ? " error" : ""}`;
}

let speakerBusy = false;
function setSpeakerBusy(busy) {
  speakerBusy = busy;
  $$("#scanSpeakers, [data-speaker-action]").forEach(button => { button.disabled = busy; });
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
  setSpeakerBusy(speakerBusy);
}

async function scanSpeakers() {
  if (speakerBusy) return;
  const button = $("#scanSpeakers");
  setSpeakerBusy(true);
  button.textContent = "Suche läuft …";
  speakerMessage("Bluetooth-Boxen werden gesucht …");
  try {
    const data = await api("/api/v1/music/player/bluetooth/scan", { method: "POST" }, true);
    state.speakers = data.devices || [];
    renderSpeakers();
    const message = `${state.speakers.length} Bluetooth-Gerät${state.speakers.length === 1 ? "" : "e"} gefunden.`;
    speakerMessage(message);
    toast(message);
  } catch (error) { speakerMessage(error.message, true); toast(error.message, true); }
  finally { setSpeakerBusy(false); button.textContent = "Boxen suchen"; }
}

async function speakerAction(button) {
  if (speakerBusy) return;
  const operation = button.dataset.speakerAction;
  const originalLabel = button.textContent;
  setSpeakerBusy(true);
  button.textContent = operation === "connect" ? "Verbinde …" : "Bitte warten …";
  speakerMessage(operation === "connect"
    ? "Die Box wird gekoppelt und verbunden. Bitte im Kopplungsmodus lassen; das kann bis zu einer Minute dauern."
    : "Bluetooth-Verbindung wird aktualisiert …");
  try {
    await api(`/api/v1/music/player/bluetooth/${operation}`, {
      method: "POST", body: JSON.stringify({ address: button.dataset.address }),
    }, true);
    const [refreshed] = await Promise.all([loadSpeakers(), loadPlayerState(true)]);
    if (refreshed) {
      const message = operation === "connect" ? "Bluetooth-Box ist verbunden." : "Bluetooth-Box wurde aktualisiert.";
      speakerMessage(message);
      toast(message);
    }
  } catch (error) { speakerMessage(error.message, true); toast(error.message, true); }
  finally { setSpeakerBusy(false); button.textContent = originalLabel; }
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
    loadSpeakers(true), loadSoundboard(), loadBackupStatus(), loadAdminRadioStations(),
  ]);
  await loadPlayerState(true);
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

async function loadBackupStatus() {
  const node = $("#backupStatus");
  try {
    const status = await api("/api/v1/music/admin/backup/status", {}, true);
    node.className = `backup-status${status.ok ? " good" : " bad"}`;
    const finished = status.finished_at ? formatDate(status.finished_at) : "noch nicht ausgeführt";
    const size = status.size_bytes ? `${Math.max(1, Math.round(status.size_bytes / 1024))} KB` : "–";
    node.innerHTML = `<strong>${status.ok ? "Sicherung geprüft" : "Sicherung prüfen"}</strong><span>${esc(status.message || finished)} · ${size}${status.usb_copied ? " · zusätzlich auf USB" : ""}</span>`;
  } catch (error) {
    node.className = "backup-status bad";
    node.innerHTML = `<strong>Nicht abrufbar</strong><span>${esc(error.message)}</span>`;
  }
}

async function installPwa() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("#installPwa").hidden = true;
}

async function loadAdminCycles() {
  await loadCycles();
  const root = $("#cycleList");
  root.innerHTML = state.cycles.map(cycle => `
    <div class="cycle-admin-card">
      <div class="admin-row">
        <div><strong>${esc(cycle.name)}</strong><span>${cyclePhase(cycle) === "active" ? "Aktiv" : cyclePhase(cycle) === "closed" ? "Beendet" : "Geplant"} · ${formatDate(cycle.starts_at)} bis ${formatDate(cycle.closes_at)} · ${cycle.max_budget} Punkte</span><span>Playlist-Länge: ${cycle.playlist_target_count} Songs · vorherige Liste ${cycle.reuse_previous_playlist ? "an" : "aus"} · ${cycle.genre_fallback_enabled ? `mit ${esc(cycle.fallback_genre)} auffüllen` : "Genre-Auffüllung aus"}</span></div>
        <div class="row-actions">
          ${cyclePhase(cycle) === "planned" && !state.activeCycle ? `<button class="button ghost small" data-cycle-action="active" data-cycle-id="${cycle.id}">Jetzt starten</button>` : ""}
          ${cycle.status === "active" ? `<button class="button ghost small" data-cycle-action="closed" data-cycle-id="${cycle.id}">Beenden</button>` : ""}
        </div>
      </div>
      <details class="cycle-settings">
        <summary>Playlist-Regeln bearbeiten</summary>
        <form class="cycle-rule-form" data-cycle-settings="${cycle.id}">
          <label>Länge (Songs)<input name="playlist_target_count" type="number" min="1" max="50" value="${cycle.playlist_target_count}" required></label>
          <label>Auffüll-Genre<input name="fallback_genre" maxlength="80" value="${esc(cycle.fallback_genre || "Party")}"></label>
          <label class="check-control"><input name="reuse_previous_playlist" type="checkbox" ${cycle.reuse_previous_playlist ? "checked" : ""}><span>Vorherige Playlist nutzen</span></label>
          <label class="check-control"><input name="genre_fallback_enabled" type="checkbox" ${cycle.genre_fallback_enabled ? "checked" : ""}><span>Mit Genre-Hits auffüllen</span></label>
          <button class="button primary small" type="submit">Regeln speichern</button>
        </form>
      </details>
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
  $$('[data-cycle-settings]', root).forEach(form => form.addEventListener("submit", async event => {
    event.preventDefault();
    const fields = new FormData(form);
    try {
      await api(`/api/v1/music/admin/cycles/${form.dataset.cycleSettings}`, {
        method: "PATCH", ...adminHeadersBody({
          playlist_target_count: Number(fields.get("playlist_target_count")),
          fallback_genre: String(fields.get("fallback_genre") || "").trim(),
          reuse_previous_playlist: fields.has("reuse_previous_playlist"),
          genre_fallback_enabled: fields.has("genre_fallback_enabled"),
        }),
      }, true);
      await loadAdminCycles();
      toast("Playlist-Regeln gespeichert.");
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
        playlist_target_count: Number($("#cyclePlaylistTarget").value),
        fallback_genre: $("#cycleFallbackGenre").value.trim(),
        reuse_previous_playlist: $("#cycleReusePrevious").checked,
        genre_fallback_enabled: $("#cycleUseGenre").checked,
      }),
    }, true);
    event.target.reset();
    $("#cycleBudget").value = "10";
    $("#cyclePlaylistTarget").value = "20";
    $("#cycleFallbackGenre").value = "Party";
    $("#cycleReusePrevious").checked = true;
    $("#cycleUseGenre").checked = true;
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
      <div><strong>${esc(member.display_name)}</strong><span>${member.active ? "Aktiv" : "Deaktiviert"} · ${member.pin_ready ? "PIN eingerichtet" : "PIN beim ersten Login festlegen"} · ${member.can_control_player ? "Player freigegeben" : "Player gesperrt"}</span></div>
      <div class="row-actions">
        <button class="button ghost small" data-toggle-player="${esc(member.member_id)}" data-player="${member.can_control_player}">${member.can_control_player ? "Player sperren" : "Player freigeben"}</button>
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
  $$('[data-toggle-player]', root).forEach(button => button.addEventListener("click", async () => {
    try {
      await api(`/api/v1/music/admin/members/${encodeURIComponent(button.dataset.togglePlayer)}`, {
        method: "PATCH", ...adminHeadersBody({ can_control_player: button.dataset.player !== "true" }),
      }, true);
      await loadAdminMembers();
      toast("Player-Freigabe aktualisiert.");
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
  $("#previewStart").addEventListener("click", startPreview);
  $("#previewDialog").addEventListener("close", () => { $("#previewFrame").replaceChildren(); previewVideoId = ""; });
  $("#refreshPlaylist").addEventListener("click", () => refreshVotingState().catch(error => toast(error.message, true)));
  $("#cycleSelect").addEventListener("change", event => selectCycle(Number(event.target.value)));
  $("#adminLogin").addEventListener("submit", adminLogin);
  $("#adminLogout").addEventListener("click", adminLogout);
  $("#cycleForm").addEventListener("submit", createCycle);
  $("#memberCreateForm").addEventListener("submit", createMember);
  $("#radioStationForm").addEventListener("submit", createRadioStation);
  $("#radioSearchForm").addEventListener("submit", searchRadioStations);
  $("#adminStopRadio").addEventListener("click", async () => {
    try {
      state.player = await api("/api/v1/music/admin/radio/stop", { method: "POST" }, true);
      renderPlayer(); toast("Zur Playlist gewechselt.");
    } catch (error) { toast(error.message, true); }
  });
  $("#stopRadio").addEventListener("click", stopRadio);
  $$('[data-player-action]').forEach(button => button.addEventListener("click", () => handlePlayerAction(button)));
  $("#queueFromRanking").addEventListener("click", queueRanking);
  $("#queueSelectedPlaylist").addEventListener("click", queueRanking);
  $("#refreshPlayer").addEventListener("click", () => loadPlayerState());
  $("#reconnectSpeaker").addEventListener("click", reconnectSpeaker);
  $("#refreshSavedSpeakers").addEventListener("click", () => loadSavedSpeakers().catch(error => toast(error.message, true)));
  $("#playerProgress").addEventListener("change", event => playerCommand("seek", Number(event.target.value)));
  $("#playerVolume").addEventListener("change", event => playerCommand("volume", Number(event.target.value)));
  $("#scanSpeakers").addEventListener("click", scanSpeakers);
  $("#soundUploadForm").addEventListener("submit", uploadSound);
  $("#djSearchForm").addEventListener("submit", searchDjSongs);
  $("#refreshDjQueue").addEventListener("click", () => loadPlayerState());
  $("#refreshActivity").addEventListener("click", () => loadActivity());
  $("#refreshBackup").addEventListener("click", () => loadBackupStatus());
  $("#installPwa").addEventListener("click", installPwa);
  window.addEventListener("online", () => { $("#connectionState").innerHTML = "<i></i> Lokal bereit"; });
  window.addEventListener("offline", () => { $("#connectionState").innerHTML = "<i></i> Offline im Kassen-WLAN"; });
}

async function start() {
  bindEvents();
  try {
    await Promise.all([loadCycles(), loadMembers(), loadPlayerState(true), loadSoundboard(), loadRadioStations(), loadActivity(true)]);
    await restoreMember();
    renderSession();
    await loadPlaylist();
  } catch (error) {
    toast(error.message, true);
  }
}

start();
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $("#installPwa").hidden = false;
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  $("#installPwa").hidden = true;
});
setInterval(updateCountdown, 1000);
setInterval(() => loadPlaylist().catch(() => {}), 30000);
setInterval(() => loadActivity(true).catch(() => {}), 30000);
setInterval(() => {
  if (!document.hidden) loadPlayerState(true).catch(() => {});
}, 3000);
