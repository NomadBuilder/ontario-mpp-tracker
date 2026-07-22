const PARTIES = {
  'Progressive Conservative': { slug: 'pc', label: 'PC' },
  'New Democratic': { slug: 'ndp', label: 'NDP' },
  'Liberal': { slug: 'liberal', label: 'Liberal' },
  'Green': { slug: 'green', label: 'Green' },
  'Independent': { slug: 'independent', label: 'Independent' },
};

const DEFAULT_FEATURED_BILLS = ['Bill 5', 'Bill 17', 'Bill 24', 'Bill 60', 'Bill 68', 'Bill 97', 'Bill 110'];
let FEATURED_BILLS = [...DEFAULT_FEATURED_BILLS];
const IS_EMBED = new URLSearchParams(window.location.search).has('embed');

let allMpps = [];
let billsMeta = [];
let display = {
  salary: false,
  benefits: false,
  votingAlignment: false,
  expenses: true,
};
let activeFilter = 'all';
/** @type {'name'|'expenses-desc'|'expenses-asc'|'hospitality-desc'|'travel-desc'} */
let sortMode = 'name';
/** @type {string} */
let expenseFocus = 'all';
/** @type {{ mpp: object, postal: string, city?: string, riding?: string, warning?: string } | null} */
let activePostal = null;
/** @type {Record<string, 'yes'|'no'|'noshow'|'na'>} */
let voteFilters = {};
/** @type {ReturnType<typeof window.MppShared.buildExpenseIndex> | null} */
let expenseIndex = null;

const EXPENSE_PRESETS = [
  { id: 'top10', label: 'Top 10% spenders', tip: 'top10', sort: 'expenses-desc' },
  { id: 'top25', label: 'Top 25% spenders', tip: 'top25', sort: 'expenses-desc' },
  { id: 'over100k', label: '$100k+', tip: 'over100k', sort: 'expenses-desc' },
  { id: 'over50k', label: '$50k+', tip: 'over50k', sort: 'expenses-desc' },
  { id: 'above-party', label: 'Above party median', tip: 'aboveParty', sort: 'expenses-desc' },
  { id: 'above-house', label: 'Above House median', tip: 'aboveHouse', sort: 'expenses-desc' },
  { id: 'hospitality', label: 'Hospitality-heavy', tip: 'hospitalityHeavy', sort: 'hospitality-desc' },
  { id: 'high-hospitality', label: 'Hospitality $20k+', tip: 'highHospitality', sort: 'hospitality-desc' },
  { id: 'travel', label: 'Travel-heavy', tip: 'travelHeavy', sort: 'travel-desc' },
  { id: 'high-travel', label: 'Travel $30k+', tip: 'highTravel', sort: 'travel-desc' },
  { id: 'below-party', label: 'Below party median', tip: 'belowParty', sort: 'expenses-asc' },
];

const EXPENSE_FOCUS_LABELS = Object.fromEntries([
  ['all', 'All MPPs'],
  ...EXPENSE_PRESETS.map(p => [p.id, p.label]),
]);

function applyFeaturedBills(list) {
  if (Array.isArray(list) && list.length) {
    FEATURED_BILLS = list.slice();
  } else {
    FEATURED_BILLS = [...DEFAULT_FEATURED_BILLS];
  }
  // Drop filters for bills that are no longer featured
  Object.keys(voteFilters).forEach((bill) => {
    if (!FEATURED_BILLS.includes(bill)) delete voteFilters[bill];
  });
}

const VOTE_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'noshow', label: 'No Show' },
  { value: 'na', label: 'N/A' },
];

function showField(key) {
  return display[key] !== false;
}

function voteKeyFromDisplay(vote) {
  if (vote?.yes === true || vote?.display === 'Yes') return 'yes';
  if (vote?.yes === false || vote?.display === 'No') return 'no';
  if (vote?.display === 'No Show' || vote?.vote === 'No Show') return 'noshow';
  return 'na';
}

