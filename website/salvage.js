/* Salvage Finder — given the items you want, find the ships that carry them by
 * default. Two kinds of item:
 *
 *   Component → matched against ship.components[]   (type · class · grade · size)
 *   Weapon    → matched against ship.hardpoints[].default_weapon_name
 *
 * Results show the ACTUAL item each ship carries (name, class, grade, size),
 * not just a count — so you know exactly what you'd pull off the wreck.
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
const DMG_LABELS = { "": "Any type", ballistic: "Ballistic", energy: "Energy" };

let SHIPS = [], SHIP_CFG = {};
let SIZES = [1, 2, 3];
let GRADES = ["A", "B", "C", "D"];
let WEAPON_NAMES = [];                  // weapons that appear as a default on some ship
let WEAPON_SIZES = [1, 2, 3, 4];
let WEAPON_META = {};                   // name -> { size, type, dmg }

let REQUIREMENTS = [];                  // starts empty — user adds rows

const $ = sel => document.querySelector(sel);

async function load() {
  const cb = "?v=" + Date.now();
  const [ships, weapons] = await Promise.all([
    fetch("ships.json" + cb).then(r => r.json()),
    fetch("weapons.json" + cb).then(r => r.json()),
  ]);
  SHIPS = ships;
  try { SHIP_CFG = JSON.parse(localStorage.getItem(SHIP_KEY)) || {}; } catch (_) { SHIP_CFG = {}; }

  // Weapon metadata for filtering the picker (size + damage type).
  for (const w of weapons) {
    WEAPON_META[w.name] = { size: w.size, type: w.type, dmg: classifyDmg(w) };
  }

  // Refine dropdowns from the data actually present.
  const sizeSet = new Set(), gradeSet = new Set(), wNames = new Set(), wSizes = new Set();
  for (const s of SHIPS) {
    for (const c of s.components || []) {
      if (c.size) sizeSet.add(c.size);
      if (c.grade) gradeSet.add(c.grade);
    }
    for (const h of s.hardpoints || []) {
      if (h.default_weapon_name) {
        wNames.add(h.default_weapon_name);
        const sz = WEAPON_META[h.default_weapon_name]?.size ?? h.size;
        if (sz) wSizes.add(sz);
      }
    }
  }
  if (sizeSet.size)  SIZES = [...sizeSet].sort((a, b) => a - b);
  if (gradeSet.size) GRADES = [...gradeSet].sort();
  WEAPON_NAMES = [...wNames].sort();
  WEAPON_SIZES = [...wSizes].sort((a, b) => a - b);

  attach();
  render();
  $("#status").textContent =
    `${SHIPS.length} ships · ${SHIPS.reduce((n, s) => n + (s.components || []).length, 0)} components · ${WEAPON_NAMES.length} default weapons`;
}

function classifyDmg(w) {
  if ((w.alpha_physical || 0) > 0) return "ballistic";
  if ((w.alpha_energy || 0) > 0)   return "energy";
  if ((w.alpha_distortion || 0) > 0) return "distortion";
  if (/Ballistic|MassDriver|Gatling/i.test(w.type || "")) return "ballistic";
  if (/Laser|Beam/i.test(w.type || "")) return "energy";
  return "";
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
/** Returns { count, lines } where lines describe the actual matched items
 *  on the ship (e.g. "2× PowerBolt Mil/A S1 Power Plant"). */
function matchInfo(ship, req) {
  const groups = new Map();   // descriptor -> count
  let count = 0;

  if (req.kind === "weapon") {
    if (!req.weapon) return { count: 0, lines: [] };
    for (const h of ship.hardpoints || []) {
      if (h.default_weapon_name !== req.weapon) continue;
      count += 1;
      const sz = WEAPON_META[req.weapon]?.size;
      const desc = sz ? `${req.weapon} (S${sz})` : req.weapon;
      groups.set(desc, (groups.get(desc) || 0) + 1);
    }
  } else {
    for (const c of ship.components || []) {
      if (c.type !== req.type) continue;
      if (req.cls && c.class !== req.cls) continue;
      if (req.grade && c.grade !== req.grade) continue;
      if (req.size !== "" && c.size !== +req.size) continue;
      const k = c.count || 1;
      count += k;
      groups.set(c.full, (groups.get(c.full) || 0) + k);
    }
  }
  const lines = [...groups.entries()].map(([desc, n]) => (n > 1 ? `${n}× ${desc}` : desc));
  return { count, lines };
}

