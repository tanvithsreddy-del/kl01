import { el } from './dom.js';

const RESEARCH_DETACHED_CACHE_LIMIT = 64;
const RESEARCH_TABS = ['Live','Evidence','Context','Verification','Timeline'];
const instances = new Map();

function n(value = 0) {
  const x = Number(value || 0);
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(x >= 10_000_000 ? 0 : 1)}m`;
  if (x >= 1000) return `${(x / 1000).toFixed(x >= 10000 ? 0 : 1)}k`;
  return String(Math.round(x));
}
function elapsed(work) {
  const start = Date.parse(work?.startedAt || '');
  if (!Number.isFinite(start)) return '0:00';
  const end = Date.parse(work?.completedAt || '');
  const ms = Math.max(0, (Number.isFinite(end) ? end : Date.now()) - start);
  const sec = Math.floor(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function statusLabel(work) {
  if (work?.status === 'interrupted') return 'Interrupted';
  if (work?.status === 'completed') return 'Complete';
  if (work?.status === 'partial') return 'Complete with limits';
  if (work?.status === 'failed') return 'Research failed';
  if (work?.status === 'cancelled') return 'Stopped';
  if (work?.stage === 'reading') return 'Reading';
  if (work?.stage === 'summarising') return 'Summarising';
  if (work?.stage === 'verification') return 'Checking evidence';
  if (work?.stage === 'drafting') return 'Building answer';
  if (work?.stage === 'conflict-resolution') return 'Resolving conflict';
  return 'Researching';
}
export function researchCounterLine(work) {
  const c = work?.counters || {};
  const t = work?.telemetry || {};
  const token = t.workTokens ?? t.totalModelTokens ?? 0;
  const mark = t.workTokensEstimated === false ? '' : '≈';
  return `${statusLabel(work)} · ${elapsed(work)} · ${mark}${n(token)} tokens · ${c.read || 0} page${c.read === 1 ? '' : 's'} · ${c.claimsSupported || 0}/${c.claimsTotal || 0} claims`;
}
function metric(label, value) {
  return el('div', { class:'research-metric' }, el('span', { class:'muted', text:label }), el('strong', { class:'numeric', text:String(value) }));
}
function metricRef(label) {
  const value=el('strong',{class:'numeric',text:'—'});
  return {root:el('div',{class:'research-metric'},el('span',{class:'muted',text:label}),value),value};
}
function setText(node,value=''){const next=String(value??'');if(node&&node.textContent!==next)node.textContent=next;}
function setHidden(node,hidden){if(node)node.hidden=Boolean(hidden);}
function safeKey(value=''){return String(value||'').replace(/[^a-zA-Z0-9_-]/gu,'-').slice(0,120)||'research';}
function sourceStateLabel(value){
  const state=String(value||'queued');
  return ({queued:'Queued',opening:'Opening',reading:'Reading',extracting:'Extracting',summarising:'Summarising',checked:'Checked',used:'Used',skipped:'Skipped',unavailable:'Unavailable'})[state]||state.replaceAll('-',' ');
}
function sourceStateRank(value){return ({queued:0,opening:1,reading:2,extracting:3,summarising:4,checked:5,used:6,skipped:6,unavailable:6})[value]??0;}
function sourceKey(source,index=0){return String(source?.sourceId||source?.url||`legacy-${index}`);}
function mergedSources(work){
  const legacy=Array.isArray(work?.sources)?work.sources:[];
  const byId=new Map();
  const byUrl=new Map();
  for(const item of legacy){if(item?.sourceId)byId.set(String(item.sourceId),item);if(item?.url)byUrl.set(String(item.url),item);}
  const result=[];const seen=new Set();
  for(const item of Array.isArray(work?.sourceWorks)?work.sourceWorks:[]){
    const old=byId.get(String(item.sourceId))||byUrl.get(String(item.url))||{};
    const merged={...old,...item,status:item.state||old.status||'queued'};const key=sourceKey(merged,result.length);seen.add(key);result.push(merged);
  }
  for(const item of legacy){const key=sourceKey(item,result.length);if(seen.has(key))continue;result.push({...item,state:item.used?'used':item.status==='skipped'?'skipped':'checked'});seen.add(key);}
  return result.sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||''))||sourceKey(a).localeCompare(sourceKey(b)));
}
function sourceProfileLine(source){
  const profile=source?.sourceProfile;if(!profile)return {role:'',detail:''};
  const classes=(profile.classIds||[]).join(' + ')||'unknown source';
  const detail=[profile.anchor?'preferred starting source':null,profile.evidenceRole||null,profile.taskProfile||null].filter(Boolean).join(' · ');
  return {role:classes,detail};
}
function createSourceCard(source,index){
  const key=sourceKey(source,index);
  const title=el('strong',{'data-source-field':'title',text:'Source'});
  const domain=el('div',{class:'muted research-source-domain','data-source-field':'domain'});
  const state=el('span',{class:'research-source-state','data-source-field':'state'});
  const profileRole=el('span',{'data-source-field':'profile-role'});
  const profileDetail=el('span',{class:'muted','data-source-field':'profile-detail'});
  const profile=el('div',{class:'research-source-priority','data-source-block':'profile'},profileRole,profileDetail);
  const reason=el('p',{class:'research-warning','data-source-block':'reason'});
  const summaryLabel=el('span',{class:'muted',text:'Page summary'});
  const summary=el('p',{class:'research-source-summary-text','data-source-field':'summary'});
  const summaryBlock=el('section',{class:'research-source-summary','data-source-block':'summary'},summaryLabel,summary);
  const excerptText=el('blockquote',{'data-source-field':'excerpt'});
  const excerpt=el('details',{class:'research-source-detail','data-preserve-key':`${key}:excerpt`},el('summary',{text:'Selected text'}),excerptText);
  const evidenceBody=el('div',{class:'research-evidence-chain','data-source-field':'evidence'});
  const evidence=el('details',{class:'research-source-detail','data-preserve-key':`${key}:evidence`},el('summary',{text:'Evidence chain'}),evidenceBody);
  const claims=el('p',{class:'muted research-source-links','data-source-block':'claims'});
  const link=el('a',{class:'research-open-source',target:'_blank',rel:'noreferrer noopener',text:'Open original ↗','data-source-field':'link'});
  const card=el('article',{class:'research-source-card','data-source-id':key,'data-source-revision':'0','aria-label':'Research source'},
    el('div',{class:'research-source-head'},el('div',{},title,domain),state),profile,reason,summaryBlock,excerpt,evidence,claims,link);
  patchSourceCard(card,source,index);
  return card;
}
function patchEvidenceChain(container,source){
  const evidence=Array.isArray(source?.evidencePreview)?source.evidencePreview:[];
  if(!evidence.length){container.replaceChildren();return;}
  const existing=new Map([...container.querySelectorAll('[data-evidence-id]')].map(node=>[node.dataset.evidenceId,node]));
  const wanted=new Set();
  for(const item of evidence){
    const id=String(item.id||`${item.claimId||'claim'}:${item.statement||''}`);wanted.add(id);
    let row=existing.get(id);
    if(!row){row=el('div',{class:'research-evidence-chain-row','data-evidence-id':id},el('span',{class:'muted','data-evidence-field':'meta'}),el('p',{'data-evidence-field':'statement'}),el('span',{class:'muted','data-evidence-field':'lineage'}));container.append(row);}
    setText(row.querySelector('[data-evidence-field="meta"]'),`${item.claimId||'claim'} · ${item.strength||'evidence'}`);
    setText(row.querySelector('[data-evidence-field="statement"]'),item.statement||'');
    const refs=Array.isArray(item.excerptIds)?item.excerptIds:[];
    setText(row.querySelector('[data-evidence-field="lineage"]'),`Page → excerpt${refs.length===1?'':'s'} ${refs.join(', ')} → dossier → ${id} → claim`);
  }
  for(const [id,row] of existing)if(!wanted.has(id))row.remove();
}
function patchSourceCard(card,source,index){
  const key=sourceKey(source,index);const state=String(source.state||source.status||'queued');const profile=sourceProfileLine(source);
  card.dataset.sourceId=key;card.dataset.sourceRevision=String(Number(source.revision||0));card.dataset.sourceState=state;
  card.className=`research-source-card ${state} ${source.used||state==='used'?'used':''}`.trim();
  card.setAttribute('aria-label',`${source.title||source.domain||`Source ${index+1}`} · ${sourceStateLabel(state)}`);
  setText(card.querySelector('[data-source-field="title"]'),source.title||source.domain||`Source ${index+1}`);
  setText(card.querySelector('[data-source-field="domain"]'),source.domain||'');
  setText(card.querySelector('[data-source-field="state"]'),sourceStateLabel(state));
  const profileBlock=card.querySelector('[data-source-block="profile"]');setHidden(profileBlock,!profile.role&&!profile.detail);
  setText(card.querySelector('[data-source-field="profile-role"]'),profile.role);setText(card.querySelector('[data-source-field="profile-detail"]'),profile.detail);
  const reason=card.querySelector('[data-source-block="reason"]');setHidden(reason,!source.reason);setText(reason,source.reason?`${state==='skipped'?'Skipped':'Unavailable'}: ${source.reason}`:'');
  const summaryBlock=card.querySelector('[data-source-block="summary"]');setHidden(summaryBlock,!source.summary);setText(card.querySelector('[data-source-field="summary"]'),source.summary||'');
  const excerpt=card.querySelector('[data-preserve-key$=":excerpt"]');setHidden(excerpt,!source.excerptPreview);setText(card.querySelector('[data-source-field="excerpt"]'),source.excerptPreview||'');
  const evidence=card.querySelector('[data-preserve-key$=":evidence"]');const evidencePreview=Array.isArray(source.evidencePreview)?source.evidencePreview:[];setHidden(evidence,!evidencePreview.length);patchEvidenceChain(card.querySelector('[data-source-field="evidence"]'),source);
  const claims=card.querySelector('[data-source-block="claims"]');const claimIds=Array.isArray(source.claimIds)?source.claimIds:[];setHidden(claims,!claimIds.length);setText(claims,claimIds.length?`Supports ${claimIds.join(', ')} · ${source.evidenceAccepted||0} accepted evidence record${source.evidenceAccepted===1?'':'s'}`:'');
  const link=card.querySelector('[data-source-field="link"]');setHidden(link,!source.url);if(source.url)link.setAttribute('href',source.url);else link.removeAttribute('href');
}
function createLiveView(instance){
  const operationTitle=el('strong',{'data-live-field':'label'});const operationDetail=el('p',{class:'muted','data-live-field':'detail'});
  const searches=metricRef('Searches'),candidates=metricRef('Candidates'),pages=metricRef('Pages read'),used=metricRef('Sources used'),claims=metricRef('Claims'),generation=metricRef('Generation');
  const webText=metricRef('Web text'),excerpts=metricRef('Selected excerpts'),input=metricRef('Model input'),output=metricRef('Model output');
  const notices=el('div',{class:'research-live-notices'});
  const sourceCount=el('span',{class:'muted numeric','data-live-field':'source-count'});
  const announcer=el('span',{class:'sr-only',role:'status','aria-live':'polite','aria-atomic':'true'});
  const feed=el('div',{class:'research-live-source-feed',role:'feed','aria-label':'Pages checked during research','aria-busy':'true','data-research-source-feed':'',tabindex:'-1'});
  const jump=el('button',{class:'btn compact research-feed-jump',type:'button',hidden:true,text:'Jump to latest'});
  const shell=el('section',{class:'research-live-source-shell'},el('div',{class:'research-live-source-head'},el('strong',{text:'Pages'}),sourceCount),feed,jump,announcer);
  const root=el('div',{class:'research-pane research-live-pane'},
    el('div',{class:'research-live-operation',role:'status','aria-live':'polite'},operationTitle,operationDetail),
    el('div',{class:'research-metric-grid'},searches.root,candidates.root,pages.root,used.root,claims.root,generation.root),
    el('div',{class:'research-token-breakdown'},webText.root,excerpts.root,input.root,output.root),notices,shell);
  const refs={operationTitle,operationDetail,searches,candidates,pages,used,claims,generation,webText,excerpts,input,output,notices,sourceCount,announcer,feed,jump,shell};
  let follow=true;let lastAnnouncement='';
  function nearBottom(){return Math.max(0,feed.scrollHeight-feed.scrollTop-feed.clientHeight)<=36;}
  function syncJump(){jump.hidden=follow||!feed.scrollHeight||feed.scrollHeight<=feed.clientHeight;instance.root.dataset.researchFollow=follow?'on':'paused';}
  feed.addEventListener('scroll',()=>{follow=nearBottom();syncJump();},{passive:true});
  jump.addEventListener('click',()=>{follow=true;feed.scrollTop=feed.scrollHeight;syncJump();feed.focus?.({preventScroll:true});});
  function patchFeed(work){
    const sources=mergedSources(work);const existing=new Map([...feed.querySelectorAll('[data-source-id]')].map(node=>[node.dataset.sourceId,node]));const wanted=new Set();let newest=null;
    for(let index=0;index<sources.length;index+=1){const source=sources[index];const key=sourceKey(source,index);wanted.add(key);let card=existing.get(key);const previousState=card?.dataset.sourceState||null;const previousRevision=Number(card?.dataset.sourceRevision||0);if(!card){card=createSourceCard(source,index);}else patchSourceCard(card,source,index);
      const at=feed.children[index];if(at!==card)feed.insertBefore(card,at||null);
      const revision=Number(source.revision||0);const updatedAt=Date.parse(source.updatedAt||source.createdAt||'')||0;
      if(!newest||updatedAt>newest.updatedAt||(updatedAt===newest.updatedAt&&sourceStateRank(source.state)>sourceStateRank(newest.source?.state)))newest={source,revision,updatedAt};
      if(previousState&&previousState!==String(source.state||source.status||'')&&revision>=previousRevision)newest={source,revision,updatedAt};
    }
    for(const [key,node] of existing)if(!wanted.has(key))node.remove();
    setText(sourceCount,`${sources.length} source${sources.length===1?'':'s'}`);feed.setAttribute('aria-busy',String(!['completed','partial','failed','cancelled'].includes(work?.status)));
    if(newest?.source){const announcement=`${newest.source.title||newest.source.domain||'Source'} · ${sourceStateLabel(newest.source.state||newest.source.status)}`;if(announcement!==lastAnnouncement){lastAnnouncement=announcement;setText(announcer,announcement);}}
    if(follow&&!instance.drawer.hidden)requestAnimationFrame(()=>{if(!feed.isConnected)return;feed.scrollTop=feed.scrollHeight;syncJump();});else syncJump();
  }
  function update(work){
    const c=work?.counters||{},t=work?.telemetry||{};setText(operationTitle,work?.live?.label||statusLabel(work));setText(operationDetail,work?.live?.detail||'');operationDetail.hidden=!work?.live?.detail;
    setText(searches.value,c.queries||0);setText(candidates.value,c.candidates||0);setText(pages.value,c.read||0);setText(used.value,c.used||0);setText(claims.value,`${c.claimsSupported||0}/${c.claimsTotal||0}`);setText(generation.value,t.currentTokPerSec?`${t.currentTokPerSec} tok/s`:'—');
    setText(webText.value,`${t.rawWebTextEstimated!==false?'≈':''}${n(t.rawWebTextTokens||0)}`);setText(excerpts.value,`${t.selectedExcerptEstimated!==false?'≈':''}${n(t.selectedExcerptTokens||0)}`);setText(input.value,`${t.allModelCountsExact?'':'≈'}${n(t.modelInputTokens||0)}`);setText(output.value,`${t.allModelCountsExact?'':'≈'}${n(t.modelOutputTokens||0)}`);
    const messages=[...(work?.degradations||[]).slice(-3).map(item=>item.message||item.code||'Research degraded'),...(work?.fallbacks||[]).slice(-3).map(item=>item.message||item.code||'Fallback used')];notices.replaceChildren(...messages.map(text=>el('p',{class:'research-warning',text})));
    patchFeed(work);
  }
  return {root,update,feed,jump,get follow(){return follow;},setFollow(value){follow=Boolean(value);syncJump();}};
}
function evidencePane(work) {
  const claims = Array.isArray(work?.claims) ? work.claims : [];
  if (!claims.length) return el('p', { class:'muted', text:'Claims are still being planned.' });
  return el('div', { class:'research-claim-list' }, ...claims.map(c => el('article', { class:`research-claim ${c.status || 'unresearched'}` },
    el('div', { class:'research-claim-head' }, el('strong', { text:c.text }), el('span', { class:'research-claim-state', text:String(c.status || 'unresearched').replaceAll('-', ' ') })),
    el('p', { class:'muted', text:`${c.supportingEvidenceIds?.length || 0} supporting · ${c.contradictingEvidenceIds?.length || 0} contradicting · ${c.independenceCount || 0} independent lineage${c.independenceCount === 1 ? '' : 's'}` }),
    c.resolution ? el('p', { class:'muted', text:c.resolution }) : null)));
}
function verificationPane(work) {
  const v = work?.verification;
  if (!v) return el('p', { class:'muted', text:'Answer verification has not started yet.' });
  return el('div', { class:'research-verification' },
    metric('Result', v.passed ? 'Checked' : 'Needs attention'), metric('Unsupported draft claims', v.unsupportedCount || 0), metric('Repairs', v.repairs || 0), metric('Conflicts', v.conflicts || 0),
    (v.unresolvedClaimIds || []).length ? el('p', { class:'research-warning', text:`Unresolved claims: ${v.unresolvedClaimIds.join(', ')}` }) : el('p', { class:'muted', text:'No critical unresolved claim remains in the published answer.' }));
}
function timelinePane(work) {
  const rows = Array.isArray(work?.timeline) ? work.timeline : [];
  if (!rows.length) return el('p', { class:'muted', text:'No timeline events yet.' });
  return el('ol', { class:'research-timeline' }, ...rows.slice(-120).map(row => el('li', {},el('span', { class:'research-timeline-time numeric muted', text:new Date(row.at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }) }),el('span', { text:row.label || row.type }))));
}
function contextPane(work) {
  const c = work?.context;
  if (!c) return el('p', { class:'muted', text:'The final evidence packet has not been built yet.' });
  return el('div', { class:'research-context-grid' },
    metric('Evidence packet', `${c.estimated ? '≈' : ''}${n(c.inputTokens || 0)} tokens`), metric('Budget', n(c.tokenBudget || 0)),metric('Included artifacts', c.includedArtifacts || 0), metric('Excluded artifacts', c.excludedArtifacts || 0),
    (c.omittedCriticalScope || []).length ? el('p', { class:'research-warning', text:`Scope omitted because it could not fit safely: ${c.omittedCriticalScope.join(', ')}` }) : null);
}
function normalizeTab(value){return value==='Sources'?'Live':RESEARCH_TABS.includes(value)?value:'Live';}
function instanceKey(message,embedded){return `${message?.id||'message'}:${message?.runId||'run'}:${embedded?'embedded':'direct'}`;}
function pruneDetachedInstances(){
  const detached=[];
  for(const [entryKey,entry] of instances){if(!entry?.root?.parentNode)detached.push(entryKey);}
  while(detached.length>RESEARCH_DETACHED_CACHE_LIMIT){const oldest=detached.shift();const entry=instances.get(oldest);entry?.destroy?.();instances.delete(oldest);}
}
function remember(key,instance){instances.delete(key);instances.set(key,instance);pruneDetachedInstances();}
export function releaseResearchWorkInstancesWithin(container){
  for(const [key,instance] of [...instances]){
    const node=instance?.root;
    if(!node||!node.parentNode||(container?.contains?.(node))){instance?.destroy?.();instances.delete(key);}
  }
}
function createInstance(key,message,options){
  let currentMessage=message;let currentOptions={...options};let active=normalizeTab(options.restoreTab);let userToggled=false;let timer=null;let disconnectedTicks=0;
  const embedded=Boolean(options.embedded);const root=el('section',{class:'research-work','data-research-work':'','data-research-tab':active,'data-research-key':key});
  const summary=el('span',{class:'research-work-summary'});const toggle=el('button',{class:'research-work-strip',type:'button','aria-expanded':String(Boolean(options.restoreOpen))},el('span',{class:'research-work-dot','aria-hidden':'true'}),summary,el('span',{class:'research-work-chevron','aria-hidden':'true',text:'›'}));
  const drawer=el('div',{class:'research-work-drawer',hidden:embedded?false:!options.restoreOpen});const recovery=el('div',{class:'research-recovery',role:'status',hidden:true});const tabs=el('div',{class:'research-tabs',role:'tablist','aria-label':'Research details'});const body=el('div',{class:'research-tab-body'});
  const instance={key,root,drawer,toggle,currentWork:null,live:null,panes:new Map(),destroy(){if(timer){clearInterval(timer);timer=null;}}};
  const drawerId=`research-drawer-${safeKey(key)}`;drawer.id=drawerId;toggle.setAttribute('aria-controls',drawerId);
  function work(){return currentMessage?.work||{};}
  function updateStrip(){const w=work();root.className=`research-work ${embedded?'embedded ':''}${w.status||'running'}`.trim();root.dataset.researchTab=active;setText(summary,researchCounterLine(w));toggle.setAttribute('aria-label',`${researchCounterLine(w)}. ${drawer.hidden?'Open':'Close'} research details.`);}
  function updateRecovery(){const w=work();if(w.status!=='interrupted'){recovery.hidden=true;recovery.replaceChildren();return;}recovery.hidden=false;recovery.replaceChildren(el('div',{},el('strong',{text:'Research was interrupted'}),el('p',{class:'muted',text:'Validated checkpoints are still available. Resume reuses committed evidence; discard removes the temporary research workspace.'})),el('div',{class:'research-recovery-actions'},currentOptions.onResume?el('button',{class:'btn primary',type:'button',onClick:()=>currentOptions.onResume(currentMessage),text:'Resume'}):null,currentOptions.onDiscard?el('button',{class:'btn',type:'button',onClick:()=>currentOptions.onDiscard(currentMessage),text:'Discard'}):null));}
  function ensurePane(name){
    if(name==='Live'){if(!instance.live)instance.live=createLiveView(instance);return instance.live.root;}
    if(!instance.panes.has(name))instance.panes.set(name,el('div',{class:`research-pane research-${name.toLowerCase()}-pane`,'data-research-pane':name}));return instance.panes.get(name);
  }
  function updatePane(name){const w=work();const pane=ensurePane(name);if(name==='Live'){instance.live.update(w);return pane;}const next=name==='Evidence'?evidencePane(w):name==='Context'?contextPane(w):name==='Verification'?verificationPane(w):timelinePane(w);pane.replaceChildren(next);return pane;}
  function renderActive(){root.dataset.researchTab=active;const pane=updatePane(active);if(body.firstChild!==pane)body.replaceChildren(pane);for(const button of tabs.querySelectorAll('[role="tab"]')){const selected=button.dataset.tab===active;button.classList.toggle('active',selected);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}}
  function buildTabs(){tabs.replaceChildren();for(const name of RESEARCH_TABS){const button=el('button',{class:'research-tab',type:'button',role:'tab','data-tab':name,'aria-selected':String(name===active),tabindex:name===active?'0':'-1',text:name,onClick:()=>{active=name;renderActive();}});button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=RESEARCH_TABS.indexOf(active);if(event.key==='Home')active=RESEARCH_TABS[0];else if(event.key==='End')active=RESEARCH_TABS.at(-1);else active=RESEARCH_TABS[(index+(event.key==='ArrowRight'?1:-1)+RESEARCH_TABS.length)%RESEARCH_TABS.length];renderActive();tabs.querySelector(`[data-tab="${active}"]`)?.focus({preventScroll:true});});tabs.append(button);}}
  function manageTimer(){const terminal=['completed','partial','failed','cancelled'].includes(work()?.status);if(terminal&&timer){clearInterval(timer);timer=null;}else if(!terminal&&!timer){timer=setInterval(()=>{if(!root.isConnected){disconnectedTicks+=1;if(disconnectedTicks>=5){clearInterval(timer);timer=null;}return;}disconnectedTicks=0;updateStrip();},1000);}}
  function update(nextMessage,nextOptions={}){currentMessage=nextMessage;currentOptions={...currentOptions,...nextOptions};instance.currentWork=work();if(!userToggled&&embedded)drawer.hidden=false;updateStrip();updateRecovery();renderActive();manageTimer();remember(key,instance);return root;}
  toggle.addEventListener('click',()=>{userToggled=true;drawer.hidden=!drawer.hidden;toggle.setAttribute('aria-expanded',String(!drawer.hidden));toggle.setAttribute('aria-label',`${researchCounterLine(work())}. ${drawer.hidden?'Open':'Close'} research details.`);if(!drawer.hidden){renderActive();tabs.querySelector('[aria-selected="true"]')?.focus({preventScroll:true});if(instance.live?.follow)requestAnimationFrame(()=>{instance.live.feed.scrollTop=instance.live.feed.scrollHeight;});}});
  buildTabs();drawer.append(recovery,tabs,body);if(embedded)root.append(drawer);else root.append(toggle,drawer);instance.update=update;root.updateResearchWork=update;update(message,options);return instance;
}

export function researchWork(message, options = {}) {
  const work=message?.work;if(!work||work.kind!=='research')return null;const embedded=Boolean(options.embedded);const key=instanceKey(message,embedded);let instance=instances.get(key);
  const focused=instance?.root?.contains?.(document.activeElement)?document.activeElement:null;
  if(!instance){instance=createInstance(key,message,options);remember(key,instance);}else instance.update(message,options);
  if(focused)queueMicrotask(()=>{if(focused.isConnected)try{focused.focus({preventScroll:true});}catch{focused.focus?.();}});
  return instance.root;
}
