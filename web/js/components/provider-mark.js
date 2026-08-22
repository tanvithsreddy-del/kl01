import { el } from './dom.js';

const PROVIDER_LOGO_FILES = new Map([
  'amazon-bedrock','anthropic','apipie','azure-openai','cerebras','cohere','cometapi','deepseek','docker-model-runner',
  'fireworks-ai','foundry-local','gitee-ai','google-gemini','google','groq','koboldcpp','lemonade','litellm','lm-studio',
  'localai','menlo','meta','minimax','mistral','moonshot-ai','novita-ai','nvidia-nim','ollama','omlx','openai-compatible',
  'openai','openrouter','perplexity','ppio','privatemode','qwen','sambanova','text-generation-webui','together-ai','xai','zai',
].map(id => [id, `${id}.webp`]));
for (const id of ['hugging-face','ibm','lg-ai-research','microsoft','tii']) PROVIDER_LOGO_FILES.set(id, `${id}.svg`);
PROVIDER_LOGO_FILES.set('z-ai', 'zai.webp');
PROVIDER_LOGO_FILES.set('text-generation-web-ui', 'text-generation-webui.webp');

function slug(value) {
  return String(value || '').normalize('NFKD').toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
}

export function providerLogoFile(entry = {}) {
  const candidates = [entry.providerId, entry.id, entry.providerName, entry.name, entry.family].map(slug).filter(Boolean);
  return candidates.map(id => PROVIDER_LOGO_FILES.get(id)).find(Boolean) || null;
}

export function providerInitials(entry = {}) {
  const source = String(entry.providerName || entry.name || entry.family || 'AI').trim();
  const words = source.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : source.slice(0, 2)).toLocaleUpperCase();
}

export function providerMark(entry = {}, { className = 'provider-logo logo-box', decorative = true } = {}) {
  const initials = providerInitials(entry);
  const fallback = el('span', { class: 'provider-mark-fallback provider-logo-text', 'aria-hidden': decorative ? 'true' : null, text: initials });
  const file = providerLogoFile(entry);
  const image = file ? el('img', {
    class:'provider-mark-image', src:`/logos/providers/${file}`,
    alt:decorative ? '' : `${entry.providerName || entry.name || entry.family || 'Provider'} logo`,
    'aria-hidden':decorative ? 'true' : null,
    onError:event => event.currentTarget.remove(),
  }) : null;
  return el('span', { class: className, 'data-provider-id': entry.providerId || entry.id || 'unknown' }, fallback, image);
}
