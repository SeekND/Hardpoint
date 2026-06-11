/* Salvage Finder — given a salvage mission's component requirements, find the
 * ships that carry those components by default, ranked so you hunt the fewest
 * targets. Uses ships.json (components[] + cargo + accessibility/salvage flags).
 *
 * Mission wording maps to our data:
 *   "Power Plant, Competition Grade (S2)"  →  type=Power Plant, class=Cmp, size=2
 */

const SHIP_KEY = "sc-loadout-ship-config-v1";

const CLASS_LABELS = {
  "":    "Any class",
  Cmp:   "Competition",
  Mil:   "Military",
  Civ:   "Civilian",
  Ind:   "Industrial",
  Sth:   "Stealth",
};
const COMP_TYPES = ["Power Plant", "Cooler", "Shield Generator", "Quantum Drive"];

let SHIPS = [], SHIP_CFG = {};
let SIZES = [1, 2, 3];                 // refined from data on load
let REQUIREMENTS = [{ type: "Power Plant", cls: "", size: "" }];

const $ = sel => document.querySelector(sel);

async function load() {
  SHIPS = await fetch("ships.json?v=" + Date.now()).then(r => r.json());
  try { SHIP_CFG = JSON.parse(localStorage.getItem(SHIP_KEY)) || {}; } catch (_) { SHIP_CFG = {}; }

  // Refine the size dropdown to the component sizes actually present.
  const sizeSet = new Set();
  for (const s of SHIPS) for (const c of s.components || []) if (c.size) sizeSet.add(c.size);
  SIZES = [...sizeSet].sort((a, b) => a - b);

  attach();
  render();
  $("#status").textContent = `${SHIPS.length} ships · ${SHIPS.reduce((n, s) => n + (s.components || []).length, 0)} component entries`;
}

// --- effective ship flags (localStorage override wins, else baked-in) ---
function shipAccessible(s) {
  const local = SHIP_CFG[s.name]?.components_accessible;
  if (local !== undefined) return local || "";
  return s.components_accessible || "";
}
function shipSalvage(s) {
  const local = SHIP_CFG[s.name]?.salvage;
  if (local !== undefined) return !!local;
  return !!s.salvage;
}
function shipDisabled(s) {
  const local = SHIP_CFG[s.name]?.state;
  if (local) return local === "disabled";
  return !!s.disabled;
}

// --- matching ---
/** Total count of components on `ship` matching requirement `req`. */
function matchCount(ship, req) {
  let n = 0;
  for (const c of ship.components || []) {
    if (c.type !== req.type) continue;
    if (req.cls && c.class !== req.cls) continue;
    if (req.size !== "" && c.size !== +req.size) continue;
    n += c.count || 1;
  }
  return n;
}

function activeReqs() {
  return REQUIREMENTS.filter(r => r.type);
}

function salvageOnly() {
  return !!document.getElementById("salvage-only")?.checked;
}

function computeResults() {
  const reqs = activeReqs();
  const onlySalvage = salvageOnly();
  const rows = [];
  for (const s of SHIPS) {
    if (shipDisabled(s)) continue;
    if (onlySalvage && !shipSalvage(s)) continue;
    const per = reqs.map(r => matchCount(s, r));
    const covered = per.filter(n => n > 0).length;
    if (covered > 0) rows.push({ ship: s, per, covered });
  }
  // Most objectives covered first; then accessible ships; then salvage-tagged; then name.
  const accRank = s => (shipAccessible(s) === "yes" ? 0 : shipAccessible(s) === "no" ? 2 : 1);
  rows.sort((a, b) =>
    b.covered - a.covered ||
    accRank(a.ship) - accRank(b.ship) ||
    (shipSalvage(b.ship) - shipSalvage(a.ship)) ||
    a.ship.name.localeCompare(b.ship.name)
  );
  return { reqs, rows };
}

// --- render ---
function classOpts(sel) {
  return Object.entries(CLASS_LABELS)
    .map(([code, label]) => `<option value="${code}" ${code === sel ? "selected" : ""}>${label}</option>`)
    .join("");
}
function sizeOpts(sel) {
  return [`<option value="" ${sel === "" ? "selected" : ""}>Any size</option>`]
    .concat(SIZES.map(n => `<option value="${n}" ${String(sel) === String(n) ? "selected" : ""}>S${n}</option>`))
    .join("");
}
function typeOpts(sel) {
  return COMP_TYPES.map(t => `<option value="${t}" ${t === sel ? "selected" : ""}>${t}</option>`).join("");
}

