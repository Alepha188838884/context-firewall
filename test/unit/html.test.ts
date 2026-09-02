import { describe, it, expect } from 'vitest';
import { htmlToMarkdownStage } from '../../src/pipeline/html.js';
import { ArtifactStore } from '../../src/artifacts.js';
import { DEFAULT_POLICY } from '../../src/config.js';

const ctx = { server: 'srv', tool: 'tool', fullHandle: 'cf-full-0000' };

function navItem(i: number): string {
  return `<div class="nav-item" data-id="nav-${i}" data-testid="nav-link-${i}"><li class="nav-li-item"><a href="/page${i}" class="nav-link" title="Navigate to page ${i}" target="_self">Page Number ${i} Link Text Here</a></li></div>`;
}

function paragraph(i: number): string {
  return `<div class="content-block" data-block-id="block-${i}" data-analytics="true"><p class="paragraph-text" style="margin:0;padding:0;">This is paragraph number ${i} with some reasonably long placeholder text to pad out the content of the page for testing purposes and compression ratio validation.</p></div>`;
}

// A ~6KB "realistic" web page: nav with attribute-heavy links, wrapper divs around each
// paragraph, a noisy inline script and a noisy inline stylesheet - the kind of markup a
// real MCP tool (e.g. a browser/fetch tool) would return.
function buildHtmlFixture(): string {
  const navItems = Array.from({ length: 10 }, (_, i) => navItem(i)).join('\n');
  const paragraphs = Array.from({ length: 8 }, (_, i) => paragraph(i)).join('\n');
  const scriptBlock = `<script type="text/javascript">\n${'console.log("noise "+ Math.random());\nvar x = document.querySelectorAll(".foo"); if (x) { x.forEach(function(el){ el.classList.add("bar"); }); }\n'.repeat(6)}</script>`;
  const styleBlock = `<style type="text/css">\n${'.class-name-here { color: red; margin: 0; padding: 0; border: 1px solid #ccc; }\n'.repeat(8)}</style>`;

  return `<!DOCTYPE html>\n<html>\n<head><title>Test Page</title>${styleBlock}</head>\n<body>\n<nav class="main-nav" role="navigation"><ul class="nav-list">${navItems}</ul></nav>\n${scriptBlock}\n<div class="content" id="main-content" data-page="test">\n<h1 class="page-title">Main Heading</h1>\n${paragraphs}\n<table class="data-table"><tr><th>Col A</th><th>Col B</th></tr><tr><td>1</td><td>2</td></tr></table>\n</div>\n</body>\n</html>`;
}

