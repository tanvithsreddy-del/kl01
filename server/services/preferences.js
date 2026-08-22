import { SETTINGS_FILE, DATA_DIR } from '../lib/paths.js';
import { readJson, readJsonRecovering, updateJson, writeJson } from './store.js';
import { fail } from '../lib/errors.js';
import { parseUpstreamProxy, formatUpstreamProxy } from '../web/upstream-proxy.js';

export const TEXT_SIZES = new Set(['small', 'default', 'large', 'larger', 'largest']);
export const SENDING_MODES = new Set(['enter', 'ctrl-enter', 'button']);
export const LENGTH_MODES = new Set(['messages', 'percentage']);
export const COMPRESSION_BEHAVIOURS = new Set(['ask', 'auto', 'new-chat']);
export const COMPRESSION_THRESHOLDS = new Set(['70', '85', 'full']);
export const RESEARCH_STRATEGIES = new Set(['balanced', 'diverse', 'source-first', 'off']);
const LEGACY_SOURCE_LENSES = new Set(['balanced', 'primary-first', 'diverse']);

export const DEFAULT_SETTINGS = Object.freeze({
  version: 13,
  revision: 0,
  activeModelId: null,
  activeServiceId: null,
  firstLaunchComplete: false,
  appearance: { theme: 'dark', textSize: 'default' },
  chat: {
    sending: 'enter',
    showReplySpeed: false,
    showMessageTimes: false,
    rememberScroll: true,
    conversationLengthAs: 'messages',
  },
  conversation: { whenFull: 'ask', offerAt: '85' },
  research: { strategy: 'balanced' },
  execution: { allowCompatibleFallback: true },
  network: { proxy: null, discoveryEndpoint: null },
  diagnostics: { includeDeveloperDetail: false },
  engine: null,
});

function legacyStrategy(source = {}) {
  const research = source.research || {};
  if (String(source.web?.decision) === 'off') return 'off';
  if (RESEARCH_STRATEGIES.has(String(research.strategy))) return String(research.strategy);
  const lens = LEGACY_SOURCE_LENSES.has(String(research.sourceLens)) ? String(research.sourceLens) : 'balanced';
  return lens === 'primary-first' ? 'source-first' : lens;
}

function normalizeProxy(value) {
  if (value == null || !String(value).trim()) return null;
  try { return formatUpstreamProxy(parseUpstreamProxy(String(value).trim())); }
  catch { return null; }
}

function normalizeDiscoveryEndpoint(value) {
  if (value == null || !String(value).trim()) return null;
  try {
    const parsed = new URL(String(value).trim());
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || ![80,443].includes(port)) return null;
    parsed.hash = '';
    return parsed.href.replace(/\/$/u, '');
  } catch { return null; }
}

function normalise(settings = {}) {
  const source = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const chat = source.chat || {};
  const conversation = source.conversation || {};
  const research = source.research || {};
  const execution = source.execution || {};
  const diagnostics = source.diagnostics || {};
  const legacy = Number(source.version || 0) < 13 || Object.hasOwn(source, 'web');
  const strategy = legacy
    ? legacyStrategy(source)
    : (RESEARCH_STRATEGIES.has(String(research.strategy)) ? String(research.strategy) : 'balanced');
  const networkSource = source.network || {};
  const proxy = normalizeProxy(networkSource.proxy ?? source.web?.upstreamProxy ?? null);
  const discoveryEndpoint = normalizeDiscoveryEndpoint(networkSource.discoveryEndpoint ?? source.web?.discovery?.searxngUrl ?? null);
  return {
    version: 13,
    revision: Math.max(0, Math.floor(Number(source.revision || 0))),
    activeModelId: typeof source.activeModelId === 'string' && source.activeModelId ? source.activeModelId : null,
    activeServiceId: typeof source.activeServiceId === 'string' && source.activeServiceId ? source.activeServiceId : null,
    firstLaunchComplete: Boolean(source.firstLaunchComplete),
    appearance: {
      theme: 'dark',
      textSize: TEXT_SIZES.has(source.appearance?.textSize) ? source.appearance.textSize : 'default',
    },
    chat: {
      sending: SENDING_MODES.has(chat.sending) ? chat.sending : 'enter',
      showReplySpeed: Boolean(chat.showReplySpeed),
      showMessageTimes: Boolean(chat.showMessageTimes),
      rememberScroll: chat.rememberScroll !== false,
      conversationLengthAs: LENGTH_MODES.has(chat.conversationLengthAs) ? chat.conversationLengthAs : 'messages',
    },
    conversation: {
      whenFull: COMPRESSION_BEHAVIOURS.has(conversation.whenFull) ? conversation.whenFull : 'ask',
      offerAt: COMPRESSION_THRESHOLDS.has(String(conversation.offerAt)) ? String(conversation.offerAt) : '85',
    },
    research: { strategy },
    execution: { allowCompatibleFallback: execution.allowCompatibleFallback !== false },
    network: { proxy, discoveryEndpoint },
    diagnostics: { includeDeveloperDetail: diagnostics.includeDeveloperDetail === true },
    engine: source.engine && typeof source.engine === 'object' ? structuredClone(source.engine) : null,
  };
}

