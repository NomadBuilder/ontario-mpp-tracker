const PARTIES = {
  'Progressive Conservative': { slug: 'pc', label: 'PC' },
  'New Democratic': { slug: 'ndp', label: 'NDP' },
  'Liberal': { slug: 'liberal', label: 'Liberal' },
  'Green': { slug: 'green', label: 'Green' },
  'Independent': { slug: 'independent', label: 'Independent' },
};

const FEATURED_BILLS = ['Bill 5', 'Bill 17', 'Bill 24', 'Bill 48', 'Bill 60', 'Bill 68', 'Bill 97'];

const params = new URLSearchParams(window.location.search);
const IS_V2 = params.get('v') === '2';
const IS_EMBED = params.has('embed');

let allMpps = [];
let activeFilter = 'all';

function formatCurrency(amount) {
  if (amount == null) return '—';
  return '$' + amount.toLocaleString('en-CA');
}

function getPartyInfo(party) {
  return PARTIES[party] || { slug: 'independent', label: party || 'Unknown' };
}

function getInitials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function getAlignmentClass(pct) {
  if (pct == null) return '';
  if (pct >= 90) return 'high';
  if (pct >= 70) return 'mid';
  return 'low';
}

function getVoteForBill(mpp, billName) {
  const vote = mpp.votes.find(v => v.bill === billName || v.bill.startsWith(billName));
  return vote || { display: 'N/A', yes: null };
}

function alignmentRing(pct) {
  if (pct == null) return '';
  const cls = getAlignmentClass(pct);
  const r = 15;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  return `
    <div class="alignment-ring-wrap" title="Party-line voting alignment">
      <svg viewBox="0 0 36 36">
        <circle class="alignment-ring-bg" cx="18" cy="18" r="${r}"/>
        <circle class="alignment-ring-fill ${cls}" cx="18" cy="18" r="${r}"
          stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/>
      </svg>
      <div class="alignment-pct">${pct}%<small>Align</small></div>
    </div>`;
}

function renderCardV2(mpp, index) {
  const party = getPartyInfo(mpp.party);
  const initials = getInitials(mpp.name);

  const voteChips = FEATURED_BILLS.map(bill => {
    const v = getVoteForBill(mpp, bill);
    const cls = v.yes === true ? 'yes' : v.yes === false ? 'no' : 'na';
    const icon = v.yes === true ? '✓' : v.yes === false ? '✗' : '·';
    return `<span class="vote-chip ${cls}">${bill} ${icon}</span>`;
  }).join('');

  const emailLink = mpp.email ? `<a class="card-link" href="mailto:${mpp.email}">Email</a>` : '';
  const phoneLink = mpp.phone ? `<a class="card-link" href="tel:${mpp.phone.replace(/\s/g, '')}">Call</a>` : '';

  return `
    <article class="mpp-card party-${party.slug}" style="animation-delay: ${Math.min(index * 40, 800)}ms">
      <div class="card-header">
        <div class="card-avatar">${initials}</div>
        <div class="card-name-row">
          <h3 class="card-name">${mpp.name}</h3>
          ${mpp.riding ? `<p class="card-riding">${mpp.riding}</p>` : ''}
          <span class="party-badge">${party.label}</span>
        </div>
      </div>

      <div class="card-body">
        <div class="card-stats">
          <div class="stat">
            <span class="stat-label">Salary</span>
            <span class="stat-value">${formatCurrency(mpp.salary)}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Benefits</span>
            <span class="stat-value">${formatCurrency(mpp.benefits)}</span>
          </div>
          ${mpp.oacScore > 0 ? `
          <div class="stat">
            <span class="stat-label">OAC Score</span>
            <span class="stat-value highlight">${mpp.oacScore}</span>
          </div>` : ''}
        </div>
        ${alignmentRing(mpp.votingAlignment)}
      </div>

      <div class="voting-section">
        <button class="voting-toggle" aria-expanded="false">
          <span>Voting on key bills</span>
          <span class="chevron">▼</span>
        </button>
        <div class="voting-list">
          <div class="vote-chips">${voteChips}</div>
        </div>
      </div>

      ${(emailLink || phoneLink) ? `<div class="card-footer">${emailLink}${phoneLink}</div>` : ''}
    </article>`;
}