describe('htmlToMarkdownStage', () => {
  it('converts a realistic HTML page to markdown, shrinking it to at most 40% of the original length', () => {
    const store = new ArtifactStore();
    const html = buildHtmlFixture();
    expect(html.length).toBeGreaterThan(4000); // sanity: fixture is meaningfully sized

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out.length).toBeLessThanOrEqual(html.length * 0.4);
    expect(out).toMatch(/^#\s+Main Heading/m);
    // fixture's nav is a real <nav role="navigation"> element, so main-content extraction now
    // strips it - this assertion flipped from toContain when that feature was added, since nav
    // links eating the truncation budget is exactly what extraction fixes (see extract-main.ts)
    expect(out).not.toContain('Page Number 0 Link Text Here');
    // script/style noise must not survive into the markdown
    expect(out).not.toContain('console.log');
    expect(out).not.toContain('class-name-here');
  });

  it('does not touch plain text with no HTML in it', () => {
    const store = new ArtifactStore();
    const text = 'Just a plain sentence about nothing in particular, with no markup at all.';

    const { text: out, applied } = htmlToMarkdownStage.apply({ text }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(false);
    expect(out).toBe(text);
  });

  it('does not trigger conversion on text with only a few scattered tags', () => {
    const store = new ArtifactStore();
    const text = 'Check out this cool <b>bold</b> idea, it is <i>really</i> neat and also <u>underlined</u>.';

    const { text: out, applied } = htmlToMarkdownStage.apply({ text }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(false);
    expect(out).toBe(text);
  });

  it('skips conversion entirely when policy.htmlToMarkdown is false', () => {
    const store = new ArtifactStore();
    const html = buildHtmlFixture();
    const policy = { ...DEFAULT_POLICY, htmlToMarkdown: false };

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, policy, store, ctx);

    expect(applied).toBe(false);
    expect(out).toBe(html);
  });

  // Regression (Finding 3, 2026-07-13 benchmark): JSON API responses (e.g. GitHub issues) often
  // embed raw HTML fragments inside string fields, which used to trip the tag-density heuristic
  // and get corrupted by turndown before jsonSummaryStage ever ran. Valid JSON must take
  // precedence, regardless of how much HTML markup its string fields contain.
  describe('regression: valid JSON with embedded HTML strings is left for jsonSummary', () => {
    it('does not touch legal JSON whose string fields contain lots of embedded HTML markup', () => {
      const store = new ArtifactStore();
      const issues = Array.from({ length: 15 }, (_, i) => ({
        id: i,
        title: `Issue ${i}`,
        body: `<details><summary>Details</summary><p>Some text</p><img src="https://example.com/${i}.png"/><table><tr><td>a</td></tr></table></details>`,
      }));
      const text = JSON.stringify({ issues });

      const { text: out, applied } = htmlToMarkdownStage.apply({ text }, DEFAULT_POLICY, store, ctx);

      expect(applied).toBe(false);
      expect(out).toBe(text);
      expect(() => JSON.parse(out)).not.toThrow();
    });

    it('still converts a real HTML page (not JSON) as before', () => {
      const store = new ArtifactStore();
      const html = buildHtmlFixture();

      const { applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

      expect(applied).toBe(true);
    });
  });
});

// Main-content extraction (extract-main.ts): large pages put nav/header/footer chrome before
// the actual article text, which eats the truncation budget before real content ever appears.
// These cover extractMainHtml's behavior as invoked through htmlToMarkdownStage.
describe('htmlToMarkdownStage: main-content extraction', () => {
  it('extracts a <main> content root out of a page with a large nav, dropping nav links and prefixing the title', () => {
    const store = new ArtifactStore();
    const navLinks = Array.from(
      { length: 12 },
      (_, i) =>
        `<li><a href="/section${i}" class="nav-link">Section Link Number ${i} With Extra Nav Words Padding The Anchor Text</a></li>`
    ).join('');
    const articleBody =
      'This is the real article body sentence that must survive extraction and stay in the compressed output. '.repeat(
        8
      );
    const html = `<!DOCTYPE html>\n<html>\n<head><title>Real News Headline</title></head>\n<body>\n<header class="site-header"><div class="branding">Site Name</div></header>\n<nav class="primary-nav" role="navigation"><ul>${navLinks}</ul></nav>\n<main class="article-body">\n<p>${articleBody}</p>\n</main>\n<footer class="site-footer"><p>Copyright footer text with more nav-like links here</p></footer>\n</body>\n</html>`;

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out).toContain('the real article body sentence that must survive extraction');
    expect(out).not.toContain('Section Link Number 0');
    expect(out).not.toContain('Copyright footer text');
    expect(out).toMatch(/^#\s+Real News Headline/);
  });

  it('leaves nav-styled content alone when the page has no semantic <nav>/<header>/<main> tags', () => {
    const store = new ArtifactStore();
    const fakeNavLinks = Array.from(
      { length: 8 },
      (_, i) =>
        `<div class="nav-item" data-id="nav-${i}" data-testid="nav-link-${i}"><a href="/x${i}" class="nav-link" title="Fake nav destination ${i}" target="_self">Fake Nav Link Number ${i} With Extra Padding Words For Realism</a></div>`
    ).join('');
    const content =
      'Genuine paragraph content that should remain visible after conversion since there is no article or main tag present in this page at all. '.repeat(
        4
      );
    const html = `<!DOCTYPE html>\n<html>\n<head><title>No Semantic Tags Page</title></head>\n<body>\n<div class="fake-nav">${fakeNavLinks}</div>\n<div class="content"><p>${content}</p></div>\n</body>\n</html>`;

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    // no real <nav> tag exists, so extraction has nothing to strip here - div-soup "nav" links
    // are not mistaken for real navigation chrome
    expect(out).toContain('Fake Nav Link Number 0');
    expect(out).toContain('Genuine paragraph content');
  });

  it('falls back to the body when the only <article> is under the 500-char content threshold', () => {
    const store = new ArtifactStore();
    const shortArticle = '<article><p>Too short to count as main content.</p></article>';
    const otherContent =
      'This other body paragraph must appear in the output because the article tag was too short to qualify as the main content root and extraction fell back to the full body. '.repeat(
        4
      );
    const html = `<!DOCTYPE html>\n<html>\n<head><title>Short Article Page</title></head>\n<body>\n${shortArticle}\n<div class="more-content"><p>${otherContent}</p></div>\n</body>\n</html>`;

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out).toContain('This other body paragraph must appear');
  });

  it('strips [aria-hidden="true"] and [role="navigation"] elements even inside the content root', () => {
    const store = new ArtifactStore();
    const hiddenBlock =
      '<div aria-hidden="true"><p>This hidden content must not appear anywhere in the output because aria-hidden marks it as decorative and it gets stripped during main-content extraction.</p></div>';
    const navRoleBlock =
      '<div role="navigation"><p>This role navigation content must also be stripped from the output since role="navigation" marks it as page chrome not article text.</p></div>';
    const mainContent =
      'This is the genuine main article content that must remain in the output after stripping the aria-hidden and role navigation blocks from the page. '.repeat(
        4
      );
    const html = `<!DOCTYPE html>\n<html>\n<head><title>Aria Hidden Page</title></head>\n<body>\n<main>\n${hiddenBlock}\n${navRoleBlock}\n<p>${mainContent}</p>\n</main>\n</body>\n</html>`;

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out).not.toContain('This hidden content must not appear');
    expect(out).not.toContain('This role navigation content must also be stripped');
    expect(out).toContain('genuine main article content');
  });
});

