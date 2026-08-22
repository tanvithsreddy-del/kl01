let originalHref = null;
function link() {
  let node = document.querySelector('link[rel="icon"]');
  if (!node) { node = document.createElement('link'); node.rel = 'icon'; document.head.append(node); }
  return node;
}
export const faviconMotion = {
  start() {
    const icon = link();
    originalHref = originalHref || icon.getAttribute('href') || '/logos/kl01-favicon.svg';
    icon.href = originalHref;
  },
  stop() { if (originalHref) link().href = originalHref; },
};