function publicPreferences(settings) {
  return {
    revision: Number(settings.revision || 0),
    firstLaunchComplete: Boolean(settings.firstLaunchComplete),
    appearance: structuredClone(settings.appearance),
    chat: structuredClone(settings.chat),
    conversation: structuredClone(settings.conversation),
    research: structuredClone(settings.research),
    execution: structuredClone(settings.execution),
    network: structuredClone(settings.network),
    diagnostics: structuredClone(settings.diagnostics),
    about: { dataFolder:DATA_DIR },
  };
}

export async function migrateSettingsV13({ readSettings = () => readJson(SETTINGS_FILE, null), writeSettings = value => writeJson(SETTINGS_FILE, value) } = {}) {
  let raw;
  try { raw = await readSettings(); }
  catch (error) { throw fail('MIGRATION_RESEARCH_SHELL','KL01 could not read Settings safely for the Research upgrade. The existing Settings file was not replaced.',507,{causeCode:error?.code||error?.name||null},error); }
  if (!raw) return { migrated:false, fromVersion:null, toVersion:13 };
  const canonical = normalise(raw);
  if (JSON.stringify(raw) === JSON.stringify(canonical)) return { migrated:false, fromVersion:13, toVersion:13 };
  try { await writeSettings(canonical); }
  catch (error) { throw fail('MIGRATION_RESEARCH_SHELL','KL01 could not migrate Settings safely. The previous Settings file remains authoritative.',507,{fromVersion:Number(raw?.version||0)||null,toVersion:13,causeCode:error?.code||error?.name||null},error); }
  return { migrated:true, fromVersion:Number(raw?.version||0)||null, toVersion:13 };
}

export async function getAllSettings() { return normalise(await readJsonRecovering(SETTINGS_FILE, DEFAULT_SETTINGS)); }
export async function getPreferences() { return publicPreferences(await getAllSettings()); }

