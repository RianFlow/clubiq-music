"use strict";

// Keep a local range draft while dragging or saving. Polling may update the
// confirmed value, but must not move the user's handle. Serialize quick changes.
function createRangeControl({ input, label, format, commit, onError = () => {} }) {
  let editing = false;
  let saving = false;
  let queued = null;
  let confirmed = Number(input.value) || 0;
  const show = value => {
    input.value = value;
    label.textContent = format(value);
    input.setAttribute("aria-valuetext", format(value));
  };
  async function flush() {
    if (saving) return;
    saving = true;
    input.setAttribute("aria-busy", "true");
    try {
      while (queued !== null) {
        const value = queued;
        queued = null;
        try { await commit(value); } catch (error) { onError(error); }
      }
    } finally {
      saving = false;
      input.setAttribute("aria-busy", "false");
      if (!editing) show(confirmed);
    }
  }
  input.addEventListener("pointerdown", () => { editing = true; });
  input.addEventListener("input", () => { editing = true; show(Number(input.value)); });
  input.addEventListener("change", () => {
    editing = false;
    if (input.disabled) return;
    queued = Number(input.value);
    return flush();
  });
  const cancelDraft = () => { editing = false; if (!saving) show(confirmed); };
  input.addEventListener("pointercancel", cancelDraft);
  input.addEventListener("blur", cancelDraft);
  return {
    update(value, { disabled = false, max } = {}) {
      confirmed = Number(value) || 0;
      input.disabled = disabled;
      if (disabled) { queued = null; editing = false; }
      if (!editing && !saving) {
        if (max !== undefined) input.max = max;
        show(confirmed);
      }
    },
  };
}
