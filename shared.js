/* Shared helpers for v1 and v2 MPP tracker */

window.MppShared = (function () {
  const EXT_ICON = '<svg class="bill-ext-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

  const BILL_LINK_NOTE = '<p class="bill-link-note">Bill names link to the official page at <strong>ola.org</strong> (Legislative Assembly of Ontario).</p>';

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

  function billLink(voteOrId, billsMeta, getBillUrl, className = 'bill-link', style = 'inline') {
    const meta = getBillMeta(voteOrId, billsMeta, getBillUrl);
    if (!meta.url) {
      return `<span class="bill-label">${meta.label}</span>`;
    }

    const title = `Opens ${meta.label} on the Legislative Assembly of Ontario (ola.org)`;

    if (style === 'header') {
      return `<a href="${meta.url}" target="_blank" rel="noopener noreferrer" class="${className}" title="${title}">
        <span class="bill-link-label">${meta.label}</span>
        <span class="bill-link-dest">View on ola.org ${EXT_ICON}</span>
      </a>`;
    }

    if (style === 'block') {
      return `<a href="${meta.url}" target="_blank" rel="noopener noreferrer" class="${className} bill-link-block" title="${title}">
        <span class="bill-link-label">${meta.label}</span>
        <span class="bill-link-dest">View full bill on OLA.org ${EXT_ICON}</span>
      </a>`;
    }

    return `<a href="${meta.url}" target="_blank" rel="noopener noreferrer" class="${className}" title="${title}">
      <span class="bill-link-label">${meta.label}</span>
      <span class="bill-link-dest"><span class="bill-link-dest-text">View on ola.org</span> ${EXT_ICON}</span>
    </a>`;
  }

  return { billLink, getBillMeta, BILL_LINK_NOTE, EXT_ICON };
})();
