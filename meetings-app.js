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
    const flagged = !!item.relevant;
    const cls = item.status === "past" ? "past" : flagged ? "flagged" : item.status === "watch" ? "watch" : "";
    const badge = flagged
      ? `<span class="badge flag">Datacentre-related</span>`
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
      if (when === "flagged" && !it.relevant) return false;
      if (when === "past" && it.status !== "past") return false;
      if (!q) return true;
      const blob = [it.municipality, it.body, it.title, it.issue, it.why, it.result, ...(it.keywordsMatched || [])]
        .join(" ")
        .toLowerCase();
      return blob.includes(q);
    }).sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r) return r;
      return (a.date || "9999").localeCompare(b.date || "9999") || (a.municipality || "").localeCompare(b.municipality || "");
    });
  }

  function render() {
    const list = filtered();
    const feed = document.getElementById("feed");
    const count = document.getElementById("count");
    const n = list.length;
    count.textContent = n
      ? `${n} meeting${n === 1 ? "" : "s"} · updated ${payload.asOf || "—"}`
      : "Nothing matches these filters.";
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
    const gaps = (payload.coverage || []).filter((c) => c.type === "gap" || (c.type === "escribe" && !c.ok));
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