function activeReqs() {
  return REQUIREMENTS.filter(r => (r.kind === "weapon" ? r.weapon : r.type));
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
    const per = reqs.map(r => matchInfo(s, r));
    const covered = per.filter(m => m.count > 0).length;
    if (covered > 0) rows.push({ ship: s, per, covered });
  }
  const accRank = s => (shipAccessible(s) === "yes" ? 0 : shipAccessible(s) === "no" ? 2 : 1);
  rows.sort((a, b) =>
    b.covered - a.covered ||
    accRank(a.ship) - accRank(b.ship) ||
    (shipSalvage(b.ship) - shipSalvage(a.ship)) ||
    a.ship.name.localeCompare(b.ship.name)
  );
  return { reqs, rows };
}

// --- render helpers ---
const opt = (v, sel, label) => `<option value="${v}" ${String(v) === String(sel) ? "selected" : ""}>${label}</option>`;
function typeOpts(sel)  { return COMP_TYPES.map(t => opt(t, sel, t)).join(""); }
function classOpts(sel) { return Object.entries(CLASS_LABELS).map(([c, l]) => opt(c, sel, l)).join(""); }
function gradeOpts(sel) { return [opt("", sel, "Any grade")].concat(GRADES.map(g => opt(g, sel, `Grade ${g}`))).join(""); }
function dmgOpts(sel)   { return Object.entries(DMG_LABELS).map(([c, l]) => opt(c, sel, l)).join(""); }
function sizeOpts(sel, sizes)  { return [opt("", sel, "Any size")].concat(sizes.map(n => opt(n, sel, `S${n}`))).join(""); }

/** Weapons matching a row's damage-type + size filter (narrows the picker). */
function weaponOptionsFor(dmg, size) {
  return WEAPON_NAMES.filter(n => {
    const m = WEAPON_META[n];
    if (!m) return !dmg && size === "";
    if (dmg && m.dmg !== dmg) return false;
    if (size !== "" && m.size !== +size) return false;
    return true;
  });
}

function renderReqRows() {
  if (!REQUIREMENTS.length) {
    $("#req-rows").innerHTML = `<div class="empty-list">no items yet — click “Add component” or “Add weapon”.</div>`;
    return;
  }
  $("#req-rows").innerHTML = REQUIREMENTS.map((r, i) => {
    if (r.kind === "weapon") {
      const wopts = weaponOptionsFor(r.dmg, r.size);
      const dl = `<datalist id="wdl-${i}">${wopts.map(n => `<option value="${n.replace(/"/g, "&quot;")}"></option>`).join("")}</datalist>`;
      return `<div class="req-row weapon-row" data-idx="${i}">
        <span class="req-kind">Weapon</span>
        <select class="req-dmg" title="Filter the weapon list by damage type">${dmgOpts(r.dmg)}</select>
        <select class="req-size" title="Filter the weapon list by size">${sizeOpts(r.size, WEAPON_SIZES)}</select>
        <input type="text" list="wdl-${i}" class="req-weapon" value="${(r.weapon || "").replace(/"/g, "&quot;")}" placeholder="weapon name (${wopts.length} match)…" autocomplete="off" />
        ${dl}
        <button class="btn req-del" title="Remove">&times;</button>
      </div>`;
    }
    return `<div class="req-row component-row" data-idx="${i}">
      <span class="req-kind">Component</span>
      <select class="req-type">${typeOpts(r.type)}</select>
      <select class="req-class">${classOpts(r.cls)}</select>
      <select class="req-grade">${gradeOpts(r.grade)}</select>
      <select class="req-size">${sizeOpts(r.size, SIZES)}</select>
      <button class="btn req-del" title="Remove">&times;</button>
    </div>`;
  }).join("");

  for (const row of document.querySelectorAll(".req-row")) {
    const idx = +row.dataset.idx;
    const r = REQUIREMENTS[idx];
    row.querySelector(".req-del").addEventListener("click", () => { REQUIREMENTS.splice(idx, 1); render(); });
    if (r.kind === "weapon") {
      // dmg/size re-render to refilter the weapon list; weapon input re-renders results
      row.querySelector(".req-dmg").addEventListener("change",  e => { REQUIREMENTS[idx].dmg = e.target.value; render(); });
      row.querySelector(".req-size").addEventListener("change", e => { REQUIREMENTS[idx].size = e.target.value; render(); });
      row.querySelector(".req-weapon").addEventListener("input", e => { REQUIREMENTS[idx].weapon = e.target.value; renderResults(); });
    } else {
      row.querySelector(".req-type").addEventListener("change",  e => { REQUIREMENTS[idx].type = e.target.value; render(); });
      row.querySelector(".req-class").addEventListener("change", e => { REQUIREMENTS[idx].cls = e.target.value; render(); });
      row.querySelector(".req-grade").addEventListener("change", e => { REQUIREMENTS[idx].grade = e.target.value; render(); });
      row.querySelector(".req-size").addEventListener("change",  e => { REQUIREMENTS[idx].size = e.target.value; render(); });
    }
  }
}

