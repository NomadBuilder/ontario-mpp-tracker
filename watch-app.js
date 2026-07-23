/* OAC Accountability Watch — separate from live tracker embed */
(function () {
  const PARTY_SHORT = {
    "Progressive Conservative": "PC",
    "New Democratic": "NDP",
    Liberal: "Liberal",
    Green: "Green",
    Independent: "Independent",
  };
  const TYPE_LABEL = {
    news: "News",
    integrity: "Integrity",
    expenses: "Expenses",
    investigation: "Investigation",
  };
  const TYPE_VAR = {
    news: "var(--news)",
    integrity: "var(--integrity)",
    expenses: "var(--expenses)",
    investigation: "var(--investigation)",
  };
  const STATUS_LABEL = {
    reported: "Reported",
    under_review: "Under review",
    resolved: "Resolved",
    candidate: "Candidate",
  };

  let items = [];
  let mpps = [];

  function normalize(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/^hon\.?\s*/, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function nameTokens(s) {
    return normalize(s).split(" ").filter(Boolean);
  }

  function matchMpp(queryName) {
    const q = normalize(queryName);
    if (!q) return null;
    const qTokens = nameTokens(queryName);
    const last = qTokens[qTokens.length - 1];

    let best = null;
    let bestScore = 0;
    for (const m of mpps) {
      const full = normalize(m.name);
      const first = normalize(m.firstName);
      const family = normalize(m.lastName);
      let score = 0;
      if (full === q || `${first} ${family}` === q) score = 100;
      else if (family && last === family && (qTokens.includes(first) || first.startsWith(qTokens[0] || ""))) score = 80;
      else if (family && last === family) score = 50;
      else if (full.includes(q) || q.includes(full)) score = 40;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return bestScore >= 50 ? best : null;
  }

  function resolveMpps(item) {
    const names = item.mppNames || (item.mppName ? [item.mppName] : []);
    const matched = [];
    const seen = new Set();
    for (const n of names) {
      const m = matchMpp(n);
      if (m && !seen.has(m.name)) {
        seen.add(m.name);
        matched.push(m);
      }
    }
    return { names, matched };
  }

  function initials(mpp) {
    const a = (mpp.firstName || "").charAt(0);
    const b = (mpp.lastName || "").charAt(0);
    if (a || b) return (a + b).toUpperCase();
    return String(mpp.name || "?")
      .replace(/^Hon\.\s*/, "")
      .split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T12:00:00");
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function faceHtml(mpp) {
    if (!mpp) {
      return `<div class="face"><div class="fallback">?</div></div>`;
    }
    if (mpp.photo) {
      return `<div class="face"><img src="${escapeHtml(mpp.photo)}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><div class="fallback" hidden>${escapeHtml(initials(mpp))}</div></div>`;
    }
    return `<div class="face"><div class="fallback">${escapeHtml(initials(mpp))}</div></div>`;
  }

  function whoLine(matched, names) {
    if (matched.length) {
      return matched
        .map((m) => {
          const short = PARTY_SHORT[m.party] || m.party || "";
          const label = (m.name || "").replace(/^Hon\.\s*/, "");
          const party = short ? `<span class="party">${escapeHtml(short)}</span>` : "";
          const riding = m.riding ? ` · ${escapeHtml(m.riding)}` : "";
          return `<strong>${escapeHtml(label)}</strong>${party}${riding}`;
        })
        .join("<br>");
    }
    return names.map((n) => `<strong>${escapeHtml(n)}</strong>`).join(", ") || "—";
  }

  function itemHtml(item, index) {
    const { names, matched } = resolveMpps(item);
    const type = item.type || "news";
    const typeColor = TYPE_VAR[type] || "var(--yellow)";
    const primary = matched[0] || null;
    const extra = matched.length > 1 ? `<div class="face-more">+${matched.length - 1}</div>` : "";
    const status = item.status && item.status !== "reported"
      ? `<span class="status">${escapeHtml(STATUS_LABEL[item.status] || item.status)}</span>`
      : "";
    const email = primary?.email
      ? `<a class="btn btn-ghost" href="mailto:${escapeHtml(primary.email)}">Email MPP</a>`
      : "";
    const cardLink = primary
      ? `<a class="btn btn-ghost" href="cards.html">Player cards</a>`
      : "";

    return `
      <article class="item" style="--type:${typeColor};animation-delay:${Math.min(index * 30, 400)}ms">
        <div class="faces">${faceHtml(primary)}${extra}</div>
        <div>
          <div class="meta-row">
            <span class="badge">${escapeHtml(TYPE_LABEL[type] || type)}</span>
            ${status}
            <span class="when">${escapeHtml(formatDate(item.date))} · ${escapeHtml(item.source || "Source")}</span>
          </div>
          <h2><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h2>
          <div class="who">${whoLine(matched, names)}</div>
          ${item.summary ? `<p class="summary">${escapeHtml(item.summary)}</p>` : ""}
          <div class="actions">
            <a class="btn btn-primary" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Read source</a>
            ${email}
            ${cardLink}
          </div>
        </div>
      </article>`;
  }

  function filtered() {
    const q = document.getElementById("q").value.trim().toLowerCase();
    const type = document.getElementById("type").value;
    const party = document.getElementById("party").value;
    const sort = document.getElementById("sort").value;

    let list = items.filter((item) => {
      if (type && item.type !== type) return false;
      const { names, matched } = resolveMpps(item);
      if (party) {
        if (!matched.length || !matched.some((m) => m.party === party)) return false;
      }
      if (!q) return true;
      const blob = [
        item.title,
        item.summary,
        item.source,
        ...(names || []),
        ...matched.map((m) => [m.name, m.riding, m.roles].join(" ")),
      ]
        .join(" ")
        .toLowerCase();
      return blob.includes(q);
    });

    list = list.slice();
    if (sort === "mpp") {
      list.sort((a, b) => {
        const an = (resolveMpps(a).matched[0]?.lastName || resolveMpps(a).names[0] || "").toLowerCase();
        const bn = (resolveMpps(b).matched[0]?.lastName || resolveMpps(b).names[0] || "").toLowerCase();
        return an.localeCompare(bn) || (b.date || "").localeCompare(a.date || "");
      });
    } else if (sort === "type") {
      list.sort((a, b) => (a.type || "").localeCompare(b.type || "") || (b.date || "").localeCompare(a.date || ""));
    } else {
      list.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (a.title || "").localeCompare(b.title || ""));
    }
    return list;
  }

  function render() {
    const list = filtered();
    const feed = document.getElementById("feed");
    const count = document.getElementById("count");
    count.textContent = list.length
      ? `${list.length} item${list.length === 1 ? "" : "s"} · updated ${items._asOf || "—"}`
      : "No items match these filters.";
    if (!list.length) {
      feed.innerHTML = `<p class="empty">Nothing here yet. Try clearing filters, or add items to <code>data/accountability.json</code>.</p>`;
      return;
    }
    feed.innerHTML = list.map((item, i) => itemHtml(item, i)).join("");
  }

  function bind() {
    ["q", "type", "party", "sort"].forEach((id) => {
      document.getElementById(id).addEventListener("input", render);
      document.getElementById(id).addEventListener("change", render);
    });
  }

  Promise.all([
    fetch("data/accountability.json").then((r) => r.json()),
    fetch("data/mpps.json").then((r) => r.json()),
  ])
    .then(([watch, payload]) => {
      items = (watch.items || []).filter((it) => it.show !== false);
      items._asOf = watch.asOf || "";
      mpps = payload.mpps || [];
      bind();
      render();
    })
    .catch((err) => {
      document.getElementById("count").textContent = "Could not load accountability data.";
      document.getElementById("feed").innerHTML = `<p class="empty">${escapeHtml(err.message || String(err))}</p>`;
    });
})();