function renderCardV1(mpp, index) {
  const party = getPartyInfo(mpp.party);

  const featuredVotes = FEATURED_BILLS.map(bill => {
    const v = getVoteForBill(mpp, bill);
    const cls = v.yes === true ? 'yes' : v.yes === false ? 'no' : 'na';
    const icon = v.yes === true ? '✓' : v.yes === false ? '✗' : '—';
    return `<div class="vote-row"><span class="vote-bill">${bill}</span><span class="vote-result ${cls}">${icon} ${v.display}</span></div>`;
  }).join('');

  const ac = mpp.votingAlignment != null
    ? (mpp.votingAlignment >= 90 ? 'alignment-high' : mpp.votingAlignment >= 70 ? 'alignment-mid' : 'alignment-low')
    : '';

  const emailLink = mpp.email ? `<a class="card-link" href="mailto:${mpp.email}">Email MPP</a>` : '';
  const phoneLink = mpp.phone ? `<a class="card-link" href="tel:${mpp.phone.replace(/\s/g, '')}">Call Office</a>` : '';

  return `
    <article class="mpp-card" style="animation-delay: ${Math.min(index * 30, 600)}ms">
      <div class="card-header">
        <div class="card-name-row">
          <div>
            <h3 class="card-name">${mpp.name}</h3>
            ${mpp.riding ? `<p class="card-riding">${mpp.riding}</p>` : ''}
          </div>
          <span class="party-badge ${party.slug}">${party.label}</span>
        </div>
      </div>
      <div class="card-divider"></div>
      <div class="card-stats">
        <div class="stat"><span class="stat-label">Party</span><span class="stat-value">${mpp.party}</span></div>
        <div class="stat"><span class="stat-label">Salary</span><span class="stat-value">${formatCurrency(mpp.salary)}</span></div>
        <div class="stat"><span class="stat-label">Benefits</span><span class="stat-value">${formatCurrency(mpp.benefits)}</span></div>
        <div class="stat"><span class="stat-label">Voting Alignment</span><span class="stat-value highlight ${ac}">${mpp.votingAlignment != null ? mpp.votingAlignment + '%' : '—'}</span></div>
      </div>
      <div class="voting-section">
        <button class="voting-toggle" aria-expanded="false"><span>Voting History</span><span class="chevron">▼</span></button>
        <div class="voting-list">${featuredVotes}</div>
      </div>
      ${(emailLink || phoneLink) ? `<div class="card-footer">${emailLink}${phoneLink}</div>` : ''}
    </article>`;
}

