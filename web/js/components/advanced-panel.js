import { el } from './dom.js';
import { cloneResponseProfile, DEFAULT_RESPONSE_PROFILE } from '../response-profile.js';

const LEVELS = Object.freeze([
  ['Instant', 'Fastest response. Facts can still use web evidence, but deliberate review is disabled.', true],
  ['Quick', 'A concise sourced answer with a small verification pass.'],
  ['Thorough', 'Recommended default: focused evidence followed by careful synthesis.'],
  ['Deep', 'More analysis over the same bounded research path.'],
]);

export function advancedPanel({ profile, onApply, onClose, onSetChatDefault, onResetNextRun, hasNextRunOverride = false }) {
  const draft = cloneResponseProfile(profile);
  let acknowledged = false;
  let warningHost = null;
  let statusValue = null;
  let defaultAction = null;
  let nextAction = null;

  const levelGrid = el('div', { class:'effort-level-grid', role:'radiogroup', 'aria-label':'Effort level' });
  const webModeControl = el('select', { class:'effort-web-mode', 'aria-label':'Web search mode' },
    el('option', { value:'off', text:'Off — never search' }),
    el('option', { value:'auto', text:'Auto — search when needed' }),
    el('option', { value:'force', text:'On — always search' }));
  webModeControl.value = ['off','auto','force'].includes(draft.research.mode) ? draft.research.mode : 'auto';
  const webEnabled = () => webModeControl.value !== 'off';
  const effectiveLevel = () => webEnabled() ? draft.effort : Math.min(1, draft.effort);
  const risky = () => draft.effort === 0 || !webEnabled();
  const syncRiskUi = () => {
    if (statusValue) statusValue.textContent = `Effective: ${LEVELS[effectiveLevel()][0]}`;
    if (defaultAction) defaultAction.textContent = risky() && !acknowledged ? 'Confirm risky chat default' : 'Set as chat default';
    if (nextAction) { nextAction.textContent = risky() && !acknowledged ? 'Confirm risky mode' : 'Use for next message'; nextAction.className = `btn ${risky() ? 'danger' : 'primary'}`; }
  };

  function renderLevels() {
    levelGrid.replaceChildren(...LEVELS.map(([label, description, danger], level) => {
      const selected = draft.effort === level;
      const capped = !webEnabled() && level > 1;
      return el('button', {
        type:'button', role:'radio', 'aria-checked':String(selected),
        class:`effort-level ${selected ? 'active' : ''} ${danger ? 'danger' : ''} ${capped ? 'capped' : ''}`.trim(),
        onClick:() => { draft.effort = level; acknowledged = false; renderLevels(); renderWarning(); },
      },
      el('span', { class:'effort-level-number numeric', text:String(level) }),
      el('span', { class:'effort-level-copy' }, el('strong', { text:label }), el('span', { class:'muted', text:description })),
      level === 2 ? el('span', { class:'pill', text:'Default' }) : capped ? el('span', { class:'pill', text:'Capped at Quick' }) : null);
    }));
  }

  function renderWarning() {
    if (!warningHost) return;
    warningHost.replaceChildren();
    if (draft.effort === 0) warningHost.append(el('div', { class:'effort-risk instant', role:'alert' },
      el('strong', { text:'! Instant mode is likely to hallucinate' }),
      el('p', { text:'Deliberate checking is disabled. Web search follows the selected Web Search mode, but synthesis can still be wrong—especially with very small local models.' })));
    if (!webEnabled()) warningHost.append(el('div', { class:'effort-risk web-off', role:'alert' },
      el('strong', { text:'! Web search is off' }),
      el('p', { text:'KL01 cannot verify factual claims. Effort is limited to Quick. Deterministic calculator results remain available.' })));
    if (risky() && !acknowledged) warningHost.append(el('p', { class:'muted', text:'Applying this risky setting requires a second confirmation.' }));
    syncRiskUi();
  }

  webModeControl.addEventListener('change', () => { draft.research.mode = webModeControl.value; acknowledged = false; renderLevels(); renderWarning(); });
  renderLevels();
  warningHost = el('div', { class:'effort-warning-host' });
  renderWarning();

  const apply = async (asDefault = false) => {
    draft.modeId = 'standard';
    draft.workflow = { definition:null, recipeId:null, slotTargets:{} };
    draft.response.thinking = ['off','quick','standard','deep'][effectiveLevel()];
    if (risky() && !acknowledged) { acknowledged = true; renderWarning(); return; }
    if (asDefault) await onSetChatDefault?.(cloneResponseProfile(draft));
    else await onApply?.(cloneResponseProfile(draft));
    onClose?.();
  };

  statusValue = el('span', { class:'muted', text:`Effective: ${LEVELS[effectiveLevel()][0]}` });
  defaultAction = el('button', { class:'btn', type:'button', onClick:()=>apply(true), text:'Set as chat default' });
  nextAction = el('button', { class:'btn primary', type:'button', onClick:()=>apply(false), text:'Use for next message' });
  const panel = el('div', { class:'advanced-panel effort-panel' },
    el('div', { class:'advanced-panel-head' },
      el('div', {}, el('h2', { text:'Effort' }), el('p', { class:'muted', text:'Four bounded modes. KL01 gathers a focused evidence packet, then spends its remaining effort analysing it.' })),
      el('button', { class:'icon-btn', type:'button', 'aria-label':'Close effort controls', onClick:onClose, text:'×' })),
    el('div', { class:'advanced-panel-body' },
      el('div', { class:'beta-explainer' }, el('strong', { text:'KL01 Pre Beta is entirely unfinished' }), el('span', { text:'Every feature is still being validated. These controls use bounded research and analysis; automatic multi-agent, Red Team, and hours-long workflow fan-out are disabled.' })),
      el('section', { class:'advanced-section' },
        el('div', { class:'advanced-section-heading' }, el('h3', { text:'Thinking and research effort' }), el('p', { class:'muted', text:'Every mode has hard limits on searches, pages, rounds, and collection time.' })),
        levelGrid),
      el('section', { class:'advanced-section' },
        el('label', { class:'effort-web-toggle' }, el('span', {}, el('strong', { text:'Web search' }), el('span', { class:'muted', text:'Auto searches only when current or externally verifiable evidence is needed. On searches every eligible message; Off never searches.' })), webModeControl)),
      warningHost,
      el('section', { class:'advanced-section effort-principles' },
        el('h3', { text:'Reliability rules' }),
        el('ul', {},
          el('li', { text:'Research collects a small relevant packet instead of feeding the model an uncontrolled pile of pages.' }),
          el('li', { text:'Important dates, eligibility rules, and India-specific claims prefer current official sources.' }),
          el('li', { text:'Calculations use the deterministic scientific calculator when supported.' }),
          el('li', { text:'The live panel shows searches, opened pages, extracted evidence, and verification.' })))),
    el('div', { class:'advanced-scope-status', role:'status' },
      el('strong', { text:hasNextRunOverride ? 'Next-run override active' : 'Using this chat’s default' }),
      statusValue),
    el('div', { class:'advanced-panel-actions' },
      el('button', { class:'btn', type:'button', onClick:() => { const reset=cloneResponseProfile(DEFAULT_RESPONSE_PROFILE); Object.assign(draft, reset); webModeControl.value='auto'; acknowledged=false; renderLevels(); renderWarning(); }, text:'Reset to Thorough' }),
      hasNextRunOverride ? el('button', { class:'btn', type:'button', onClick:async()=>{ await onResetNextRun?.(); onClose?.(); }, text:'Clear next-run override' }) : null,
      el('span', { class:'advanced-action-spacer' }),
      defaultAction,
      nextAction),
  );
  syncRiskUi();
  return panel;
}