// Regression fixes from independent review (A/B-reproduced): extract-main.ts used to strip the
// full chrome selector (including header/footer/aside) document-wide before picking a content
// root, and unconditionally on the body-fallback path. That (1) silently dropped a real
// <header>/<aside> that was the *content root's own* structure (article title block, byline,
// callout box - legal HTML5, not page chrome), and (2) had no guard against the fallback path
// collapsing a page down to nothing when its only real content happened to live inside a
// <header>/<aside> tag. Fixed by stripping in layers (never-content tags -> pick root -> only
// nav/aria-hidden inside the root) and adding a before/after text-length guard on the body
// fallback path. The 4 tests above were re-run against the new layered logic and still pass
// unmodified - no conflicts with the new semantics.
describe('htmlToMarkdownStage: reviewer regressions (layered stripping + body-fallback guard)', () => {
  it('does not collapse a page down to just the title when its only real content lives inside <header> (no article/main)', () => {
    const store = new ArtifactStore();
    const bodyText =
      'All of this page real content lives inside the page header instead of a semantic article or main element, which is an unusual but real pattern this regression test guards against. '.repeat(
        4
      );
    const html = `<!DOCTYPE html>\n<html>\n<head><title>All Content In Header</title></head>\n<body>\n<header>\n<h1>Page Heading</h1>\n<p>${bodyText}</p>\n</header>\n</body>\n</html>`;

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out).toContain('real content lives inside the page header');
    // pre-fix bug: unconditional body-fallback stripping removed the <header> itself, collapsing
    // this down to just the injected "# <title>" line (~20 chars) with no fallback
    expect(out.length).toBeGreaterThan(300);
  });

  it('keeps a real <header> (headline + byline) inside a selected <article> root, while still stripping page-level nav outside it', () => {
    const store = new ArtifactStore();
    const articleBody =
      'This is the article body text that must remain in the output alongside the header byline information after extraction picks this article as the content root. '.repeat(
        4
      );
    const html = `<!DOCTYPE html>\n<html>\n<head><title>Article With Header Page</title></head>\n<body>\n<nav><a href="/">Site Nav Link That Should Be Stripped</a></nav>\n<article>\n<header>\n<h1>The Real Article Headline</h1>\n<p class="byline">By Jane Reporter, Staff Writer</p>\n</header>\n<p>${articleBody}</p>\n</article>\n</body>\n</html>`;

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out).toContain('The Real Article Headline');
    expect(out).toContain('By Jane Reporter, Staff Writer');
    expect(out).toContain('This is the article body text that must remain');
    // page-level nav sits outside the selected <article> root, so it's still excluded
    expect(out).not.toContain('Site Nav Link That Should Be Stripped');
  });

  it('keeps a real <aside> (callout/tip box) inside a selected <article> root', () => {
    const store = new ArtifactStore();
    const articleBody =
      'This is the main article paragraph text that must remain visible in the output together with the sidebar tip callout after main-content extraction picks this article as the root element. '.repeat(
        4
      );
    const html = `<!DOCTYPE html>\n<html>\n<head><title>Article With Aside Page</title></head>\n<body>\n<article>\n<p>${articleBody}</p>\n<aside class="callout"><p>Tip: this callout box contains a genuine supplementary note that belongs to the article, not page navigation.</p></aside>\n</article>\n</body>\n</html>`;

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out).toContain('This is the main article paragraph text');
    expect(out).toContain('this callout box contains a genuine supplementary note');
  });

  it('collapses a <title> with internal newlines/whitespace into a single injected heading line', () => {
    const store = new ArtifactStore();
    const articleBody =
      'This paragraph exists purely to give the page enough real content so main-content extraction has something substantial to select as the article root for this title whitespace regression test. '.repeat(
        3
      );
    const html = `<!DOCTYPE html>\n<html>\n<head><title>\n  Multi\n  Line\n  Title\n</title></head>\n<body>\n<article>\n<p>${articleBody}</p>\n</article>\n</body>\n</html>`;

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    // the injected title heading must be a single line - no raw newline from <title>'s source
    // formatting should survive inside the "# ..." line
    const headingLine = out.split('\n')[0];
    expect(headingLine).toBe('# Multi Line Title');
  });
});

