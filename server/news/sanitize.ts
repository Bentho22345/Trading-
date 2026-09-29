import sanitizeHtml from 'sanitize-html';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

/** Strip every tag and decode common entities. The browser renders plain text only. */
export function cleanText(input: string | undefined | null, max = 600): string {
  if (!input) return '';
  const stripped = sanitizeHtml(String(input), { allowedTags: [], allowedAttributes: {}, disallowedTagsMode: 'discard' });
  const decoded = stripped
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 31 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return decoded.length > max ? decoded.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : decoded;
}

/** Only allow http(s) links out. */
export function cleanUrl(url: string | undefined | null): string {
  if (!url) return '#';
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '#';
  } catch {
    return '#';
  }
}
