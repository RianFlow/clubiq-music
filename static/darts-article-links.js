/* Keep the match page open and carry its appearance into public articles. */
(() => {
  'use strict';
  const valid=value=>value==='light'||value==='dark';
  const reader=document.documentElement.hasAttribute('data-follow-darts-theme');
  function preferredTheme(){
    const requested=new URL(location.href).searchParams.get('theme');
    if(valid(requested))return requested;
    try{const saved=localStorage.getItem('clubiq_darts_theme');if(valid(saved))return saved;}catch(_){}
    return matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
  }
  function apply(theme){document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty('--link',theme==='dark'?'#91ddba':document.documentElement.style.getPropertyValue('--article-link-light')||'#176b56');document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#0b1712':'#176b56');}
  if(reader)apply(preferredTheme());
  function prepare(event){
    const link=event.target.closest?.('a[data-article-link]');if(!link)return;
    const url=new URL(link.href,location.href);if(url.origin!==location.origin)return;
    const current=document.documentElement.dataset.theme;
    url.searchParams.set('theme',valid(current)?current:preferredTheme());link.href=url.href;
  }
  for(const type of ['pointerdown','click','auxclick','contextmenu','focusin'])document.addEventListener(type,prepare,true);
  if(reader)window.addEventListener('storage',event=>{
    if(['clubiq_darts_theme','clubiq_darts_page_theme'].includes(event.key)&&valid(event.newValue)){
      apply(event.newValue);const url=new URL(location.href);url.searchParams.set('theme',event.newValue);history.replaceState(null,'',url);
    }
  });
})();
