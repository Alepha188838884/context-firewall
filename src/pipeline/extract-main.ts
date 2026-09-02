import domino from '@mixmark-io/domino';

// Elements that are never content, wherever they sit in the document - safe to strip globally
// before we even try to pick a content root.
const NEVER_CONTENT_SELECTOR = ['script', 'style', 'svg', 'noscript', 'iframe', 'template'].join(', ');

// Root-internal strip list for an <article> root: nav-as-decoration and hidden regions are
// still chrome wherever they sit, but header/footer/aside are left alone - per the HTML5 spec
// they're commonly the article's own title block + byline (<header>), its own end matter
// (<footer>), or a genuine pull-quote/callout box (<aside>), not page chrome.
const ROOT_INTERNAL_STRIP_SELECTOR_ARTICLE = ['nav', '[role="navigation"]', '[aria-hidden="true"]'].join(', ');

// Root-internal strip list for a <main>/[role="main"] root: same as above, but header/footer
// are ALSO stripped here. Evidence: MediaWiki wraps <main> in a <header class="mw-body-header">
// that holds the page titlebar + a language-switcher dropdown - genuine page chrome, not an
// article's own byline (that distinction only holds for <article>). aside is still kept - a
// callout/tip box can legitimately sit directly in a <main> too.
const ROOT_INTERNAL_STRIP_SELECTOR_MAIN = ['nav', '[role="navigation"]', '[aria-hidden="true"]', 'header', 'footer'].join(
  ', '
);

// Full page-chrome set, used only on the body fallback path (no content root was found), where
// there's no root boundary to exclude page-level chrome for us.
const BODY_FALLBACK_STRIP_SELECTOR = [
  'nav',
  'header',
  'footer',
  'aside',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
].join(', ');

// Below this, a candidate content root (e.g. a near-empty <main> wrapper) is treated as not
// found rather than accepted - short "content" is usually itself boilerplate.
const MIN_CONTENT_CHARS = 500;

// Over-stripping guard (shared by the body-fallback path and root-internal stripping): if
// stripping a selector's matches would take the container's remaining text below both an
// absolute floor and this fraction of what it had before, the container's real content must
// actually live inside one of the "chrome" tags being stripped (e.g. an all-in-<header> page,
// or a <main> whose only real content sits inside its own <header>) - stripping would be
// actively harmful, so it's skipped entirely.
const MIN_REMAINING_FRACTION = 0.2;

export interface ExtractMainResult {
  html: string;
  title: string | null;
}

function textLength(el: { textContent: string | null }): number {
  return (el.textContent ?? '').trim().length;
}

// Picks the longest candidate whose trimmed textContent clears MIN_CONTENT_CHARS, or null.
function longestQualifying<T extends { textContent: string | null }>(elements: T[]): T | null {
  let best: { el: T; length: number } | null = null;
  for (const el of elements) {
    const length = textLength(el);
    if (!best || length > best.length) {
      best = { el, length };
    }
  }
  return best && best.length >= MIN_CONTENT_CHARS ? best.el : null;
}

// Picks the first candidate whose trimmed textContent clears MIN_CONTENT_CHARS, or null.
function firstQualifying<T extends { textContent: string | null }>(elements: T[]): T | null {
  for (const el of elements) {
    if (textLength(el) >= MIN_CONTENT_CHARS) {
      return el;
    }
  }
  return null;
}

// Drops elements that are descendants of another element already in the list, so summing their
// text length (or removing them) doesn't double-count/double-remove nested matches - e.g. a
// <header> that itself contains a <nav>, both matched by the same strip selector.
//
// `elements` MUST come from a single querySelectorAll(mergedSelector) call, which returns
// matches in document order (verified empirically against @mixmark-io/domino - see
// verify-doc-order.mjs in the fix-round scratch notes). That guarantee is what makes an O(k)
// linear scan correct instead of an O(k^2) all-pairs contains() check: if candidate X is a
// descendant of some earlier candidate K in the list, K appears before X in document order, and
// nothing outside K's subtree can appear between K and X (K's subtree is contiguous in document
// order) - so K is still the *most recently kept* element by the time we reach X. Comparing only
// against the last kept element is therefore equivalent to comparing against all of them.
function topLevelOnly<T extends { contains(other: unknown): boolean }>(elements: T[]): T[] {
  const kept: T[] = [];
  for (const el of elements) {
    const last = kept[kept.length - 1];
    if (!last || !last.contains(el)) {
      kept.push(el);
    }
  }
  return kept;
}