function matchesVoteFilters(mpp) {
  const entries = Object.entries(voteFilters);
  if (!entries.length) return true;
  return entries.every(([bill, required]) => {
    const v = getVoteForBill(mpp, bill);
    return voteKeyFromDisplay(v) === required;
  });
}

function activeVoteFilterCount() {
  return Object.keys(voteFilters).length;
}

function voteFilterLabel(key) {
  return VOTE_OPTIONS.find(o => o.value === key)?.label || key;
}

function formatCurrency(amount) {
  if (amount == null) return '—';
  return '$' + amount.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function expenseInsights(mpp) {
  return expenseIndex?.insights(mpp) || null;
}

function renderExpensePanel(mpp) {
  if (!showField('expenses')) return '';
  const info = expenseInsights(mpp);
  if (!info) {
    return `<div class="expense-panel expense-panel-empty">
      <span class="stat-label">Expenses (2yr)</span>
      <p class="expense-empty">No OLA claims filed in the past two years.</p>
    </div>`;
  }

  const short = window.MppShared.formatMoneyShort;
  const partyLabel = getPartyInfo(mpp.party).label;
  const compareBits = [];
  if (info.rank) compareBits.push(`#${info.rank} of ${info.count}`);
  if (info.vsParty != null) {
    compareBits.push(`${info.vsParty.toFixed(1)}× ${partyLabel} median`);
  } else if (info.partyMedian != null) {
    compareBits.push(`${partyLabel} median ${short(info.partyMedian)}`);
  }
  if (info.legMedian != null) {
    compareBits.push(`House median ${short(info.legMedian)}`);
  }

  const bars = info.cats
    .filter(c => c.value > 0)
    .map(c => `<span class="expense-bar-seg expense-bar-${c.key}" style="flex:${Math.max(c.share, 0.02)}" title="${c.label}: ${formatCurrency(c.value)}"></span>`)
    .join('');

  const legend = info.cats.map(c =>
    `<span class="expense-legend-item"><i class="expense-dot expense-dot-${c.key}"></i>${c.label} ${short(c.value)}</span>`
  ).join('');

  const flags = info.flags.map(f =>
    `<span class="expense-flag tone-${f.tone}">${f.label}</span>`
  ).join('');

  const ola = info.sourceUrl
    ? `<a class="expense-ola" href="${info.sourceUrl}" target="_blank" rel="noopener">OLA disclosure →</a>`
    : '';

  return `
    <div class="expense-panel${info.isTop10 ? ' is-top10' : info.isTop25 ? ' is-top25' : ''}">
      <div class="expense-panel-head">
        <span class="stat-label">Expenses (2yr · OLA)</span>
        <span class="expense-total">${formatCurrency(info.total)}</span>
      </div>
      ${compareBits.length ? `<p class="expense-compare">${compareBits.join(' · ')}</p>` : ''}
      ${flags ? `<div class="expense-flags">${flags}</div>` : ''}
      ${bars ? `<div class="expense-bar" aria-hidden="true">${bars}</div>` : ''}
      <div class="expense-legend">${legend}</div>
      <div class="expense-panel-foot">
        ${info.claimCount ? `<span>${info.claimCount} claims</span>` : '<span></span>'}
        ${ola}
      </div>
    </div>`;
}

function getPartyInfo(party) {
  return PARTIES[party] || { slug: 'independent', label: party || 'Unknown' };
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

function getVoteForBill(mpp, billName) {
  const vote = mpp.votes.find(v => v.bill === billName || v.bill.startsWith(billName));
  return vote || { bill: billName, display: 'N/A', yes: null, url: getBillUrl(billName) };
}

function renderCard(mpp, index) {
  const party = getPartyInfo(mpp.party);
  const ac = mpp.votingAlignment != null
    ? (mpp.votingAlignment >= 90 ? 'alignment-high' : mpp.votingAlignment >= 70 ? 'alignment-mid' : 'alignment-low')
    : '';

  const featuredVotes = FEATURED_BILLS.map(bill => {
    const v = getVoteForBill(mpp, bill);
    const cls = v.yes === true ? 'yes' : v.yes === false ? 'no' : 'na';
    const icon = v.yes === true ? '✓' : v.yes === false ? '✗' : '—';
    return `<div class="vote-row"><span class="vote-bill">${billLink(v)}</span><span class="vote-result ${cls}">${icon} ${v.display}</span></div>`;
  }).join('');

  const emailLink = mpp.email ? `<a class="card-link" href="mailto:${mpp.email}">Email MPP</a>` : '';
  const phoneLink = mpp.phone ? `<a class="card-link" href="tel:${mpp.phone.replace(/\s/g, '')}">Call Office</a>` : '';

  const stats = [
    `<div class="stat"><span class="stat-label">Party</span><span class="stat-value">${mpp.party}</span></div>`,
  ];
  if (showField('salary')) {
    stats.push(`<div class="stat"><span class="stat-label">Salary</span><span class="stat-value">${formatCurrency(mpp.salary)}</span></div>`);
  }
  if (showField('benefits')) {
    stats.push(`<div class="stat"><span class="stat-label">Benefits</span><span class="stat-value">${formatCurrency(mpp.benefits)}</span></div>`);
  }
  if (showField('votingAlignment')) {
    stats.push(`<div class="stat"><span class="stat-label">Voting Alignment</span><span class="stat-value highlight ${ac}">${mpp.votingAlignment != null ? mpp.votingAlignment + '%' : '—'}</span></div>`);
  }

  return `
    <article class="mpp-card${showField('expenses') && expenseInsights(mpp)?.isTop10 ? ' card-expense-alert' : ''}" style="animation-delay: ${Math.min(index * 30, 600)}ms">
      <div class="card-header">
        <div class="card-name-row">
          ${renderAvatar(mpp, 'card-avatar')}
          <div class="card-name-block">
            <h3 class="card-name">${mpp.profileUrl ? `<a href="${mpp.profileUrl}" target="_blank" rel="noopener" class="mpp-profile-link">${mpp.name}</a>` : mpp.name}</h3>
            ${mpp.riding ? `<p class="card-riding">${mpp.riding}</p>` : ''}
          </div>
          <span class="party-badge ${party.slug}">${party.label}</span>
        </div>
      </div>
      <div class="card-divider"></div>
      <div class="card-stats">${stats.join('')}</div>
      ${renderExpensePanel(mpp)}
      <div class="voting-section">
        <button class="voting-toggle" aria-expanded="false"><span>Voting History</span><span class="chevron">▼</span></button>
        <div class="voting-list">${featuredVotes}</div>
      </div>
      ${(emailLink || phoneLink) ? `<div class="card-footer">${emailLink}${phoneLink}</div>` : ''}
    </article>`;
}

function renderYourMpp(mpp, meta = {}) {
  const party = getPartyInfo(mpp.party);
  const ac = mpp.votingAlignment != null
    ? (mpp.votingAlignment >= 90 ? 'alignment-high' : mpp.votingAlignment >= 70 ? 'alignment-mid' : 'alignment-low')
    : '';

  const featuredVotes = FEATURED_BILLS.map(bill => {
    const v = getVoteForBill(mpp, bill);
    const cls = v.yes === true ? 'yes' : v.yes === false ? 'no' : 'na';
    const icon = v.yes === true ? '✓' : v.yes === false ? '✗' : '—';
    return `<div class="vote-row"><span class="vote-bill">${billLink(v)}</span><span class="vote-result ${cls}">${icon} ${v.display}</span></div>`;
  }).join('');

  const emailLink = mpp.email ? `<a class="card-link" href="mailto:${mpp.email}">Email MPP</a>` : '';
  const phoneLink = mpp.phone ? `<a class="card-link" href="tel:${mpp.phone.replace(/\s/g, '')}">Call Office</a>` : '';

  const stats = [
    `<div class="stat"><span class="stat-label">Party</span><span class="stat-value">${mpp.party}</span></div>`,
  ];
  if (showField('salary')) {
    stats.push(`<div class="stat"><span class="stat-label">Salary</span><span class="stat-value">${formatCurrency(mpp.salary)}</span></div>`);
  }
  if (showField('benefits')) {
    stats.push(`<div class="stat"><span class="stat-label">Benefits</span><span class="stat-value">${formatCurrency(mpp.benefits)}</span></div>`);
  }
  if (showField('votingAlignment')) {
    stats.push(`<div class="stat"><span class="stat-label">Voting Alignment</span><span class="stat-value highlight ${ac}">${mpp.votingAlignment != null ? mpp.votingAlignment + '%' : '—'}</span></div>`);
  }

  const where = [meta.postal, meta.city, meta.riding].filter(Boolean).join(' · ');

  return `
    <div class="search-result-head">
      <div>
        <p class="search-result-eyebrow">Your MPP</p>
        <p class="search-result-meta">${where}</p>
        ${meta.warning ? `<p class="search-result-warning">${meta.warning}</p>` : ''}
      </div>
      <button type="button" class="search-clear" id="postal-clear">Clear</button>
    </div>
    <article class="mpp-card search-mpp-card">
      <div class="card-header">
        <div class="card-name-row">
          ${renderAvatar(mpp, 'card-avatar')}
          <div class="card-name-block">
            <h3 class="card-name">${mpp.profileUrl ? `<a href="${mpp.profileUrl}" target="_blank" rel="noopener" class="mpp-profile-link">${mpp.name}</a>` : mpp.name}</h3>
            ${mpp.riding ? `<p class="card-riding">${mpp.riding}</p>` : ''}
          </div>
          <span class="party-badge ${party.slug}">${party.label}</span>
        </div>
      </div>
      <div class="card-divider"></div>
      <div class="card-stats">${stats.join('')}</div>
      ${renderExpensePanel(mpp)}
      <div class="voting-section">
        <button class="voting-toggle open" aria-expanded="true"><span>Voting History</span><span class="chevron">▼</span></button>
        <div class="voting-list open">${featuredVotes || '<p class="no-results">No votes on file.</p>'}</div>
      </div>
      ${(emailLink || phoneLink) ? `<div class="card-footer">${emailLink}${phoneLink}</div>` : ''}
    </article>`;
}

function wireVotingToggles(root = document) {
  root.querySelectorAll('.voting-toggle').forEach(btn => {
    btn.onclick = () => {
      const list = btn.nextElementSibling;
      const open = btn.classList.toggle('open');
      list.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open);
    };
  });
}

function looksLikePostalInput(raw) {
  // Only treat as postal while the typed characters follow the Canadian
  // letter-digit-letter digit-letter-digit pattern. Plain names like "Sol"
  // or "Smith" must not get a space / uppercasing forced in.
  const n = window.MppShared.normalizePostal(raw);
  if (!n || n.length > 6) return false;
  const partial = [
    /^[ABCEGHJ-NPRSTVXY]$/i,
    /^[ABCEGHJ-NPRSTVXY]\d$/i,
    /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]$/i,
    /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d$/i,
    /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]$/i,
    /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/i,
  ];
  return partial.some((re) => re.test(n));
}

