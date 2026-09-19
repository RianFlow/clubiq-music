"use strict";
function musicSongInfo(song) {
  const labels = [];
  if (Number.isFinite(song.duration_ms) && song.duration_ms > 0) {
    const seconds = Math.round(song.duration_ms / 1000);
    labels.push(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} min`);
  }
  const title = String(song.title || "");
  for (const [pattern, label] of [[/\blive\b/i,"Live"], [/\bremix\b/i,"Remix"], [/\bcover\b/i,"Cover"],
    [/\bkaraoke\b/i,"Karaoke"], [/\binstrumental\b/i,"Instrumental"], [/\bacoustic\b|\bakustik\b/i,"Akustik"], [/\bextended\b/i,"Extended"]]) {
    if (pattern.test(title)) labels.push(`${label} (laut Titel)`);
  }
  return labels.join(" · ");
}
function musicDuplicate(song, existing) {
  if (existing.some(item => item.external_id === song.external_id)) return "exact";
  const normalize = title => String(title || "").normalize("NFKD").toLowerCase()
    .replace(/\b(official|music|video|audio|lyrics|lyric|hd|4k|hq)\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  const title = normalize(song.title);
  return title.split(" ").length >= 3 && existing.some(item => normalize(item.title) === title) ? "similar" : "";
}
