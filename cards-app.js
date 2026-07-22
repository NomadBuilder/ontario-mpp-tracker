/* OAC MPP player cards */
(function () {
  const PARTY_SHORT = {
    "Progressive Conservative": "PC",
    "New Democratic": "NDP",
    Liberal: "Liberal",
    Green: "Green",
    Independent: "Independent",
  };
  const PARTY_VAR = {
    "Progressive Conservative": "var(--pc)",
    "New Democratic": "var(--ndp)",
    Liberal: "var(--liberal)",
    Green: "var(--green)",
    Independent: "var(--ind)",
  };

  let mpps = [];
  let featured = [];
  let active = null;

  function money(n) {
    if (typeof n !== "number" || Number.isNaN(n)) return "—";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return "$" + Math.round(n / 1e3) + "k";
    return "$" + Math.round(n).toLocaleString("en-CA");
  }

  function voteKey(vote) {
    if (!vote) return "na";
    if (vote.yes === true || vote.display === "Yes") return "yes";
    if (vote.yes === false || vote.display === "No") return "no";
    if (vote.display === "No Show" || vote.vote === "No Show") return "noshow";
    return "na";
  }

  function voteLabel(key) {
    return ({ yes: "Yes", no: "No", noshow: "NS", na: "N/A" })[key] || key;
  }

  function getVote(mpp, bill) {
    return (mpp.votes || []).find((v) => v.bill === bill || String(v.bill || "").startsWith(bill)) || null;
  }

  function powerLabel(mpp) {
    const blob = String(mpp.roles || "").toLowerCase();
    if (/\bpremier\b/.test(blob)) return "Premier";
    if (/associate minister/.test(blob)) return "Associate minister";
    if (/\bminister\b/.test(blob) && !/parliamentary assistant/.test(blob)) return "Minister";
    if (/house leader/.test(blob)) return "House leadership";
    if (/\bwhip\b/.test(blob)) return "Whip";
    if (/\bspeaker\b/.test(blob)) return "Speaker";
    if (/parliamentary assistant|assistant to the minister|assistant to the premier/.test(blob)) {
      return "Parliamentary assistant";
    }
    return null;
  }

  function roleSnippet(mpp) {
    const power = powerLabel(mpp);
    if (power) return power;
    const raw = String(mpp.roles || "").split("|")[0].trim();
    return raw || "Member of Provincial Parliament";
  }

  function initials(mpp) {
    const a = (mpp.firstName || "").charAt(0);
    const b = (mpp.lastName || "").charAt(0);
    if (a || b) return (a + b).toUpperCase();
    return String(mpp.name || "?")
      .split(/\s+/)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }

  function featuredVotes(mpp, limit) {
    const bills = featured.slice(0, limit || 4);
    return bills.map((bill) => {
      const k = voteKey(getVote(mpp, bill));
      const short = bill.replace("Bill ", "B");
      return `<span class="vote-chip ${k}" title="${bill}: ${voteLabel(k)}">${short} ${voteLabel(k)}</span>`;
    }).join("");
  }

  function cardHtml(mpp, index) {
    const party = PARTY_SHORT[mpp.party] || mpp.party || "—";
    const total = mpp.expenses?.total;
    const photo = mpp.photo
      ? `<img src="${mpp.photo}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true;this.nextElementSibling.hidden=false">
         <div class="fallback" hidden>${initials(mpp)}</div>`
      : `<div class="fallback">${initials(mpp)}</div>`;
    const email = mpp.email
      ? `<a class="btn btn-primary" href="mailto:${mpp.email}" data-stop="1">Email</a>`
      : "";
    const phone = mpp.phone
      ? `<a class="btn btn-ghost" href="tel:${String(mpp.phone).replace(/[^\d+]/g, "")}" data-stop="1">Call</a>`
      : "";

    return `
      <button type="button" class="player" data-id="${index}" style="--party:${PARTY_VAR[mpp.party] || "var(--yellow)"};animation-delay:${Math.min(index * 20, 500)}ms">
        <div class="player-photo">${photo}</div>
        <div class="player-body">
          <div class="player-party">${party}</div>
          <div class="player-name">${mpp.name}</div>
          <div class="player-riding">${mpp.riding || "—"}</div>
          <div class="player-role">${roleSnippet(mpp)}</div>
          <div class="vote-strip">${featuredVotes(mpp, 4)}</div>
          <div class="stat-row">
            <div><span>Expenses</span><span>${money(total)}</span></div>
            <div><span>Salary</span><span>${money(mpp.salary)}</span></div>
          </div>
          <div class="player-actions">${email}${phone}<span class="btn btn-ghost" data-stop="1" data-open="1">Open card</span></div>
        </div>
      </button>`;
  }

  function filtered() {
    const q = document.getElementById("q").value.trim().toLowerCase();
    const party = document.getElementById("party").value;
    const sort = document.getElementById("sort").value;
    let list = mpps.slice();
    if (party) list = list.filter((m) => m.party === party);
    if (q) {
      list = list.filter((m) => {
        const hay = `${m.name || ""} ${m.riding || ""} ${m.roles || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }
    list.sort((a, b) => {
      if (sort === "expenses") return (b.expenses?.total || 0) - (a.expenses?.total || 0);
      if (sort === "salary") return (b.salary || 0) - (a.salary || 0);
      if (sort === "riding") return String(a.riding || "").localeCompare(String(b.riding || ""));
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
    return list;
  }

  function render() {
    const list = filtered();
    document.getElementById("count").textContent =
      `${list.length} player card${list.length === 1 ? "" : "s"}` +
      (list.length !== mpps.length ? ` · filtered from ${mpps.length}` : "");
    const grid = document.getElementById("grid");
    grid.innerHTML = list.map((m, i) => cardHtml(m, mpps.indexOf(m))).join("") ||
      `<p style="color:var(--muted);grid-column:1/-1">No MPPs match that search.</p>`;
  }

  function openLightbox(mpp) {
    active = mpp;
    const box = document.getElementById("lightbox");
    const card = document.getElementById("lightbox-card");
    const party = PARTY_SHORT[mpp.party] || mpp.party || "—";
    const photo = mpp.photo
      ? `<img src="${mpp.photo}" alt="">`
      : `<div class="fallback" style="display:grid;place-items:center;height:100%;font-family:var(--display);font-size:4rem;color:var(--dim)">${initials(mpp)}</div>`;
    const votes = featured.map((bill) => {
      const k = voteKey(getVote(mpp, bill));
      return `<div class="lb-vote"><span>${bill}</span><span class="vote-chip ${k}">${voteLabel(k)}</span></div>`;
    }).join("");
    const raise = mpp.raisePct ?? mpp.sunshine?.raisePct;
    const tracker = `./?embed=1`;
    const map = `map.html`;

    card.innerHTML = `
      <button type="button" class="lb-close" id="lb-close" aria-label="Close">&times;</button>
      <div class="lb-photo">${photo}</div>
      <div class="lb-body">
        <p class="player-party">${party}${powerLabel(mpp) ? " · " + powerLabel(mpp) : ""}</p>
        <h2 id="lb-name">${mpp.name}</h2>
        <p class="lb-meta">${mpp.riding || "—"}</p>
        <p class="lb-meta">${roleSnippet(mpp)}</p>
        <div class="stat-row">
          <div><span>Expenses</span><span>${money(mpp.expenses?.total)}</span></div>
          <div><span>Salary</span><span>${money(mpp.salary)}${raise != null ? ` · ${raise > 0 ? "+" : ""}${Number(raise).toFixed(1)}%` : ""}</span></div>
        </div>
        <div class="lb-votes">${votes}</div>
        <div class="lb-actions">
          ${mpp.email ? `<a class="btn btn-primary" href="mailto:${mpp.email}">Email MPP</a>` : ""}
          ${mpp.phone ? `<a class="btn btn-ghost" href="tel:${String(mpp.phone).replace(/[^\d+]/g, "")}">Call</a>` : ""}
          <a class="btn btn-ghost" href="${tracker}">Tracker</a>
          <a class="btn btn-ghost" href="${map}">Map</a>
          ${mpp.profileUrl ? `<a class="btn btn-ghost" href="${mpp.profileUrl}" target="_blank" rel="noopener">OLA profile</a>` : ""}
        </div>
      </div>`;
    box.hidden = false;
    document.getElementById("lb-close").onclick = closeLightbox;
  }

  function closeLightbox() {
    document.getElementById("lightbox").hidden = true;
    active = null;
  }

  document.getElementById("grid").addEventListener("click", (e) => {
    const stop = e.target.closest("[data-stop]");
    const player = e.target.closest(".player");
    if (!player) return;
    if (stop && stop.tagName === "A") return;
    const mpp = mpps[Number(player.dataset.id)];
    if (mpp) openLightbox(mpp);
  });

  document.getElementById("lightbox").addEventListener("click", (e) => {
    if (e.target.id === "lightbox") closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });

  ["q", "party", "sort"].forEach((id) => {
    document.getElementById(id).addEventListener("input", render);
    document.getElementById(id).addEventListener("change", render);
  });

  fetch("data/mpps.json")
    .then((r) => r.json())
    .then((data) => {
      mpps = data.mpps || [];
      featured = data.featuredBills || [];
      render();
    })
    .catch((err) => {
      console.error(err);
      document.getElementById("count").textContent = "Couldn’t load MPP data.";
    });
})();
