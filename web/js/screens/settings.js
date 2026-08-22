import { api } from '../api.js';
import { el, clear, copyText, cssTime } from '../components/dom.js';
import { modal } from '../components/modal.js';
import { showOverlay, hideOverlay } from '../components/overlay.js';
import { topNav } from '../components/nav.js';
import { state } from '../state.js';
import { conditionError } from '../condition-error.js';
import { providerMark } from '../components/provider-mark.js';
import { downloadDiagnostic } from '../diagnostics.js';

const SIZE_LABELS = [['small','Small'],['default','Default'],['large','Large'],['larger','Larger'],['largest','Largest']];
const SENDING = [['enter','Enter sends, Shift+Enter for a new line'],['ctrl-enter','Ctrl+Enter sends, Enter for a new line'],['button','Only the Send button sends']];
const FULL_BEHAVIOURS = [['ask','Ask me before compressing'],['auto','Compress automatically and show me after'],['new-chat','Start a new chat instead']];
const OFFER_THRESHOLDS = [['70','70%'],['85','85%'],['full','Only when full']];
const PROVIDER_AND_MODEL_MARKS = [
  'OpenAI','Anthropic','Google Gemini','Azure OpenAI','Amazon Bedrock','Cohere','DeepSeek','Groq','Mistral','NVIDIA NIM',
  'OpenRouter','Together AI','xAI','Cerebras','Fireworks AI','Perplexity','SambaNova','Moonshot AI','MiniMax','Z.AI',
  'APIpie','CometAPI','Gitee AI','Novita AI','PPIO','PrivateMode','LiteLLM','Ollama','LM Studio','LocalAI','KoboldCpp',
  'Text generation web UI','Docker Model Runner','Foundry Local','Lemonade','OMLX','OpenAI-compatible',
  'Qwen','Meta','Google','Menlo','Hugging Face','IBM','LG AI Research','TII','Microsoft',
];

function dateLabel(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'short' }).format(new Date(time));
}