function renderReqRows() {
  $("#req-rows").innerHTML = REQUIREMENTS.map((r, i) => `
    <div class="req-row" data-idx="${i}">
      <select class="req-type">${typeOpts(r.type)}</select>
      <select class="req-class">${classOpts(r.cls)}</select>
      <select class="req-size">${sizeOpts(r.size)}</select>
      <button class="btn req-del" title="Remove">&times;</button>
    </div>`).join("");

  for (const row of document.querySelectorAll(".req-row")) {
    const idx = +row.dataset.idx;
    row.querySelector(".req-type").addEventListener("change", e => { REQUIREMENTS[idx].type = e.target.value; render(); });
    row.querySelector(".req-class").addEventListener("change", e => { REQUIREMENTS[idx].cls = e.target.value; render(); });
    row.querySelector(".req-size").addEventListener("change", e => { REQUIREMENTS[idx].size = e.target.value; render(); });
    row.querySelector(".req-del").addEventListener("click", () => { REQUIREMENTS.splice(idx, 1); render(); });
  }
}

function accBadge(s) {
  const a = shipAccessible(s);
  if (a === "yes") return `<span class="tag good">removable</span>`;
  if (a === "no")  return `<span class="tag bad">sealed</span>`;
  return `<span class="tag">access unverified</span>`;
}

function reqLabel(r) {
  const cls = r.cls ? CLASS_LABELS[r.cls] : "Any";
  const size = r.size === "" ? "" : ` S${r.size}`;
  return `${r.type} · ${cls}${size}`;
}

function renderResults() {
  const { reqs, rows } = computeResults();
  if (!reqs.length) {
    $("#results").innerHTML = `<div class="empty-list">add an objective above to see matching ships</div>`;
    $("#results-summary").textContent = "";
    $("#breakdown").innerHTML = "";
    return;
  }

  const full = rows.filter(r => r.covered === reqs.length).length;
  $("#results-summary").textContent =
    reqs.length > 1
      ? `${rows.length} ships carry ≥1 of your ${reqs.length} objectives · ${full} carry all ${reqs.length}`
      : `${rows.length} ships carry this component`;

  if (!rows.length) {
    $("#results").innerHTML = `<div class="empty-list">no ship carries a matching component by default</div>`;
  } else {
    const tableRows = rows.slice(0, 60).map(({ ship, per, covered }) => {
      const cells = per.map((n, i) =>
        n > 0
          ? `<td class="num cover-yes" title="${reqLabel(reqs[i])}">${n}×</td>`
          : `<td class="num cover-no">—</td>`
      ).join("");
      const cargo = (ship.cargo_scu || 0) > 0 ? `${ship.cargo_scu} SCU` : "—";
      return `<tr>
        <td class="num">${covered}/${reqs.length}</td>
        <td class="ship-cell">${ship.name}${shipSalvage(ship) ? ' <span class="tag warn">salvage</span>' : ""}<span class="mfg">${ship.manufacturer || ""}</span></td>
        ${cells}
        <td>${accBadge(ship)}</td>
        <td class="num">${cargo}</td>
      </tr>`;
    }).join("");

    const headCells = reqs.map((r, i) => `<th class="num" title="${reqLabel(r)}">obj ${i + 1}</th>`).join("");
    $("#results").innerHTML = `
      <table class="loadout salvage-table">
        <thead><tr>
          <th class="num">covers</th><th>Ship</th>${headCells}<th>Components</th><th class="num">Cargo</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
      ${rows.length > 60 ? `<div class="muted" style="padding:6px 12px">showing first 60 of ${rows.length}</div>` : ""}
      <div class="obj-legend">${reqs.map((r, i) => `<span class="muted">obj ${i + 1} = ${reqLabel(r)}</span>`).join(" &nbsp;·&nbsp; ")}</div>
    `;
  }

  // Per-objective breakdown (honours the salvage-tagged filter too)
  const onlySalvage = salvageOnly();
  $("#breakdown").innerHTML = reqs.map((r, i) => {
    const hits = SHIPS
      .filter(s => !shipDisabled(s) && (!onlySalvage || shipSalvage(s)))
      .map(s => ({ s, n: matchCount(s, r) }))
      .filter(x => x.n > 0)
      .sort((a, b) => a.s.name.localeCompare(b.s.name));
    const chips = hits.map(({ s, n }) =>
      `<span class="chip ${shipAccessible(s) === "yes" ? "good" : ""}" title="${s.name}">
        ${n > 1 ? `${n}× ` : ""}${s.name}
      </span>`).join("");
    return `<div class="obj-block">
      <div class="obj-title">obj ${i + 1} — ${reqLabel(r)} <span class="count">${hits.length} ship${hits.length === 1 ? "" : "s"}</span></div>
      ${hits.length ? `<div class="list">${chips}</div>` : `<div class="empty-list">no ship carries this by default</div>`}
    </div>`;
  }).join("");
}

function render() {
  renderReqRows();
  renderResults();
}

function attach() {
  $("#add-req").addEventListener("click", () => {
    REQUIREMENTS.push({ type: "Power Plant", cls: "", size: "" });
    render();
  });
  $("#clear-req").addEventListener("click", () => {
    REQUIREMENTS = [{ type: "Power Plant", cls: "", size: "" }];
    render();
  });
  $("#salvage-only").addEventListener("change", render);
}

load().catch(err => {
  console.error(err);
  $("#status").innerHTML = `<span style="color:var(--bad)">load error: ${err.message}</span>`;
});
