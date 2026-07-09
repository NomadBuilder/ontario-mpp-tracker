const PARTIES = {
  'Progressive Conservative': { slug: 'pc', label: 'PC' },
  'New Democratic': { slug: 'ndp', label: 'NDP' },
  'Liberal': { slug: 'liberal', label: 'Liberal' },
  'Green': { slug: 'green', label: 'Green' },
  'Independent': { slug: 'independent', label: 'Independent' },
};

const FEATURED_BILLS = ['Bill 5', 'Bill 17', 'Bill 24', 'Bill 48', 'Bill 60', 'Bill 68', 'Bill 97'];
const IS_EMBED = new URLSearchParams(window.location.search).has('embed');

let allMpps = [];
let activeFilter = 'all';
let activeView = 'cards';

function formatCurrency(amount) {
  if (amount == null) return '—';
  return '$' + amount.toLocaleString('en-CA');
}

function getPartyInfo(party) {
  return PARTIES[party] || { slug: 'independent', label: party || 'Unknown' };
}

function getAlignmentClass(pct) {
  if (pct == null) return '';
  if (pct >= 90) return 'alignment-high';
  if (pct >= 70) return 'alignment-mid';
  return 'alignment-low';
}

function getVoteForBill(mpp, billName) {
  const vote = mpp.votes.find(v => v.bill === billName || v.bill.startsWith(billName));
  return vote || { display: 'N/A', yes: null };
}

function renderCard(mpp, index) {
  const party = getPartyInfo(mpp.party);
  const alignmentClass = getAlignmentClass(mpp.votingAlignment);

  const featuredVotes = FEATURED_BILLS.map(bill => {
    const v = getVoteForBill(mpp, bill);
    const cls = v.yes === true ? 'yes' : v.yes === false ? 'no' : 'na';
    const icon = v.yes === true ? '✓' : v.yes === false ? '✗' : '—';
    return `
      <div class="vote-row">
        <span class="vote-bill">${bill}</span>
        <span class="vote-result ${cls}">${icon} ${v.display}</span>
      </div>`;
  }).join('');

  const emailLink = mpp.email
    ? `<a class="card-link" href="mailto:${mpp.email}">Email MPP</a>`
    : '';
  const phoneLink = mpp.phone
    ? `<a class="card-link" href="tel:${mpp.phone.replace(/\s/g, '')}">Call Office</a>`
    : '';

  return `
    <article class="mpp-card" style="animation-delay: ${Math.min(index * 30, 600)}ms" data-name="${mpp.name.toLowerCase()}" data-party="${mpp.party}">
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
        <div class="stat">
          <span class="stat-label">Party</span>
          <span class="stat-value">${mpp.party}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Salary</span>
          <span class="stat-value">${formatCurrency(mpp.salary)}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Benefits</span>
          <span class="stat-value">${formatCurrency(mpp.benefits)}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Voting Alignment</span>
          <span class="stat-value highlight ${alignmentClass}">${mpp.votingAlignment != null ? mpp.votingAlignment + '%' : '—'}</span>
        </div>
        ${mpp.oacScore != null && mpp.oacScore > 0 ? `
        <div class="stat">
          <span class="stat-label">OAC Score</span>
          <span class="stat-value highlight">${mpp.oacScore}</span>
        </div>` : ''}
      </div>

      <div class="voting-section">
        <button class="voting-toggle" aria-expanded="false">
          <span>Voting History</span>
          <span class="chevron">▼</span>
        </button>
        <div class="voting-list">
          ${featuredVotes}
        </div>
      </div>

      ${(emailLink || phoneLink) ? `<div class="card-footer">${emailLink}${phoneLink}</div>` : ''}
    </article>`;
}