function renderTable(mpps) {
  const billHeaders = mpps[0]?.votes.map(v => v.bill) || [];
  const headerCells = ['<th>Name</th>', '<th>Party</th>', '<th>Riding</th>', '<th>Salary</th>', '<th>Benefits</th>', '<th>Alignment</th>', ...billHeaders.map(b => `<th>${b}</th>`)].join('');
  const rows = mpps.map(mpp => {
    const voteCells = mpp.votes.map(v => {
      const cls = v.yes === true ? 'yes' : v.yes === false ? 'no' : 'na';
      return `<td class="vote-cell ${cls}">${v.display}</td>`;
    }).join('');
    return `<tr>
      <td class="name-cell">${mpp.name}</td><td>${mpp.party}</td><td>${mpp.riding || '—'}</td>
      <td>${formatCurrency(mpp.salary)}</td><td>${formatCurrency(mpp.benefits)}</td>
      <td>${mpp.votingAlignment != null ? mpp.votingAlignment + '%' : '—'}</td>${voteCells}</tr>`;
  }).join('');
  return `<div class="table-wrapper"><table class="data-table"><thead><tr>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function filterMpps(query, party) {
  return allMpps.filter(mpp => {
    const matchesParty = party === 'all' || mpp.party === party;
    const q = query.toLowerCase().trim();
    return matchesParty && (!q || mpp.name.toLowerCase().includes(q) || (mpp.riding && mpp.riding.toLowerCase().includes(q)) || mpp.party.toLowerCase().includes(q));
  });
}

function renderIntroStats() {
  const bills = allMpps[0]?.votes.length || 0;
  const parties = {};
  allMpps.forEach(m => { parties[m.party] = (parties[m.party] || 0) + 1; });

  const partyBreakdown = Object.entries(parties).sort((a, b) => b[1] - a[1]).map(([party, count]) => {
    const info = getPartyInfo(party);
    return `<span class="party-stat"><span class="party-dot ${info.slug}"></span>${info.label}: ${count}</span>`;
  }).join('');

  if (IS_V2) {
    document.getElementById('intro-stats').innerHTML = `
      <div class="stat-pill"><span class="stat-pill-number">${allMpps.length}</span><span class="stat-pill-label">MPPs</span></div>
      <div class="stat-pill"><span class="stat-pill-number">${bills}</span><span class="stat-pill-label">Votes tracked</span></div>
      <div class="stat-pill stat-pill-wide"><span class="stat-pill-label">Party breakdown</span><span class="stat-pill-parties">${partyBreakdown}</span></div>`;
  } else {
    document.getElementById('intro-stats').innerHTML = `
      <div class="stat-pill"><span class="stat-pill-number">${allMpps.length}</span><span class="stat-pill-label">MPPs tracked</span></div>
      <div class="stat-pill"><span class="stat-pill-number">${bills}</span><span class="stat-pill-label">Bills & votes</span></div>
      <div class="stat-pill stat-pill-wide"><span class="stat-pill-label">By party</span><span class="stat-pill-parties">${partyBreakdown}</span></div>`;
  }
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

function updateView() {
  const filtered = filterMpps(document.getElementById('search').value, activeFilter);
  const grid = document.getElementById('cards-grid');
  const renderCard = IS_V2 ? renderCardV2 : renderCardV1;

  grid.innerHTML = filtered.length
    ? filtered.map((m, i) => renderCard(m, i)).join('')
    : '<p class="no-results">No MPPs match your search.</p>';

  document.getElementById('result-count').textContent = `${filtered.length} of ${allMpps.length} MPPs`;
  document.getElementById('table-container').innerHTML = renderTable(filtered);
  attachCardListeners();
}

function attachCardListeners() {
  document.querySelectorAll('.voting-toggle').forEach(btn => {
    btn.onclick = () => {
      const list = btn.nextElementSibling;
      const open = btn.classList.toggle('open');
      list.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open);
    };
  });
}

function setupFilters() {
  const container = document.getElementById('filter-buttons');
  const parties = ['all', ...new Set(allMpps.map(m => m.party).filter(Boolean))];
  container.innerHTML = parties.map(p => {
    const label = p === 'all' ? 'All' : (PARTIES[p]?.label || p);
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

function setupVersionBadge() {
  const link = document.createElement('a');
  link.className = 'version-badge';
  if (IS_V2) {
    link.href = window.location.pathname + (IS_EMBED ? '?embed=1' : '');
    link.textContent = '← Classic view';
  } else {
    const qs = new URLSearchParams(window.location.search);
    qs.set('v', '2');
    link.href = '?' + qs.toString();
    link.textContent = '✦ New design';
  }
  document.body.appendChild(link);
}

async function init() {
  if (IS_EMBED) {
    document.body.classList.add('embed-mode');
    document.querySelector('.site-header')?.remove();
    document.querySelector('.site-footer')?.remove();
  }

  if (IS_V2) {
    document.body.classList.add('v2');
    document.title = 'Ontario MPPs & How They Vote · v2';
  }

  try {
    const res = await fetch('data/mpps.json');
    allMpps = (await res.json()).mpps;

    document.getElementById('loading').style.display = 'none';
    document.getElementById('main-content').style.display = 'block';

    renderIntroStats();
    setupFilters();
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.onclick = () => setView(btn.dataset.view);
    });
    updateView();
    document.getElementById('search').addEventListener('input', updateView);
    setupVersionBadge();
  } catch (err) {
    document.getElementById('loading').innerHTML = '<p>Failed to load MPP data.</p>';
    console.error(err);
  }
}

init();