function setSearchStatus(message, type = '') {
  const el = document.getElementById('search-status');
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    el.className = 'search-status';
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = `search-status${type ? ` is-${type}` : ''}`;
}

function clearPostalMatch() {
  activePostal = null;
  const result = document.getElementById('search-result');
  result.hidden = true;
  result.innerHTML = '';
  setSearchStatus('');
}

function showPostalMatch(lookup) {
  activePostal = {
    mpp: lookup.mpp,
    postal: lookup.postal,
    city: lookup.city,
    riding: lookup.riding,
    warning: lookup.warning,
  };
  setSearchStatus(lookup.warning || '', lookup.warning ? 'warning' : '');
  const result = document.getElementById('search-result');
  result.hidden = false;
  result.innerHTML = renderYourMpp(lookup.mpp, {
    postal: lookup.postal,
    city: lookup.city,
    riding: lookup.riding,
    warning: lookup.warning,
  });
  wireVotingToggles(result);
  document.getElementById('postal-clear').onclick = () => {
    clearPostalMatch();
    document.getElementById('search').value = '';
    document.getElementById('search').focus();
    updateView();
  };
}

async function runPostalLookup(raw) {
  const input = document.getElementById('search');
  input.value = window.MppShared.formatPostal(raw);
  clearPostalMatch();
  setSearchStatus('Looking up your MPP…', 'loading');

  const lookup = await window.MppShared.lookupMppByPostal(input.value, allMpps);
  if (!lookup.ok) {
    setSearchStatus(lookup.error, 'error');
    updateView();
    return;
  }

  showPostalMatch(lookup);
  updateView();
  document.getElementById('search-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setupSearch() {
  const form = document.getElementById('search-form');
  const input = document.getElementById('search');
  if (!form || !input) return;

  input.addEventListener('input', () => {
    const before = input.value;
    if (looksLikePostalInput(before)) {
      const formatted = window.MppShared.formatPostal(before);
      if (formatted !== before) {
        const start = input.selectionStart;
        input.value = formatted;
        const delta = formatted.length - before.length;
        input.setSelectionRange(start + delta, start + delta);
      }
    }

    if (activePostal && window.MppShared.normalizePostal(input.value) !== window.MppShared.normalizePostal(activePostal.postal)) {
      clearPostalMatch();
    } else if (!window.MppShared.isValidPostal(input.value)) {
      setSearchStatus('');
    }

    updateView();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (window.MppShared.isValidPostal(input.value)) {
      e.preventDefault();
      runPostalLookup(input.value);
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (window.MppShared.isValidPostal(input.value)) {
      runPostalLookup(input.value);
    }
  });
}

function renderTable(mpps) {
  const billHeaders = mpps[0]?.votes || [];
  const cols = [
    '<th>Name</th>',
    '<th>Party</th>',
    '<th>Riding</th>',
  ];
  if (showField('salary')) cols.push('<th>Salary</th>');
  if (showField('benefits')) cols.push('<th>Benefits</th>');
  if (showField('votingAlignment')) cols.push('<th>Alignment</th>');
  if (showField('expenses')) cols.push('<th>Expenses (2yr)</th>');
  cols.push(...billHeaders.map(v => `<th>${billLink(v, 'bill-link-header')}</th>`));

  const rows = mpps.map(mpp => {
    const voteCells = mpp.votes.map(v => {
      const cls = v.yes === true ? 'yes' : v.yes === false ? 'no' : 'na';
      return `<td class="vote-cell ${cls}">${v.display}</td>`;
    }).join('');
    const mid = [];
    if (showField('salary')) mid.push(`<td>${formatCurrency(mpp.salary)}</td>`);
    if (showField('benefits')) mid.push(`<td>${formatCurrency(mpp.benefits)}</td>`);
    if (showField('votingAlignment')) mid.push(`<td>${mpp.votingAlignment != null ? mpp.votingAlignment + '%' : '—'}</td>`);
    if (showField('expenses')) mid.push(`<td>${mpp.expenses ? formatCurrency(mpp.expenses.total) : '—'}</td>`);
    return `<tr>
      <td class="name-cell">${renderAvatar(mpp, 'table-avatar')}<span>${mpp.name}</span></td><td>${mpp.party}</td><td>${mpp.riding || '—'}</td>
      ${mid.join('')}${voteCells}</tr>`;
  }).join('');
  return `<div class="table-wrapper"><table class="data-table"><thead><tr>${cols.join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function matchesExpenseFocus(mpp) {
  if (expenseFocus === 'all' || !showField('expenses')) return true;
  const info = expenseInsights(mpp);
  if (!info) return false;
  switch (expenseFocus) {
    case 'top10': return info.isTop10;
    case 'top25': return info.isTop25;
    case 'over100k': return info.over100k;
    case 'over50k': return info.over50k;
    case 'above-party': return info.aboveParty;
    case 'above-house': return info.aboveHouse;
    case 'below-party': return info.belowParty;
    case 'hospitality': return info.hospitalityHeavy;
    case 'high-hospitality': return info.highHospitality;
    case 'travel': return info.travelHeavy;
    case 'high-travel': return info.highTravel;
    default: return true;
  }
}

function filterMpps(query, party) {
  const pool = activePostal ? [activePostal.mpp] : allMpps;
  return pool.filter(mpp => {
    const matchesParty = party === 'all' || mpp.party === party;
    const q = query.toLowerCase().trim();
    const matchesQuery = activePostal
      || !q
      || mpp.name.toLowerCase().includes(q)
      || (mpp.riding && mpp.riding.toLowerCase().includes(q))
      || mpp.party.toLowerCase().includes(q);
    return matchesParty && matchesQuery && matchesVoteFilters(mpp) && matchesExpenseFocus(mpp);
  });
}

function sortMpps(list) {
  const sorted = [...list];
  if (sortMode === 'expenses-desc') {
    sorted.sort((a, b) => (b.expenses?.total ?? -1) - (a.expenses?.total ?? -1));
  } else if (sortMode === 'expenses-asc') {
    sorted.sort((a, b) => (a.expenses?.total ?? Infinity) - (b.expenses?.total ?? Infinity));
  } else if (sortMode === 'hospitality-desc') {
    sorted.sort((a, b) => (b.expenses?.hospitality ?? -1) - (a.expenses?.hospitality ?? -1));
  } else if (sortMode === 'travel-desc') {
    sorted.sort((a, b) => (b.expenses?.travel ?? -1) - (a.expenses?.travel ?? -1));
  } else {
    sorted.sort((a, b) => String(a.lastName || a.name).localeCompare(String(b.lastName || b.name)));
  }
  return sorted;
}

function renderIntroStats() {
  const bills = allMpps[0]?.votes.length || 0;
  const parties = {};
  allMpps.forEach(m => { parties[m.party] = (parties[m.party] || 0) + 1; });
  const partyBreakdown = Object.entries(parties).sort((a, b) => b[1] - a[1]).map(([party, count]) => {
    const info = getPartyInfo(party);
    return `<span class="party-stat"><span class="party-dot ${info.slug}"></span>${info.label}: ${count}</span>`;
  }).join('');

  const short = window.MppShared.formatMoneyShort;
  const expBits = [];
  if (showField('expenses') && expenseIndex?.count) {
    expBits.push(`
      <div class="stat-pill has-tip"${window.MppShared.tipAttrs('disclosedTotal')}>
        <span class="stat-pill-number">${short(expenseIndex.sumAll)}</span>
        <span class="stat-pill-label">Disclosed expenses (2yr)<span class="tip-mark" aria-hidden="true">?</span></span>
      </div>
      <div class="stat-pill has-tip"${window.MppShared.tipAttrs('houseMedian')}>
        <span class="stat-pill-number">${short(expenseIndex.legMedian)}</span>
        <span class="stat-pill-label">House median<span class="tip-mark" aria-hidden="true">?</span></span>
      </div>
    `);
    if (expenseIndex.top) {
      expBits.push(`
        <div class="stat-pill stat-pill-wide has-tip"${window.MppShared.tipAttrs('highestSpender')}>
          <span class="stat-pill-label">Highest spender<span class="tip-mark" aria-hidden="true">?</span></span>
          <span class="stat-pill-parties">${expenseIndex.top.mpp.name} · ${short(expenseIndex.top.total)}</span>
        </div>
      `);
    }
  }

  document.getElementById('intro-stats').innerHTML = `
    <div class="stat-pill"><span class="stat-pill-number">${allMpps.length}</span><span class="stat-pill-label">MPPs tracked</span></div>
    <div class="stat-pill"><span class="stat-pill-number">${bills}</span><span class="stat-pill-label">Bills & votes</span></div>
    ${expBits.join('')}
    <div class="stat-pill stat-pill-wide"><span class="stat-pill-label">By party</span><span class="stat-pill-parties">${partyBreakdown}</span></div>`;
}

function openParentDrawer(el) {
  const drawer = el?.closest?.('details.filter-drawer');
  if (drawer) drawer.open = true;
}

function setupMobileLayout() {
  const mq = window.matchMedia('(max-width: 768px)');
  const apply = () => {
    document.body.classList.toggle('is-mobile', mq.matches);
    document.querySelectorAll('details[data-collapse-mobile]').forEach((el) => {
      if (!mq.matches) {
        el.open = true;
        return;
      }
      const hasActive = el.querySelector('.campaign-preset.active, .campaign-clear:not([hidden])');
      if (!hasActive) el.open = false;
    });
    const howto = document.getElementById('howto-details');
    if (howto) howto.open = !mq.matches;
  };
  apply();
  mq.addEventListener('change', apply);
}

function setView(view) {
  document.getElementById('cards-section').classList.toggle('hidden', view !== 'cards');
  document.getElementById('table-section').classList.toggle('hidden', view !== 'table');
  document.querySelectorAll('.view-btn').forEach(btn => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active);
  });
}

function updateCampaignSummary(filteredCount) {
  const summary = document.getElementById('campaign-summary');
  const clearBtn = document.getElementById('campaign-clear');
  const n = activeVoteFilterCount();
  clearBtn.hidden = n === 0;
  if (n === 0) {
    summary.hidden = true;
    summary.textContent = '';
    return;
  }
  openParentDrawer(clearBtn);
  const parts = Object.entries(voteFilters).map(
    ([bill, key]) => `${voteFilterLabel(key)} on ${bill}`
  );
  summary.hidden = false;
  summary.textContent = `Matching ${parts.join(' + ')} · ${filteredCount} MPP${filteredCount === 1 ? '' : 's'}`;
}

function applyVoteFilters(next) {
  voteFilters = { ...next };
  Object.keys(voteFilters).forEach(k => {
    if (!voteFilters[k]) delete voteFilters[k];
  });

  document.querySelectorAll('.campaign-bill-select').forEach(sel => {
    sel.value = voteFilters[sel.dataset.bill] || '';
  });

  updateView();
}

function setupCampaignFilters() {
  const grid = document.getElementById('campaign-bill-grid');
  if (!grid) return;

  grid.innerHTML = FEATURED_BILLS.map(bill => `
    <label class="campaign-bill">
      <span class="campaign-bill-name">${bill}</span>
      <select class="campaign-bill-select" data-bill="${bill}" aria-label="Vote filter for ${bill}">
        ${VOTE_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
      </select>
    </label>
  `).join('');

  grid.querySelectorAll('.campaign-bill-select').forEach(sel => {
    sel.onchange = () => {
      const next = { ...voteFilters };
      if (sel.value) next[sel.dataset.bill] = sel.value;
      else delete next[sel.dataset.bill];
      applyVoteFilters(next);
    };
  });

  document.getElementById('campaign-clear').onclick = () => applyVoteFilters({});
}

function updateExpenseSummary(filteredCount) {
  const summary = document.getElementById('expense-summary');
  const clearBtn = document.getElementById('expense-clear');
  if (!summary || !clearBtn) return;

  const active = expenseFocus !== 'all';
  clearBtn.hidden = !active;
  document.querySelectorAll('#expense-presets .campaign-preset').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.expense === expenseFocus);
  });

  if (!active) {
    summary.hidden = true;
    summary.textContent = '';
    return;
  }

  openParentDrawer(clearBtn);
  summary.hidden = false;
  summary.textContent = `${EXPENSE_FOCUS_LABELS[expenseFocus] || expenseFocus} · ${filteredCount} MPP${filteredCount === 1 ? '' : 's'}`;
}

function applyExpenseFocus(next, preferredSort) {
  expenseFocus = next || 'all';
  if (expenseFocus !== 'all') {
    if (preferredSort) sortMode = preferredSort;
    else if (sortMode === 'name') sortMode = 'expenses-desc';
  }
  const sortEl = document.getElementById('sort-mode');
  if (sortEl) sortEl.value = sortMode;
  updateView();
}

function setupExpenseControls() {
  const section = document.getElementById('expense-filters');
  const presets = document.getElementById('expense-presets');
  const sortEl = document.getElementById('sort-mode');
  if (!section || !presets || !sortEl) return;

  if (!showField('expenses')) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  presets.innerHTML = EXPENSE_PRESETS.map(p => {
    const tip = window.MppShared.EXPENSE_TIPS[p.tip] || '';
    const safe = tip.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<button type="button" class="campaign-preset has-tip" data-expense="${p.id}" data-tip="${safe}" title="${safe}">${p.label}</button>`;
  }).join('');

  presets.querySelectorAll('.campaign-preset').forEach(btn => {
    btn.onclick = () => {
      const preset = EXPENSE_PRESETS.find(p => p.id === btn.dataset.expense);
      if (!preset) return;
      const same = expenseFocus === preset.id;
      applyExpenseFocus(same ? 'all' : preset.id, same ? null : preset.sort);
    };
  });

  sortEl.value = sortMode;
  sortEl.onchange = () => {
    sortMode = sortEl.value;
    updateView();
  };

  document.getElementById('expense-clear').onclick = () => applyExpenseFocus('all');
}

function updateView() {
  const filtered = sortMpps(filterMpps(document.getElementById('search').value, activeFilter));
  const grid = document.getElementById('cards-grid');
  grid.innerHTML = filtered.length
    ? filtered.map((m, i) => renderCard(m, i)).join('')
    : '<p class="no-results">No MPPs match your search and filters.</p>';
  document.getElementById('result-count').textContent = `${filtered.length} of ${allMpps.length} MPPs`;
  document.getElementById('table-container').innerHTML = renderTable(filtered);
  updateCampaignSummary(filtered.length);
  updateExpenseSummary(filtered.length);
  wireVotingToggles();
}

function setupFilters() {
  const container = document.getElementById('filter-buttons');
  const parties = ['all', ...new Set(allMpps.map(m => m.party).filter(Boolean))];
  container.innerHTML = parties.map(p => {
    const label = p === 'all' ? 'All Parties' : (PARTIES[p]?.label || p);
    return `<button class="filter-btn${p === 'all' ? ' active' : ''}" data-party="${p}">${label}</button>`;
  }).join('');
  container.querySelectorAll('.filter-btn').forEach(btn => {
    btn.onclick = () => {
      container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.party;
      updateView();
    };
  });
}

async function init() {
  if (IS_EMBED) {
    document.body.classList.add('embed-mode');
    document.querySelector('.site-header')?.remove();
    document.querySelector('.site-footer')?.remove();
  }

  try {
    const payload = await (await fetch('data/mpps.json')).json();
    allMpps = payload.mpps;
    billsMeta = payload.bills || [];
    if (payload.display) display = { ...display, ...payload.display };
    applyFeaturedBills(payload.featuredBills);
    expenseIndex = window.MppShared.buildExpenseIndex(allMpps);
    document.getElementById('loading').style.display = 'none';
    document.getElementById('main-content').style.display = 'block';
    setupMobileLayout();
    renderIntroStats();
    setupFilters();
    setupExpenseControls();
    setupCampaignFilters();
    setupSearch();
    document.querySelectorAll('.view-btn').forEach(btn => { btn.onclick = () => setView(btn.dataset.view); });
    updateView();
  } catch (err) {
    document.getElementById('loading').innerHTML = '<p>Failed to load MPP data.</p>';
    console.error(err);
  }
}

init();