export async function updatePreferences(input, { storageUpdate = updateJson } = {}) {
  await getAllSettings();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('SETTINGS_SHAPE','The settings could not be saved; try again.',400);
  for (const removed of ['memory','reasoning','lookup','web']) if (Object.hasOwn(input,removed)) throw fail('SETTING_REMOVED','That setting is no longer part of KL01.',400);
  const hasAppearance=Object.hasOwn(input,'appearance');
  const hasChat=Object.hasOwn(input,'chat');
  const hasConversation=Object.hasOwn(input,'conversation');
  const hasFirstLaunch=Object.hasOwn(input,'firstLaunchComplete');
  const hasResearch=Object.hasOwn(input,'research');
  const hasExecution=Object.hasOwn(input,'execution');
  const hasNetwork=Object.hasOwn(input,'network');
  const hasDiagnostics=Object.hasOwn(input,'diagnostics');
  if(!hasAppearance && !hasChat && !hasConversation && !hasFirstLaunch && !hasResearch && !hasExecution && !hasNetwork && !hasDiagnostics) throw fail('SETTINGS_EMPTY','Choose a setting to change.',400);

  if(hasAppearance && Object.hasOwn(input.appearance||{},'textSize') && !TEXT_SIZES.has(input.appearance.textSize)) throw fail('APPEARANCE_VALUE','Choose one of the available text sizes.',400);
  if(hasAppearance && Object.hasOwn(input.appearance||{},'theme') && input.appearance.theme !== 'dark') throw fail('APPEARANCE_VALUE','This appearance cannot be changed in this version; keep the KL01 dark theme.',400);
  if(hasChat){
    if(Object.hasOwn(input.chat||{},'sending') && !SENDING_MODES.has(input.chat.sending)) throw fail('SENDING_VALUE','Choose one of the available sending options.',400);
    if(Object.hasOwn(input.chat||{},'conversationLengthAs') && !LENGTH_MODES.has(input.chat.conversationLengthAs)) throw fail('LENGTH_VALUE','Choose messages left or percentage.',400);
    for(const key of ['showReplySpeed','showMessageTimes','rememberScroll']) if(Object.hasOwn(input.chat||{},key) && typeof input.chat[key] !== 'boolean') throw fail('SETTING_VALUE','This setting could not be saved; try again.',400);
  }
  if(hasConversation){
    if(Object.hasOwn(input.conversation||{},'whenFull') && !COMPRESSION_BEHAVIOURS.has(input.conversation.whenFull)) throw fail('COMPRESSION_BEHAVIOUR','Choose one of the available full-chat options.',400);
    if(Object.hasOwn(input.conversation||{},'offerAt') && !COMPRESSION_THRESHOLDS.has(String(input.conversation.offerAt))) throw fail('COMPRESSION_THRESHOLD','Choose 70%, 85%, or only when full.',400);
  }
  if(hasFirstLaunch && typeof input.firstLaunchComplete !== 'boolean') throw fail('FIRST_LAUNCH_VALUE','The setup state could not be saved; try again.',400);
  if(hasResearch){
    if(!input.research || typeof input.research !== 'object' || Array.isArray(input.research)) throw fail('RESEARCH_SETTINGS_SHAPE','Research settings could not be saved.',400);
    if(Object.hasOwn(input.research,'depth') || Object.hasOwn(input.research,'sourceLens')) throw fail('SETTING_REMOVED','Research depth and source lens are now managed automatically.',400);
    if(Object.hasOwn(input.research,'strategy') && !RESEARCH_STRATEGIES.has(String(input.research.strategy))) throw fail('RESEARCH_STRATEGY','Choose Balanced, Diverse, Source-first, or Off.',400);
  }
  if(hasExecution){
    if(!input.execution || typeof input.execution !== 'object' || Array.isArray(input.execution)) throw fail('EXECUTION_SETTINGS_SHAPE','Execution settings could not be saved.',400);
    if(Object.hasOwn(input.execution,'allowCompatibleFallback') && typeof input.execution.allowCompatibleFallback !== 'boolean') throw fail('EXECUTION_FALLBACK_VALUE','Fallback permission could not be saved.',400);
  }
  if(hasNetwork){
    if(!input.network || typeof input.network !== 'object' || Array.isArray(input.network)) throw fail('NETWORK_SETTINGS_SHAPE','Network settings could not be saved.',400);
    for(const key of Object.keys(input.network)) if(!['proxy','discoveryEndpoint'].includes(key)) throw fail('NETWORK_SETTING_UNKNOWN','That network setting is not supported.',400);
    if(Object.hasOwn(input.network,'proxy') && input.network.proxy !== null){
      if(typeof input.network.proxy !== 'string') throw fail('WEB_PROXY_URL','The proxy URL is not valid.',400);
      parseUpstreamProxy(input.network.proxy);
    }
    if(Object.hasOwn(input.network,'discoveryEndpoint') && input.network.discoveryEndpoint !== null && normalizeDiscoveryEndpoint(input.network.discoveryEndpoint) === null) throw fail('WEB_DISCOVERY_URL','Enter a public SearXNG URL on standard HTTP or HTTPS without embedded credentials.',400);
  }
  if(hasDiagnostics){
    if(!input.diagnostics || typeof input.diagnostics !== 'object' || Array.isArray(input.diagnostics)) throw fail('DIAGNOSTIC_SETTINGS_SHAPE','Diagnostic settings could not be saved.',400);
    if(Object.hasOwn(input.diagnostics,'includeDeveloperDetail') && typeof input.diagnostics.includeDeveloperDetail !== 'boolean') throw fail('DIAGNOSTIC_SETTING_VALUE','Diagnostic detail preference could not be saved.',400);
  }

  let stored;
  try {
    stored=await storageUpdate(SETTINGS_FILE,DEFAULT_SETTINGS,current=>{
      const base=normalise(current);
      const expectedRevision = input.expectedRevision == null ? null : Math.max(0, Math.floor(Number(input.expectedRevision)));
      if (expectedRevision != null && expectedRevision !== Number(base.revision || 0)) throw fail('SETTINGS_STALE','Settings changed elsewhere. Reload the latest settings before saving again.',409,{expectedRevision,actualRevision:Number(base.revision||0)});
      const next={
        ...base,
        version:13,
        revision:Number(base.revision || 0) + 1,
        ...(hasAppearance ? {appearance:{...base.appearance,...input.appearance,theme:'dark'}} : {}),
        ...(hasChat ? {chat:{...base.chat,...input.chat}} : {}),
        ...(hasConversation ? {conversation:{...base.conversation,...input.conversation,offerAt:String(input.conversation?.offerAt ?? base.conversation.offerAt)}} : {}),
        ...(hasFirstLaunch ? {firstLaunchComplete:input.firstLaunchComplete} : {}),
        ...(hasResearch ? {research:{strategy:Object.hasOwn(input.research,'strategy')?String(input.research.strategy):base.research.strategy}} : {}),
        ...(hasExecution ? {execution:{...base.execution,...input.execution}} : {}),
        ...(hasNetwork ? {network:{
          proxy:Object.hasOwn(input.network,'proxy')?normalizeProxy(input.network.proxy):base.network.proxy,
          discoveryEndpoint:Object.hasOwn(input.network,'discoveryEndpoint')?normalizeDiscoveryEndpoint(input.network.discoveryEndpoint):base.network.discoveryEndpoint,
        }} : {}),
        ...(hasDiagnostics ? {diagnostics:{...base.diagnostics,...input.diagnostics}} : {}),
      };
      return normalise(next);
    });
  } catch (error) {
    if (error?.code === 'SETTINGS_STALE' || ['SETTINGS_SHAPE','SETTING_REMOVED','SETTINGS_EMPTY','SETTING_VALUE','APPEARANCE_VALUE','SENDING_VALUE','LENGTH_VALUE','COMPRESSION_BEHAVIOUR','COMPRESSION_THRESHOLD','FIRST_LAUNCH_VALUE','RESEARCH_SETTINGS_SHAPE','RESEARCH_STRATEGY','EXECUTION_SETTINGS_SHAPE','EXECUTION_FALLBACK_VALUE','NETWORK_SETTINGS_SHAPE','NETWORK_SETTING_UNKNOWN','DIAGNOSTIC_SETTINGS_SHAPE','DIAGNOSTIC_SETTING_VALUE','WEB_PROXY_URL','WEB_PROXY_AUTH_UNSUPPORTED','WEB_DISCOVERY_URL'].includes(error?.code)) throw error;
    throw fail('SETTINGS_PERSIST_FAIL','KL01 could not save these settings safely. Your previous settings are unchanged; check storage access and try again.',507,{causeCode:error?.code||error?.name||null},error);
  }
  return publicPreferences(normalise(stored));
}
