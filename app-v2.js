const PARTIES = {
  'Progressive Conservative': { slug: 'pc', label: 'PC' },
  'New Democratic': { slug: 'ndp', label: 'NDP' },
  'Liberal': { slug: 'liberal', label: 'Liberal' },
  'Green': { slug: 'green', label: 'Green' },
  'Independent': { slug: 'independent', label: 'Independent' },
};

const DEFAULT_FEATURED_BILLS = ['Bill 5', 'Bill 17', 'Bill 24', 'Bill 48', 'Bill 60', 'Bill 68', 'Bill 97'];
let FEATURED_BILLS = [...DEFAULT_FEATURED_BILLS];
const IS_EMBED = new URLSearchParams(window.location.search).has('embed');

let allMpps = [];
let billsMeta = [];
let allBills = [];
let filteredMpps = [];
let selectedMpp = null;
let activeTab = 'reps';       // reps | bills | table
let activeFilter = 'all';
let selectedBill = FEATURED_BILLS[0];
let mobileShowDetail = false;
let display = {
  salary: false,
  benefits: false,
  votingAlignment: false,
  expenses: true,
};
/** @type {ReturnType<typeof window.MppShared.buildExpenseIndex> | null} */
let expenseIndex = null;

function applyFeaturedBills(list) {
  if (Array.isArray(list) && list.length) {
    FEATURED_BILLS = list.slice();
  } else {
    FEATURED_BILLS = [...DEFAULT_FEATURED_BILLS];
  }
  if (!FEATURED_BILLS.includes(selectedBill)) {
    selectedBill = FEATURED_BILLS[0] || (allBills[0] || '');
  }
}

function showField(key) {
  return display[key] !== false;
}

function formatCurrency(n) {
  return n == null ? '—' : '$' + n.toLocaleString('en-CA');
}

function getPartyInfo(party) {
  return PARTIES[party] || { slug: 'independent', label: party || '?' };
}

