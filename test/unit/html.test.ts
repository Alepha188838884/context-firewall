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
    expect(out).toContain('[Page Number 0 Link Text Here](/page0');
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
});
