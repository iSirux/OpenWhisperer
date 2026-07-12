// @ts-ignore - marked types
import { Marked, Renderer } from 'marked';
// @ts-ignore - marked-highlight types
import { markedHighlight } from 'marked-highlight';
// @ts-ignore - highlight.js types
import hljs from 'highlight.js';

// Create a custom renderer that opens links in external browser
const renderer = new Renderer();
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : '';
  // Add data-external attribute so our click handler can identify external links
  return `<a href="${href}"${titleAttr} data-external="true">${text}</a>`;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CODE_COPY_BUTTON_HTML =
  `<button type="button" class="code-copy-button" title="Copy code" aria-label="Copy code">` +
  `<svg class="code-copy-icon" viewBox="0 0 20 20" fill="currentColor"><path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/><path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"/></svg>` +
  `<svg class="code-copied-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>` +
  `</button>`;

// Wrap fenced code blocks so a copy button can sit fixed at the top-right,
// outside the horizontally-scrolling <pre>. Clicks are handled by the global
// delegated listener in the root layout (like data-external links).
renderer.code = ({ text, lang, escaped }: { text: string; lang?: string; escaped?: boolean }) => {
  const language = (lang || '').match(/^\S*/)?.[0] ?? '';
  const classAttr = language ? ` class="hljs language-${escapeHtml(language)}"` : '';
  const code = text.replace(/\n$/, '');
  return `<div class="code-block-wrapper"><pre><code${classAttr}>${escaped ? code : escapeHtml(code)}\n</code></pre>${CODE_COPY_BUTTON_HTML}</div>`;
};

// Create a configured marked instance with highlight.js for syntax highlighting
const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch (err) {
          console.error('Error highlighting code:', err);
        }
      }
      // Fallback to automatic language detection
      try {
        return hljs.highlightAuto(code).value;
      } catch (err) {
        console.error('Error auto-highlighting code:', err);
        return code;
      }
    },
  }),
  { renderer }
);

// Configure marked options
marked.setOptions({
  breaks: true, // Convert \n to <br>
  gfm: true, // GitHub Flavored Markdown
});

// Marked's default GFM strikethrough accepts single tildes without GFM's
// flanking rules, so "~245 ... (~58" pairs into one giant <del> span.
// Models write "~N" for "approximately" all the time; require ~~ instead.
marked.use({
  tokenizer: {
    del(src: string) {
      const match = /^~~(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))~~(?=[^~]|$)/.exec(src);
      if (!match) return undefined;
      return {
        type: 'del',
        raw: match[0],
        text: match[1],
        tokens: this.lexer.inlineTokens(match[1]),
      };
    },
  },
});

/**
 * Renders markdown text to HTML
 * @param markdown - The markdown string to render
 * @returns HTML string
 */
export function renderMarkdown(markdown: string): string {
  try {
    return marked.parse(markdown) as string;
  } catch (error) {
    console.error('Error parsing markdown:', error);
    return markdown; // Return original text if parsing fails
  }
}

/**
 * Sanitizes HTML to prevent XSS attacks
 * Note: marked has built-in sanitization options, but for extra safety
 * we could add DOMPurify here if needed
 */
export function sanitizeHtml(html: string): string {
  // For now, rely on marked's built-in sanitization
  // If we need more strict sanitization, we can add DOMPurify
  return html;
}
