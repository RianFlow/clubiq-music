"use strict";

// Shared by the main player, DJ remote and party display. Never retry writes:
// a lost acknowledgement does not mean the command was not executed.
async function musicRequestJson(path, options = {}) {
  const {timeoutMs = options.method && options.method !== "GET" ? 100000 : 12000, ...init} = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  init.signal?.addEventListener("abort", abort, {once:true});
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(path, {...init, signal:controller.signal});
    const data = await response.json().catch(() => null);
    if (!response.ok || data === null) {
      const error = new Error(data?.detail || data?.error || (response.ok
        ? "Keine gültige Antwort vom Musikserver. Bitte die Seite neu laden, falls die Anmeldung abgelaufen ist."
        : `Musikserver antwortet mit Fehler ${response.status}.`));
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.status) throw error;
    throw new Error(init.method && init.method !== "GET"
      ? "Keine Antwort erhalten. Bitte erst den Status prüfen, bevor du die Aktion erneut ausführst."
      : "Der Musikserver ist gerade nicht erreichbar. Die Wiedergabe auf der Box kann weiterlaufen.");
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

// Schedule after completion, not on a fixed interval: slow connections must
// never build up overlapping requests. Back off on outages; wake on demand.
function createMusicPoller(refresh, {interval=3000, maxDelay=30000, enabled=()=>!document.hidden} = {}) {
  let timer, pending=null, failures=0, active=false;
  const schedule = () => {
    clearTimeout(timer);
    if (active) timer = setTimeout(run, Math.min(maxDelay, interval * 2 ** failures));
  };
  function run() {
    if (pending) return pending;
    clearTimeout(timer);
    if (!enabled()) { schedule(); return Promise.resolve(); }
    pending = Promise.resolve().then(refresh).then(result => {
      failures = result === false ? Math.min(failures + 1, 5) : 0;
    }).catch(() => { failures = Math.min(failures + 1, 5); }).finally(() => {
      pending = null;
      schedule();
    });
    return pending;
  }
  return {refresh:run, start() { active=true; schedule(); }, stop() { active=false; clearTimeout(timer); }};
}

function musicPlaybackSummary(player = {}, stale = false) {
  if (stale) return {level:"warn", title:"Verbindung unterbrochen", hint:"Letzter bekannter Stand – die Musik kann weiterhin laufen. Der Status wird automatisch erneut abgefragt."};
  if (player.available === false) return {level:"error", title:"Player-Dienst nicht erreichbar", hint:"Der Musikserver antwortet, aber der Player auf dem Raspberry ist nicht bereit. Bitte den Dienst im Wartungsbereich prüfen."};
  if (!player.speaker?.connected) return {level:"warn", title:"Keine Box verbunden", hint:"Box einschalten und oben die gespeicherte Box verbinden. Eine neue Suche ist dafür nicht nötig."};
  if (player.sound_active) return {level:"ok", title:"Soundboard läuft", hint:"Danach wird die Musik automatisch fortgesetzt."};
  if (player.last_error) return {level:"error", title:"Wiedergabe braucht Aufmerksamkeit", hint:player.last_error};
  if (player.muted || Number(player.volume) === 0) return {level:"warn", title:"Ton ist ausgeschaltet", hint:player.muted ? "Stummschaltung am Lautsprechersymbol aufheben." : "Die Lautstärke steht auf 0 %."};
  if (player.buffering) return {level:"warn", title:"Musik puffert nach", hint:"Der Audiopuffer wird aufgefüllt. Bitte kurz warten; wiederholtes Starten leert den Puffer erneut."};
  if (player.loading) return {level:"info", title:"Titel wird vorbereitet", hint:"Stream wird geöffnet und ein Startpuffer aufgebaut. Die Wiedergabe beginnt automatisch."};
  if (player.paused) return {level:"info", title:"Wiedergabe pausiert", hint:"Mit Start setzt du die Musik fort."};
  if (player.playing) return {level:"ok", title:player.source_mode === "radio" ? "Internetradio läuft" : "Musik läuft", hint:"Falls nichts zu hören ist: zusätzlich die Lautstärke direkt an der Box prüfen."};
  return {level:"info", title:player.current ? "Bereit zum Abspielen" : "Noch keine Musik gewählt", hint:player.current ? "Mit Start beginnt die Wiedergabe." : "Eine Playlist auswählen oder einen Radiosender starten."};
}

function musicNextTrack(player = {}) {
  if (player.source_mode === "radio") return "Live-Radio · keine feste Titelfolge";
  if (player.shuffle) return "Zufallsmodus · nächster Titel wird beim Wechsel gewählt";
  const queue = player.queue || [];
  if (!queue.length || !(player.current_index >= 0)) return "Noch keine Warteschlange";
  let index = player.repeat === "one" ? player.current_index : player.current_index + 1;
  if (index === queue.length && player.repeat === "all") index = 0;
  const next = queue[index];
  return next ? `${player.repeat === "one" ? "Wiederholung" : "Als Nächstes"}: ${next.title}${next.artist ? ` · ${next.artist}` : ""}` : "Letzter Titel · danach endet die Playlist";
}
