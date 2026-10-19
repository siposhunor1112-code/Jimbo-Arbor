import { html } from './html.js';

const MONTH_NAMES = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
export const CATEGORY_SUGGESTIONS = ['Poszt', 'Carousel', 'Story', 'Reel', 'TikTok'];

export function monthLabel(month) {
  const [year, m] = month.split('-');
  return `${year}. ${MONTH_NAMES[Number(m) - 1] ?? m}`;
}

const dateLabel = (unixSeconds) =>
  new Date(unixSeconds * 1000).toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric' });

function sizeLabel(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function layout(ctx, title, body) {
  const { config, user, member, admin } = ctx;
  return html`<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} – ${config.siteName}` : config.siteName}</title>
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head>
<body>
<header class="site-header">
  <div class="wrap header-row">
    <a class="brand" href="/">${config.siteName}</a>
    <nav class="nav">
      ${user
        ? html`${member ? html`<a href="/tagoknak">Sablonok</a>` : html`<a href="/elofizetes">Előfizetés</a>`}
          ${admin ? html`<a href="/admin">Admin</a>` : ''}
          <a href="/fiok">Fiók</a>`
        : html`<a href="/belepes">Belépés</a><a class="btn btn-small" href="/regisztracio">Csatlakozom</a>`}
    </nav>
  </div>
</header>
<main class="wrap">
${body}
</main>
<footer class="site-footer"><div class="wrap">© ${new Date().getFullYear()} ${config.siteName}</div></footer>
</body>
</html>`;
}

const errorBox = (message) => (message ? html`<p class="alert" role="alert">${message}</p>` : '');
const noticeBox = (message) => (message ? html`<p class="notice" role="status">${message}</p>` : '');

export function landingPage(ctx) {
  const { config, user } = ctx;
  const cta = user ? '/elofizetes' : '/regisztracio';
  return layout(ctx, null, html`
<section class="hero">
  <h1>Kész Insta- és TikTok-tartalmak ${config.audience}</h1>
  <p class="lead">Havonta frissülő poszt-, Story- és Reel-sablonok. Letöltöd, a saját márkádra szabod, és már posztolhatsz is.</p>
  <a class="btn" href="${cta}">Csatlakozom – ${config.priceLabel}</a>
  <p class="muted small">Bármikor lemondható.</p>
</section>

<section>
  <h2>Mit kapsz?</h2>
  <div class="features">
    <div class="card"><h3>Poszt- és Story-sablonok</h3><p>Szerkeszthető grafikák, amelyeket pár perc alatt a saját színeidre és szövegedre igazítasz.</p></div>
    <div class="card"><h3>Reel- és TikTok-ötletek</h3><p>Kész forgatókönyvek és sablonok rövid videókhoz, hogy ne kelljen a nulláról kitalálni.</p></div>
    <div class="card"><h3>Havonta új csomag</h3><p>Minden hónapban friss tartalom kerül a könyvtárba, a korábbiak is elérhetők maradnak.</p></div>
  </div>
</section>

<section>
  <h2>Így működik</h2>
  <ol class="steps">
    <li><strong>Regisztrálsz és előfizetsz</strong> bankkártyával.</li>
    <li><strong>Böngészed a könyvtárat</strong> hónap és típus szerint.</li>
    <li><strong>Letöltöd a sablont</strong>, átírod, és posztolsz.</li>
  </ol>
</section>

<section class="price-box">
  <h2>Egy csomag, minden benne</h2>
  <p class="price">${config.priceLabel}</p>
  <ul class="checks">
    <li>A teljes sablonkönyvtár</li>
    <li>Havonta új tartalom</li>
    <li>Bármikor lemondható a fiókodban</li>
  </ul>
  <a class="btn" href="${cta}">Csatlakozom</a>
</section>

<section>
  <h2>Gyakori kérdések</h2>
  <details><summary>Le tudom mondani az előfizetést?</summary><p>Igen, bármikor, a Fiók oldalon. A már kifizetett időszak végéig megmarad a hozzáférésed.</p></details>
  <details><summary>Hogyan fizetek?</summary><p>Bankkártyával, a Stripe biztonságos fizetési oldalán. A kártyaadataid nem kerülnek hozzánk.</p></details>
  <details><summary>Milyen formátumban vannak a sablonok?</summary><p>Minden sablonnál jelöljük a formátumot: letölthető fájl (például PNG, MP4 vagy ZIP) vagy szerkeszthető online sablon linkje.</p></details>
</section>`);
}

export function authPage(ctx, { mode, email = '', error = null }) {
  const isRegister = mode === 'register';
  return layout(ctx, isRegister ? 'Regisztráció' : 'Belépés', html`
<section class="narrow">
  <h1>${isRegister ? 'Regisztráció' : 'Belépés'}</h1>
  ${errorBox(error)}
  <form method="post" action="${isRegister ? '/regisztracio' : '/belepes'}" class="form">
    <label>E-mail-cím
      <input type="email" name="email" value="${email}" required autocomplete="email" maxlength="254">
    </label>
    <label>Jelszó${isRegister ? ' (legalább 8 karakter)' : ''}
      <input type="password" name="password" required minlength="${isRegister ? 8 : 1}" maxlength="200"
        autocomplete="${isRegister ? 'new-password' : 'current-password'}">
    </label>
    <button class="btn" type="submit">${isRegister ? 'Fiók létrehozása' : 'Belépés'}</button>
  </form>
  <p class="muted">${isRegister
    ? html`Már van fiókod? <a href="/belepes">Lépj be</a>.`
    : html`Még nincs fiókod? <a href="/regisztracio">Regisztrálj</a>.`}</p>
</section>`);
}

export function subscribePage(ctx, { error = null } = {}) {
  const { config, user } = ctx;
  const pastDue = user.subscription_status === 'past_due' || user.subscription_status === 'unpaid';
  return layout(ctx, 'Előfizetés', html`
<section class="narrow price-box">
  <h1>Előfizetés</h1>
  ${errorBox(error)}
  ${pastDue
    ? html`<p class="alert">A legutóbbi terhelés nem sikerült. Frissítsd a kártyádat a <a href="/fiok">Fiók</a> oldalon, és a hozzáférésed visszaáll.</p>`
    : html`
  <p class="price">${config.priceLabel}</p>
  <ul class="checks">
    <li>A teljes sablonkönyvtár</li>
    <li>Havonta új tartalom</li>
    <li>Bármikor lemondható</li>
  </ul>
  <form method="post" action="/elofizetes/fizetes">
    <button class="btn" type="submit">Tovább a fizetéshez</button>
  </form>
  <p class="muted small">A fizetés a Stripe biztonságos oldalán történik.</p>`}
</section>`);
}

function previewTile(template) {
  return template.preview_key
    ? html`<img class="thumb" src="/elonezet/${template.id}" alt="" loading="lazy">`
    : html`<div class="thumb thumb-empty" aria-hidden="true">${template.category.slice(0, 1)}</div>`;
}

export function libraryPage(ctx, { templates, months, categories, month, category, notice }) {
  const filterLink = (params) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    const qs = query.toString();
    return qs ? `/tagoknak?${qs}` : '/tagoknak';
  };
  return layout(ctx, 'Sablonok', html`
<h1>Sablonkönyvtár</h1>
${noticeBox(notice)}
<form method="get" action="/tagoknak" class="filters">
  ${category ? html`<input type="hidden" name="tipus" value="${category}">` : ''}
  <label>Hónap
    <select name="honap" data-autosubmit>
      <option value="">Összes hónap</option>
      ${months.map((m) => html`<option value="${m}" ${m === month ? 'selected' : ''}>${monthLabel(m)}</option>`)}
    </select>
  </label>
  <noscript><button class="btn btn-small" type="submit">Szűrés</button></noscript>
</form>
<nav class="chips" aria-label="Típus">
  <a class="chip ${category ? '' : 'chip-on'}" href="${filterLink({ honap: month })}">Mind</a>
  ${categories.map((c) => html`<a class="chip ${c === category ? 'chip-on' : ''}" href="${filterLink({ honap: month, tipus: c })}">${c}</a>`)}
</nav>
${templates.length === 0
  ? html`<p class="muted">Ehhez a szűréshez még nincs sablon.</p>`
  : html`<div class="grid">
  ${templates.map((t) => html`
  <article class="tile">
    ${previewTile(t)}
    <div class="tile-body">
      <h2 class="tile-title">${t.title}</h2>
      <p class="muted small">${t.category} · ${monthLabel(t.month)}${t.size_bytes ? ` · ${sizeLabel(t.size_bytes)}` : ''}</p>
      ${t.description ? html`<p class="tile-desc">${t.description}</p>` : ''}
      <a class="btn btn-small btn-block" href="/letoltes/${t.id}" ${t.link_url ? html`target="_blank" rel="noopener"` : ''}>
        ${t.link_url ? 'Megnyitás' : 'Letöltés'}</a>
    </div>
  </article>`)}
</div>`}`);
}

function statusText(user) {
  switch (user.subscription_status) {
    case 'active':
    case 'trialing':
      return user.current_period_end
        ? `Aktív. A jelenlegi időszak vége: ${dateLabel(user.current_period_end)}.`
        : 'Aktív.';
    case 'past_due':
    case 'unpaid':
      return 'Fizetési probléma: a legutóbbi terhelés nem sikerült. Frissítsd a kártyádat.';
    case 'incomplete':
      return 'A fizetés még nem fejeződött be.';
    default:
      return 'Nincs aktív előfizetésed.';
  }
}

export function accountPage(ctx, { error = null } = {}) {
  const { user, member, admin } = ctx;
  return layout(ctx, 'Fiók', html`
<section class="narrow">
  <h1>Fiók</h1>
  ${errorBox(error)}
  <dl class="facts">
    <dt>E-mail</dt><dd>${user.email}</dd>
    <dt>Előfizetés</dt><dd>${admin && !user.subscription_status ? 'Adminként teljes hozzáférésed van.' : statusText(user)}</dd>
  </dl>
  ${user.stripe_customer_id
    ? html`<form method="post" action="/fiok/szamlazas"><button class="btn btn-secondary" type="submit">Előfizetés és kártya kezelése</button></form>
      <p class="muted small">Itt mondhatod le vagy módosíthatod az előfizetést, és cserélheted a kártyát.</p>`
    : ''}
  ${member ? '' : html`<p><a class="btn" href="/elofizetes">Előfizetek</a></p>`}
  <form method="post" action="/kilepes"><button class="btn-link" type="submit">Kilépés</button></form>
</section>`);
}

export function adminPage(ctx, { templates, categories, values = {}, error = null, notice = null }) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  return layout(ctx, 'Admin', html`
<h1>Sablonok kezelése</h1>
${errorBox(error)}
${noticeBox(notice)}
<form method="post" action="/admin/sablon" enctype="multipart/form-data" class="form card">
  <h2>Új sablon</h2>
  <label>Cím <input name="title" required maxlength="200" value="${values.title ?? ''}"></label>
  <div class="form-row">
    <label>Típus <input name="category" required maxlength="40" list="categories" value="${values.category ?? ''}"></label>
    <label>Hónap <input type="month" name="month" required value="${values.month ?? currentMonth}"></label>
  </div>
  <datalist id="categories">
    ${[...new Set([...CATEGORY_SUGGESTIONS, ...categories])].map((c) => html`<option value="${c}">`)}
  </datalist>
  <label>Leírás (nem kötelező) <textarea name="description" rows="3" maxlength="1000">${values.description ?? ''}</textarea></label>
  <fieldset>
    <legend>Tartalom: fájl <em>vagy</em> link</legend>
    <label>Fájl (ZIP, PNG, MP4 …) <input type="file" name="file"></label>
    <label>Vagy link (pl. Canva-sablon) <input type="url" name="linkUrl" placeholder="https://" value="${values.linkUrl ?? ''}"></label>
  </fieldset>
  <label>Előnézeti kép (nem kötelező, JPG/PNG/WebP) <input type="file" name="preview" accept="image/jpeg,image/png,image/webp"></label>
  <button class="btn" type="submit">Feltöltés</button>
</form>

<h2>Feltöltött sablonok (${templates.length})</h2>
${templates.length === 0
  ? html`<p class="muted">Még nincs sablon.</p>`
  : html`<ul class="admin-list">
  ${templates.map((t) => html`
  <li>
    <div><strong>${t.title}</strong><br><span class="muted small">${t.category} · ${monthLabel(t.month)} · ${t.link_url ? 'link' : t.original_name}</span></div>
    <form method="post" action="/admin/sablon/${t.id}/torles" data-confirm="Biztosan törlöd?">
      <button class="btn-link danger" type="submit">Törlés</button>
    </form>
  </li>`)}
</ul>`}`);
}

export function messagePage(ctx, { title, message }) {
  return layout(ctx, title, html`<section class="narrow"><h1>${title}</h1><p>${message}</p><p><a href="/">Vissza a főoldalra</a></p></section>`);
}