// Second round of reviewer regressions: keeping header/footer inside a content root (previous
// round's fix) is correct for <article> (byline block) but wrong for <main>/[role="main"] -
// MediaWiki wraps <main> in a <header> that holds the page titlebar + a 20+ entry
// language-switcher dropdown, which is page chrome, not article byline. Root-internal stripping
// is now type-dependent (article: nav/aria-hidden only; main/role=main: also header/footer) and
// guarded the same way as the body-fallback path, so a <main> whose real content happens to live
// inside its own <header> isn't collapsed to nothing either.
describe('htmlToMarkdownStage: main-vs-article root-internal stripping + guard', () => {
  it('strips a <main>-internal <header> (interlanguage links + TOC nav) so real prose is near the front of the output', () => {
    const store = new ArtifactStore();
    const langLinks = Array.from(
      { length: 22 },
      (_, i) => `<li class="interlanguage-link"><a href="https://xx${i}.wikipedia.org/wiki/Foo" lang="xx${i}">Language Name Number ${i}</a></li>`
    ).join('');
    const articleBody =
      'This is the real Wikipedia-style article body prose that must appear near the front of the compressed output and must survive truncation to the token budget. '.repeat(
        6
      );
    const html = `<!DOCTYPE html>\n<html>\n<head><title>Wikipedia Shape Page</title></head>\n<body>\n<main id="content" class="mw-body">\n<header class="mw-body-header">\n<nav aria-label="Contents" class="vector-toc-landmark"><ul><li><a href="#Background">Background</a></li><li><a href="#Features">Features</a></li></ul></nav>\n<div id="p-lang-btn" class="vector-dropdown mw-portlet mw-portlet-lang"><ul class="vector-menu-content-list">${langLinks}</ul></div>\n</header>\n<div class="mw-parser-output"><p>${articleBody}</p></div>\n</main>\n</body>\n</html>`;

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out).not.toContain('Language Name Number 0');
    expect(out).toContain('This is the real Wikipedia-style article body prose');
    // real prose must be near the front, not pushed past where the (now-stripped) header used
    // to sit
    expect(out.indexOf('This is the real Wikipedia-style article body prose')).toBeLessThan(200);
  });

  it('skips root-internal stripping (guard) when almost all of a <main> root content lives inside its own <header>', () => {
    const store = new ArtifactStore();
    const headerText =
      'All of the real content on this page lives inside the main roots own header element rather than beside it, which is the pathological case this guard exists to protect against collapsing the root down to nothing. '.repeat(
        4
      );
    const html = `<!DOCTYPE html>\n<html>\n<head><title>Header Heavy Main Page</title></head>\n<body>\n<main id="content">\n<header><p>${headerText}</p></header>\n<p>Just a short trailer line.</p>\n</main>\n</body>\n</html>`;

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    // the guard tripped, so the <header> (almost all of the root's content) is kept
    expect(out).toContain('All of the real content on this page lives inside the main roots own header');
  });

  it('still keeps a real <header> (headline + byline) inside a selected <article> root (unchanged from the previous round)', () => {
    const store = new ArtifactStore();
    const articleBody =
      'This is the article body text that must remain in the output alongside the header byline information after extraction picks this article as the content root. '.repeat(
        4
      );
    const html = `<!DOCTYPE html>\n<html>\n<head><title>Article With Header Page</title></head>\n<body>\n<nav><a href="/">Site Nav Link That Should Be Stripped</a></nav>\n<article>\n<header>\n<h1>The Real Article Headline</h1>\n<p class="byline">By Jane Reporter, Staff Writer</p>\n</header>\n<p>${articleBody}</p>\n</article>\n</body>\n</html>`;

    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out).toContain('The Real Article Headline');
    expect(out).toContain('By Jane Reporter, Staff Writer');
    expect(out).toContain('This is the article body text that must remain');
    expect(out).not.toContain('Site Nav Link That Should Be Stripped');
  });
});