export function createSettingsScreen({ onRoute }) {
  let root;
  let services = [];
  let archivedChats = [];
  let catalogue = [];
  let preferences = null;
  let networkProxyDraft = '';
  let discoveryEndpointDraft = '';
  let formOpen = false;
  let removeAction = null;
  let dialogNode = null;
  let overlayTrigger = null;
  let form = { name:'OpenAI-compatible service', baseUrl:'', model:'', apiKey:'', providerId:'openai-compatible' };
  let error = null;
  let queue = Promise.resolve();
  let settingsPending = 0;
  let lastUndo = null;
  let saveStatus = '';
  let diagnosticBusy = false;
  let bugReportBusy = false;
  let desktopZoom = null;
  let desktopZoomBusy = false;
  let desktopZoomCleanup = null;
  let savingService = false;
  const busyArchived = new Set();

  function scrollNode() { return root?.querySelector('[data-scroll-region="settings"]') || null; }
  function ensureShell() {
    let node = scrollNode();
    if (node || !root) return node;
    node = el('div', { class: 'setup-main page-scroll', 'data-scroll-region': 'settings' });
    clear(root).append(el('div', { class: 'setup-shell' }, topNav('settings', onRoute), node));
    return node;
  }
  function applyAppearance() { if (preferences) document.documentElement.dataset.textSize = preferences.appearance.textSize; }
  function renderPreservingScroll() { render(); }
  function syncControls() {
    if (!root || !preferences) return;
    for (const button of root.querySelectorAll('[data-text-size]')) {
      const active = button.dataset.textSize === preferences.appearance.textSize;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    for (const [key, value] of [['sending',preferences.chat.sending],['conversationLengthAs',preferences.chat.conversationLengthAs],['whenFull',preferences.conversation.whenFull],['offerAt',preferences.conversation.offerAt]]) {
      const select = root.querySelector(`[data-pref-select="${key}"]`);
      if (select) select.value = value;
    }
    for (const button of root.querySelectorAll('[data-pref-toggle]')) {
      const key = button.dataset.prefToggle;
      const on = Boolean(preferences.chat[key]);
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
      button.setAttribute('aria-label', `${button.dataset.prefLabel}: ${on ? 'on' : 'off'}`);
      button.textContent = on ? 'On' : 'Off';
    }
  }

  async function load() {
    try {
      const [serviceResult, preferenceResult, runtimeResult, catalogueResult, archivedResult] = await Promise.all([
        api.services(), api.preferences(), api.runtime(), api.models(), api.archivedChats(),
      ]);
      services = serviceResult.services || [];
      preferences = preferenceResult;
      state.setRuntime(runtimeResult);
      catalogue = catalogueResult.entries || [];
      archivedChats = archivedResult.chats || [];
      state.set({ preferences });
      applyAppearance();
      if (globalThis.kl01Desktop?.getZoom) desktopZoom = await globalThis.kl01Desktop.getZoom().catch(() => null);
      error = null;
    } catch {
      error = conditionError('settings-load', 'Settings did not load.');
    }
    renderPreservingScroll();
  }

  function mergePreferencePatch(base, patch) {
    return {
      ...base,
      ...(patch.appearance ? { appearance:{ ...base.appearance, ...patch.appearance } } : {}),
      ...(patch.chat ? { chat:{ ...base.chat, ...patch.chat } } : {}),
      ...(patch.conversation ? { conversation:{ ...base.conversation, ...patch.conversation } } : {}),
      ...(patch.research ? { research:{ ...base.research, ...patch.research } } : {}),
      ...(patch.execution ? { execution:{ ...base.execution, ...patch.execution } } : {}),
      ...(patch.diagnostics ? { diagnostics:{ ...base.diagnostics, ...patch.diagnostics } } : {}),
      ...(patch.network ? { network:{ ...base.network, ...patch.network } } : {}),
    };
  }
  function inversePreferencePatch(before, patch) {
    const inverse={};
    for(const group of ['appearance','chat','conversation','research','execution','network','diagnostics']){
      if(!patch[group]) continue;
      inverse[group]={};
      for(const key of Object.keys(patch[group])) inverse[group][key]=before[group]?.[key];
    }
    return inverse;
  }
  function savePreferences(patch, { label='Setting', allowUndo=true } = {}) {
    if (!preferences) return Promise.resolve(null);
    const before = structuredClone(preferences);
    const inverse = inversePreferencePatch(before, patch);
    preferences = mergePreferencePatch(preferences, patch);
    applyAppearance(); syncControls(); renderPreservingScroll();
    const requested = structuredClone(patch);
    settingsPending += 1;
    queue = queue.then(async () => {
      try {
        const payload={...requested, expectedRevision:Number(preferences?.revision ?? before.revision ?? 0)};
        // The optimistic object may have inherited the same revision; the authoritative server response advances it.
        const freshBefore=await api.preferences();
        payload.expectedRevision=Number(freshBefore.revision||0);
        const saved = await api.savePreferences(payload);
        preferences = saved;
        state.set({ preferences:saved });
        error = null;
        saveStatus = `${label} saved`;
        if (allowUndo) lastUndo={ label, inverse, expectedRevision:Number(saved.revision||0) };
      } catch (caught) {
        error = conditionError('setting-save', caught?.message || `${label} was not saved.`);
        saveStatus = '';
        try { preferences = await api.preferences(); state.set({preferences}); applyAppearance(); } catch {}
      } finally {
        settingsPending=Math.max(0,settingsPending-1);
        applyAppearance(); renderPreservingScroll();
      }
      return preferences;
    });
    return queue;
  }
  async function undoLastSetting() {
    if(!lastUndo || settingsPending) return;
    const undo=lastUndo;
    try {
      const current=await api.preferences();
      if(Number(current.revision||0)!==Number(undo.expectedRevision||0)){
        preferences=current;
        state.set({preferences:current});
        lastUndo=null;
        saveStatus='Undo unavailable because Settings changed after that save';
        applyAppearance();
        renderPreservingScroll();
        return;
      }
    } catch(caught) {
      error=conditionError('setting-undo-check',caught?.message||'KL01 could not confirm that undo is still safe.');
      renderPreservingScroll();
      return;
    }
    lastUndo=null;
    await savePreferences(undo.inverse,{label:`Undo ${undo.label}`,allowUndo:false});
  }

  async function removeService(id) {
    try { await api.removeService(id); removeAction = null; await load(); }
    catch { error = conditionError('service-remove', 'External service was not removed.'); removeAction = null; renderPreservingScroll(); }
  }

  async function deleteArchived(id) {
    if (busyArchived.has(id)) return;
    busyArchived.add(id);
    try { await api.deleteChat(id); removeAction = null; archivedChats = archivedChats.filter(chat => chat.id !== id); error = null; }
    catch { error = conditionError('archive-delete', 'Archived chat was not deleted.'); removeAction = null; }
    finally { busyArchived.delete(id); renderPreservingScroll(); }
  }

  async function restoreArchived(id) {
    if (busyArchived.has(id)) return;
    busyArchived.add(id); renderPreservingScroll();
    try { await api.restoreChat(id); archivedChats = archivedChats.filter(chat => chat.id !== id); error = null; }
    catch { error = conditionError('archive-restore', 'Archived chat was not restored.'); }
    finally { busyArchived.delete(id); renderPreservingScroll(); }
  }

  async function connectService() {
    if (savingService) return;
    if (serviceFormInvalid()) { error = conditionError('service-form', 'Service name, address, and AI name are required.'); renderPreservingScroll(); return; }
    savingService = true;
    dialogNode?.setPrimaryDisabled?.(true, 'The external service is being saved.');
    try {
      await api.saveService(form);
      formOpen = false;
      form = { name:'OpenAI-compatible service', baseUrl:'', model:'', apiKey:'', providerId:'openai-compatible' };
      await load();
    } catch { error = conditionError('service-save', 'External service was not saved.'); renderPreservingScroll(); }
    finally { savingService = false; dialogNode?.setPrimaryDisabled?.(serviceFormInvalid()); }
  }

  function serviceFormInvalid() { return [form.name, form.baseUrl, form.model].some(value => !String(value || '').trim()); }
  function field(label, key, type = 'text', placeholder = '') {
    return el('label', { class:'label' }, el('span', { text:label }), el('input', { class:'field', type, value:form[key], placeholder, 'data-service-field':key, onInput:event => { form[key] = event.target.value; dialogNode?.setPrimaryDisabled?.(savingService || serviceFormInvalid()); } }));
  }
  function row(title, detail, control, attributes = {}) {
    return el('div', { class:'settings-row card', ...attributes }, el('div', { class:'settings-row-copy' }, el('strong', { text:title }), detail ? el('p', { class:/\d/.test(String(detail)) ? 'muted numeric readout' : 'muted', text:detail }) : null), control);
  }
  function savingReason(disabled = settingsPending > 0) { return disabled ? 'Another Settings change is being saved.' : ''; }
  function toggle(label, key) {
    const on = Boolean(preferences.chat[key]);
    return el('button', { class:`btn toggle ${on ? 'active' : ''}`, type:'button', 'data-pref-toggle':key, 'data-pref-label':label, 'aria-pressed':String(on), 'aria-label':`${label}: ${on ? 'on' : 'off'}`, onClick:() => savePreferences({ chat:{ [key]:!on } }), text:on ? 'On' : 'Off' });
  }



  function proxyControls() {
    const proxyValue=String(preferences?.network?.proxy || '').trim();
    const configured=Boolean(proxyValue);
    let type=null;
    if(configured){try{type=new URL(proxyValue).protocol.replace(':','');}catch{type='proxy';}}
    let saveButton=null;
    const input=el('input', { class:'field', type:'url', value:networkProxyDraft, placeholder:configured ? 'Enter a replacement proxy URL' : 'http://proxy.example:8080', autocomplete:'off', spellcheck:'false', 'aria-label':'Static Research proxy URL', onInput:event => {
      networkProxyDraft=event.target.value;
      if(saveButton) saveButton.disabled=settingsPending>0 || !String(networkProxyDraft || '').trim();
    } });
    saveButton=el('button', { class:'btn primary', type:'button', disabled:settingsPending>0 || !String(networkProxyDraft || '').trim(), title:savingReason(), onClick:async()=>{const value=String(networkProxyDraft||'').trim();if(!value)return;await savePreferences({network:{proxy:value}},{label:'Network proxy'});networkProxyDraft='';}, text:'Save proxy' });
    return el('details', { class:'web-proxy-settings card' },
      el('summary', { text:'Managed network / proxy' }),
      el('p', { class:'muted', text:configured ? `A ${String(type || 'proxy').toUpperCase()} proxy is configured. Research will not bypass it with a direct connection if the proxy fails.` : 'Optional expert network setting. Use a static HTTP, HTTPS or SOCKS5 proxy when your network requires one.' }),
      el('label', { class:'label' }, el('span', { text:'Static proxy URL' }), input),
      el('div', { class:'web-proxy-actions' },
        saveButton,
        configured ? el('button', { class:'btn', type:'button', disabled:settingsPending>0, title:savingReason(), onClick:async()=>{networkProxyDraft='';await savePreferences({network:{proxy:null}},{label:'Network proxy'});}, text:'Clear proxy' }) : null));
  }

  function discoveryControls() {
    const configured=String(preferences?.network?.discoveryEndpoint || '').trim();
    let saveButton=null;
    const input=el('input',{class:'field',type:'url',value:discoveryEndpointDraft,placeholder:configured?'Enter a replacement endpoint':'https://search.example.com',autocomplete:'off',spellcheck:'false','aria-label':'Custom Research discovery endpoint',onInput:event=>{
      discoveryEndpointDraft=event.target.value;
      if(saveButton) saveButton.disabled=settingsPending>0||!String(discoveryEndpointDraft||'').trim();
    }});
    saveButton=el('button',{class:'btn primary',type:'button',disabled:settingsPending>0||!String(discoveryEndpointDraft||'').trim(),title:savingReason(),onClick:async()=>{const value=String(discoveryEndpointDraft||'').trim();if(!value)return;await savePreferences({network:{discoveryEndpoint:value}},{label:'Discovery endpoint'});discoveryEndpointDraft='';},text:'Save endpoint'});
    return el('details',{class:'web-proxy-settings card'},
      el('summary',{text:'Custom discovery endpoint'}),
      el('p',{class:'muted',text:configured?'A custom SearXNG endpoint is configured. It is used as one discovery path; page evidence still passes through the normal Research verification pipeline.':'Optional expert setting for a public SearXNG endpoint. Leave blank to use KL01’s built-in discovery paths.'}),
      el('label',{class:'label'},el('span',{text:'SearXNG endpoint'}),input),
      el('div',{class:'web-proxy-actions'},
        saveButton,
        configured?el('button',{class:'btn',type:'button',disabled:settingsPending>0,title:savingReason(),onClick:async()=>{discoveryEndpointDraft='';await savePreferences({network:{discoveryEndpoint:null}},{label:'Discovery endpoint'});},text:'Clear endpoint'}):null));
  }

  function networkSection() {
    return el('section', { class:'settings-section', 'data-settings-section':'network' },
      el('div', { class:'settings-section-head' },
        el('div', {}, el('h2', { text:'Network' }), el('p', { class:'muted', text:'Expert network configuration only. Research uses these settings automatically when needed.' }))),
      proxyControls(), discoveryControls());
  }

  function externalServicesSection() {
    const serviceRows = services.length
      ? services.map(service => {const health=service.health||{status:'unknown'};const healthText=health.status==='healthy'?'Last request reached the service':health.status==='unavailable'?`Last request failed${health.lastFailureCode?` · ${health.lastFailureCode}`:''}`:'Health unknown until this service is used';return el('div', { class:'settings-row card external-service-row', 'data-service-id':service.id },
          providerMark(service, { className:'logo-box external-service-logo' }),
          el('div', { class:'settings-row-copy' }, el('strong', { text:service.name }), el('p', { class:'muted', text:`${service.model} · ${service.baseUrl}` }),el('p',{class:'muted service-capability-line',text:`Text input · Attachments blocked · Structured output not advertised · ${healthText}` })),
          el('div', { class:'settings-row-actions' }, el('button', { class:'btn', type:'button', onClick:event => { overlayTrigger = event.currentTarget; removeAction = { kind:'service', id:service.id, name:service.name }; renderDialog(); }, text:'Remove' })));})
      : [row('No external AI services saved', 'Add one only when you want requests to leave this computer.', null, { class:'settings-row card settings-empty-row' })];
    return el('section', { class:'settings-section', 'data-settings-section':'external-services' },
      el('div', { class:'settings-section-head' }, el('h2', { text:'External AI services' })),
      row('Connect another service', 'Use any OpenAI-compatible local or remote address.', el('button', { class:'btn blue', type:'button', onClick:event => { overlayTrigger = event.currentTarget; formOpen = true; renderDialog(); }, text:'Add service' })),
      ...serviceRows);
  }

  function archivedSection() {
    const rows = archivedChats.length ? archivedChats.map(chat => {
      const busy = busyArchived.has(chat.id);
      return row(chat.title, `Archived ${dateLabel(chat.archivedAt)} · Last active ${dateLabel(chat.updatedAt)}`,
        el('div', { class:'settings-row-actions' },
          el('button', { class:'btn', type:'button', disabled:busy, onClick:() => restoreArchived(chat.id), text:busy ? 'Working…' : 'Restore' }),
          el('button', { class:'btn danger', type:'button', disabled:busy, onClick:event => { overlayTrigger = event.currentTarget; removeAction = { kind:'archived-chat', id:chat.id, name:chat.title }; renderDialog(); }, text:'Delete' })),
        { 'data-archived-chat-id':chat.id });
    }) : [row('No archived chats', 'Chats you archive will appear here until restored or deleted.', null, { class:'settings-row card settings-empty-row' })];
    return el('section', { class:'settings-section', 'data-settings-section':'archived-chats' },
      el('div', { class:'settings-section-head' }, el('h2', { text:'Archived chats' }), el('p', { class:'muted', text:'Hidden from Chats and ordinary search, but still stored on this computer.' })),
      el('div', { class:'archived-chat-list' }, ...rows));
  }

  function appearanceSection() {
    return el('section', { class:'settings-section' },
      el('div', { class:'settings-section-head' }, el('h2', { text:'Appearance' })),
      el('div', { class:'appearance-card card' }, el('strong', { text:'Text size' }), el('div', { class:'segmented', role:'group', 'aria-label':'Text size' }, ...SIZE_LABELS.map(([value,label]) => el('button', { class:`theme-option ${preferences.appearance.textSize === value ? 'active' : ''}`, type:'button', 'data-text-size':value, 'aria-pressed':String(preferences.appearance.textSize === value), onClick:() => savePreferences({ appearance:{ textSize:value } }), text:label })))),
      row('Windows app zoom', desktopZoom ? `${desktopZoom.percent}% · 50%–150% · Ctrl+Plus, Ctrl+Minus, or Ctrl+0` : 'The packaged Windows app starts at 75% and supports 50%–150%. Use Ctrl+Plus to zoom in, Ctrl+Minus to zoom out, or Ctrl+0 for 100%.', globalThis.kl01Desktop ? el('div', { class:'settings-row-actions', role:'group', 'aria-label':'Windows app zoom' },
        el('button', { class:'btn', type:'button', disabled:desktopZoomBusy || desktopZoom?.percent <= desktopZoom?.minimum, 'aria-label':'Zoom out', onClick:() => changeDesktopZoom('out'), text:'−' }),
        el('button', { class:'btn', type:'button', disabled:desktopZoomBusy, onClick:() => changeDesktopZoom('reset'), text:'100%' }),
        el('button', { class:'btn', type:'button', disabled:desktopZoomBusy || desktopZoom?.percent >= desktopZoom?.maximum, 'aria-label':'Zoom in', onClick:() => changeDesktopZoom('in'), text:'+' })) : null),
      row('Sending', '', el('select', { class:'field', 'data-pref-select':'sending', 'aria-label':'Sending', onChange:event => savePreferences({ chat:{ sending:event.target.value } }) }, ...SENDING.map(([value,label]) => el('option', { value, selected:preferences.chat.sending === value, text:label })))),
      row('Show reply speed', '', toggle('Show reply speed','showReplySpeed')),
      row('Show message times', '', toggle('Show message times','showMessageTimes')),
      row('Remember where you were in each chat', '', toggle('Remember where you were in each chat','rememberScroll')),
      row('Conversation length as', '', el('select', { class:'field', 'data-pref-select':'conversationLengthAs', 'aria-label':'Conversation length as', onChange:event => savePreferences({ chat:{ conversationLengthAs:event.target.value } }) }, el('option', { value:'messages', selected:preferences.chat.conversationLengthAs === 'messages', text:'Messages left' }), el('option', { value:'percentage', selected:preferences.chat.conversationLengthAs === 'percentage', text:'Percentage' }))));
  }

  async function changeDesktopZoom(action) {
    if (!globalThis.kl01Desktop || desktopZoomBusy) return;
    desktopZoomBusy = true;
    renderPreservingScroll();
    try {
      const method = action === 'in' ? 'zoomIn' : action === 'out' ? 'zoomOut' : 'resetZoom';
      desktopZoom = await globalThis.kl01Desktop[method]();
      error = null;
    } catch (caught) { error = conditionError('desktop-zoom', caught?.message || 'Windows app zoom did not change.'); }
    finally { desktopZoomBusy = false; renderPreservingScroll(); }
  }

  function conversationSection() {
    return el('section', { class:'settings-section' },
      el('div', { class:'settings-section-head' }, el('h2', { text:'Conversation' })),
      row('When a chat gets full', 'Compression shortens what the model receives without changing your original transcript.', el('select', { class:'field', 'data-pref-select':'whenFull', 'aria-label':'When a chat gets full', onChange:event => savePreferences({ conversation:{ whenFull:event.target.value } }) }, ...FULL_BEHAVIOURS.map(([value,label]) => el('option', { value, selected:preferences.conversation.whenFull === value, text:label })))),
      row('Start offering to compress at', '', el('select', { class:'field numeric', 'data-pref-select':'offerAt', 'aria-label':'Start offering to compress at', onChange:event => savePreferences({ conversation:{ offerAt:event.target.value } }) }, ...OFFER_THRESHOLDS.map(([value,label]) => el('option', { value, selected:preferences.conversation.offerAt === value, text:label })))));
  }

  function researchDefaultsSection() {
    const research=preferences.research||{strategy:'balanced'};
    const details={
      balanced:'Balances relevance, source quality, freshness and independent confirmation.',
      diverse:'Spends more effort on independent source and viewpoint breadth when useful.',
      'source-first':'Tries task-appropriate preferred and primary sources first, then broadens automatically.',
      off:'Keeps automatic Research off. A direct same-turn request to search still counts as an explicit instruction.',
    };
    return el('section',{class:'settings-section','data-settings-section':'research-defaults'},
      el('div',{class:'settings-section-head'},el('div',{},el('h2',{text:'Research'}),el('p',{class:'muted',text:'KL01 decides when outside verification is useful. You choose only the high-level research strategy.'}))),
      row('Strategy',details[research.strategy]||details.balanced,el('select',{class:'field','aria-label':'Research strategy',disabled:settingsPending>0,title:savingReason(),onChange:event=>savePreferences({research:{strategy:event.target.value}},{label:'Research strategy'})},
        ...[['balanced','Balanced'],['diverse','Diverse'],['source-first','Source-first'],['off','Off']].map(([value,label])=>el('option',{value,selected:research.strategy===value,text:label})))));
  }

  async function exportDiagnostics(){
    if(diagnosticBusy)return;
    diagnosticBusy=true;renderPreservingScroll();
    try{
      const report=await api.diagnostics();
      downloadDiagnostic(report,{filename:`kl01-diagnostic-${new Date().toISOString().replace(/[:.]/gu,'-')}.json`});
      saveStatus='Sanitized diagnostic exported';error=null;
    }catch(caught){error=conditionError('diagnostic-export',caught?.message||'Diagnostic export failed.');}
    finally{diagnosticBusy=false;renderPreservingScroll();}
  }

  async function reportBug(){
    if(bugReportBusy)return;
    bugReportBusy=true;saveStatus='';renderPreservingScroll();
    try{
      const report=await api.diagnostics();
      const filename=`kl01-bug-report-${new Date().toISOString().replace(/[:.]/gu,'-')}.json`;
      downloadDiagnostic(report,{filename});
      const product=state.get().product||{};
      const subject='[KL01 Pre Beta] Bug report';
      const body=['What happened?','','','What did you expect?','','','Can you reproduce it?','','',`KL01 generated ${filename} locally. Please review and attach it. The file excludes chat text, prompts, file names and contents, page URLs and bodies, credentials, headers, proxy paths, and service addresses.`].join('\n');
      const address=String(product.bugReportEmail||'bugs@kondalabs.com');
      globalThis.location.href=`mailto:${encodeURIComponent(address)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      saveStatus='Private diagnostic downloaded; email draft opened';error=null;
    }catch(caught){error=conditionError('bug-report',caught?.message||'Bug report could not be prepared.');}
    finally{bugReportBusy=false;renderPreservingScroll();}
  }

  function executionSafetySection() {
    const execution=preferences.execution||{allowCompatibleFallback:true};
    const diagnostics=preferences.diagnostics||{includeDeveloperDetail:false};
    const fallback=Boolean(execution.allowCompatibleFallback);
    const detail=Boolean(diagnostics.includeDeveloperDetail);
    return el('section',{class:'settings-section','data-settings-section':'execution-safety'},
      el('div',{class:'settings-section-head'},el('div',{},el('h2',{text:'Execution and diagnostics'}),el('p',{class:'muted',text:'Global permissions and display preferences. Actual fallback remains visible in each run.'}))),
      row('Allow compatible fallback','Only after the selected configuration cannot execute. KL01 does not use this as a recommendation system.',el('button',{class:`btn toggle ${fallback?'active':''}`,type:'button','aria-pressed':String(fallback),disabled:settingsPending>0,title:savingReason(),onClick:()=>savePreferences({execution:{allowCompatibleFallback:!fallback}},{label:'Fallback permission'}),text:fallback?'Allowed':'Off'})),
      row('Show developer diagnostic detail','Normal errors stay concise. Technical codes, node IDs and target IDs remain behind disclosure. Private prompts and page/file bodies are never included.',el('button',{class:`btn toggle ${detail?'active':''}`,type:'button','aria-pressed':String(detail),disabled:settingsPending>0,title:savingReason(),onClick:()=>savePreferences({diagnostics:{includeDeveloperDetail:!detail}},{label:'Diagnostic detail'}),text:detail?'On':'Off'})),
      row('Export sanitized diagnostics','Exports app/runtime/settings metadata and safe failure/fallback timing. It excludes chat text, prompts, file bodies and names, Research page bodies/URLs, keys, cookies, headers, proxy/browser paths and service addresses.',el('button',{class:'btn',type:'button',disabled:diagnosticBusy,'aria-disabled':String(diagnosticBusy),title:diagnosticBusy?'A diagnostic export is already being prepared.':'Export a privacy-safe JSON diagnostic.',onClick:exportDiagnostics,text:diagnosticBusy?'Preparing…':'Export JSON'})),
      row('Report a bug','Downloads a privacy-safe diagnostic and opens a pre-addressed email draft. Nothing is sent automatically; review the JSON before attaching it.',el('button',{class:'btn blue',type:'button',disabled:bugReportBusy,'aria-disabled':String(bugReportBusy),onClick:reportBug,text:bugReportBusy?'Preparing…':'Report a bug'})),
      lastUndo ? el('div',{class:'settings-undo card',role:'status'},el('span',{text:`${saveStatus||lastUndo.label}.`}),el('button',{class:'btn compact',type:'button',disabled:settingsPending>0,title:savingReason(),onClick:undoLastSetting,text:'Undo'})) : saveStatus ? el('p',{class:'muted settings-save-status',role:'status',text:saveStatus}) : null);
  }

  function aboutSection() {
    return el('section', { class:'settings-section', 'data-settings-section':'about' },
      el('div', { class:'settings-section-head' }, el('h2', { text:'About' })),
      row('KL01 Pre Beta', 'The entire application is Pre Beta', null),
      el('div', { class:'card appearance-card' }, el('p', { text:'Local AI runs on this computer. External AI requests use network. Chats are stored on this computer.' })),
      el('div', { class:'card appearance-card' },
        el('strong', { text:'Licences and attribution' }),
        el('p', { text:'ANYTHINGLLM: LOGOS ONLY. No AnythingLLM code, runtime, packages, database, services, or routing are included in KL01.' }),
        el('p', { class:'muted', text:'KL01 application terms are in LICENSE. Logo artwork and other third-party notices are in THIRD_PARTY_NOTICES.md and the licenses folder.' }),
        el('h3', { text:'Model download terms' }),
        el('ul', { class:'attribution-list' }, ...catalogue.map(entry => el('li', {},
          el('span', { text:`${entry.name} — ${entry.licence || 'unknown'}` }),
          entry.licenceUrl ? el('a', { href:entry.licenceUrl, target:'_blank', rel:'noreferrer', text:' View terms' }) : null))),
        el('h3', { text:'Provider and model-maker marks' }),
        el('div', { class:'provider-mark-list', role:'list' }, ...PROVIDER_AND_MODEL_MARKS.map(name => el('div', { class:'provider-mark-item', role:'listitem' },
          providerMark({ providerName:name }, { className:'provider-mark-compact', decorative:false }),
          el('span', { text:name })))),
        el('p', { class:'muted', text:'Marks identify compatible services or model provenance only; inclusion does not imply endorsement.' })),
      el('details', { class:'advanced-disclosure' }, el('summary', { text:'Advanced' }), el('div', { class:'settings-row card' }, el('code', { class:'data-path', text:preferences.about?.dataFolder || '' }), (() => {
        const button = el('button', { class:'nav-chip', type:'button', text:'Copy', 'aria-label':'Copy' });
        button.addEventListener('click', async () => {
          try { await copyText(preferences.about?.dataFolder || ''); button.textContent = 'Copied'; }
          catch { button.textContent = 'Copy failed'; }
          setTimeout(() => { if (button.isConnected) button.textContent = 'Copy'; }, cssTime('--kl01-copy-reset'));
        });
        return button;
      })())));
  }

  function removeDialog() {
    if (!removeAction) return null;
    const action = removeAction;
    const archived = action.kind === 'archived-chat';
    return modal({
      title: archived ? 'Delete this archived chat?' : 'Remove this external AI service?',
      description: action.name,
      content: el('p', { class:'muted', text:archived ? 'The chat, its messages, and its saved context snapshots will be permanently deleted.' : 'The saved service configuration will be deleted.' }),
      primaryLabel: archived ? 'Delete chat' : 'Remove',
      onPrimary:() => archived ? deleteArchived(action.id) : removeService(action.id),
      onClose:() => { removeAction = null; renderDialog(); },
    });
  }

  function serviceDialog() {
    if (!formOpen) return null;
    dialogNode = modal({
      title:'Add an external AI service',
      description:'Saved services appear in Chat. Requests sent through them use network.',
      content:el('div', { class:'config-form external-service-form' },
        el('section', { class:'external-required-fields', 'aria-labelledby':'external-required-title' },
          el('div', { class:'external-form-heading' }, el('h3', { id:'external-required-title', text:'Connection details' }), el('p', { class:'muted', text:'Enter the required address and AI name before saving.' })),
          field('Service name','name'), field('Service address','baseUrl','url','https://example.com/v1'), field('AI name','model','text','Model name used by the service'), field('Access key','apiKey','password','Optional when the service does not require one')),
        el('p', { class:'muted', text:'Any OpenAI-compatible address can be used. KL01 does not maintain provider-specific shortcuts.' }),
        el('p', { class:'muted', text:'Local HTTP is allowed only for localhost; remote services must use HTTPS.' }),
        el('p', { class:'dialog-scroll-note muted', text:'This dialog scrolls internally when the window is short.' })),
      primaryLabel:'Save service',
      primaryDisabled:savingService || serviceFormInvalid(),
      primaryDisabledReason:savingService ? 'The external service is being saved.' : 'Enter a service name, address, and AI name.',
      onPrimary:connectService,
      onClose:() => { formOpen = false; renderDialog(); },
    });
    return dialogNode;
  }

  function renderDialog() {
    if (!root) return;
    const dialog = removeDialog() || serviceDialog();
    if (dialog) showOverlay(root, dialog, { trigger:overlayTrigger });
    else { hideOverlay(root); overlayTrigger = null; }
  }

  function render() {
    if (!root) return;
    if (!preferences) {
      const node = ensureShell();
      if (!node) return;
      clear(node).append(el('div', { class:'content-container' }, el('h1', { text:'Settings' }), el('div', { class:'failure-card card', role:'alert' }, el('strong', { text:error?.message || 'Settings could not be loaded; select Try again.' }), el('button', { class:'btn primary', type:'button', onClick:load, text:'Try again' }))));
      return;
    }
    const content = el('main', { class:'content-container', 'data-content-container':'settings', 'data-signature-surface':'settings' },
      el('div', { class:'setup-heading' }, el('div', { class:'setup-heading-copy' }, el('h1', { tabindex:'-1', text:'Settings' }))),
      error ? el('div', { class:'failure-card card', role:'alert' }, el('strong', { text:error.message })) : null,
      researchDefaultsSection(), networkSection(), executionSafetySection(), externalServicesSection(), archivedSection(), appearanceSection(), conversationSection(), aboutSection());
    const node = ensureShell();
    if (!node) return;
    clear(node).append(content);
    renderDialog();
  }

  return {
    mount(node) {
      root = node;
      ensureShell();
      if (!desktopZoomCleanup && globalThis.kl01Desktop?.onZoomChanged) {
        desktopZoomCleanup = globalThis.kl01Desktop.onZoomChanged(next => {
          desktopZoom = next;
          renderPreservingScroll();
        });
      }
      load();
    },
    unmount() {
      if (root) hideOverlay(root, { restoreFocus:false });
      desktopZoomCleanup?.();
      desktopZoomCleanup = null;
      root = null;
    },
  };
}
