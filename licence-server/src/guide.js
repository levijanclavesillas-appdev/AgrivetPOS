'use strict';

// The user guide at /guide — one page per chapter. Each chapter is an HTML fragment in
// site/guide/<slug>.html; this wraps it in the site's header, the list of chapters and
// the links to the chapters either side. Only the slugs in site/guide/chapters.json are
// served, so a URL can never name a file.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'site', 'guide');

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const chapters = () => JSON.parse(fs.readFileSync(path.join(DIR, 'chapters.json'), 'utf8'));

function header() {
  return `<header class="site-header">
  <div class="wrap">
    <a class="logo" href="/" aria-label="Chachi POS home">
      <img src="/static/img/logo-96.png" alt="" width="36" height="36">
      <span>Chachi POS<small>by Chachi's Software</small></span>
    </a>
    <nav class="nav" aria-label="Main">
      <a href="/#stores">Stores</a>
      <a href="/#features">Features</a>
      <a href="/#pricing">Pricing</a>
      <a href="/guide" aria-current="page">Guide</a>
      <a href="/#faq">FAQ</a>
      <a href="/stores">Your stores</a>
      <a href="/link">Link a POS</a>
      <a class="btn btn-primary btn-small" href="/#contact">Try it free</a>
    </nav>
    <details class="menu">
      <summary><svg aria-hidden="true"><use href="/static/icons.svg#menu"/></svg> Menu</summary>
      <div class="menu-panel">
        <a href="/">Home</a>
        <a href="/#features">Features</a>
        <a href="/#pricing">Pricing</a>
        <a href="/guide">Guide</a>
        <a href="/#faq">FAQ</a>
        <a href="/stores">Your stores</a>
      <a href="/link">Link a POS</a>
        <a class="btn btn-primary" href="/#contact">Try it free for 14 days</a>
      </div>
    </details>
  </div>
</header>`;
}

const footer = `<footer class="site-footer">
  <div class="wrap">
    <div class="who">
      <img src="/static/img/logo-96.png" alt="" width="30" height="30">
      <span>© 2026 Chachi's Software Development Service · Koronadal City</span>
    </div>
    <nav aria-label="Footer">
      <a href="/">Home</a>
      <a href="/guide">Guide</a>
      <a href="/privacy">Privacy</a>
      <a href="/stores">Your stores</a>
      <a href="/link">Link a POS</a>
      <a href="mailto:ChachiSoftware@gmail.com">Email us</a>
    </nav>
  </div>
</footer>`;

function chapterList(all, current) {
  return `<ol>${all.map((c) => `<li><a href="/guide/${c.slug}"${c.slug === current ? ' aria-current="page"' : ''}>${esc(c.title)}</a></li>`).join('')}</ol>`;
}

function chapterGrid(all) {
  return `<ol class="chapter-grid">${all.map((c) => `<li><a href="/guide/${c.slug}"><strong>${esc(c.title)}</strong><span>${esc(c.summary)}</span></a></li>`).join('')}</ol>`;
}

function page({ slug, title, description, canonical, body, all }) {
  const i = all.findIndex((c) => c.slug === slug);
  const prev = i > 0 ? all[i - 1] : (slug ? { slug: '', title: 'Guide home' } : null);
  const next = i >= 0 ? all[i + 1] : all[0];
  const link = (c, rel) => (c ? `<a class="${rel}" href="/guide${c.slug ? `/${c.slug}` : ''}"><small>${rel === 'prev' ? 'Previous' : 'Next'}</small>${esc(c.title)}</a>` : '<span></span>');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="https://pos.chachisoftware.store${canonical}">
<meta name="theme-color" content="#0f172a">
<link rel="icon" type="image/png" sizes="32x32" href="/static/img/favicon-32.png">
<link rel="stylesheet" href="/static/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${header()}
<div class="guide wrap">
  <aside class="guide-side" aria-label="Guide chapters">
    <p class="guide-side-title"><a href="/guide">User guide</a></p>
    ${chapterList(all, slug)}
  </aside>
  <main id="main" class="guide-main">
    <details class="guide-chapters">
      <summary>All chapters</summary>
      ${chapterList(all, slug)}
    </details>
    <article class="guide-body">
${body}
    </article>
    <nav class="guide-pager" aria-label="Chapters">${link(prev, 'prev')}${link(next, 'next')}</nav>
    <p class="guide-help">Something here doesn't match your screen, or you're stuck?
      Email <a href="mailto:ChachiSoftware@gmail.com?subject=Chachi%20POS%20guide">ChachiSoftware@gmail.com</a>.</p>
  </main>
</div>
${footer}
</body>
</html>`;
}

/** The guide's home, or one chapter; null for anything else. */
function render(slug = '') {
  const all = chapters();
  if (!slug) {
    return page({
      slug: '', all, canonical: '/guide',
      title: 'User guide · Chachi POS',
      description: 'How to use Chachi POS: setting up, selling, returns, closing the shift, stock, suppliers, customers and utang, reports and backups.',
      body: fs.readFileSync(path.join(DIR, 'index.html'), 'utf8').replace(/<!-- chapters:[^>]*-->/, chapterGrid(all)),
    });
  }
  const chapter = all.find((c) => c.slug === slug);
  if (!chapter) return null;
  return page({
    slug, all, canonical: `/guide/${slug}`,
    title: `${chapter.title} · Chachi POS guide`,
    description: chapter.summary,
    body: fs.readFileSync(path.join(DIR, `${slug}.html`), 'utf8'),
  });
}

/** Every public page, for search engines: the site, and the guide from its chapter list. */
function sitemap() {
  const urls = ['/', '/guide', ...chapters().map((c) => `/guide/${c.slug}`), '/privacy', '/link'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>https://pos.chachisoftware.store${u}</loc></url>`).join('\n')}
</urlset>
`;
}

module.exports = { render, chapters, sitemap };
