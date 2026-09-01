"use strict";

function setMediaImage(image, source, radio = false) {
  const fallback = radio ? "/static/radio-placeholder.svg" : "/pics/logo.png";
  const safeSource = typeof source === "string" && source.startsWith("/") && !source.startsWith("//")
    ? source : fallback;
  image.classList.toggle("radio-cover", radio);
  if (image.dataset.mediaSource === safeSource) return;
  image.dataset.mediaSource = safeSource;
  image.onerror = () => { image.onerror = null; image.src = fallback; };
  image.src = safeSource;
}

// Image errors do not bubble. Capture them once, including re-rendered cards.
document.addEventListener("error", event => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.hasAttribute("data-radio-logo")) {
    image.removeAttribute("data-radio-logo");
    image.src = "/static/radio-placeholder.svg";
  }
}, true);
