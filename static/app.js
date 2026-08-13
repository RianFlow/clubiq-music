"use strict";

const state = {
  token: localStorage.getItem("clubiq_music_token") || "",
  adminPassword: sessionStorage.getItem("clubiq_music_admin") || "",
  member: null,
  cycles: [],
  activeCycle: null,
  budget: { remaining: 0, maximum: 0 },
  playlist: [],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>'"]/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

let toastTimer;
function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = "toast"; }, 2800);
}

async function api(path, options = {}, admin = false) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
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

function setTab(name) {
  $$(".tab").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
  $$(".tab-panel").forEach(panel => panel.classList.toggle("active", panel.id === `tab-${name}`));
  if (name === "mine") renderMyVotes();
}

function setAdminTab(name) {
  $$(".subtab").forEach(button => button.classList.toggle("active", button.dataset.adminTab === name));
  $$(".admin-panel").forEach(panel => panel.classList.toggle("active", panel.id === `admin-${name}`));
}

function renderSession() {
  const loggedIn = Boolean(state.member);
  $("#loginHint").hidden = loggedIn;
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
  state.playlist = [];
  state.budget = { remaining: 0, maximum: 0 };
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
  state.activeCycle = state.cycles.find(cycle => cycle.status === "active") || null;
  $("#cycleName").textContent = state.activeCycle?.name || "Keine aktive Abstimmung";
  $("#cycleMeta").textContent = state.activeCycle
    ? `Geöffnet bis ${formatDate(state.activeCycle.closes_at)} · ${state.activeCycle.max_budget} Punkte pro Mitglied`
    : "Die Verwaltung kann eine neue Abstimmung starten.";
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
  if (!state.member || !state.activeCycle) {
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
  return `
    <article class="song-card" data-song-id="${song.suggestion_id}">
      <span class="song-rank">${mine ? "♪" : song.rank}</span>
      <div class="song-copy">
        <strong>${esc(song.title)}</strong>
        <span>${esc(song.channel_title || "Unbekannter Interpret")}${song.suggested_by_me ? " · <em>von dir vorgeschlagen</em>" : ""}</span>
      </div>
      ${mine ? `
        <div class="points">
          <button type="button" data-vote="-1" aria-label="Einen Punkt entfernen">−</button>
          <strong>${song.my_points}</strong>
          <button type="button" data-vote="1" aria-label="Einen Punkt hinzufügen">+</button>
        </div>` : `
        <div class="points">
          <button type="button" data-vote="-1" aria-label="Einen Punkt entfernen">−</button>
          <strong>${song.my_points}</strong>
          <button type="button" data-vote="1" aria-label="Einen Punkt hinzufügen">+</button>
        </div>
        <div class="total"><strong>${song.total_points}</strong><small>gesamt</small></div>`}
    </article>`;
}

function wireVoteButtons(root) {
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
  if (!state.member) {
    root.innerHTML = '<div class="empty">Melde dich an, um die Rangliste zu sehen und Punkte zu vergeben.</div>';
  } else if (!state.activeCycle) {
    root.innerHTML = '<div class="empty">Derzeit ist keine Abstimmung geöffnet.</div>';
  } else if (!state.playlist.length) {
    root.innerHTML = '<div class="empty">Noch keine Songs vorhanden. Mach den ersten Vorschlag.</div>';
  } else {
    root.innerHTML = state.playlist.map(song => songCard(song)).join("");
    wireVoteButtons(root);
  }
  $("#mineCount").textContent = state.playlist.filter(song => song.my_points > 0).length;
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

async function logout() {
  if (!state.member) return;
  try { await api("/api/v1/music/auth/logout", { method: "POST" }); } catch (_) { /* local logout still works */ }
  clearMemberSession();
}

async function searchSongs(event) {
  event.preventDefault();
  if (!state.member) {
    $("#memberDialog").showModal();
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
        <span class="song-rank">${index + 1}</span>
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
  await Promise.all([loadAdminStats(), loadAdminCycles(), loadAdminMembers(), loadVoteHistory()]);
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
      <div><strong>${esc(cycle.name)}</strong><span>${cycle.status === "active" ? "Aktiv" : cycle.status === "closed" ? "Beendet" : "Geplant"} · bis ${formatDate(cycle.closes_at)} · ${cycle.max_budget} Punkte</span></div>
      <div class="row-actions">
        ${cycle.status !== "active" ? `<button class="button ghost small" data-cycle-action="active" data-cycle-id="${cycle.id}">Aktivieren</button>` : ""}
        ${cycle.status === "active" ? `<button class="button ghost small" data-cycle-action="closed" data-cycle-id="${cycle.id}">Beenden</button>` : ""}
      </div>
    </div>`).join("") || '<div class="empty">Noch keine Abstimmung vorhanden.</div>';
  $$('[data-cycle-action]', root).forEach(button => button.addEventListener("click", async () => {
    try {
      await api(`/api/v1/music/admin/cycles/${button.dataset.cycleId}`, {
        method: "PATCH", ...adminHeadersBody({ status: button.dataset.cycleAction }),
      }, true);
      await loadAdminCycles();
      await loadPlaylist();
      toast("Abstimmung aktualisiert.");
    } catch (error) { toast(error.message, true); }
  }));
}

async function createCycle(event) {
  event.preventDefault();
  try {
    await api("/api/v1/music/admin/cycles", {
      method: "POST", ...adminHeadersBody({
        name: $("#cycleTitle").value.trim(),
        duration_days: Number($("#cycleDays").value),
        max_budget: Number($("#cycleBudget").value),
      }),
    }, true);
    event.target.reset();
    $("#cycleDays").value = "7";
    $("#cycleBudget").value = "10";
    await Promise.all([loadAdminCycles(), loadAdminStats()]);
    await loadPlaylist();
    toast("Neue Abstimmung gestartet.");
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
  $$('[data-open-member]').forEach(button => button.addEventListener("click", () => $("#memberDialog").showModal()));
  $("#memberOpen").addEventListener("click", () => state.member ? logout() : $("#memberDialog").showModal());
  $("#adminOpen").addEventListener("click", openAdmin);
  $$('[data-close]').forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  $$("dialog").forEach(dialog => dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  }));
  $("#loginForm").addEventListener("submit", login);
  $("#searchForm").addEventListener("submit", searchSongs);
  $("#refreshPlaylist").addEventListener("click", loadPlaylist);
  $("#adminLogin").addEventListener("submit", adminLogin);
  $("#adminLogout").addEventListener("click", adminLogout);
  $("#cycleForm").addEventListener("submit", createCycle);
  $("#memberCreateForm").addEventListener("submit", createMember);
  window.addEventListener("online", () => { $("#connectionState").innerHTML = "<i></i> Lokal bereit"; });
  window.addEventListener("offline", () => { $("#connectionState").innerHTML = "<i></i> Offline im Kassen-WLAN"; });
}

async function start() {
  bindEvents();
  try {
    await Promise.all([loadCycles(), loadMembers()]);
    await restoreMember();
    renderSession();
    await loadPlaylist();
  } catch (error) {
    toast(error.message, true);
  }
}

start();
