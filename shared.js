/* Shared helpers for v1 and v2 MPP tracker */

window.MppShared = (function () {
  const EXT_ICON = '<svg class="bill-ext-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

  const BILL_LINK_NOTE = '<p class="bill-link-note">Bill names link to the official page at <strong>ola.org</strong> (Legislative Assembly of Ontario).</p>';

  const POSTAL_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\s?\d[ABCEGHJ-NPRSTV-Z]\d$/i;
  const REPRESENT_BASE = 'https://represent.opennorth.ca';

  function getBillMeta(voteOrId, billsMeta, getBillUrl) {
    const vote = typeof voteOrId === 'object' && voteOrId !== null ? voteOrId : null;
    const id = vote ? (vote.bill || vote.id) : voteOrId;
    const meta = billsMeta.find(b =>
      b.id === id || b.id.trim() === String(id).trim() || String(id).startsWith(b.id.trim())
    );
    return {
      id,
      label: (vote?.billFull || vote?.label || meta?.label || id || '').trim(),
      url: vote?.url || meta?.url || getBillUrl(id),
    };
  }

  function billLink(voteOrId, billsMeta, getBillUrl, className = 'bill-link') {
    const meta = getBillMeta(voteOrId, billsMeta, getBillUrl);
    if (!meta.url) {
      return `<span class="bill-label">${meta.label}</span>`;
    }

    const title = `Opens ${meta.label} on ola.org`;
    return `<a href="${meta.url}" target="_blank" rel="noopener noreferrer" class="${className}" title="${title}">${meta.label}</a>`;
  }

  function normalizePostal(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function formatPostal(raw) {
    const n = normalizePostal(raw).slice(0, 6);
    if (n.length > 3) return `${n.slice(0, 3)} ${n.slice(3)}`;
    return n;
  }

  function isValidPostal(raw) {
    return POSTAL_RE.test(String(raw || '').trim());
  }

  function normalizeRiding(name) {
    return String(name || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[—–−‑]/g, '-')
      .replace(/[''`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizePersonName(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/^(hon\.|dr\.)\s*/i, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z\s-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function findMppForDistrict(mpps, districtName, apiName) {
    const wantRiding = normalizeRiding(districtName);
    if (wantRiding) {
      const byRiding = mpps.find(m => normalizeRiding(m.riding) === wantRiding);
      if (byRiding) return byRiding;
    }
    const wantName = normalizePersonName(apiName);
    if (wantName) {
      const byName = mpps.find(m => normalizePersonName(m.name) === wantName);
      if (byName) return byName;
    }
    return null;
  }

  /**
   * Look up Ontario MPP for a Canadian postal code via OpenNorth Represent,
   * then match to our local MPP dataset (votes, contact, etc.).
   */
  async function lookupMppByPostal(postalCode, mpps) {
    const code = normalizePostal(postalCode);
    if (code.length !== 6 || !isValidPostal(code)) {
      return { ok: false, error: 'Enter a valid Canadian postal code (e.g. M5V 2T6).' };
    }

    let data;
    try {
      const res = await fetch(`${REPRESENT_BASE}/postcodes/${code}/`);
      if (res.status === 404) {
        return { ok: false, error: 'That postal code was not found. Double-check it and try again.' };
      }
      if (!res.ok) {
        return { ok: false, error: 'Lookup service is unavailable right now. Try again in a moment.' };
      }
      data = await res.json();
    } catch {
      return { ok: false, error: 'Could not reach the lookup service. Check your connection and try again.' };
    }

    if (data.province && data.province !== 'ON') {
      return {
        ok: false,
        error: `That postal code is in ${data.province || 'another province'}, not Ontario.`,
      };
    }

    const ontarioMpps = (data.representatives_centroid || []).filter(
      r => r.elected_office === 'MPP'
        && (r.representative_set_name || '').includes('Ontario')
    );

    for (const rep of ontarioMpps) {
      const mpp = findMppForDistrict(mpps, rep.district_name, rep.name);
      if (mpp) {
        return {
          ok: true,
          mpp,
          riding: mpp.riding || rep.district_name,
          postal: formatPostal(code),
          city: data.city || null,
        };
      }
    }

    const districts = [];
    for (const b of data.boundaries_centroid || []) {
      if ((b.boundary_set_name || '').includes('Ontario electoral')) {
        const name = b.name;
        if (name && !districts.includes(name)) districts.push(name);
      }
    }

    for (const district of districts) {
      const mpp = findMppForDistrict(mpps, district, null);
      if (mpp) {
        return {
          ok: true,
          mpp,
          riding: mpp.riding || district,
          postal: formatPostal(code),
          city: data.city || null,
          warning: districts.length > 1
            ? 'This postal code may touch more than one riding — we matched the best available result.'
            : null,
        };
      }
    }

    if (ontarioMpps.length || districts.length) {
      const label = ontarioMpps[0]?.district_name || districts[0];
      return {
        ok: false,
        error: `Found riding “${label}”, but it isn’t in our MPP list yet.`,
      };
    }

    return {
      ok: false,
      error: 'No Ontario MPP found for that postal code.',
    };
  }

  function median(nums) {
    if (!nums.length) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function formatMoneyShort(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 1000) return '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return '$' + Math.round(n).toLocaleString('en-CA');
  }

  /** Plain-language glossary for expense UI tooltips. */
  const EXPENSE_TIPS = {
    houseMedian:
      'House median: the midpoint of all MPPs’ disclosed expense totals over ~2 years. Half of MPPs spent more than this; half spent less. “House” means the Legislative Assembly.',
    partyMedian:
      'Party median: the midpoint expense total for MPPs in the same party only — a peer benchmark within that caucus.',
    vsParty:
      'Compared with this MPP’s party median. 1.0× means typical for the party; 2.0× means about twice the party midpoint.',
    disclosedTotal:
      'Total travel, accommodation, meals, and hospitality filed on ola.org over about two years. Does not include travel inside the MPP’s own riding.',
    rank:
      'Rank among all MPPs who filed expense claims in the OLA disclosure window (highest total = #1).',
    top10: 'This MPP is among the highest 10% of disclosed expense totals in the House.',
    top25: 'This MPP is among the highest 25% of disclosed expense totals in the House.',
    hospitalityHeavy:
      'More than 60% of this MPP’s disclosed expenses were hospitality / events (not travel or meals).',
    travelHeavy:
      'More than 60% of this MPP’s disclosed expenses were travel outside the riding.',
    over50k: 'More than $50,000 in disclosed expenses over the ~2-year OLA window.',
    over100k: 'More than $100,000 in disclosed expenses over the ~2-year OLA window.',
    highestSpender: 'MPP with the largest disclosed expense total in the current OLA ~2-year window.',
    claims: 'Number of individual expense claim lines published on the OLA disclosure page.',
    olaLink: 'Opens this MPP’s official expense disclosure page on ola.org (Legislative Assembly of Ontario).',
    travel: 'Travel outside the constituency (flights, mileage between regions, etc.). In-riding travel is not disclosed here.',
    accommodation: 'Hotel / lodging while travelling for legislative or constituency business outside the riding.',
    meals: 'Meal expenses tied to disclosed travel or events.',
    hospitality: 'Hospitality and events — receptions, coffee meet-ups, dining-room hospitality, ceremonies, etc.',
    expensesPanel: 'Public expense disclosure from the Legislative Assembly of Ontario (ola.org), covering roughly the past two years.',
    aboveParty: 'Total is at least 35% above this MPP’s party median.',
    aboveHouse: 'Total is at least 35% above the House (all-MPP) median.',
    belowParty: 'Total is at least 25% below this MPP’s party median.',
    highHospitality: 'At least $20,000 in hospitality / events claims in the ~2-year window.',
    highTravel: 'At least $30,000 in travel claims in the ~2-year window.',
  };

  function tipAttrs(keyOrText) {
    const text = EXPENSE_TIPS[keyOrText] || keyOrText || '';
    if (!text) return '';
    const safe = String(text)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
    // Do not set class= here — callers already have a class attribute.
    return ` tabindex="0" data-tip="${safe}" title="${safe}"`;
  }

  function tipSpan(labelHtml, keyOrText, withMark = false) {
    const text = EXPENSE_TIPS[keyOrText] || keyOrText || '';
    if (!text) return labelHtml;
    const safe = String(text)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
    const mark = withMark ? '<span class="tip-mark" aria-hidden="true">?</span>' : '';
    return `<span class="has-tip" tabindex="0" data-tip="${safe}" title="${safe}">${labelHtml}${mark}</span>`;
  }

  /** Build peer comparison index once; call insights(mpp) per card. */
  function buildExpenseIndex(mpps) {
    const rows = (mpps || [])
      .filter(m => m.expenses && typeof m.expenses.total === 'number')
      .map(m => ({ mpp: m, total: m.expenses.total }));

    rows.sort((a, b) => b.total - a.total);
    const totalsAsc = rows.map(r => r.total).sort((a, b) => a - b);
    const legMedian = median(totalsAsc);
    const topDecileCut = totalsAsc.length
      ? totalsAsc[Math.max(0, Math.ceil(totalsAsc.length * 0.9) - 1)]
      : null;
    const topQuartileCut = totalsAsc.length
      ? totalsAsc[Math.max(0, Math.ceil(totalsAsc.length * 0.75) - 1)]
      : null;

    const partyMedians = {};
    const byParty = {};
    rows.forEach(({ mpp, total }) => {
      const p = mpp.party || 'Unknown';
      (byParty[p] || (byParty[p] = [])).push(total);
    });
    Object.keys(byParty).forEach(p => {
      partyMedians[p] = median(byParty[p]);
    });

    const rankByName = new Map();
    rows.forEach((r, i) => rankByName.set(r.mpp.name, i + 1));

    const sumAll = rows.reduce((s, r) => s + r.total, 0);
    const top = rows[0] || null;

    function insights(mpp) {
      const e = mpp?.expenses;
      if (!e || typeof e.total !== 'number') return null;

      const partyMed = partyMedians[mpp.party] ?? null;
      const vsParty = partyMed > 0 ? e.total / partyMed : null;
      const vsLeg = legMedian > 0 ? e.total / legMedian : null;
      const rank = rankByName.get(mpp.name) || null;
      const count = rows.length;

      const cats = [
        { key: 'travel', label: 'Travel', value: e.travel || 0 },
        { key: 'accommodation', label: 'Accommodation', value: e.accommodation || 0 },
        { key: 'meals', label: 'Meals', value: e.meals || 0 },
        { key: 'hospitality', label: 'Hospitality', value: e.hospitality || 0 },
      ];
      const catSum = cats.reduce((s, c) => s + c.value, 0) || 1;
      cats.forEach(c => { c.share = c.value / catSum; });
      const dominant = [...cats].sort((a, b) => b.value - a.value)[0];

      const flags = [];
      if (topDecileCut != null && e.total >= topDecileCut) {
        flags.push({ id: 'top10', label: 'Top 10% spender', tone: 'alert' });
      } else if (topQuartileCut != null && e.total >= topQuartileCut) {
        flags.push({ id: 'top25', label: 'Top 25% spender', tone: 'warn' });
      }
      if (vsParty != null && vsParty >= 2) {
        flags.push({ id: 'party2x', label: `${vsParty.toFixed(1)}× party median`, tone: 'alert' });
      } else if (vsParty != null && vsParty >= 1.35) {
        flags.push({ id: 'partyHigh', label: `${vsParty.toFixed(1)}× party median`, tone: 'warn' });
      }
      if (dominant && dominant.share >= 0.6 && dominant.value > 0) {
        flags.push({
          id: 'catHeavy',
          label: `${dominant.label}-heavy (${Math.round(dominant.share * 100)}%)`,
          tone: dominant.key === 'hospitality' ? 'warn' : 'info',
        });
      }
      if (e.total >= 100000) {
        flags.push({ id: 'over100k', label: '$100k+ disclosed', tone: 'alert' });
      } else if (e.total >= 50000) {
        flags.push({ id: 'over50k', label: '$50k+ disclosed', tone: 'warn' });
      }

      return {
        total: e.total,
        travel: e.travel || 0,
        accommodation: e.accommodation || 0,
        meals: e.meals || 0,
        hospitality: e.hospitality || 0,
        claimCount: e.claimCount || 0,
        sourceUrl: e.sourceUrl,
        asOf: e.asOf,
        rank,
        count,
        legMedian,
        partyMedian: partyMed,
        vsParty,
        vsLeg,
        cats,
        dominant,
        flags,
        isTop25: topQuartileCut != null && e.total >= topQuartileCut,
        isTop10: topDecileCut != null && e.total >= topDecileCut,
        hospitalityHeavy: dominant?.key === 'hospitality' && dominant.share >= 0.6,
        travelHeavy: dominant?.key === 'travel' && dominant.share >= 0.6,
        aboveParty: vsParty != null && vsParty >= 1.35,
        belowParty: vsParty != null && vsParty <= 0.75,
        aboveHouse: vsLeg != null && vsLeg >= 1.35,
        over50k: e.total >= 50000,
        over100k: e.total >= 100000,
        highHospitality: (e.hospitality || 0) >= 20000,
        highTravel: (e.travel || 0) >= 30000,
      };
    }

    return {
      count: rows.length,
      sumAll,
      legMedian,
      top,
      partyMedians,
      insights,
    };
  }

  return {
    billLink,
    getBillMeta,
    BILL_LINK_NOTE,
    EXT_ICON,
    normalizePostal,
    formatPostal,
    isValidPostal,
    normalizeRiding,
    lookupMppByPostal,
    buildExpenseIndex,
    formatMoneyShort,
    EXPENSE_TIPS,
    tipAttrs,
    tipSpan,
  };
})();
