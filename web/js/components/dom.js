export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'value') node.value = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'disabled') node.disabled = Boolean(value);
    else if (key === 'checked') node.checked = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
export function clear(node) { node.replaceChildren(); return node; }
export function icon(path, label = '') {
  const namespace = 'http://www.w3.org/2000/svg';
  const create = tag => typeof document.createElementNS === 'function'
    ? document.createElementNS(namespace, tag)
    : document.createElement(tag);
  const svg = create('svg');
  const attributes = {
    class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': label ? 'false' : 'true',
  };
  if (label) attributes['aria-label'] = label;
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
  const shape = create('path');
  shape.setAttribute('d', String(path || ''));
  svg.append(shape);
  return svg;
}
export function cssTime(name, fallback = 0) {
  if (typeof getComputedStyle !== 'function') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  if (raw.endsWith('ms')) return Number.parseFloat(raw) || fallback;
  if (raw.endsWith('s')) return (Number.parseFloat(raw) || 0) * 1000;
  return Number.parseFloat(raw) || fallback;
}
export async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(String(text));
  const area = el('textarea', { value: String(text), class: 'clipboard-proxy', 'aria-hidden': 'true' });
  document.body.append(area); area.select(); document.execCommand('copy'); area.remove();
}
