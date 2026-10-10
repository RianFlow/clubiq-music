(() => {
  'use strict';
  const panel=document.querySelector('#clubNewsPanel');if(!panel)return;
  let hasPosts=false;
  const visibility=()=>{panel.hidden=!hasPosts||document.querySelector('#todayPanel')?.hidden||document.body.matches('.tv-live,.app-tv');};
  new MutationObserver(visibility).observe(document.querySelector('#todayPanel'),{attributes:true,attributeFilter:['hidden']});
  new MutationObserver(visibility).observe(document.body,{attributes:true,attributeFilter:['class']});
  async function load(){try{const response=await fetch('/api/v1/cms/sites/barver/posts?limit=3',{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!response.ok)return;const data=await response.json(),target=document.querySelector('#clubNewsList');target.replaceChildren();for(const post of data.posts||[]){const article=document.createElement('article'),heading=document.createElement('h3'),summary=document.createElement('p'),time=document.createElement('time'),link=document.createElement('a');heading.textContent=post.title;summary.textContent=post.summary;time.dateTime=post.publishedAt;time.textContent=new Date(post.publishedAt).toLocaleDateString('de-DE');link.href=post.href;link.textContent='Beitrag lesen →';article.append(time,heading,summary,link);target.append(article);}hasPosts=target.children.length>0;visibility();}catch(_){/* Club news must not interfere with the live feed. */}}
  load();setInterval(()=>{if(!document.hidden)load();},90000);
})();
