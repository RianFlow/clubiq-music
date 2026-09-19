"use strict";
let libraryOwner = "", libraryGeneration = 0, librarySongs = [], eveningBusy = false;
let eveningRequest = "";

function eveningRequestId() {
  // randomUUID requires HTTPS; the local Vereins-WLAN may use plain HTTP.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(n => n.toString(16).padStart(2,"0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

const libraryPanel = document.createElement("section");
libraryPanel.id = "tab-library";
libraryPanel.className = "tab-panel";
libraryPanel.innerHTML = `<div class="section-head"><div><p class="eyebrow">Wiederfinden statt neu suchen</p><h2>Meine Musik</h2></div><button id="libraryRefresh" class="button ghost" type="button">Aktualisieren</button></div>
  <p id="libraryStatus" role="status"></p>
  <div id="libraryContent" hidden>
    <h3>Persönliche Favoriten</h3><p class="muted">Mit „☆ Merken“ bei einem Song speichern. Deine Favoriten sind nur für dich sichtbar, auch auf anderen Geräten.</p>
    <div id="favoriteSongs" class="song-list"></div>
    <h3>Im Vereinsheim gestartet</h3><label>Abend auswählen<input id="historyDay" type="date"></label>
    <p class="muted">Tatsächlich gestartete Songs und Radiosender, keine bloß geladenen Playlists. Letzte 90 Tage · Zeitzone Berlin · Abgleich etwa alle 30 Sekunden. Radio zeigt den Sender, nicht dessen einzelne Lieder.</p>
    <div id="historySongs" class="song-list"></div>
  </div>`;
$("#tab-player").before(libraryPanel);
$("#historyDay").value = new Intl.DateTimeFormat("en-CA", {timeZone:"Europe/Berlin",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
$("#libraryRefresh").addEventListener("click", loadMusicLibrary);
$("#historyDay").addEventListener("change", loadMusicLibrary);

function renderComfort() {
  const owner = state.token || "";
  if (libraryOwner !== owner) {
    libraryOwner = owner; libraryGeneration++; librarySongs = [];
    $("#favoriteSongs").replaceChildren(); $("#historySongs").replaceChildren();
    $("#libraryContent").hidden = true;
    $("#libraryStatus").textContent = state.member ? "Bitte aktualisieren, um deine Musik zu laden." : "Bitte oben anmelden, um Favoriten und Verlauf zu sehen.";
  }
  const p = state.player || {}, current = p.current;
  $("#miniPlayer").hidden = !current || state.tab === "player";
  document.body.classList.toggle("has-mini-player", Boolean(current) && state.tab !== "player");
  $("#miniTitle").textContent = current?.title || "";
  $("#miniPause").hidden = !state.member?.can_control_player;
  $("#miniPause").disabled = playerStale || playerMutationsPending > 0;
  $("#miniPause").textContent = p.playing || p.loading ? "Pause" : "Start";
  $("#miniFavorite").hidden = !state.member || !currentSong();
  $("#openEvening").hidden = !state.member?.can_control_player;
  $("#fallbackMessage").textContent = p.fallback_active ? "Ersatzsender läuft nach einer Stream-Störung. Mit „Radio beenden“ zur pausierten Playlist zurückkehren."
    : p.fallback_enabled ? `Ersatzsender bereit: ${p.fallback_name}. Wechsel nach 45 Sekunden Stream-Störung.` : "Kein automatischer Ersatzsender aktiviert.";
  $("#disableFallback").hidden = !p.fallback_enabled || !state.member?.can_control_player;
}

function currentSong() {
  const p = state.player || {}, current = p.current;
  if (!current || p.source_mode === "radio") return null;
  let id = "";
  try { id = new URL(current.url).searchParams.get("v") || ""; } catch (_) { /* No playable URL. */ }
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  return {external_id:id,title:current.title,channel_title:current.artist || ""};
}

async function saveMusicFavorite(song, button) {
  if (!state.member) return openMemberDialog();
  button.disabled = true;
  const original = button.textContent;
  try {
    await api("/api/v1/music/library/favorites", {method:"PUT",body:JSON.stringify(song)});
    button.textContent = "✓ Gemerkt";
    toast("In deinen persönlichen Favoriten gespeichert.");
  } catch (error) { button.textContent = original; toast(error.message, true); }
  finally { button.disabled = false; }
}

document.addEventListener("click", event => {
  const button = event.target.closest("[data-save-favorite]");
  if (!button) return;
  saveMusicFavorite({external_id:button.dataset.saveFavorite,title:button.dataset.title,
    channel_title:button.dataset.channel || "",duration_ms:Number(button.dataset.duration) || null}, button);
});

async function loadMusicLibrary() {
  renderComfort();
  if (!state.member) return;
  const generation = ++libraryGeneration, token = state.token;
  $("#libraryStatus").textContent = "Deine Musik wird geladen …";
  try {
    const [favorites, history] = await Promise.all([
      api("/api/v1/music/library/favorites"),
      api(`/api/v1/music/library/history?day=${encodeURIComponent($("#historyDay").value)}`),
    ]);
    if (generation !== libraryGeneration || token !== state.token) return;
    librarySongs = favorites.favorites || [];
    const card = (song, index, favorite) => `<article class="song-card comfort-song"><div class="song-copy"><strong>${esc(song.title)}</strong>
      <span>${esc(song.channel_title || song.artist || "")}${song.started_at ? ` · ${esc(new Date(song.started_at).toLocaleTimeString("de-DE", {timeZone:"Europe/Berlin",hour:"2-digit",minute:"2-digit"}))} Uhr` : ""}</span>${previewButton(song, favorite)}</div>
      ${favorite ? `<div class="comfort-actions"><button type="button" class="button primary small" data-library-suggest="${index}" ${canVoteInDisplayedCycle() ? "" : "disabled"}>Zur Abstimmung vorschlagen</button><button type="button" class="button ghost small" data-remove-favorite="${esc(song.external_id)}">Entfernen</button></div>` : ""}</article>`;
    $("#favoriteSongs").innerHTML = librarySongs.map((s,i) => card(s,i,true)).join("") || '<p class="empty">Noch keine Favoriten. Tippe bei einem Song auf „☆ Merken“.</p>';
    $("#historySongs").innerHTML = (history.history || []).map((s,i) => card(s,i,false)).join("") || '<p class="empty">Für diesen Tag gibt es noch keine aufgezeichnete Wiedergabe.</p>';
    $("#libraryContent").hidden = false;
    $("#libraryStatus").textContent = `${librarySongs.length} von 200 Favoriten${history.truncated ? " · Verlauf auf die letzten 200 Starts dieses Tages begrenzt" : ""}${!canVoteInDisplayedCycle() ? " · Neue Vorschläge sind wieder bei einer geöffneten Abstimmung möglich." : ""}`;
    $("#libraryStatus").textContent += history.last_sync
      ? ` · Verlauf zuletzt abgeglichen: ${new Date(history.last_sync).toLocaleString("de-DE")}`
      : " · Verlauf wartet auf den ersten Abgleich mit dem Player.";
    wirePreviewButtons(libraryPanel);
    $$('[data-remove-favorite]', libraryPanel).forEach(button => button.addEventListener("click", async () => {
      button.disabled = true;
      try { await api(`/api/v1/music/library/favorites/${encodeURIComponent(button.dataset.removeFavorite)}`, {method:"DELETE"}); await loadMusicLibrary(); }
      catch (error) { toast(error.message,true); button.disabled = false; }
    }));
    $$('[data-library-suggest]', libraryPanel).forEach(button => button.addEventListener("click", () => {
      const song = librarySongs[Number(button.dataset.librarySuggest)];
      button.dataset.suggest = song.external_id; button.dataset.title = song.title;
      button.dataset.channel = song.channel_title; button.dataset.duration = song.duration_ms || "";
      suggestSong(button);
    }));
  } catch (error) {
    if (generation === libraryGeneration && token === state.token) $("#libraryStatus").textContent = `Musik konnte nicht aktualisiert werden: ${error.message}`;
  }
}

const fallbackPanel = document.createElement("section");
fallbackPanel.className = "panel-box";
fallbackPanel.innerHTML = '<p id="fallbackMessage" role="status"></p><button id="disableFallback" class="button ghost" type="button" hidden>Ersatzsender ausschalten</button>';
$("#savedSpeakerPanel").after(fallbackPanel);
$("#disableFallback").addEventListener("click", async () => {
  $("#disableFallback").disabled = true;
  const mutation = ++playerMutationVersion;
  playerMutationsPending++;
  try { const player = await api("/api/v1/music/player/fallback/disable", {method:"POST"}); if (mutation === playerMutationVersion) state.player = player; renderPlayer(); }
  catch(error) { toast(error.message,true); }
  finally { playerMutationsPending--; $("#disableFallback").disabled = false; renderPlayer(); }
});
$("#miniOpen").addEventListener("click", () => { setTab("player"); $("#tab-player").scrollIntoView({block:"start",behavior:"smooth"}); });
$("#miniPause").addEventListener("click", () => playerCommand(state.player.playing || state.player.loading ? "pause" : "play"));
$("#miniFavorite").addEventListener("click", () => { const song = currentSong(); if (song) saveMusicFavorite(song, $("#miniFavorite")); });

function eveningSummary() {
  const radio = $("#eveningSource").value.startsWith("radio:");
  $("#eveningFallback").disabled = radio;
  if (radio) $("#eveningFallback").value = "";
  $("#eveningVolumeLabel").value = `${$("#eveningVolume").value} %`;
  const label = id => $(id).selectedOptions[0]?.textContent || "nicht ausgewählt";
  $("#eveningSummary").textContent = `Starten auf „${label("#eveningSpeaker") }“ mit „${label("#eveningSource")}“ bei ${$("#eveningVolume").value} % Lautstärke. Ersatzsender: ${$("#eveningFallback").value ? label("#eveningFallback") : "aus"}.${Number($("#eveningVolume").value) > 70 ? " Achtung: hohe Startlautstärke!" : ""}`;
  eveningRequest = "";
}
$("#eveningForm").addEventListener("input", eveningSummary);
$("#openEvening").addEventListener("click", async () => {
  if (!state.member?.can_control_player) return;
  if ($("#eveningDialog").open) return;
  $("#eveningError").textContent = "Boxen und Quellen werden geladen …";
  $("#confirmEvening").disabled = true;
  $("#eveningDialog").showModal();
  try {
    const [speakers, stations] = await Promise.all([
      api("/api/v1/music/player/bluetooth/saved", {timeoutMs:35000}),
      api("/api/v1/music/player/radio/stations"),
    ]);
    if (!state.member?.can_control_player) throw new Error("Bitte erneut anmelden.");
    state.savedSpeakers = speakers.devices || [];
    state.radioStations = stations.stations || [];
    $("#eveningSpeaker").innerHTML = '<option value="">Bitte Box auswählen</option>' + state.savedSpeakers.map(s => `<option value="${esc(s.address)}">${esc(s.name || s.address)}</option>`).join("");
    $("#eveningSource").innerHTML = '<option value="">Bitte Musikquelle auswählen</option>' + state.cycles.filter(c => cyclePhase(c) !== "planned").map(c => `<option value="cycle:${c.id}">Playlist: ${esc(c.name)}</option>`).join("") + state.radioStations.map(s => `<option value="radio:${s.id}">Radio: ${esc(s.name)}</option>`).join("");
    $("#eveningFallback").innerHTML = '<option value="">Aus – Musik bei Fehler anhalten</option>' + state.radioStations.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
    $("#eveningVolume").value = "40";
    eveningSummary();
    $("#eveningError").textContent = state.savedSpeakers.length ? "" : "Keine gespeicherte Box gefunden. Bitte zuerst in der Verwaltung koppeln.";
    $("#confirmEvening").disabled = !state.savedSpeakers.length;
  } catch(error) { $("#eveningError").textContent = error.message; }
});
$("#closeEvening").addEventListener("click", () => { if (!eveningBusy) $("#eveningDialog").close(); });
$("#eveningDialog").addEventListener("cancel", event => { if (eveningBusy) event.preventDefault(); });
$("#eveningForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (eveningBusy || !state.member?.can_control_player) return;
  const [kind,id] = $("#eveningSource").value.split(":");
  if (!id || !$("#eveningSpeaker").value) return;
  eveningBusy = true;
  eveningRequest ||= eveningRequestId();
  const payload = {request_id:eveningRequest,address:$("#eveningSpeaker").value,volume:Number($("#eveningVolume").value),
    cycle_id:kind === "cycle" ? Number(id) : null, station_id:kind === "radio" ? Number(id) : null,
    fallback_station_id:kind === "cycle" && $("#eveningFallback").value ? Number($("#eveningFallback").value) : null};
  $$("input,select,button", $("#eveningForm")).forEach(n => { n.disabled = true; });
  $("#eveningError").textContent = "Box wird verbunden, Musik wird gestartet. Das kann bis zu zwei Minuten dauern …";
  const mutation = ++playerMutationVersion;
  playerMutationsPending++;
  try {
    const result = await api("/api/v1/music/player/evening/start", {method:"POST",body:JSON.stringify(payload),timeoutMs:120000});
    if (mutation === playerMutationVersion) state.player = result;
    playerStale = false;
    $("#eveningDialog").close(); setTab("player"); renderPlayer();
    toast("Abendstart an den Player übergeben. Der Status zeigt, sobald Musik läuft.");
  } catch(error) { $("#eveningError").textContent = `${error.message} Bei Zeitüberschreitung zuerst den Playerstatus prüfen; derselbe Start kann gefahrlos erneut bestätigt werden.`; }
  finally {
    eveningBusy = false; playerMutationsPending--;
    $$("input,select,button", $("#eveningForm")).forEach(n => { n.disabled = false; });
    $("#eveningFallback").disabled = kind === "radio"; renderPlayer();
  }
});
renderComfort();