function getInitials(name) {
  return name.replace(/^Hon\.\s*/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function renderAvatar(mpp, className) {
  const party = getPartyInfo(mpp.party);
  const initials = getInitials(mpp.name);
  const cls = `${className} party-${party.slug}`;
  if (mpp.photo) {
    return `<span class="${cls}"><img src="${mpp.photo}" alt="" loading="lazy" class="avatar-img" onerror="this.parentElement.classList.add('avatar-fallback')"><span class="avatar-initials">${initials}</span></span>`;
  }
  return `<span class="${cls} avatar-fallback"><span class="avatar-initials">${initials}</span></span>`;
}

function billLink(vote, className = 'bill-link') {
  return window.MppShared.billLink(vote, billsMeta, getBillUrl, className);
}

function getBillUrl(billId) {
  const meta = billsMeta.find(b => b.id === billId || billId.startsWith(b.id));
  if (meta?.url) return meta.url;
  return allMpps[0]?.votes.find(v => v.bill === billId)?.url || null;
}

function mppKey(m) { return m.email || m.name; }

function filterMpps(query, party) {
  const q = query.toLowerCase().trim();
  return allMpps.filter(m => {
    if (party !== 'all' && m.party !== party) return false;
    if (!q) return true;
    return m.name.toLowerCase().includes(q)
      || (m.riding && m.riding.toLowerCase().includes(q))
      || m.party.toLowerCase().includes(q);
  });
}

function getVote(mpp, bill) {
  return mpp.votes.find(v => v.bill === bill || v.bill.startsWith(bill))
    || { display: 'N/A', yes: null, vote: 'N/A' };
}

function voteClass(v) {
  if (v.yes === true) return 'yes';
  if (v.yes === false) return 'no';
  return 'na';
}

function alignmentClass(pct) {
  if (pct == null) return '';
  if (pct >= 90) return 'high';
  if (pct >= 70) return 'mid';
  return 'low';
}

/* ── Shell ── */

function buildShell() {
  const root = document.getElementById('v2-app');
  root.innerHTML = `
    <div class="v2-wrap">
      ${IS_EMBED ? '' : `
      <header class="v2-header">
        <div class="v2-header-inner">
          <div>
            <p class="v2-eyebrow">Ontarians Against Corruption</p>
            <h1>Who represents you — and how do they vote?</h1>
          </div>
          <a class="v2-classic-link" href="${IS_EMBED ? '?' : window.location.pathname}">← Main layout</a>
        </div>
      </header>`}

      <div id="v2-loading" class="v2-loading">
        <div class="v2-spinner"></div>
        <p>Loading…</p>
      </div>

      <main id="v2-main" hidden>
        <nav class="v2-tabs" role="tablist">
          <button class="v2-tab active" data-tab="reps" role="tab">Find Your Rep</button>
          <button class="v2-tab" data-tab="bills" role="tab">Votes by Bill</button>
          <button class="v2-tab" data-tab="table" role="tab">Full Data</button>
        </nav>

        <div id="panel-reps" class="v2-panel"></div>
        <div id="panel-bills" class="v2-panel hidden"></div>
        <div id="panel-table" class="v2-panel hidden"></div>
      </main>

      ${IS_EMBED ? '' : `
      <footer class="v2-footer">
        <p>Source: <a href="https://www.ola.org/" target="_blank" rel="noopener">Legislative Assembly of Ontario</a></p>
      </footer>`}
    </div>`;
  root.hidden = false;

  document.querySelectorAll('.v2-tab').forEach(btn => {
    btn.onclick = () => setTab(btn.dataset.tab);
  });
}

/* ── Tab switching ── */

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.v2-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.getElementById('panel-reps').classList.toggle('hidden', tab !== 'reps');
  document.getElementById('panel-bills').classList.toggle('hidden', tab !== 'bills');
  document.getElementById('panel-table').classList.toggle('hidden', tab !== 'table');
  if (tab === 'bills') renderBillsPanel();
  if (tab === 'table') renderTablePanel();
}

/* ── REPS: master-detail ── */

function buildRepsPanel() {
  document.getElementById('panel-reps').innerHTML = `
    <div class="master-detail ${mobileShowDetail ? 'show-detail' : ''}">
      <aside class="master-pane">
        <div class="master-toolbar">
          <input type="search" id="v2-search" class="v2-search" placeholder="Search name or riding…" autocomplete="off">
          <div class="v2-filters" id="v2-filters"></div>
          <p class="master-count" id="master-count"></p>
        </div>
        <ul class="master-list" id="master-list" role="listbox"></ul>
      </aside>
      <section class="detail-pane" id="detail-pane" aria-live="polite"></section>
    </div>`;

  document.getElementById('v2-search').oninput = refreshReps;
  setupV2Filters();
}

function setupV2Filters() {
  const el = document.getElementById('v2-filters');
  const parties = ['all', ...new Set(allMpps.map(m => m.party).filter(Boolean))];
  el.innerHTML = parties.map(p => {
    const info = p === 'all' ? { label: 'All' } : getPartyInfo(p);
    return `<button class="v2-filter${p === activeFilter ? ' active' : ''}" data-party="${p}">${info.label}</button>`;
  }).join('');
  el.querySelectorAll('.v2-filter').forEach(btn => {
    btn.onclick = () => {
      activeFilter = btn.dataset.party;
      el.querySelectorAll('.v2-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      refreshReps();
    };
  });
}

function renderMasterList() {
  const list = document.getElementById('master-list');
  if (!filteredMpps.length) {
    list.innerHTML = '<li class="master-empty">No MPPs match your search.</li>';
    return;
  }

  list.innerHTML = filteredMpps.map(m => {
    const p = getPartyInfo(m.party);
    const sel = selectedMpp && mppKey(selectedMpp) === mppKey(m);
    const align = showField('votingAlignment') && m.votingAlignment != null
      ? `${m.votingAlignment}%`
      : null;
    const info = showField('expenses') ? expenseIndex?.insights(m) : null;
    const expBadge = info
      ? `<span class="master-exp${info.isTop10 ? ' is-hot' : ''}">${window.MppShared.formatMoneyShort(info.total)}</span>`
      : '';
    return `
      <li class="master-item party-${p.slug}${sel ? ' selected' : ''}"
          role="option" aria-selected="${sel}"
          data-key="${mppKey(m)}">
        ${renderAvatar(m, 'master-avatar')}
        <span class="master-info">
          <span class="master-name">${m.name}</span>
          <span class="master-meta">${m.riding || '—'} · ${p.label}</span>
        </span>
        ${expBadge}
        ${align != null ? `<span class="master-align ${alignmentClass(m.votingAlignment)}">${align}</span>` : ''}
      </li>`;
  }).join('');

  list.querySelectorAll('.master-item').forEach(item => {
    item.onclick = () => selectMpp(item.dataset.key);
  });
}

function renderDetailEmpty() {
  document.getElementById('detail-pane').innerHTML = `
    <div class="detail-empty">
      <div class="detail-empty-icon">→</div>
      <h2>Select an MPP</h2>
      <p>Choose someone from the list to see their compensation, party alignment, and full voting record.</p>
      <p class="detail-empty-hint">${allMpps.length} representatives · ${allBills.length} bills tracked</p>
    </div>`;
}

function renderDetail(m) {
  const p = getPartyInfo(m.party);
  const alignCls = alignmentClass(m.votingAlignment);
  const showAlign = showField('votingAlignment');
  const showSalary = showField('salary');
  const showBenefits = showField('benefits');
  const showExpenses = showField('expenses') && m.expenses;
  const showComp = showSalary || showBenefits || showExpenses;
  const info = showExpenses ? expenseIndex?.insights(m) : null;
  const short = window.MppShared.formatMoneyShort;

  const voteRows = m.votes.map(v => `
    <tr class="vote-row-${voteClass(v)}">
      <td class="vote-bill-name">${v.bill}</td>
      <td class="vote-bill-result ${voteClass(v)}">${v.display}</td>
    </tr>`).join('');

  const featuredSet = new Set(FEATURED_BILLS);
  const featuredRows = m.votes.filter(v => [...featuredSet].some(fb => v.bill.startsWith(fb)));
  const otherRows = m.votes.filter(v => ![...featuredSet].some(fb => v.bill.startsWith(fb)));
  const exp = m.expenses;
  const partyLabel = p.label;
  const flags = (info?.flags || []).map(f =>
    `<span class="expense-flag tone-${f.tone}">${f.label}</span>`
  ).join('');
  const compare = info
    ? [
        info.rank ? `Rank #${info.rank} of ${info.count}` : null,
        info.vsParty != null ? `${info.vsParty.toFixed(1)}× ${partyLabel} median (${short(info.partyMedian)})` : null,
        info.legMedian != null ? `House median ${short(info.legMedian)}` : null,
      ].filter(Boolean).join(' · ')
    : '';

  document.getElementById('detail-pane').innerHTML = `
    <div class="detail-card party-${p.slug}">
      <button class="detail-back" id="detail-back" aria-label="Back to list">← Back</button>

      <header class="detail-header">
        ${renderAvatar(m, 'detail-avatar')}
        <div class="detail-identity">
          <h2>${m.profileUrl ? `<a href="${m.profileUrl}" target="_blank" rel="noopener" class="mpp-profile-link">${m.name}</a>` : m.name}</h2>
          <p>${m.riding || '—'}</p>
          <span class="detail-party">${m.party}</span>
        </div>
        ${showAlign ? `
        <div class="detail-align-badge ${alignCls}">
          <span class="detail-align-num">${m.votingAlignment != null ? m.votingAlignment + '%' : '—'}</span>
          <span class="detail-align-label">Party alignment</span>
        </div>` : ''}
      </header>

      <div class="detail-sections">
        ${showComp ? `
        <section class="detail-section">
          <h3>Compensation &amp; expenses</h3>
          <dl class="detail-dl">
            ${showSalary ? `<div><dt>Salary</dt><dd>${formatCurrency(m.salary)}</dd></div>` : ''}
            ${showBenefits ? `<div><dt>Benefits</dt><dd>${formatCurrency(m.benefits)}</dd></div>` : ''}
            ${showSalary && m.asOf ? `<div><dt>As of</dt><dd>${m.asOf}</dd></div>` : ''}
            ${showExpenses ? `<div><dt>Expenses (2yr)</dt><dd>${formatCurrency(exp.total)}</dd></div>` : ''}
            ${showExpenses ? `<div><dt>Travel</dt><dd>${formatCurrency(exp.travel)}</dd></div>` : ''}
            ${showExpenses ? `<div><dt>Accommodation</dt><dd>${formatCurrency(exp.accommodation)}</dd></div>` : ''}
            ${showExpenses ? `<div><dt>Meals</dt><dd>${formatCurrency(exp.meals)}</dd></div>` : ''}
            ${showExpenses ? `<div><dt>Hospitality / events</dt><dd>${formatCurrency(exp.hospitality)}</dd></div>` : ''}
            ${m.oacScore > 0 ? `<div><dt>OAC Score</dt><dd class="accent">${m.oacScore}</dd></div>` : ''}
          </dl>
          ${showExpenses && compare ? `<p class="detail-expense-note">${compare}</p>` : ''}
          ${showExpenses && flags ? `<div class="expense-flags" style="margin-top:0.65rem">${flags}</div>` : ''}
          ${showExpenses && exp.sourceUrl ? `<p class="detail-expense-note"><a href="${exp.sourceUrl}" target="_blank" rel="noopener">OLA expense disclosure →</a>${exp.claimCount ? ` · ${exp.claimCount} claims` : ''}${exp.asOf ? ` · scraped ${exp.asOf}` : ''}</p>` : ''}
        </section>` : ''}

        <section class="detail-section detail-section-wide">
          <h3>Key votes</h3>
          <table class="detail-vote-table">
            <thead><tr><th>Bill</th><th>Vote</th></tr></thead>
            <tbody>${featuredRows.map(v => `
              <tr class="vote-row-${voteClass(v)}">
                <td>${billLink(v)}</td>
                <td class="${voteClass(v)}">${v.display}</td>
              </tr>`).join('')}</tbody>
          </table>
        </section>

        ${otherRows.length ? `
        <section class="detail-section detail-section-wide">
          <details class="detail-more">
            <summary>All other votes (${otherRows.length})</summary>
            <table class="detail-vote-table">
              <thead><tr><th>Bill</th><th>Vote</th></tr></thead>
              <tbody>${otherRows.map(v => `
                <tr><td>${billLink(v)}</td><td class="${voteClass(v)}">${v.display}</td></tr>`).join('')}</tbody>
            </table>
          </details>
        </section>` : ''}

        ${m.roles ? `
        <section class="detail-section detail-section-wide">
          <h3>Roles</h3>
          <p class="detail-roles">${m.roles}</p>
        </section>` : ''}
      </div>

      <footer class="detail-actions">
        ${m.email ? `<a class="detail-btn primary" href="mailto:${m.email}">Email ${m.firstName || 'MPP'}</a>` : ''}
        ${m.phone ? `<a class="detail-btn" href="tel:${m.phone.replace(/\s/g, '')}">Call office</a>` : ''}
      </footer>
    </div>`;

  document.getElementById('detail-back').onclick = () => {
    mobileShowDetail = false;
    document.querySelector('.master-detail').classList.remove('show-detail');
  };
}

function selectMpp(key) {
  selectedMpp = filteredMpps.find(m => mppKey(m) === key) || allMpps.find(m => mppKey(m) === key);
  mobileShowDetail = true;
  document.querySelector('.master-detail')?.classList.add('show-detail');
  renderMasterList();
  if (selectedMpp) {
    renderDetail(selectedMpp);
    if (window.innerWidth <= 860) {
      requestAnimationFrame(() => {
        document.querySelector('.detail-pane')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }
}

function refreshReps() {
  const q = document.getElementById('v2-search')?.value || '';
  filteredMpps = filterMpps(q, activeFilter);
  document.getElementById('master-count').textContent = `${filteredMpps.length} of ${allMpps.length}`;

  if (selectedMpp && !filteredMpps.find(m => mppKey(m) === mppKey(selectedMpp))) {
    selectedMpp = filteredMpps[0] || null;
  }
  if (!selectedMpp && filteredMpps.length) selectedMpp = filteredMpps[0];

  renderMasterList();
  if (selectedMpp) renderDetail(selectedMpp);
  else renderDetailEmpty();
}

/* ── BILLS panel ── */

function buildBillsPanel() {
  document.getElementById('panel-bills').innerHTML = `
    <div class="bills-layout">
      <nav class="bill-nav" id="bill-nav"></nav>
      <div class="bill-content" id="bill-content"></div>
    </div>`;
}

function renderBillsPanel() {
  if (!document.getElementById('bill-nav')) buildBillsPanel();

  document.getElementById('bill-nav').innerHTML = allBills.map(b => {
    const meta = billsMeta.find(x => x.id === b);
    const label = (meta?.label || b).trim();
    const active = b === selectedBill;
    const featured = FEATURED_BILLS.some(f => b.startsWith(f));
    return `<button type="button" class="bill-nav-item bill-nav-select${active ? ' active' : ''}${featured ? ' featured' : ''}" data-bill="${b}">${label}</button>`;
  }).join('');

  document.getElementById('bill-nav').querySelectorAll('.bill-nav-select').forEach(btn => {
    btn.onclick = () => { selectedBill = btn.dataset.bill; renderBillsPanel(); };
  });

  const groups = { yes: [], no: [], na: [] };
  allMpps.forEach(m => {
    const v = getVote(m, selectedBill);
    const bucket = v.yes === true ? 'yes' : v.yes === false ? 'no' : 'na';
    groups[bucket].push({ mpp: m, vote: v });
  });

  const partyBreakdown = (bucket) => {
    const counts = {};
    groups[bucket].forEach(({ mpp }) => { counts[mpp.party] = (counts[mpp.party] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([party, n]) => `<span class="bill-party-count">${getPartyInfo(party).label}: ${n}</span>`).join('');
  };

  function renderGroup(title, cls, items) {
    if (!items.length) return '';
    return `
      <div class="bill-group bill-group-${cls}">
        <div class="bill-group-head">
          <h3>${title} <span class="bill-group-count">${items.length}</span></h3>
          <div class="bill-group-parties">${partyBreakdown(cls)}</div>
        </div>
        <ul class="bill-mpp-list">
          ${items.sort((a, b) => a.mpp.lastName.localeCompare(b.mpp.lastName)).map(({ mpp }) => {
            const p = getPartyInfo(mpp.party);
            return `<li><button class="bill-mpp-link party-${p.slug}" data-key="${mppKey(mpp)}">${renderAvatar(mpp, 'bill-mpp-avatar')}<span class="bill-mpp-text">${mpp.name}<span>${mpp.riding || p.label}</span></span></button></li>`;
          }).join('')}
        </ul>
      </div>`;
  }

  const billMeta = billsMeta.find(x => x.id === selectedBill);
  const billTitle = billMeta?.url
    ? billLink(billMeta, 'bill-header-link')
    : `<span class="bill-header-title">${(billMeta?.label || selectedBill).trim()}</span>`;

  document.getElementById('bill-content').innerHTML = `
    <header class="bill-header">
      <div class="bill-header-top">${billTitle}</div>
      <div class="bill-summary-bar">
        <div class="bill-stat yes"><span class="bill-stat-n">${groups.yes.length}</span><span>Voted Yes</span></div>
        <div class="bill-stat no"><span class="bill-stat-n">${groups.no.length}</span><span>Voted No</span></div>
        <div class="bill-stat na"><span class="bill-stat-n">${groups.na.length}</span><span>Absent / N/A</span></div>
      </div>
    </header>
    <div class="bill-groups">
      ${renderGroup('Voted Yes', 'yes', groups.yes)}
      ${renderGroup('Voted No', 'no', groups.no)}
      ${renderGroup('Absent or N/A', 'na', groups.na)}
    </div>`;

  document.querySelectorAll('.bill-mpp-link').forEach(btn => {
    btn.onclick = () => {
      selectMpp(btn.dataset.key);
      setTab('reps');
    };
  });
}

/* ── TABLE panel ── */

function renderTablePanel() {
  const panel = document.getElementById('panel-table');
  const bills = allBills;
  const midHeaders = [];
  if (showField('salary')) midHeaders.push('<th>Salary</th>');
  if (showField('benefits')) midHeaders.push('<th>Benefits</th>');
  if (showField('votingAlignment')) midHeaders.push('<th>Align</th>');
  if (showField('expenses')) midHeaders.push('<th>Expenses</th>');

  panel.innerHTML = `
    <p class="table-intro">Complete dataset for all ${allMpps.length} MPPs. Scroll horizontally for bill columns.</p>
    <div class="table-wrap">
      <table class="v2-table">
        <thead><tr>
          <th>Name</th><th>Party</th><th>Riding</th>${midHeaders.join('')}
          ${bills.map(b => {
            const v = allMpps[0]?.votes.find(x => x.bill === b);
            return `<th>${v ? billLink(v, 'bill-link-header') : b}</th>`;
          }).join('')}
        </tr></thead>
        <tbody>${allMpps.map(m => {
          const mid = [];
          if (showField('salary')) mid.push(`<td>${formatCurrency(m.salary)}</td>`);
          if (showField('benefits')) mid.push(`<td>${formatCurrency(m.benefits)}</td>`);
          if (showField('votingAlignment')) mid.push(`<td>${m.votingAlignment != null ? m.votingAlignment + '%' : '—'}</td>`);
          if (showField('expenses')) mid.push(`<td>${m.expenses ? formatCurrency(m.expenses.total) : '—'}</td>`);
          return `
          <tr>
            <td class="name-col"><button class="table-name-link" data-key="${mppKey(m)}">${renderAvatar(m, 'table-avatar')}<span>${m.name}</span></button></td>
            <td>${getPartyInfo(m.party).label}</td>
            <td>${m.riding || '—'}</td>
            ${mid.join('')}
            ${m.votes.map(v => `<td class="${voteClass(v)}">${v.display}</td>`).join('')}
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>`;

  panel.querySelectorAll('.table-name-link').forEach(btn => {
    btn.onclick = () => { selectMpp(btn.dataset.key); setTab('reps'); };
  });
}

/* ── Init ── */

async function init() {
  buildShell();

  try {
    const data = await (await fetch('data/mpps.json')).json();
    allMpps = data.mpps;
    billsMeta = data.bills || [];
    if (data.display) display = { ...display, ...data.display };
    allBills = billsMeta.length ? billsMeta.map(b => b.id) : (allMpps[0]?.votes.map(v => v.bill) || []);
    applyFeaturedBills(data.featuredBills);
    expenseIndex = window.MppShared.buildExpenseIndex(allMpps);
    filteredMpps = [...allMpps];
    selectedMpp = allMpps[0];

    document.getElementById('v2-loading').hidden = true;
    document.getElementById('v2-main').hidden = false;

    buildRepsPanel();
    buildBillsPanel();
    refreshReps();
  } catch (e) {
    document.getElementById('v2-loading').innerHTML = '<p>Failed to load data.</p>';
    console.error(e);
  }
}

init();