function accBadge(s) {
  const a = shipAccessible(s);
  if (a === "yes") return `<span class="tag good">removable</span>`;
  if (a === "no")  return `<span class="tag bad">sealed</span>`;
  return `<span class="tag">access unverified</span>`;
}

function reqLabel(r) {
  if (r.kind === "weapon") {
    const parts = [r.weapon || "(any weapon)"];
    if (r.size !== "") parts.push(`S${r.size}`);
    return parts.join(" · ");
  }
  const parts = [r.type];
  if (r.cls)         parts.push(CLASS_LABELS[r.cls]);
  if (r.grade)       parts.push(`Grade ${r.grade}`);
  if (r.size !== "") parts.push(`S${r.size}`);
  return parts.join(" · ");
}

function renderResults() {
  const { reqs, rows } = computeResults();
  if (!reqs.length) {
    $("#results").innerHTML = `<div class="empty-list">add a component or weapon above to see matching ships</div>`;
    $("#results-summary").textContent = "";
    $("#breakdown").innerHTML = "";
    return;
  }

  const full = rows.filter(r => r.covered === reqs.length).length;
  $("#results-summary").textContent =
    reqs.length > 1
      ? `${rows.length} ships carry ≥1 of your ${reqs.length} items · ${full} carry all ${reqs.length}`
      : `${rows.length} ships carry this`;

  // --- coverage overview table (compact) ---
  if (!rows.length) {
    $("#results").innerHTML = `<div class="empty-list">no ship carries a match by default</div>`;
  } else {
    const tableRows = rows.slice(0, 60).map(({ ship, per, covered }) => {
      const cells = per.map((m, i) =>
        m.count > 0
          ? `<td class="num cover-yes" title="${m.lines.join(", ")}">${m.count}×</td>`
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
    const headCells = reqs.map((r, i) => `<th class="num" title="${reqLabel(r)}">#${i + 1}</th>`).join("");
    $("#results").innerHTML = `
      <table class="loadout salvage-table">
        <thead><tr>
          <th class="num">covers</th><th>Ship</th>${headCells}<th>Access</th><th class="num">Cargo</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
      ${rows.length > 60 ? `<div class="muted" style="padding:6px 12px">showing first 60 of ${rows.length}</div>` : ""}
      <div class="obj-legend">${reqs.map((r, i) => `<span class="muted">#${i + 1} = ${reqLabel(r)}</span>`).join(" &nbsp;·&nbsp; ")}</div>
    `;
  }

  // --- per-item breakdown: a table per requirement showing the ACTUAL item on each ship ---
  const onlySalvage = salvageOnly();
  $("#breakdown").innerHTML = reqs.map((r, i) => {
    const hits = SHIPS
      .filter(s => !shipDisabled(s) && (!onlySalvage || shipSalvage(s)))
      .map(s => ({ s, m: matchInfo(s, r) }))
      .filter(x => x.m.count > 0)
      .sort((a, b) => a.s.name.localeCompare(b.s.name));

    const isWeapon = r.kind === "weapon";
    const itemHead = isWeapon ? "Weapon on ship" : "Component on ship";
    const body = hits.map(({ s, m }) => `
      <tr>
        <td class="ship-cell">${s.name}${shipSalvage(s) ? ' <span class="tag warn">salvage</span>' : ""}<span class="mfg">${s.manufacturer || ""}</span></td>
        <td class="item-cell">${m.lines.join("<br>")}</td>
        <td>${accBadge(s)}</td>
        <td class="num">${(s.cargo_scu || 0) > 0 ? `${s.cargo_scu} SCU` : "—"}</td>
      </tr>`).join("");

    return `<div class="obj-block">
      <div class="obj-title">#${i + 1} — ${reqLabel(r)} <span class="count">${hits.length} ship${hits.length === 1 ? "" : "s"}</span></div>
      ${hits.length ? `
        <table class="loadout breakdown-table">
          <thead><tr><th>Ship</th><th>${itemHead}</th><th>Access</th><th class="num">Cargo</th></tr></thead>
          <tbody>${body}</tbody>
        </table>` : `<div class="empty-list">no ship carries this by default</div>`}
    </div>`;
  }).join("");
}

function render() {
  renderReqRows();
  renderResults();
}

function attach() {
  $("#add-component").addEventListener("click", () => {
    REQUIREMENTS.push({ kind: "component", type: "Power Plant", cls: "", grade: "", size: "" });
    render();
  });
  $("#add-weapon").addEventListener("click", () => {
    REQUIREMENTS.push({ kind: "weapon", weapon: "", dmg: "", size: "" });
    render();
  });
  $("#clear-req").addEventListener("click", () => {
    REQUIREMENTS = [];
    render();
  });
  $("#salvage-only").addEventListener("change", render);
}

load().catch(err => {
  console.error(err);
  $("#status").innerHTML = `<span style="color:var(--bad)">load error: ${err.message}</span>`;
});
