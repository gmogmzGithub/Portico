/* Portico handbook — client app (no deps, offline). Reads window.PORTICO from content.js */
(function(){
  "use strict";
  var PORTICO = window.PORTICO || {pages:{},nav:[],flat:[],meta:{}};
  var root = document.documentElement;
  var elNav = document.getElementById('tree');
  var elScroll = document.getElementById('scroll');
  var elCrumbs = document.getElementById('crumbs');
  var elSeg = document.getElementById('modeseg');
  var elPill = document.getElementById('modepill');

  /* ---------- persisted prefs ---------- */
  function getPref(k,d){ try{var v=localStorage.getItem(k);return v===null?d:v;}catch(_){return d;} }
  function setPref(k,v){ try{localStorage.setItem(k,v);}catch(_){ } }
  root.setAttribute('data-theme', getPref('portico-theme','dark'));
  root.setAttribute('data-mode', getPref('portico-mode','simple'));

  /* ---------- anchor index: anchorId -> pageId (scan both modes) ---------- */
  var anchorIndex = {};
  var idRe = /\sid="([^"]+)"/g;
  Object.keys(PORTICO.pages).forEach(function(pid){
    var p = PORTICO.pages[pid]; var blobs=[p.simple||'',p.technical||''];
    blobs.forEach(function(h){ var m; while((m=idRe.exec(h))){ if(!(m[1] in anchorIndex)) anchorIndex[m[1]]=pid; } });
  });

  /* ---------- sidebar ---------- */
  function buildNav(){
    var html='';
    PORTICO.nav.forEach(function(g){
      html+='<div class="grp"><div class="grp-h">'+esc(g.group)+'</div>';
      g.items.forEach(function(id){
        var p=PORTICO.pages[id]; if(!p) return;
        html+='<a href="#/'+id+'" data-page="'+id+'" data-text="'+esc((p.title+' '+(p.kicker||'')).toLowerCase())+'">'
          +'<span class="ix">'+(p.ix||'')+'</span><span class="nm">'+esc(p.title)+'</span></a>';
      });
      html+='</div>';
    });
    elNav.innerHTML=html;
  }

  /* ---------- routing ---------- */
  function currentRoute(){ return (location.hash||'').replace(/^#\/?/,'').split('#')[0]; }
  function go(id){ location.hash = id?('#/'+id):'#/'; }

  function render(){
    var id = currentRoute();
    setActiveNav(id);
    if(!id || id==='home'){ renderHome(); }
    else if(PORTICO.pages[id]){ renderPage(id); }
    else { renderHome(); }
    closeMobileNav();
  }

  function setActiveNav(id){
    var links=elNav.querySelectorAll('a'); for(var i=0;i<links.length;i++){ links[i].classList.toggle('active', links[i].getAttribute('data-page')===id); }
  }

  function renderHome(){
    elCrumbs.innerHTML='<span class="cur">Home</span>';
    var m=PORTICO.meta||{}; var mode=root.getAttribute('data-mode');
    var cards='';
    PORTICO.nav.forEach(function(g){
      g.items.forEach(function(id){
        var p=PORTICO.pages[id]; if(!p) return;
        cards+='<a class="mapcard" href="#/'+id+'"><span class="go">→</span>'
          +'<div class="ix">'+esc(g.group)+(p.ix?' · '+p.ix:'')+'</div>'
          +'<h3>'+esc(p.title)+'</h3><p>'+esc(p.short||p.kicker||'')+'</p></a>';
      });
    });
    var steps=[
      ['01','You send a message','Open WebUI hands it to the unified_context filter'],
      ['02','Context is built','Skills activate, tools resolve, history is shaped'],
      ['03','Routed to a model','Bifrost translates to Anthropic / GPT-5 / Gemini'],
      ['04','The agentic loop','Model thinks → calls tools → reads results → repeats'],
      ['05','Tools run safely','In sandboxes, with a confirmation gate for risky ones'],
      ['06','Streamed back','Answer, cost, and reasoning stream to your screen']
    ];
    var fd='<div class="flowdiag">'+steps.map(function(s){return '<div class="flowstep"><div class="n">'+s[0]+'</div><div class="h">'+esc(s[1])+'</div><div class="d">'+esc(s[2])+'</div></div>';}).join('')+'</div>';
    var html=''
      +'<div class="home">'
      +'<div class="hero">'
        +'<div class="eyebrow">Internal Engineering Handbook</div>'
        +'<h1>Portico <span class="acc">AI&nbsp;Chat</span>,<br>explained end&#8209;to&#8209;end.</h1>'
        +'<p class="sub">An enterprise desktop AI assistant: a heavily patched Open&nbsp;WebUI in an Electron shell, backed by Rust MCP orchestration, an LLM&#8209;routing bridge, and per&#8209;chat sandboxed agent VMs. Browse by area, and switch between a friendly <b>Simple</b> view and the full <b>Technical</b> detail anytime.</p>'
        +'<div class="actions">'
          +'<a class="btn primary" href="#/overview">Start with the overview →</a>'
          +'<a class="btn" href="#/loop-lifecycle">Jump to the agentic loop</a>'
          +'<button class="btn" id="homeModeBtn">You’re in '+(mode==='simple'?'Simple':'Technical')+' mode — switch</button>'
        +'</div>'
        +'<div class="statline">'
          +'<span><b>~592K</b> lines of code</span><span><b>12</b> layers</span><span><b>~10</b> services</span>'
          +'<span><b>15,329</b> lines in the agentic core</span><span><b>258</b> files indexed</span>'
        +'</div>'
      +'</div>'
      +'<div class="section-label">The request lifecycle</div>'+fd
      +'<div class="section-label">Explore the system</div>'
      +'<div class="map">'+cards+'</div>'
      +footer()
      +'</div>';
    setDoc(html,false);
    var hb=document.getElementById('homeModeBtn'); if(hb) hb.onclick=function(){ toggleMode(); };
    elScroll.scrollTop=0;
  }

  function renderPage(id){
    var p=PORTICO.pages[id]; var mode=root.getAttribute('data-mode');
    var body = (mode==='simple') ? (p.simple||p.technical||'') : (p.technical||p.simple||'');
    var grpTitle=groupOf(id);
    elCrumbs.innerHTML='<a href="#/">Home</a><span class="sep">/</span>'
      +'<span>'+esc(grpTitle)+'</span><span class="sep">/</span><span class="cur">'+esc(p.title)+'</span>';
    var hint = mode==='simple'
      ? '<div class="mode-hint">Simple view — the gist, no jargon. Want the internals? <b>Switch to Technical</b> (top right).</div>'
      : '<div class="mode-hint">Technical view — full implementation detail with <b>file:line</b> citations. Prefer the gist? <b>Switch to Simple</b>.</div>';
    var head='<div class="page-eyebrow">'+esc(grpTitle)+'</div>'
      +'<h1 class="page-title">'+esc(p.title)+'</h1>'
      +(p.kicker?'<p class="page-kicker">'+esc(p.kicker)+'</p>':'')
      +hint;
    var nav=pageNav(id);
    setDoc('<div class="doc" id="doc">'+head+'<div class="page-body">'+body+'</div>'+nav+footer()+'</div>', true);
    decorate();
    elScroll.scrollTop=0;
    // jump to sub-anchor if hash carried one (#/page#sub not used; handled by link clicks)
  }

  function setDoc(inner, withRail){
    var rail = withRail ? '<aside class="rail" id="rail"></aside>' : '';
    elScroll.innerHTML='<div class="wrap'+(withRail?'':' no-rail')+'">'+inner+rail+'</div>';
  }

  function groupOf(id){ for(var i=0;i<PORTICO.nav.length;i++){ if(PORTICO.nav[i].items.indexOf(id)>=0) return PORTICO.nav[i].group; } return ''; }

  function pageNav(id){
    var f=PORTICO.flat, i=f.indexOf(id), out='<div class="pagenav">';
    var prev=i>0?f[i-1]:null, next=i>=0&&i<f.length-1?f[i+1]:null;
    out+= prev?'<a href="#/'+prev+'"><div class="lbl">← Previous</div><div class="nm">'+esc(PORTICO.pages[prev].title)+'</div></a>':'<span></span>';
    out+= next?'<a class="next" href="#/'+next+'"><div class="lbl">Next →</div><div class="nm">'+esc(PORTICO.pages[next].title)+'</div></a>':'<span></span>';
    return out+'</div>';
  }
  function footer(){ return '<div class="foot"><span>Portico — reverse-documented by multi-agent analysis with adversarial verification.</span><span><a href="#/verification">Verification &amp; corrections</a> · Generated 2026-06-19</span></div>'; }

  /* ---------- decorate a rendered page: anchors, rail, scroll-spy ---------- */
  var spy=null;
  function decorate(){
    var doc=document.getElementById('doc'); if(!doc) return;
    var heads=doc.querySelectorAll('.page-body h2[id], .page-body h3[id], .page-body h3.s-h[id], .page-body h4[id]');
    // add hover anchors
    heads.forEach(function(h){
      if(h.querySelector('.anchor')) return;
      var a=document.createElement('a'); a.className='anchor'; a.href='#'+h.id; a.textContent='#'; a.setAttribute('aria-hidden','true');
      h.insertBefore(a,h.firstChild);
    });
    // build "on this page" rail from h2/h3 only
    var rail=document.getElementById('rail');
    var tops=[].slice.call(doc.querySelectorAll('.page-body h2[id], .page-body h3[id], .page-body h3.s-h[id]'));
    if(rail){
      if(tops.length>=3){
        rail.innerHTML='<div class="rh">On this page</div>'+tops.map(function(h){
          return '<a href="#'+h.id+'" data-spy="'+h.id+'">'+esc(h.textContent.replace(/^#/,'').trim())+'</a>';
        }).join('');
      } else { rail.remove(); var w=doc.parentElement; if(w) w.classList.add('no-rail'); }
    }
    // scroll-spy
    if(spy) spy.disconnect();
    var railLinks={}; if(rail) rail.querySelectorAll('a').forEach(function(a){railLinks[a.getAttribute('data-spy')]=a;});
    spy=new IntersectionObserver(function(es){
      es.forEach(function(e){ var a=railLinks[e.target.id]; if(!a) return;
        if(e.isIntersecting){ var c=document.querySelector('.rail a.active'); if(c)c.classList.remove('active'); a.classList.add('active'); }
      });
    },{root:elScroll,rootMargin:'-72px 0px -70% 0px',threshold:0});
    tops.forEach(function(h){ spy.observe(h); });
  }

  /* ---------- link interception (cross-refs + in-page anchors) ---------- */
  document.addEventListener('click',function(e){
    var a=e.target.closest && e.target.closest('a[href^="#"]'); if(!a) return;
    var href=a.getAttribute('href');
    if(href==='#'||href==='#/'){ return; }
    if(href.indexOf('#/')===0){ return; } // route link — let hashchange handle
    var anc=href.slice(1); // bare #anchor
    e.preventDefault();
    var target=document.getElementById(anc);
    if(target){ scrollToEl(target); history.replaceState(null,'',href); return; }
    var pid=anchorIndex[anc];
    if(pid){ pendingAnchor=anc; go(pid); }
  });
  var pendingAnchor=null;
  function scrollToEl(el){ var top=el.getBoundingClientRect().top - elScroll.getBoundingClientRect().top + elScroll.scrollTop - 72; elScroll.scrollTo({top:top,behavior:'smooth'}); }

  /* ---------- mode toggle ---------- */
  function placePill(){
    if(!elSeg||!elPill) return;
    var mode=root.getAttribute('data-mode');
    var btn=elSeg.querySelector('button[data-mode="'+mode+'"]'); if(!btn) return;
    elSeg.querySelectorAll('button').forEach(function(b){b.classList.toggle('on',b===btn);});
    elPill.style.left=btn.offsetLeft+'px'; elPill.style.width=btn.offsetWidth+'px';
  }
  function setMode(m){ root.setAttribute('data-mode',m); setPref('portico-mode',m); placePill(); }
  function toggleMode(){ setMode(root.getAttribute('data-mode')==='simple'?'technical':'simple'); render(); }
  if(elSeg){ elSeg.addEventListener('click',function(e){ var b=e.target.closest('button[data-mode]'); if(!b)return; if(b.getAttribute('data-mode')!==root.getAttribute('data-mode')){ setMode(b.getAttribute('data-mode')); render(); } }); }

  /* ---------- theme ---------- */
  var themeBtn=document.getElementById('themeBtn');
  if(themeBtn) themeBtn.onclick=function(){ var t=root.getAttribute('data-theme')==='dark'?'light':'dark'; root.setAttribute('data-theme',t); setPref('portico-theme',t); placePill(); };

  /* ---------- search ---------- */
  var search=document.getElementById('search');
  if(search) search.addEventListener('input',function(){
    var q=this.value.trim().toLowerCase();
    var groups=elNav.querySelectorAll('.grp');
    groups.forEach(function(g){
      var any=false; g.querySelectorAll('a').forEach(function(a){
        var m=!q || a.getAttribute('data-text').indexOf(q)>=0; a.classList.toggle('tree-hidden',!m); if(m)any=true;
      });
      g.classList.toggle('tree-hidden',!any);
    });
  });

  /* ---------- mobile nav ---------- */
  var side=document.getElementById('side'), scrim=document.getElementById('scrim'), menuBtn=document.getElementById('menuBtn');
  function closeMobileNav(){ if(side)side.classList.remove('open'); if(scrim)scrim.classList.remove('show'); }
  if(menuBtn) menuBtn.onclick=function(){ side.classList.toggle('open'); scrim.classList.toggle('show'); };
  if(scrim) scrim.onclick=closeMobileNav;

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  /* ---------- boot ---------- */
  window.addEventListener('hashchange',function(){
    render();
    if(pendingAnchor){ var anc=pendingAnchor; pendingAnchor=null;
      setTimeout(function(){ var el=document.getElementById(anc); if(el) scrollToEl(el); },60);
    }
  });
  buildNav();
  render();
  placePill();
  window.addEventListener('resize',placePill);
})();
