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
  };
})();
