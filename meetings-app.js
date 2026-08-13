/* OAC municipal meeting watch — separate from the live MPP iframe */
(function () {
  let payload = { items: [], coverage: [], asOf: "" };

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatWhen(item) {
    if (!item.date) return "Date TBA";
    const d = new Date(item.date + "T12:00:00");
    if (Number.isNaN(d.getTime())) return item.date;
    const day = d.toLocaleDateString("en-CA", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    return item.time ? `${day} · ${item.time}` : day;
  }

  function participateHtml(p) {
    if (!p) return "";
    const bits = [];
    if (p.attend) bits.push(`<span class="check yes">Public can attend</span>`);
    else if (p.attend === false) bits.push(`<span class="check no">Not a public sitting</span>`);
    if (p.deputations === true) bits.push(`<span class="check yes">Deputations / delegations possible</span>`);
    else if (p.deputations === false) bits.push(`<span class="check no">Deputations not available</span>`);
    else bits.push(`<span class="check warn">Check clerk for deputations</span>`);
    if (p.registerBy) bits.push(`<span class="check warn">Register by ${escapeHtml(p.registerBy)}</span>`);
    return `<div class="checks">${bits.join("")}</div>${p.notes ? `<p class="block"><span style="color:var(--dim)">${escapeHtml(p.notes)}</span></p>` : ""}`;
  }

  function itemHtml(item, i) {
    const flagged = !!item.relevant || !!matchKind(item);
    const cls = [
      flagged ? "flagged" : "",
      item.status === "past" ? "past" : "",
      item.status === "watch" ? "watch" : "",
    ].filter(Boolean).join(" ");
    const kind = matchKind(item);
    const badge = kind === "exact"
      ? `<span class="badge flag">Data centre</span>`
      : kind === "broad"
        ? `<span class="badge flag">Related</span>`
      : item.status === "past"
        ? `<span class="badge past">Past</span>`
        : `<span class="badge">Scan agenda</span>`;
    const links = item.links || {};
    const actions = [
      links.meeting ? `<a class="btn btn-primary" href="${escapeHtml(links.meeting)}" target="_blank" rel="noopener">Agenda / meeting</a>` : "",
      links.agenda && links.agenda !== links.meeting
        ? `<a class="btn btn-ghost" href="${escapeHtml(links.agenda)}" target="_blank" rel="noopener">Agenda</a>`
        : "",
      links.report ? `<a class="btn btn-ghost" href="${escapeHtml(links.report)}" target="_blank" rel="noopener">Staff report</a>` : "",
      links.application ? `<a class="btn btn-ghost" href="${escapeHtml(links.application)}" target="_blank" rel="noopener">Application</a>` : "",
      links.source ? `<a class="btn btn-ghost" href="${escapeHtml(links.source)}" target="_blank" rel="noopener">Source</a>` : "",
    ].filter(Boolean);

    return `
      <article class="item ${cls}" style="animation-delay:${Math.min(i * 25, 350)}ms">
        <div class="item-kicker">
          ${badge}
          <span>${escapeHtml(item.municipality || "")}</span>
          ${item.curated ? `<span>Curated</span>` : ""}
        </div>
        <h2>${escapeHtml(item.title || item.body || "Meeting")}</h2>
        <p class="when">${escapeHtml(formatWhen(item))}</p>
        ${item.body && item.body !== item.title ? `<p class="where">${escapeHtml(item.body)}</p>` : ""}
        ${item.location ? `<p class="where">${escapeHtml(item.location)}</p>` : ""}
        ${item.issue ? `<div class="block"><h3>What’s on the table</h3><p>${escapeHtml(item.issue)}</p></div>` : ""}
        ${item.why ? `<div class="block"><h3>Why this matters</h3><p>${escapeHtml(item.why)}</p></div>` : ""}
        ${item.result ? `<div class="block"><h3>Result</h3><p>${escapeHtml(item.result)}</p></div>` : ""}
        <div class="block">
          <h3>How to participate</h3>
          ${participateHtml(item.participate)}
        </div>
        <div class="actions">${actions.join("")}</div>
      </article>`;
  }

  function matchKind(item) {
    if (item.matchKind === "exact" || item.matchKind === "broad") return item.matchKind;
    const blob = [item.title, item.body, item.issue, ...(item.keywordsMatched || [])].join(" ").toLowerCase();
    if (/data[\s-]?cent(?:re|er)|datacent(?:re|er)/.test(blob)) return "exact";
    if (item.relevant) return "broad";
    return "";
  }

  function countLine(list, when) {
    const all = payload.items || [];
    const exactAll = all.filter((it) => matchKind(it) === "exact");
    const exactAhead = exactAll.filter((it) => ["upcoming", "watch"].includes(it.status)).length;
    const exactPast = exactAll.filter((it) => it.status === "past").length;
    const relatedAhead = all.filter((it) => matchKind(it) === "broad" && ["upcoming", "watch"].includes(it.status)).length;
    const asOf = payload.asOf || "—";
    if (when === "upcoming") {
      return `${list.length} upcoming · ${exactAhead} data-centre still ahead · ${exactPast} already happened · updated ${asOf}`;
    }
    if (when === "exact") {
      return `${list.length} with “data centre” in the agenda · ${exactAhead} upcoming · ${exactPast} past · updated ${asOf}`;
    }
    if (when === "broad") {
      return `${list.length} exact + related · ${exactAhead + relatedAhead} upcoming · updated ${asOf}`;
    }
    if (when === "past") {
      return `${list.length} past meetings · ${exactPast} data-centre · updated ${asOf}`;
    }
    return `${list.length} meetings · ${exactAll.length} data-centre · updated ${asOf}`;
  }

  const HINTS = {
    upcoming: "Every upcoming council and planning meeting we found. Green cards matched data-centre language.",
    exact: "Only items whose agenda or title literally says data centre, data center, or datacentre.",
    broad: "Exact matches plus related terms — hyperscale, colocation, AI campus, named operators, large-load / IESO connection, crypto mining.",
    past: "Meetings that already happened, including recorded votes when we have them.",
    all: "Upcoming, watch list, and past together.",
  };

  function filtered() {
    const q = document.getElementById("q").value.trim().toLowerCase();
    const when = document.getElementById("when").value;
    const place = document.getElementById("place").value;
    const rank = (it) => {
      if (it.status === "upcoming") return 0;
      if (it.status === "watch") return 1;
      if (it.status === "cancelled") return 3;
      return 2;
    };
    return (payload.items || []).filter((it) => {
      if (place && it.municipalityId !== place && it.municipality !== place) return false;
      if (when === "upcoming" && !["upcoming", "watch"].includes(it.status)) return false;
      if (when === "exact" && matchKind(it) !== "exact") return false;
      if (when === "broad" && !["exact", "broad"].includes(matchKind(it))) return false;
      if (when === "past" && it.status !== "past") return false;
      if (!q) return true;
      const blob = [it.municipality, it.body, it.title, it.issue, it.why, it.result, ...(it.keywordsMatched || [])]
        .join(" ")
        .toLowerCase();
      return blob.includes(q);
    }).sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r) return r;
      const flag = Number(!!b.relevant) - Number(!!a.relevant);
      if (flag) return flag;
      return (a.date || "9999").localeCompare(b.date || "9999") || (a.municipality || "").localeCompare(b.municipality || "");
    });
  }

  function render() {
    const list = filtered();
    const feed = document.getElementById("feed");
    const count = document.getElementById("count");
    const n = list.length;
    const hint = document.getElementById("filter-hint");
    const whenSel = document.getElementById("when");
    const opt = whenSel.options[whenSel.selectedIndex];
    if (hint) hint.textContent = HINTS[whenSel.value] || "";
    if (opt && opt.title) whenSel.title = opt.title;
    count.textContent = n ? countLine(list, whenSel.value) : "Nothing matches these filters.";
    feed.innerHTML = n
      ? list.map((it, i) => itemHtml(it, i)).join("")
      : `<p class="empty">No meetings in this view. Try “Upcoming” or clear the search — or add a row to data/meetings-curated.json.</p>`;
  }

  function fillPlaces() {
    const sel = document.getElementById("place");
    const names = new Map();
    for (const it of payload.items || []) {
      if (it.municipalityId && it.municipality) names.set(it.municipalityId, it.municipality);
    }
    for (const row of payload.coverage || []) {
      if (row.id && row.name) names.set(row.id, row.name);
    }
    const opts = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    sel.innerHTML =
      `<option value="">All places</option>` +
      opts.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
  }

  function renderGaps() {
    const gaps = (payload.coverage || []).filter((c) => c.type === "gap" || !c.ok);
    const box = document.getElementById("gaps");
    const ul = document.getElementById("gap-list");
    if (!gaps.length) return;
    box.hidden = false;
    ul.innerHTML = gaps
      .map((g) => {
        const href = g.calendarUrl
          ? `<a href="${escapeHtml(g.calendarUrl)}" target="_blank" rel="noopener">${escapeHtml(g.name)}</a>`
          : escapeHtml(g.name);
        const note = g.note ? ` — ${escapeHtml(g.note)}` : "";
        return `<li>${href}${note}</li>`;
      })
      .join("");
  }

  ["q", "when", "place"].forEach((id) => {
    document.getElementById(id).addEventListener("input", render);
    document.getElementById(id).addEventListener("change", render);
  });

  fetch("data/meetings.json")
    .then((r) => {
      if (!r.ok) throw new Error("Missing data/meetings.json — run scripts/fetch_meetings.py");
      return r.json();
    })
    .then((data) => {
      payload = data;
      fillPlaces();
      renderGaps();
      render();
    })
    .catch((err) => {
      document.getElementById("count").textContent = "Could not load meetings.";
      document.getElementById("feed").innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
    });
})();
