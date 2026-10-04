/* Local SVG icons: no remote image requests or icon font. */
window.DartsSocialIcons = {
  create(platform) {
    const ns='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
    svg.setAttribute('focusable','false');svg.classList.add('social-platform-icon');
    svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');
    svg.setAttribute('stroke-width','1.8');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');
    const paths={
      instagram:['M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Z','M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0','M17.5 6.5h.01'],
      facebook:['M14 21V12h3l.5-4H14V6.5c0-1 .5-1.5 1.5-1.5H18V2h-3c-3 0-5 2-5 5v1H7v4h3v9'],
      whatsapp:['M20.5 11.5a9 9 0 0 1-13.4 7.8L3 21l1.6-4.2a9 9 0 1 1 15.9-5.3Z','M8 7.5 9.5 10 8.7 11c1 2 2.3 3.3 4.3 4.3l1-.8 2.5 1.5c-.5 2-2 2-3.5 1.3-3-1.5-5-3.5-6.5-6.5C5.8 9.3 6 8 8 7.5Z'],
      youtube:['M7 5h10c4 0 5 1 5 7s-1 7-5 7H7c-4 0-5-1-5-7s1-7 5-7Z','m10 8 6 4-6 4Z'],
      tiktok:['M14 3v13a4 4 0 1 1-4-4','M14 3c1 4 3 6 7 6V6c-2 0-4-1-4-3Z'],
      x:['M4 3h4l12 18h-4L4 3Z','m20 3-7 8M4 21l7-8'],
      website:['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z','M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z'],
    };
    for(const d of paths[platform]||paths.website){const path=document.createElementNS(ns,'path');path.setAttribute('d',d);svg.append(path);}
    return svg;
  }
};