function renderTable(mpps) {
  const billHeaders = mpps[0]?.votes.map(v => v.bill) || [];

  const headerCells = [
    '<th>Name</th>',
    '<th>Party</th>',
    '<th>Riding</th>',
    '<th>Salary</th>',
    '<th>Benefits</th>',
    '<th>Alignment</th>',
    ...billHeaders.map(b => `<th>${b}</th>`),
  ].join('');

  const rows = mpps.map(mpp => {
    const voteCells = mpp.votes.map(v => {
      const cls = v.yes === true ? 'yes' : v.yes === false ? 'no' : 'na';
      return `<td class="vote-cell ${cls}">${v.display}</td>`;
    }).join('');

    return `<tr>
      <td class="name-cell">${mpp.name}</td>
      <td>${mpp.party}</td>
      <td>${mpp.riding || '—'}</td>
      <td>${formatCurrency(mpp.salary)}</td>
      <td>${formatCurrency(mpp.benefits)}</td>
      <td>${mpp.votingAlignment != null ? mpp.votingAlignment + '%' : '—'}</td>
      ${voteCells}
    </tr>`;
  }).join('');

  return `
    <div class="table-wrapper">
      <table class="data-table">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function filterMpps(query, party) {
  return allMpps.filter(mpp => {
    const matchesParty = party === 'all' || mpp.party === party;
    const q = query.toLowerCase().trim();
    const matchesQuery = !q ||
      mpp.name.toLowerCase().includes(q) ||
      (mpp.riding && mpp.riding.toLowerCase().includes(q)) ||
      mpp.party.toLowerCase().includes(q);
    return matchesParty && matchesQuery;
  });
}

function renderIntroStats() {
  const bills = allMpps[0]?.votes.length || 0;
  const parties = {};
  allMpps.forEach(m => {
    parties[m.party] = (parties[m.party] || 0) + 1;
  });

  const partyBreakdown = Object.entries(parties)
    .sort((a, b) => b[1] - a[1])
    .map(([party, count]) => {
      const info = getPartyInfo(party);
      return `<span class="party-stat"><span class="party-dot ${info.slug}"></span>${info.label}: ${count}</span>`;
    }).join('');

  document.getElementById('intro-stats').innerHTML = `
    <div class="stat-pill">
      <span class="stat-pill-number">${allMpps.length}</span>
      <span class="stat-pill-label">MPPs tracked</span>
    </div>
    <div class="stat-pill">
      <span class="stat-pill-number">${bills}</span>
      <span class="stat-pill-label">Bills & votes</span>
    </div>
    <div class="stat-pill stat-pill-wide">
      <span class="stat-pill-label">By party</span>
      <span class="stat-pill-parties">${partyBreakdown}</span>
    </div>`;
}

function setView(view) {
  activeView = view;
  const cardsSection = document.getElementById('cards-section');
  const tableSection = document.getElementById('table-section');

  document.querySelectorAll('.view-btn').forEach(btn => {
    const isActive = btn.dataset.view === view;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive);
  });

  cardsSection.classList.toggle('hidden', view !== 'cards');
  tableSection.classList.toggle('hidden', view !== 'table');
}

function setupViewToggle() {
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
}

function updateView() {
  const query = document.getElementById('search').value;
  const filtered = filterMpps(query, activeFilter);

  const grid = document.getElementById('cards-grid');
  const count = document.getElementById('result-count');

  if (filtered.length === 0) {
    grid.innerHTML = '<p class="no-results">No MPPs match your search.</p>';
  } else {
    grid.innerHTML = filtered.map((mpp, i) => renderCard(mpp, i)).join('');
    attachCardListeners();
  }

  count.textContent = `${filtered.length} of ${allMpps.length} MPPs`;

  document.getElementById('table-container').innerHTML = renderTable(filtered);
}

function attachCardListeners() {
  document.querySelectorAll('.voting-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const list = btn.nextElementSibling;
      const isOpen = btn.classList.toggle('open');
      list.classList.toggle('open', isOpen);
      btn.setAttribute('aria-expanded', isOpen);
    });
  });
}

function setupFilters() {
  const parties = ['all', ...new Set(allMpps.map(m => m.party).filter(Boolean))];
  const container = document.getElementById('filter-buttons');

  container.innerHTML = parties.map(p => {
    const label = p === 'all' ? 'All Parties' : (PARTIES[p]?.label || p);
    return `<button class="filter-btn${p === 'all' ? ' active' : ''}" data-party="${p}">${label}</button>`;
  }).join('');

  container.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.party;
      updateView();
    });
  });
}

async function init() {
  if (IS_EMBED) {
    document.body.classList.add('embed-mode');
    document.querySelector('.site-header')?.remove();
    document.querySelector('.site-footer')?.remove();
  }

  try {
    const res = await fetch('data/mpps.json');
    const data = await res.json();
    allMpps = data.mpps;

    document.getElementById('loading').style.display = 'none';
    document.getElementById('main-content').style.display = 'block';

    renderIntroStats();
    setupFilters();
    setupViewToggle();
    updateView();

    document.getElementById('search').addEventListener('input', updateView);
  } catch (err) {
    document.getElementById('loading').innerHTML =
      '<p>Failed to load MPP data. Make sure data/mpps.json exists.</p>';
    console.error(err);
  }
}

init();