// Performance regression (reviewer-measured): topLevelOnly used to be an O(k^2) all-pairs
// contains() scan over the strip-selector candidate set. A real-world icon-font page with tens
// of thousands of flat (non-nested) [aria-hidden="true"] icon spans - none containing any other,
// which is the worst case for an O(k^2) scan since every pair needs a contains() check - took
// 45.9s end-to-end (34.1s inside topLevelOnly alone) before the O(k) document-order rewrite.
describe('htmlToMarkdownStage: performance regression (O(k) topLevelOnly)', () => {
  it('handles 20,000 flat aria-hidden icon spans inside an <article> root well under 3 seconds', () => {
    const store = new ArtifactStore();
    const iconSpans = Array.from({ length: 20000 }, (_, i) => `<span aria-hidden="true" class="icon icon-${i % 50}"></span>`).join(
      ''
    );
    const articleBody =
      'This is the real article paragraph text that must remain in the output after stripping twenty thousand decorative aria-hidden icon spans from the page, which is a common pattern on icon-font-heavy sites. '.repeat(
        6
      );
    const html = `<!DOCTYPE html>\n<html>\n<head><title>Icon Font Page</title></head>\n<body>\n<article>\n<p>${articleBody}</p>\n<div class="icon-grid">${iconSpans}</div>\n</article>\n</body>\n</html>`;

    const start = performance.now();
    const { text: out, applied } = htmlToMarkdownStage.apply({ text: html }, DEFAULT_POLICY, store, ctx);
    const elapsedMs = performance.now() - start;

    expect(applied).toBe(true);
    expect(out).toContain('This is the real article paragraph text');
    // reviewer measured 45.9s pre-fix; O(k) fix should be sub-second - 3s leaves slow-CI margin
    expect(elapsedMs).toBeLessThan(3000);
  }, 10000);
});
