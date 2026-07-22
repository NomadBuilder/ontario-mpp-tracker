/* OAC Ontario power map */
(function () {
  const TRACKER = "./?embed=1";
  const PARTY_SHORT = {
    "Progressive Conservative": "PC",
    "New Democratic": "NDP",
    Liberal: "Liberal",
    Green: "Green",
    Independent: "Independent",
  };

  const VOTE_COLORS = {
    yes: "#ffc745",
    no: "#5b8def",
    noshow: "#6a6a6a",
    na: "#4a4a4a",
    none: "#2a2a2a",
  };

  const BIVARIATE = {
    "yes-high": "#ffc745",
    "yes-low": "#8a7028",
    "no-high": "#5b8def",
    "no-low": "#2f4a7a",
    other: "#3a3a3a",
  };

  const ALIGN_RAMP = ["#2a2a2a", "#5c4a1f", "#8f7324", "#c9a12e", "#ffc745"];
  const EXPENSE_RAMP = ALIGN_RAMP;
  const MARGIN_RAMP = ["#ff7a7a", "#ffb060", "#e6d36a", "#6a8f6a", "#3d5c3d"];
  const NOSHOW_RAMP = ["#2a2a2a", "#4a4a4a", "#7a5a5a", "#b06060", "#ff7a7a"];

  const RIDING_ALIASES = {
    iiwetinoong: "kiiwetinoong",
    kiiwetinoong: "kiiwetinoong",
  };

  let meta = null;
  let mpps = [];
  let featuredBills = [];
  let ridingsGeo = null;
  let neighbours = {};
  let elections = { ridings: {} };
  let signals = { byBill: {} };

  let byRiding = new Map();
  let partyModeVote = new Map(); // bill -> party -> modal vote key
  let expenseP75 = 0;
  let expenseExtent = { min: 0, max: 1 };
  let alignmentExtent = { min: 0, max: 1 };

  let mode = "vote";
  let selectedBill = null;
  let layer = null;
  let selectedLayer = null;
  let selectedFeature = null;
  let neighbourNames = new Set();
  let filterMask = null; // Set of riding names or null

  let highlightCabinet = false;
  let highlightRebels = false;
  let highlightOpposition = false;

  const map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    minZoom: 5,
    maxZoom: 12,
  }).setView([50.5, -85.5], 5);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution:
      '&copy; OSM &copy; CARTO · Boundaries Represent/Elections Ontario · Results Elections Ontario',
    subdomains: "abcd",
    maxZoom: 12,
  }).addTo(map);

  function money(n) {
    if (typeof n !== "number" || Number.isNaN(n)) return "—";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return "$" + Math.round(n / 1e3) + "k";
    return "$" + Math.round(n).toLocaleString("en-CA");
  }

  function pct(n) {
    if (typeof n !== "number" || Number.isNaN(n)) return "—";
    return n.toFixed(1) + "%";
  }

  function ridingKey(name) {
    const n = window.MppShared.normalizeRiding(name);
    return RIDING_ALIASES[n] || n;
  }

  function voteKey(vote) {
    if (!vote) return "none";
    if (vote.yes === true || vote.display === "Yes") return "yes";
    if (vote.yes === false || vote.display === "No") return "no";
    if (vote.display === "No Show" || vote.vote === "No Show") return "noshow";
    return "na";
  }

  function voteLabel(key) {
    return ({ yes: "Yes", no: "No", noshow: "No show", na: "N/A", none: "No data" })[key] || key;
  }

  function getVote(mpp, bill) {
    if (!mpp || !bill) return null;
    return (mpp.votes || []).find((v) => v.bill === bill || String(v.bill || "").startsWith(bill)) || null;
  }

  function rolesText(mpp) {
    const r = mpp?.roles;
    if (!r) return "";
    return Array.isArray(r) ? r.join(" | ") : String(r);
  }

  function powerFlags(mpp) {
    const blob = rolesText(mpp).toLowerCase();
    const flags = {
      premier: /\bpremier\b/.test(blob),
      minister: /\bminister\b/.test(blob) && !/parliamentary assistant/.test(blob),
      associate: /associate minister/.test(blob),
      pa: /parliamentary assistant|assistant to the minister|assistant to the premier|assistant to the president|assistant to the attorney|assistant to the solicitor/.test(blob),
      whip: /\bwhip\b/.test(blob),
      houseLeader: /house leader/.test(blob),
      speaker: /\bspeaker\b/.test(blob),
    };
    flags.any =
      flags.premier ||
      flags.minister ||
      flags.associate ||
      flags.pa ||
      flags.whip ||
      flags.houseLeader ||
      flags.speaker;
    flags.label = flags.premier
      ? "Premier"
      : flags.minister
        ? "Minister"
        : flags.associate
          ? "Associate minister"
          : flags.houseLeader
            ? "House leadership"
            : flags.whip
              ? "Whip"
              : flags.speaker
                ? "Speaker"
                : flags.pa
                  ? "Parliamentary assistant"
                  : null;
    return flags;
  }

  function expenseTotal(mpp) {
    const n = mpp?.expenses?.total;
    return typeof n === "number" ? n : null;
  }

  function electionFor(ridingName) {
    if (!ridingName) return null;
    if (elections.ridings[ridingName]) return elections.ridings[ridingName];
    const key = ridingKey(ridingName);
    for (const [name, row] of Object.entries(elections.ridings || {})) {
      if (ridingKey(name) === key) return row;
    }
    return null;
  }

  function alignmentScore(mpp) {
    const bills = featuredBills.length ? featuredBills : [];
    let scored = 0;
    let yes = 0;
    for (const bill of bills) {
      const k = voteKey(getVote(mpp, bill));
      if (k === "yes" || k === "no") {
        scored += 1;
        if (k === "yes") yes += 1;
      }
    }
    if (!scored) return null;
    return yes / scored;
  }

  function noshowRate(mpp) {
    const bills = featuredBills.length ? featuredBills : [];
    if (!bills.length) return null;
    let n = 0;
    for (const bill of bills) {
      if (voteKey(getVote(mpp, bill)) === "noshow") n += 1;
    }
    return n / bills.length;
  }

  function buildPartyModes() {
    partyModeVote.clear();
    for (const bill of featuredBills) {
      const counts = new Map();
      for (const m of mpps) {
        const party = m.party || "Unknown";
        const k = voteKey(getVote(m, bill));
        if (k !== "yes" && k !== "no") continue;
        if (!counts.has(party)) counts.set(party, { yes: 0, no: 0 });
        counts.get(party)[k] += 1;
      }
      const modes = new Map();
      for (const [party, c] of counts) {
        modes.set(party, c.yes === c.no ? null : c.yes > c.no ? "yes" : "no");
      }
      partyModeVote.set(bill, modes);
    }
  }

  function isRebel(mpp, bill) {
    if (!mpp || !bill) return false;
    const k = voteKey(getVote(mpp, bill));
    if (k !== "yes" && k !== "no") return false;
    const modeVote = partyModeVote.get(bill)?.get(mpp.party);
    return modeVote && modeVote !== k;
  }

  function localOppositionNote(ridingName, bill) {
    const block = signals.byBill?.[bill];
    if (!block?.ridings) return null;
    if (block.ridings[ridingName]) return { label: block.label, note: block.ridings[ridingName] };
    const key = ridingKey(ridingName);
    for (const [name, note] of Object.entries(block.ridings)) {
      if (ridingKey(name) === key) return { label: block.label, note };
    }
    return null;
  }

  function indexMpps(list) {
    byRiding.clear();
    for (const m of list) {
      const key = ridingKey(m.riding);
      if (key) byRiding.set(key, m);
    }
    const kii = byRiding.get("kiiwetinoong") || byRiding.get("iiwetinoong");
    if (kii) {
      byRiding.set("kiiwetinoong", kii);
      byRiding.set("iiwetinoong", kii);
    }
  }

  function mppForFeature(feature) {
    const name = feature?.properties?.name || "";
    return byRiding.get(ridingKey(name)) || null;
  }

  function rampColor(t, ramp) {
    const x = Math.max(0, Math.min(1, t));
    const i = Math.min(ramp.length - 1, Math.floor(x * (ramp.length - 1)));
    return ramp[i];
  }

  function featureFill(feature) {
    const mpp = mppForFeature(feature);
    const riding = feature.properties.name;

    if (filterMask && !filterMask.has(riding)) return "#1a1a1a";

    if (mode === "vote") {
      return VOTE_COLORS[voteKey(getVote(mpp, selectedBill))] || VOTE_COLORS.none;
    }
    if (mode === "expense") {
      const total = expenseTotal(mpp);
      if (typeof total !== "number") return VOTE_COLORS.none;
      const { min, max } = expenseExtent;
      return rampColor(max === min ? 1 : (total - min) / (max - min), EXPENSE_RAMP);
    }
    if (mode === "alignment") {
      const s = alignmentScore(mpp);
      if (s == null) return VOTE_COLORS.none;
      return rampColor(s, ALIGN_RAMP);
    }
    if (mode === "noshow") {
      const s = noshowRate(mpp);
      if (s == null) return VOTE_COLORS.none;
      return rampColor(s, NOSHOW_RAMP);
    }
    if (mode === "margin") {
      const el = electionFor(riding);
      if (!el || typeof el.marginPct !== "number") return VOTE_COLORS.none;
      // Soft = low margin → red end of ramp
      const t = Math.min(1, el.marginPct / 25);
      return rampColor(t, MARGIN_RAMP);
    }
    if (mode === "vote-money") {
      const k = voteKey(getVote(mpp, selectedBill));
      const total = expenseTotal(mpp);
      if (k !== "yes" && k !== "no") return BIVARIATE.other;
      if (typeof total !== "number") return BIVARIATE.other;
      const high = total >= expenseP75;
      return BIVARIATE[`${k}-${high ? "high" : "low"}`];
    }
    return VOTE_COLORS.none;
  }

  let overlayMarkers = null;

  function countOverlayHits() {
    let rebels = 0;
    let local = 0;
    let cabinet = 0;
    if (!ridingsGeo) return { rebels, local, cabinet };
    for (const feature of ridingsGeo.features) {
      const mpp = mppForFeature(feature);
      const riding = feature.properties.name;
      if (powerFlags(mpp).any) cabinet += 1;
      if (isRebel(mpp, selectedBill)) rebels += 1;
      if (localOppositionNote(riding, selectedBill)) local += 1;
    }
    return { rebels, local, cabinet };
  }

  function updateOverlayCounts() {
    const { rebels, local } = countOverlayHits();
    const rebelEl = document.getElementById("rebel-count");
    const localEl = document.getElementById("local-count");
    if (rebelEl) {
      rebelEl.textContent = selectedBill ? `(${rebels})` : "";
      rebelEl.classList.toggle("is-zero", rebels === 0);
      rebelEl.title =
        rebels === 0
          ? `No caucus rebels on ${selectedBill} — every Yes/No matched their party’s majority`
          : `${rebels} MPP${rebels === 1 ? "" : "s"} voted against their party majority on ${selectedBill}`;
    }
    if (localEl) {
      localEl.textContent = selectedBill ? `(${local})` : "";
      localEl.classList.toggle("is-zero", local === 0);
      localEl.title =
        local === 0
          ? `No curated local-opposition notes for ${selectedBill}`
          : `${local} riding${local === 1 ? "" : "s"} have local opposition notes for ${selectedBill}`;
    }
  }

  function anyOverlayOn() {
    return highlightCabinet || highlightRebels || highlightOpposition || neighbourNames.size > 0;
  }

  function overlayFlags(feature) {
    const mpp = mppForFeature(feature);
    const riding = feature.properties.name;
    const cabinet = highlightCabinet && powerFlags(mpp).any;
    const rebel = highlightRebels && isRebel(mpp, selectedBill);
    const local = highlightOpposition && !!localOppositionNote(riding, selectedBill);
    const neighbour = neighbourNames.has(riding);
    return {
      cabinet,
      rebel,
      local,
      neighbour,
      hit: cabinet || rebel || local || neighbour,
    };
  }

  function featureStyle(feature) {
    const mpp = mppForFeature(feature);
    const riding = feature.properties.name;
    const flags = overlayFlags(feature);
    const isSelected = selectedFeature && selectedFeature.properties.name === riding;
    const dimmedByFilter = filterMask && !filterMask.has(riding);
    const overlaysOn = anyOverlayOn();
    const dimmedByOverlay = overlaysOn && !flags.hit && !isSelected;

    let weight = overlaysOn ? 0.5 : 0.7;
    let color = overlaysOn ? "#222" : "#111";
    let dashArray = null;
    let fillOpacity = dimmedByFilter ? 0.12 : 0.84;

    if (dimmedByOverlay) {
      fillOpacity = 0.12;
      weight = 0.4;
      color = "#1a1a1a";
    }

    if (flags.hit) {
      fillOpacity = 0.92;
      weight = 4.5;
      color = "#ffffff";
      if (flags.cabinet) color = "#ffc745";
      if (flags.local) color = "#ff4fd8";
      if (flags.rebel) {
        color = "#ff3b3b";
        dashArray = "8 5";
        weight = 5;
      }
      if (flags.neighbour && !flags.cabinet && !flags.rebel && !flags.local) {
        color = "#4dc9ff";
      }
    }

    if (isSelected) {
      weight = 6;
      color = "#ffffff";
      fillOpacity = 0.96;
      dashArray = null;
    }

    return {
      fillColor: featureFill(feature),
      weight,
      color,
      opacity: 1,
      fillOpacity,
      dashArray,
      lineJoin: "round",
      lineCap: "round",
    };
  }

  function centroidOf(feature) {
    try {
      const b = L.geoJSON(feature).getBounds();
      return b.getCenter();
    } catch (_) {
      return null;
    }
  }

  function refreshOverlayMarkers() {
    if (overlayMarkers) {
      map.removeLayer(overlayMarkers);
      overlayMarkers = null;
    }
    if (!anyOverlayOn() || !ridingsGeo) return;

    const group = L.layerGroup();
    for (const feature of ridingsGeo.features) {
      const flags = overlayFlags(feature);
      if (!flags.hit) continue;
      const c = centroidOf(feature);
      if (!c) continue;

      let fill = "#ffffff";
      if (flags.rebel) fill = "#ff3b3b";
      else if (flags.cabinet) fill = "#ffc745";
      else if (flags.local) fill = "#ff4fd8";
      else if (flags.neighbour) fill = "#4dc9ff";

      const marker = L.circleMarker(c, {
        radius: 9,
        color: "#000",
        weight: 2,
        fillColor: fill,
        fillOpacity: 1,
        className: "overlay-hit-marker",
      });
      marker.bindTooltip(
        `${feature.properties.name}${flags.rebel ? " · rebel" : ""}${flags.cabinet ? " · cabinet" : ""}${flags.local ? " · local opposition" : ""}`,
        { sticky: true, opacity: 0.95 }
      );
      marker.on("click", () => {
        let target = null;
        layer?.eachLayer((lyr) => {
          if (lyr.feature?.properties?.name === feature.properties.name) target = lyr;
        });
        openPanel(feature, target);
      });
      group.addLayer(marker);

      // Halo ring so markers read at GTA zoom
      group.addLayer(
        L.circleMarker(c, {
          radius: 16,
          color: fill,
          weight: 3,
          fillOpacity: 0,
          opacity: 0.95,
          interactive: false,
          className: "overlay-hit-halo",
        })
      );
    }
    overlayMarkers = group.addTo(map);
  }

  function renderLegend() {
    const el = document.getElementById("legend");
    let base = "";
    if (mode === "vote") {
      base = `<h2>${selectedBill || "Vote"}</h2>${["yes", "no", "noshow", "na", "none"]
        .map((k) => `<div class="legend-row"><span class="swatch" style="background:${VOTE_COLORS[k]}"></span>${voteLabel(k)}</div>`)
        .join("")}`;
    } else if (mode === "vote-money") {
      base = `<h2>Vote × expenses</h2>
        <div class="legend-row"><span class="swatch" style="background:${BIVARIATE["yes-high"]}"></span>Yes · high spend</div>
        <div class="legend-row"><span class="swatch" style="background:${BIVARIATE["yes-low"]}"></span>Yes · lower spend</div>
        <div class="legend-row"><span class="swatch" style="background:${BIVARIATE["no-high"]}"></span>No · high spend</div>
        <div class="legend-row"><span class="swatch" style="background:${BIVARIATE["no-low"]}"></span>No · lower spend</div>
        <div class="legend-row"><span class="swatch" style="background:${BIVARIATE.other}"></span>Other / no data</div>`;
    } else if (mode === "expense") {
      base = `<h2>Disclosed expenses</h2>
        <div class="legend-scale">${EXPENSE_RAMP.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
        <div class="legend-scale-labels"><span>${money(expenseExtent.min)}</span><span>${money(expenseExtent.max)}</span></div>`;
    } else if (mode === "alignment") {
      base = `<h2>Yes rate on watched bills</h2>
        <div class="legend-scale">${ALIGN_RAMP.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
        <div class="legend-scale-labels"><span>0%</span><span>100%</span></div>`;
    } else if (mode === "noshow") {
      base = `<h2>No-show rate (watched bills)</h2>
        <div class="legend-scale">${NOSHOW_RAMP.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
        <div class="legend-scale-labels"><span>0%</span><span>High</span></div>`;
    } else if (mode === "margin") {
      base = `<h2>2025 win margin</h2>
        <div class="legend-scale">${MARGIN_RAMP.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
        <div class="legend-scale-labels"><span>Soft</span><span>Safe (25%+)</span></div>`;
    }

    const overlayBits = [];
    if (highlightCabinet) {
      overlayBits.push(`<div class="legend-row"><span class="swatch swatch-ring" style="--ring:#ffc745;background:#ffc745"></span>Cabinet / power</div>`);
    }
    if (highlightRebels) {
      overlayBits.push(`<div class="legend-row"><span class="swatch swatch-ring" style="--ring:#ff3b3b;background:#ff3b3b"></span>Caucus rebel</div>`);
    }
    if (highlightOpposition) {
      overlayBits.push(`<div class="legend-row"><span class="swatch swatch-ring" style="--ring:#ff4fd8;background:#ff4fd8"></span>Local opposition</div>`);
    }
    if (neighbourNames.size) {
      overlayBits.push(`<div class="legend-row"><span class="swatch swatch-ring" style="--ring:#4dc9ff;background:#4dc9ff"></span>Neighbours</div>`);
    }
    if (overlayBits.length) {
      const { rebels, local } = countOverlayHits();
      let emptyNote = "";
      if (highlightRebels && rebels === 0) {
        emptyNote += `<p class="legend-note warn">No rebels on ${selectedBill}: every Yes/No matched that MPP’s party majority.</p>`;
      }
      if (highlightOpposition && local === 0) {
        emptyNote += `<p class="legend-note warn">No curated local-opposition notes for ${selectedBill}.</p>`;
      }
      base += `<h2 class="legend-sub">Highlights</h2>
        <p class="legend-note">Matching ridings stay bright with a thick outline + marker. Everything else is dimmed.</p>
        ${emptyNote}
        ${overlayBits.join("")}`;
    }
    el.innerHTML = base;
  }

  function redraw(refit) {
    const keep = selectedFeature?.properties?.name;
    if (layer) {
      map.removeLayer(layer);
      layer = null;
    }
    layer = L.geoJSON(ridingsGeo, { style: featureStyle, onEachFeature }).addTo(map);
    refreshOverlayMarkers();
    renderLegend();
    updateBillControlVisibility();
    updateOverlayCounts();
    updateDoNext();
    if (keep) {
      layer.eachLayer((lyr) => {
        if (lyr.feature?.properties?.name === keep) {
          selectedLayer = lyr;
          lyr.setStyle(featureStyle(lyr.feature));
          lyr.bringToFront();
        }
      });
    }
    if (refit) {
      try {
        map.fitBounds(layer.getBounds(), { padding: [24, 24], maxZoom: 6 });
      } catch (_) { /* ignore */ }
    }
  }

  let activeAction = null; // { mpp, riding, vKey }

  function mailBody(mpp, vKey) {
    const bill = selectedBill || "this bill";
    const vote = voteLabel(vKey).toLowerCase();
    return [
      `Hello ${mpp.name},`,
      "",
      `I'm a constituent in ${mpp.riding}. I'm writing about ${bill}.`,
      "",
      meta?.billBlurbs?.[selectedBill] ? `${meta.billBlurbs[selectedBill]}` : "",
      "",
      `Our records show you voted ${vote}. Please reply with a clear explanation of that vote and whether you will support stronger accountability and transparency going forward.`,
      "",
      "Thank you,",
      "[Your name]",
      "[Your postal code]",
    ]
      .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
      .join("\n");
  }

  function mailHref(mpp, vKey) {
    if (!mpp?.email) return null;
    const subject = `${selectedBill || "Your record"} — constituent asking for a clear answer`;
    return `mailto:${mpp.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailBody(mpp, vKey))}`;
  }

  function updateDoNext() {
    const textEl = document.getElementById("do-next-text");
    const actionsEl = document.getElementById("do-next-actions");
    if (!textEl || !actionsEl) return;

    if (activeAction?.mpp) {
      const { mpp, vKey } = activeAction;
      const href = mailHref(mpp, vKey);
      textEl.textContent = `Ask ${mpp.name} to explain their ${voteLabel(vKey)} on ${selectedBill || "this vote"} — one email is enough to start.`;
      actionsEl.innerHTML = href
        ? `<a class="btn btn-primary btn-sm" id="do-next-primary" href="${href}">Email MPP</a>
           <button type="button" class="btn btn-ghost btn-sm" id="do-next-secondary">Share card</button>`
        : `<button type="button" class="btn btn-primary btn-sm" id="do-next-primary">Call ${mpp.phone ? "now" : "from tracker"}</button>`;
      document.getElementById("do-next-secondary")?.addEventListener("click", () => {
        if (selectedFeature) drawShareCard(selectedFeature);
      });
      document.getElementById("do-next-primary")?.addEventListener("click", (e) => {
        if (href) return;
        if (mpp.phone) window.location.href = `tel:${String(mpp.phone).replace(/[^\d+]/g, "")}`;
        else e.preventDefault();
      });
      return;
    }

    if (filterMask && filterMask.size) {
      textEl.textContent = `${filterMask.size} pressure targets match your filters. Download the list and assign emails this week.`;
      actionsEl.innerHTML = `<button type="button" class="btn btn-primary btn-sm" id="do-next-primary">Download CSV</button>
        <button type="button" class="btn btn-ghost btn-sm" id="do-next-secondary">Clear filters</button>`;
      document.getElementById("do-next-primary").onclick = downloadCsv;
      document.getElementById("do-next-secondary").onclick = () => document.getElementById("f-clear").click();
      return;
    }

    if (highlightCabinet || highlightRebels || highlightOpposition) {
      const { rebels, local, cabinet } = countOverlayHits();
      const bits = [];
      if (highlightRebels) {
        bits.push(
          rebels
            ? `${rebels} caucus rebel${rebels === 1 ? "" : "s"} on ${selectedBill}`
            : `No caucus rebels on ${selectedBill} — full party discipline`
        );
      }
      if (highlightOpposition) {
        bits.push(
          local
            ? `${local} riding${local === 1 ? "" : "s"} with local opposition notes`
            : `No local-opposition notes tagged for ${selectedBill}`
        );
      }
      if (highlightCabinet) bits.push(`${cabinet} cabinet/power ridings`);
      textEl.textContent = bits.join(". ") + ". Click a bright riding, then email one clear ask.";
      actionsEl.innerHTML = `<button type="button" class="btn btn-primary btn-sm" id="do-next-primary">Enter postal code</button>`;
      document.getElementById("do-next-primary").onclick = () => {
        document.getElementById("postal").focus();
        document.getElementById("postal").scrollIntoView({ behavior: "smooth", block: "center" });
      };
      return;
    }

    textEl.textContent = "Find your riding, check the vote, then send one clear ask.";
    actionsEl.innerHTML = `<button type="button" class="btn btn-primary btn-sm" id="do-next-primary">Enter postal code</button>`;
    document.getElementById("do-next-primary").onclick = () => {
      document.getElementById("postal").focus();
      document.getElementById("postal").scrollIntoView({ behavior: "smooth", block: "center" });
    };
  }

  function openPanel(feature, layerRef) {
    const panel = document.getElementById("panel");
    const body = document.getElementById("panel-body");
    const riding = feature.properties.name;
    const mpp = mppForFeature(feature);
    selectedLayer = layerRef;
    selectedFeature = feature;
    neighbourNames = new Set(neighbours[riding] || []);

    if (!mpp) {
      activeAction = null;
      updateDoNext();
      body.innerHTML = `
        <p class="panel-kicker">${riding}</p>
        <h2>Vacant / unmatched</h2>
        <p class="meta">This riding is in the boundary file but not in the current MPP list.</p>
        <div class="panel-actions"><a class="btn btn-ghost" href="${TRACKER}">Open tracker</a></div>`;
      panel.classList.add("is-open");
      redraw(false);
      return;
    }

    const vote = getVote(mpp, selectedBill);
    const vKey = voteKey(vote);
    const total = expenseTotal(mpp);
    const power = powerFlags(mpp);
    const rebel = isRebel(mpp, selectedBill);
    const el = electionFor(riding);
    const align = alignmentScore(mpp);
    const ns = noshowRate(mpp);
    const local = localOppositionNote(riding, selectedBill);
    const party = PARTY_SHORT[mpp.party] || mpp.party || "—";
    const blurb = meta?.billBlurbs?.[selectedBill] || "";
    const raise = mpp.raisePct ?? mpp.sunshine?.raisePct;
    const soft = el && typeof el.marginPct === "number" && el.marginPct <= 10;
    const href = mailHref(mpp, vKey);

    activeAction = { mpp, riding, vKey };
    updateDoNext();

    const badges = [];
    if (power.label) badges.push(`<span class="badge power">${power.label}</span>`);
    if (rebel) badges.push(`<span class="badge rebel">Caucus rebel</span>`);
    if (soft) badges.push(`<span class="badge soft">Soft seat · ${pct(el.marginPct)}</span>`);
    if (local) badges.push(`<span class="badge local">Local opposition</span>`);

    const trackerBill = selectedBill
      ? `${TRACKER}&bill=${encodeURIComponent(selectedBill)}&vote=${vKey === "none" || vKey === "na" ? "yes" : vKey}`
      : TRACKER;

    const ask =
      vKey === "yes"
        ? `Ask why they voted Yes on ${selectedBill || "this bill"} and what they’ll do next.`
        : vKey === "no"
          ? `Thank them for voting No on ${selectedBill || "this bill"} — and ask them to keep fighting.`
          : `Ask where they stand on ${selectedBill || "this bill"} and demand a clear Yes/No answer.`;

    body.innerHTML = `
      <p class="panel-kicker">${riding}</p>
      <h2>${mpp.name}</h2>
      <p class="meta">${party} · ${mpp.riding}</p>
      ${badges.length ? `<div class="badge-row">${badges.join("")}</div>` : ""}
      <div class="action-box">
        <h3>Your move</h3>
        <p>${ask}</p>
        <div class="panel-actions" style="margin-top:0">
          ${href ? `<a class="btn btn-primary" href="${href}">Email this ask</a>` : ""}
          ${mpp.phone ? `<a class="btn btn-ghost" href="tel:${String(mpp.phone).replace(/[^\d+]/g, "")}">Call</a>` : ""}
        </div>
      </div>
      <div class="stat"><span>${selectedBill || "Vote"}</span><span class="${vKey}">${voteLabel(vKey)}</span></div>
      <div class="stat"><span>Gov-line Yes rate</span><span>${align == null ? "—" : Math.round(align * 100) + "%"}</span></div>
      <div class="stat"><span>No-show rate</span><span>${ns == null ? "—" : Math.round(ns * 100) + "%"}</span></div>
      <div class="stat"><span>Expenses</span><span>${money(total)}</span></div>
      <div class="stat"><span>Salary (Sunshine)</span><span>${money(mpp.salary)}${raise != null ? ` · ${raise > 0 ? "+" : ""}${Number(raise).toFixed(1)}%` : ""}</span></div>
      <div class="stat"><span>2025 margin</span><span>${el ? `${pct(el.marginPct)} · ${el.winnerParty} over ${el.secondParty || "—"}` : "—"}</span></div>
      <div class="stat"><span>2025 turnout</span><span>${el ? pct(el.turnoutPct) : "—"}</span></div>
      ${power.label ? `<div class="stat"><span>Role</span><span>${power.label}</span></div>` : ""}
      ${local ? `<p class="blurb"><strong>${local.label}.</strong> ${local.note}</p>` : ""}
      ${blurb ? `<p class="blurb">${blurb}</p>` : ""}
      <div class="panel-actions">
        <a class="btn btn-ghost" href="${trackerBill}">See in tracker</a>
        <button type="button" class="btn btn-ghost" id="btn-share">Share card</button>
      </div>`;

    panel.classList.add("is-open");
    document.getElementById("btn-share")?.addEventListener("click", () => drawShareCard(feature));
    redraw(false);
  }

  function closePanel() {
    document.getElementById("panel").classList.remove("is-open");
    selectedLayer = null;
    selectedFeature = null;
    neighbourNames = new Set();
    activeAction = null;
    updateDoNext();
    redraw(false);
  }

  function onEachFeature(feature, lyr) {
    lyr.on({
      mouseover(e) {
        const t = e.target;
        const base = featureStyle(feature);
        t.setStyle({
          ...base,
          weight: Math.max(base.weight || 1, 6),
          color: "#ffffff",
          fillOpacity: 0.98,
        });
        if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) t.bringToFront();
      },
      mouseout(e) {
        layer.resetStyle(e.target);
      },
      click(e) {
        openPanel(feature, e.target);
      },
    });
  }

  function updateBillControlVisibility() {
    const needsBill = mode === "vote" || mode === "vote-money";
    document.getElementById("bill-control").hidden = !needsBill;
  }

  function fillBills() {
    const sel = document.getElementById("bill-select");
    const priority = ["Bill 110", "Bill 97", "Bill 5", "Bill 60"];
    const bills = (featuredBills.length ? featuredBills.slice() : Object.keys(meta?.billBlurbs || {}));
    bills.sort((a, b) => {
      const ia = priority.indexOf(a);
      const ib = priority.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    sel.innerHTML = bills
      .map((b) => {
        const t = meta?.billBlurbs?.[b] ? ` — ${meta.billBlurbs[b].slice(0, 42)}…` : "";
        return `<option value="${b}">${b}${t}</option>`;
      })
      .join("");
    selectedBill = bills[0] || null;
    if (selectedBill) sel.value = selectedBill;
  }

  function fillStories() {
    const sel = document.getElementById("story-select");
    const stories = meta?.stories || [];
    sel.innerHTML =
      `<option value="">Custom view</option>` +
      stories.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  }

  function applyStory(id) {
    const story = (meta?.stories || []).find((s) => s.id === id);
    const caption = document.getElementById("story-caption");
    if (!story) {
      caption.hidden = true;
      return;
    }
    mode = story.mode || "vote";
    document.getElementById("mode-select").value = mode;
    if (story.bill) {
      selectedBill = story.bill;
      document.getElementById("bill-select").value = story.bill;
    }
    highlightCabinet = !!story.highlightCabinet;
    highlightRebels = !!story.highlightRebels;
    highlightOpposition = !!story.highlightOpposition;
    document.getElementById("tog-cabinet").checked = highlightCabinet;
    document.getElementById("tog-rebels").checked = highlightRebels;
    document.getElementById("tog-opposition").checked = highlightOpposition;

    if (story.filterMarginMax != null || story.filterVote) {
      document.getElementById("f-margin").value = story.filterMarginMax ?? "";
      document.getElementById("f-vote").value = story.filterVote || "";
      applyFilters();
    } else {
      filterMask = null;
      document.getElementById("f-count").textContent = "";
    }

    caption.textContent = story.caption || "";
    caption.hidden = !story.caption;
    redraw(false);
  }

  function matchingTargets() {
    const party = document.getElementById("f-party").value;
    const vote = document.getElementById("f-vote").value;
    const marginMax = document.getElementById("f-margin").value;
    const cabinetOnly = document.getElementById("f-cabinet").checked;
    const rebelsOnly = document.getElementById("f-rebel").checked;
    const marginNum = marginMax === "" ? null : Number(marginMax);

    const rows = [];
    for (const f of ridingsGeo.features) {
      const riding = f.properties.name;
      const mpp = mppForFeature(f);
      if (!mpp) continue;
      if (party && mpp.party !== party) continue;
      if (cabinetOnly && !powerFlags(mpp).any) continue;
      if (rebelsOnly && !isRebel(mpp, selectedBill)) continue;
      const vk = voteKey(getVote(mpp, selectedBill));
      if (vote && vk !== vote) continue;
      const el = electionFor(riding);
      if (marginNum != null && !(el && typeof el.marginPct === "number" && el.marginPct <= marginNum)) continue;
      rows.push({ feature: f, mpp, riding, vk, el });
    }
    return rows;
  }

  function applyFilters() {
    const rows = matchingTargets();
    filterMask = new Set(rows.map((r) => r.riding));
    document.getElementById("f-count").textContent = `${rows.length} target${rows.length === 1 ? "" : "s"}`;
    document.getElementById("organizer").querySelector("details").open = true;
    redraw(false);
  }

  function downloadCsv() {
    const rows = matchingTargets();
    const header = [
      "riding",
      "mpp",
      "party",
      "bill",
      "vote",
      "expenses",
      "salary",
      "raisePct",
      "marginPct2025",
      "turnoutPct2025",
      "powerRole",
      "rebel",
      "email",
      "phone",
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      const power = powerFlags(r.mpp);
      const vals = [
        r.riding,
        r.mpp.name,
        r.mpp.party,
        selectedBill || "",
        r.vk,
        expenseTotal(r.mpp) ?? "",
        r.mpp.salary ?? "",
        r.mpp.raisePct ?? r.mpp.sunshine?.raisePct ?? "",
        r.el?.marginPct ?? "",
        r.el?.turnoutPct ?? "",
        power.label || "",
        isRebel(r.mpp, selectedBill) ? "yes" : "no",
        r.mpp.email || "",
        r.mpp.phone || "",
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
      lines.push(vals.join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `oac-targets-${selectedBill || "map"}-${rows.length}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function setInset(id) {
    document.querySelectorAll(".zoom-chips .chip").forEach((b) => {
      b.classList.toggle("active", b.dataset.inset === id);
    });
    const inset = meta?.insets?.[id];
    if (!inset) return;
    map.setView(inset.center, inset.zoom, { animate: true });
  }

  async function lookupPostal(ev) {
    ev.preventDefault();
    const raw = document.getElementById("postal").value;
    const res = await window.MppShared.lookupMppByPostal(raw, mpps);
    if (!res.ok) {
      alert(res.error || "Lookup failed");
      return;
    }
    const riding = res.riding || res.mpp?.riding;
    if (!riding) return;
    let found = null;
    let foundLayer = null;
    layer.eachLayer((lyr) => {
      if (ridingKey(lyr.feature.properties.name) === ridingKey(riding)) {
        found = lyr.feature;
        foundLayer = lyr;
      }
    });
    if (found) {
      neighbourNames = new Set(neighbours[found.properties.name] || []);
      map.fitBounds(foundLayer.getBounds(), { padding: [40, 40], maxZoom: 10 });
      openPanel(found, foundLayer);
    } else if (res.mpp) {
      // fallback panel without geometry match
      selectedFeature = { properties: { name: riding } };
      openPanel(selectedFeature, null);
    }
  }

  function drawShareCard(feature) {
    const mpp = mppForFeature(feature);
    const riding = feature.properties.name;
    if (!mpp) return;
    const canvas = document.getElementById("share-canvas");
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    const vKey = voteKey(getVote(mpp, selectedBill));
    const el = electionFor(riding);
    const total = expenseTotal(mpp);

    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#ffc745";
    ctx.fillRect(0, 0, W, 18);

    ctx.fillStyle = "#ffc745";
    ctx.font = "700 36px Fira Sans, sans-serif";
    ctx.fillText("OAC POWER MAP", 64, 100);

    ctx.fillStyle = "#ffffff";
    ctx.font = "700 64px Archivo Black, Fira Sans, sans-serif";
    wrapText(ctx, riding, 64, 190, W - 128, 70);

    ctx.fillStyle = "#b5b5b5";
    ctx.font = "500 36px Fira Sans, sans-serif";
    ctx.fillText(`${mpp.name} · ${PARTY_SHORT[mpp.party] || mpp.party}`, 64, 360);

    ctx.fillStyle = VOTE_COLORS[vKey] || "#fff";
    ctx.font = "700 72px Archivo Black, sans-serif";
    ctx.fillText(`${selectedBill || "Vote"}: ${voteLabel(vKey).toUpperCase()}`, 64, 480);

    ctx.fillStyle = "#ffffff";
    ctx.font = "500 34px Fira Sans, sans-serif";
    ctx.fillText(`Expenses ${money(total)}`, 64, 580);
    ctx.fillText(`2025 margin ${el ? pct(el.marginPct) : "—"}`, 64, 640);
    const align = alignmentScore(mpp);
    ctx.fillText(`Gov-line Yes rate ${align == null ? "—" : Math.round(align * 100) + "%"}`, 64, 700);

    const blurb = meta?.billBlurbs?.[selectedBill] || "Hold your MPP to account.";
    ctx.fillStyle = "#b5b5b5";
    ctx.font = "400 30px Fira Sans, sans-serif";
    wrapText(ctx, blurb, 64, 800, W - 128, 40);

    ctx.fillStyle = "#ffc745";
    ctx.font = "700 28px Fira Sans, sans-serif";
    ctx.fillText("onac.ca · Find your MPP. Apply pressure.", 64, H - 80);

    document.getElementById("share-modal").hidden = false;
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = String(text).split(/\s+/);
    let line = "";
    let yy = y;
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, yy);
        line = w;
        yy += lineHeight;
      } else line = test;
    }
    if (line) ctx.fillText(line, x, yy);
  }

  // events
  document.getElementById("mode-select").onchange = (e) => {
    mode = e.target.value;
    document.getElementById("story-select").value = "";
    document.getElementById("story-caption").hidden = true;
    redraw(false);
  };
  document.getElementById("bill-select").onchange = (e) => {
    selectedBill = e.target.value;
    if (selectedFeature) {
      openPanel(selectedFeature, selectedLayer);
    } else {
      redraw(false);
    }
  };
  document.getElementById("story-select").onchange = (e) => applyStory(e.target.value);
  document.getElementById("tog-cabinet").onchange = (e) => {
    highlightCabinet = e.target.checked;
    redraw(false);
  };
  document.getElementById("tog-rebels").onchange = (e) => {
    highlightRebels = e.target.checked;
    redraw(false);
  };
  document.getElementById("tog-opposition").onchange = (e) => {
    highlightOpposition = e.target.checked;
    redraw(false);
  };
  document.getElementById("panel-close").onclick = closePanel;
  document.getElementById("f-apply").onclick = applyFilters;
  document.getElementById("f-clear").onclick = () => {
    filterMask = null;
    document.getElementById("f-party").value = "";
    document.getElementById("f-vote").value = "";
    document.getElementById("f-margin").value = "";
    document.getElementById("f-cabinet").checked = false;
    document.getElementById("f-rebel").checked = false;
    document.getElementById("f-count").textContent = "";
    redraw(false);
  };
  document.getElementById("f-csv").onclick = downloadCsv;
  document.getElementById("postal-form").onsubmit = lookupPostal;
  document.querySelectorAll(".zoom-chips .chip").forEach((btn) => {
    btn.onclick = () => setInset(btn.dataset.inset);
  });
  document.getElementById("share-close").onclick = () => {
    document.getElementById("share-modal").hidden = true;
  };
  document.getElementById("share-download").onclick = () => {
    const canvas = document.getElementById("share-canvas");
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = "oac-riding-card.png";
    a.click();
  };
  document.getElementById("share-copy").onclick = async () => {
    const url = location.href.split("#")[0];
    try {
      await navigator.clipboard.writeText(url);
      alert("Map link copied");
    } catch (_) {
      prompt("Copy this link", url);
    }
  };

  Promise.all([
    fetch("data/mpps.json").then((r) => r.json()),
    fetch("data/ontario-ridings.geojson").then((r) => r.json()),
    fetch("data/election-results.json").then((r) => r.json()),
    fetch("data/riding-neighbours.json").then((r) => r.json()),
    fetch("data/campaign-signals.json").then((r) => r.json()),
    fetch("data/map-meta.json").then((r) => r.json()),
  ])
    .then(([mppData, geo, elec, neigh, sig, mapMeta]) => {
      meta = mapMeta;
      mpps = mppData.mpps || [];
      featuredBills = mppData.featuredBills || [];
      ridingsGeo = geo;
      elections = elec;
      neighbours = neigh;
      signals = sig;

      indexMpps(mpps);
      buildPartyModes();

      const totals = mpps.map(expenseTotal).filter((n) => typeof n === "number").sort((a, b) => a - b);
      expenseExtent = totals.length
        ? { min: totals[0], max: totals[totals.length - 1] }
        : { min: 0, max: 1 };
      expenseP75 = totals.length ? totals[Math.floor(totals.length * 0.75)] : 0;

      fillStories();
      fillBills();
      redraw(true);
    })
    .catch((err) => {
      console.error(err);
      document.getElementById("panel-body").innerHTML =
        `<p class="empty-hint">Couldn’t load map data.</p>`;
      document.getElementById("panel").classList.add("is-open");
    });
})();
