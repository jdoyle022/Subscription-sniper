// Runs inside the page (passed to page.evaluate). Returns a copy of the DOM with
// scripts, tokens, form values and URL query strings removed, keeping the
// structure, roles, labels and visible text that adapters are written against.
function sanitizeDocument() {
  const KEEP_DATA_ATTR_MAX = 40; // longer data-* values are usually tokens
  const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'poster'];
  const root = document.documentElement.cloneNode(true);

  root.querySelectorAll('script, noscript, style, link, meta:not([charset]), template, input[type=hidden]')
    .forEach((el) => el.remove());

  for (const el of root.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || ['value', 'nonce', 'integrity', 'srcset', 'style'].includes(name)) {
        el.removeAttribute(attr.name);
      } else if (name.startsWith('data-') && attr.value.length > KEEP_DATA_ATTR_MAX) {
        el.setAttribute(attr.name, '[long]');
      } else if (URL_ATTRS.includes(name)) {
        try {
          const u = new URL(attr.value, location.href);
          el.setAttribute(attr.name, u.protocol.startsWith('http') ? `${u.origin}${u.pathname}` : '[url]');
        } catch {
          el.removeAttribute(attr.name);
        }
      }
    }
    if (el.tagName === 'path') el.removeAttribute('d'); // icon geometry, just noise
    if (el.tagName === 'TEXTAREA') el.textContent = '';
  }
  return '<!doctype html>\n' + root.outerHTML;
}

module.exports = { sanitizeDocument };