// Strips selector matches from container, but only if doing so wouldn't be over-stripping (see
// MIN_REMAINING_FRACTION above). Shared by the body-fallback path and root-internal stripping.
function guardedStrip<T extends { textContent: string | null; contains(other: unknown): boolean; remove(): void }>(
  container: { textContent: string | null; querySelectorAll(selector: string): T[] },
  selector: string
): void {
  const before = textLength(container);
  const candidates = topLevelOnly(Array.from(container.querySelectorAll(selector)));
  const removedLength = candidates.reduce((sum, el) => sum + textLength(el), 0);
  const after = Math.max(0, before - removedLength);

  if (after >= Math.max(MIN_CONTENT_CHARS, before * MIN_REMAINING_FRACTION)) {
    // Remove in reverse document order. domino's element removal splices the parent's
    // (lazily-materialized) children array at the removed node's index, which costs O(remaining
    // siblings) per call - removing ascending (document order) repeatedly splices near the
    // front, which is O(n^2) for a large flat sibling list (e.g. 20,000 icon spans under one
    // wrapper div - measured ~5.5s). Removing from the back first makes each splice O(1)
    // (nothing after it left to shift), so the whole loop is O(n) (measured ~16ms for the same
    // input).
    for (let i = candidates.length - 1; i >= 0; i--) {
      candidates[i].remove();
    }
  }
  // else: stripping would be over-stripping - leave container as-is.
}

// Strips page chrome (nav/header/footer/scripts/hidden regions) and, when possible, narrows
// the page down to its <article>/<main> content root. Large real-world pages (news sites,
// docs) put hundreds of nav/header links before the actual article text; without this,
// htmlToMarkdownStage's output is dominated by nav links and the article text never survives
// truncation to the caller's token budget.
export function extractMainHtml(html: string): ExtractMainResult {
  const document = domino.createDocument(html);

  // Step 1: strip only elements that are never content, document-wide. Deliberately narrow -
  // nav/header/footer/aside are NOT stripped yet, because whether they're page chrome or the
  // content root's own structure depends on where (inside or outside the root) they end up.
  // Removed in reverse document order - see the removal loop in guardedStrip for why (avoids an
  // O(n^2) splice cost when many matches share a parent).
  const neverContentMatches = Array.from(document.querySelectorAll(NEVER_CONTENT_SELECTOR));
  for (let i = neverContentMatches.length - 1; i >= 0; i--) {
    neverContentMatches[i].remove();
  }

  const titleText = document.querySelector('title')?.textContent?.trim();
  const title = titleText ? titleText : null;

  // Step 2: pick a content root, in priority order: <article> (picking the longest if there
  // are several - e.g. a list page with multiple teaser <article> blocks plus the real one),
  // then <main>, then [role="main"], each taking the first element clearing the threshold.
  const root =
    longestQualifying(Array.from(document.querySelectorAll('article'))) ??
    firstQualifying(Array.from(document.querySelectorAll('main'))) ??
    firstQualifying(Array.from(document.querySelectorAll('[role="main"]')));

  if (root) {
    // Step 3: a root was found, so page-level chrome is already excluded (it lives outside the
    // root). Within the root, strip the type-appropriate chrome list (see the two
    // ROOT_INTERNAL_STRIP_SELECTOR_* comments), guarded against over-stripping a root whose
    // real content happens to live inside the very tag being stripped.
    const rootSelector =
      root.tagName.toLowerCase() === 'article' ? ROOT_INTERNAL_STRIP_SELECTOR_ARTICLE : ROOT_INTERNAL_STRIP_SELECTOR_MAIN;
    guardedStrip(root, rootSelector);
    return { html: root.outerHTML, title };
  }

  // Step 4: no content root found - fall back to the whole body. There's no root boundary to
  // exclude page chrome for us here, so strip the full chrome set, guarded the same way.
  const body = document.body;
  if (!body) {
    return { html, title };
  }

  guardedStrip(body, BODY_FALLBACK_STRIP_SELECTOR);
  return { html: body.innerHTML, title };
}
