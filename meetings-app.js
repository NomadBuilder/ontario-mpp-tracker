/* OAC municipal meeting watch — separate from the live MPP iframe */
(function () {
  let payload = { items: [], coverage: [], asOf: "" };
  let portals = [];
  let view = "meetings";

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatWhen(item) {
    if (item.status === "watch") return "Not a single sitting — watch the calendar";
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

  function statusMark(item) {
    if (item.status === "past") return { cls: "past", label: "Past" };
    if (item.status === "watch") return { cls: "watch", label: "Watch" };
    if (item.status === "cancelled") return { cls: "past", label: "Cancelled" };
    return { cls: "upcoming", label: "Upcoming" };
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
    const extra = [
      kind === "exact" ? `<span class="badge flag">Data centre</span>` : "",
      kind === "broad" ? `<span class="badge flag">Related</span>` : "",
      !kind && item.status !== "past" && item.status !== "watch" ? `<span class="badge">Scan agenda</span>` : "",
    ].filter(Boolean).join("");
    const mark = statusMark(item);
    const links = item.links || {};
    const officialLabel = item.status === "watch" ? "Open meeting calendar" : "Open official agenda";
    const actions = [
      links.meeting ? `<a class="btn btn-primary" href="${escapeHtml(links.meeting)}" target="_blank" rel="noopener">${officialLabel}</a>` : "",
      links.agenda && links.agenda !== links.meeting
        ? `<a class="btn btn-ghost" href="${escapeHtml(links.agenda)}" target="_blank" rel="noopener">Agendas & minutes</a>`
        : "",
      links.report ? `<a class="btn btn-ghost" href="${escapeHtml(links.report)}" target="_blank" rel="noopener">Staff report</a>` : "",
      links.application ? `<a class="btn btn-ghost" href="${escapeHtml(links.application)}" target="_blank" rel="noopener">Application</a>` : "",
      links.source ? `<a class="btn btn-ghost" href="${escapeHtml(links.source)}" target="_blank" rel="noopener">News coverage</a>` : "",
    ].filter(Boolean);
    const meetingName = item.title || item.body || "Meeting";
    const showBody = item.body && item.body !== item.title && item.body !== item.municipality;

    return `
      <article class="item ${cls}" style="animation-delay:${Math.min(i * 25, 350)}ms">
        ${extra ? `<div class="item-kicker">${extra}</div>` : ""}
        <p class="place">${escapeHtml(item.municipality || "Municipality")}</p>
        <h2>${escapeHtml(meetingName)}</h2>
        <div class="when-block">
          <span class="status-mark ${mark.cls}">${mark.label}</span>
          <p class="when">${escapeHtml(formatWhen(item))}</p>
        </div>
        ${showBody ? `<p class="where">${escapeHtml(item.body)}</p>` : ""}
        ${item.location ? `<p class="where">${escapeHtml(item.location)}</p>` : ""}
        ${item.result ? `<div class="block result"><h3>Result</h3><p>${escapeHtml(item.result)}</p></div>` : ""}
        ${item.issue ? `<div class="block"><h3>What’s on the table</h3><p>${escapeHtml(item.issue)}</p></div>` : ""}
        ${item.why ? `<div class="block"><h3>Why this matters</h3><p>${escapeHtml(item.why)}</p></div>` : ""}
        ${item.status === "past" ? "" : `<div class="block">
          <h3>What to do next</h3>
          ${participateHtml(item.participate)}
        </div>`}
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

  function sourceMeta(portal, cov) {
    if (portal.type === "gap") return "Calendar link saved — not read automatically yet.";
    if (portal.priority !== "high") return "On our list, not in the twice-daily check yet.";
    if (cov && cov.ok && cov.meetings > 0) {
      return `Checked twice a day · ${cov.meetings} meeting${cov.meetings === 1 ? "" : "s"} in the current list`;
    }
    if (cov && cov.ok) return "Checked twice a day · nothing upcoming in the current window";
    if (cov && !cov.ok) return "Last automatic check didn’t load — use the official calendar";
    return "Checked twice a day";
  }

  function renderSources() {
    const ul = document.getElementById("source-list");
    const covById = new Map((payload.coverage || []).map((c) => [c.id, c]));
    const rows = (portals.length ? portals : payload.coverage || []).slice().sort((a, b) => {
      const pa = a.priority === "high" ? 0 : a.priority === "medium" ? 1 : 2;
      const pb = b.priority === "high" ? 0 : b.priority === "medium" ? 1 : 2;
      if (pa !== pb) return pa - pb;
      return (a.name || "").localeCompare(b.name || "");
    });
    ul.innerHTML = rows
      .map((p) => {
        const cov = covById.get(p.id) || {};
        const href = p.calendarUrl || p.base || cov.calendarUrl || "";
        const name = href
          ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>`
          : escapeHtml(p.name);
        return `<li>${name}<span class="meta">${escapeHtml(sourceMeta(p, cov))}</span></li>`;
      })
      .join("");
  }

  function setView(next) {
    view = next === "sources" ? "sources" : "meetings";
    const onSources = view === "sources";
    document.getElementById("tab-meetings").classList.toggle("current", !onSources);
    document.getElementById("tab-sources").classList.toggle("current", onSources);
    document.getElementById("tab-meetings").setAttribute("aria-selected", String(!onSources));
    document.getElementById("tab-sources").setAttribute("aria-selected", String(onSources));
    document.getElementById("meetings-blurb").hidden = onSources;
    document.getElementById("meetings-filters").hidden = onSources;
    document.getElementById("filter-hint").hidden = onSources;
    document.getElementById("meetings-panel").hidden = onSources;
    document.getElementById("sources-panel").hidden = !onSources;
    if (onSources) {
      if (location.hash !== "#sources") history.replaceState(null, "", "#sources");
      renderSources();
    } else if (location.hash === "#sources") {
      history.replaceState(null, "", location.pathname + location.search);
      render();
    }
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

  ["q", "when", "place"].forEach((id) => {
    document.getElementById(id).addEventListener("input", render);
    document.getElementById(id).addEventListener("change", render);
  });
  document.getElementById("tab-meetings").addEventListener("click", () => setView("meetings"));
  document.getElementById("tab-sources").addEventListener("click", () => setView("sources"));

  Promise.all([
    fetch("data/meetings.json").then((r) => {
      if (!r.ok) throw new Error("Could not load the meeting list.");
      return r.json();
    }),
    fetch("data/municipalities.json")
      .then((r) => (r.ok ? r.json() : { portals: [] }))
      .catch(() => ({ portals: [] })),
  ])
    .then(([data, registry]) => {
      payload = data;
      portals = registry.portals || [];
      fillPlaces();
      const q = new URLSearchParams(location.search);
      const when = q.get("when");
      const place = q.get("place");
      const whenSel = document.getElementById("when");
      const placeSel = document.getElementById("place");
      if (when && [...whenSel.options].some((o) => o.value === when)) whenSel.value = when;
      if (place && [...placeSel.options].some((o) => o.value === place)) placeSel.value = place;
      render();
      setView(location.hash === "#sources" ? "sources" : "meetings");
    })
    .catch((err) => {
      document.getElementById("count").textContent = "Could not load meetings.";
      document.getElementById("feed").innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
    });
})();
