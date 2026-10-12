// Text-level redaction for captured pages. Prices and dates are kept on purpose:
// adapters need them to detect fees and renewal dates.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Masked card numbers such as "•••• 1234", "**** 1234", "ending in 1234".
const MASKED_CARD = /(?:[•*xX]{2,}[\s-]*)+\d{2,4}\b|\bending in \d{2,4}\b/gi;
// Card brand followed by its last digits, e.g. "Visa ending 4242" or a mangled bullet.
const BRAND_CARD = /\b(?:visa|mastercard|master card|amex|american express|discover|card)\b[^\n\d]{0,24}\d{4}\b/gi;
// Query strings and fragments on "/url:" lines of an accessibility snapshot.
const ARIA_URL_QUERY = /(\/url: [^\s?#]*)[?#]\S*/g;
// Phone numbers and other long identifiers (7+ digits, optionally separated).
const LONG_NUMBER = /\+?\(?\d(?:[\s().-]{0,2}\d){6,}/g;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactText(input, extraTerms = []) {
  let out = String(input)
    .replace(EMAIL, '[email]')
    .replace(ARIA_URL_QUERY, '$1')
    .replace(BRAND_CARD, '[card]')
    .replace(MASKED_CARD, '[card]')
    .replace(LONG_NUMBER, '[number]');
  for (const term of extraTerms) {
    if (term && term.trim().length >= 2) {
      out = out.replace(new RegExp(escapeRegExp(term.trim()), 'gi'), '[redacted]');
    }
  }
  return out;
}

module.exports = { redactText };
