/* Catalog configuration editor — Weapons + Ships tabs.
 *
 * Weapons state per weapon (keyed by weaponKey = name|Ssize|mfg):
 *   normal    — available everywhere (default; not stored)
 *   forced    — only available when the named ship is selected
 *   disabled  — never available
 *
 * Ship state per ship (keyed by ship.name):
 *   normal    — visible in ship picker (default; not stored)
 *   disabled  — hidden from the main page's ship dropdown
 *
 * Both states persist to localStorage; main app.js reads the same keys.
 */

const WEAPON_KEY = "sc-loadout-weapon-config-v2";
const SHIP_KEY   = "sc-loadout-ship-config-v1";

function weaponKey(w) {
  return `${w.name}|S${w.size}|${w.manufacturer || ""}`;
}

let WEAPONS = [], SHIPS = [];
let WEAPON_CFG = {}, SHIP_CFG = {};
let CURRENT_TAB = "weapons";

// Inline-edit state: which ship name has its hardpoints editor open?
let EDITING_SHIP = null;
// Local working buffer for the open editor (groups before save).
let EDIT_BUFFER  = null;

const HP_TYPES = ["gun", "pilot_gun", "weapon", "missile", "turret"];
const HP_SIZES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Group a flat hardpoints[] array into editable groups by parent_port. */
function hardpointsToGroups(hps) {
  const map = new Map();
  for (const h of hps || []) {
    const key = `${h.parent_port || h.port}|${h.size}|${h.type}`;
    if (!map.has(key)) {
      map.set(key, {
        parent_port:    h.parent_port || h.port,
        size:           h.size,
        type:           h.type,
        count:          0,
        default_weapon: h.default_weapon_name || "",
      });
    }
    const g = map.get(key);
    g.count += 1;
    if (!g.default_weapon && h.default_weapon_name) g.default_weapon = h.default_weapon_name;
  }
  return [...map.values()];
}

const $ = sel => document.querySelector(sel);

async function load() {
  const cb = `?v=${Date.now()}`;
  [WEAPONS, SHIPS] = await Promise.all([
    fetch("weapons.json" + cb).then(r => r.json()),
    fetch("ships.json"   + cb).then(r => r.json()),
  ]);
  WEAPON_CFG = loadJSON(WEAPON_KEY);
  SHIP_CFG   = loadJSON(SHIP_KEY);
  migrateWeaponConfig();    // v2 single-ship 'ship' -> v3 'ships' array
  ensureShipDatalist();     // shared <datalist> for typeahead-filtered ship pickers
  attach();
  render();
}

/** One shared <datalist> for all weapon→ship pickers, so typing filters the list. */
function ensureShipDatalist() {
  let dl = document.getElementById("all-ships-datalist");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = "all-ships-datalist";
    document.body.appendChild(dl);
  }
  dl.innerHTML = SHIPS.map(s => `<option value="${s.name.replace(/"/g, "&quot;")}"></option>`).join("");

  // Weapon-name datalist — used by the hardpoint editor's default-weapon column.
  let wl = document.getElementById("all-weapons-datalist");
  if (!wl) {
    wl = document.createElement("datalist");
    wl.id = "all-weapons-datalist";
    document.body.appendChild(wl);
  }
  const names = [...new Set(WEAPONS.map(w => w.name))].sort();
  wl.innerHTML = names.map(n => `<option value="${n.replace(/"/g, "&quot;")}"></option>`).join("");
}

/** Migrate older { state:'forced', ship:'X' } entries to { state:'forced', ships:['X'] }. */
function migrateWeaponConfig() {
  let migrated = 0;
  for (const k of Object.keys(WEAPON_CFG)) {
    const c = WEAPON_CFG[k];
    if (c?.state === "forced" && c.ship && !c.ships) {
      c.ships = [c.ship];
      delete c.ship;
      migrated++;
    }
  }
  if (migrated) saveJSON(WEAPON_KEY, WEAPON_CFG);
}

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; }
  catch (_) { return {}; }
}
function saveJSON(key, obj) {
  localStorage.setItem(key, JSON.stringify(obj));
}

// --- weapon ops ---
function getWeaponState(key)  { return WEAPON_CFG[key]?.state || "normal"; }
function getForcedShips(key)  { return WEAPON_CFG[key]?.ships || []; }

/** Effective state for display = localStorage override if present, else
 *  whatever the JSON-baked restriction says. Returns {state, ships, source}
 *  where source is "local" | "build" | "default". */
function getEffectiveWeaponState(key, weapon) {
  const cfg = WEAPON_CFG[key];
  if (cfg?.state === "disabled") return { state: "disabled", ships: [],             source: "local" };
  if (cfg?.state === "forced")   return { state: "forced",   ships: cfg.ships || [], source: "local" };
  if (cfg?.state === "normal")   return { state: "normal",   ships: [],             source: "local" };
  // No localStorage entry — fall through to JSON-baked restrictions.
  if (weapon.disabled) return { state: "disabled", ships: [], source: "build" };
  if (Array.isArray(weapon.force_to_ships) && weapon.force_to_ships.length) {
    return { state: "forced", ships: weapon.force_to_ships, source: "build" };
  }
  return { state: "normal", ships: [], source: "default" };
}

/** If localStorage has no entry but JSON has a force_to_ships restriction,
 *  seed it into WEAPON_CFG so subsequent edits layer on top instead of
 *  clobbering the JSON list. */
function _seedFromJson(key) {
  if (WEAPON_CFG[key]) return;
  const w = WEAPONS.find(x => weaponKey(x) === key);
  if (Array.isArray(w?.force_to_ships) && w.force_to_ships.length) {
    WEAPON_CFG[key] = { state: "forced", ships: [...w.force_to_ships] };
  }
}

function setWeaponState(key, state) {
  if (state === "normal") {
    // Keep an explicit "normal" when the data files bake a restriction in —
    // that's how a local config re-enables a baked-disabled/forced weapon.
    const w = WEAPONS.find(x => weaponKey(x) === key);
    const baked = w && (w.disabled || (w.force_to_ships || []).length);
    if (baked) WEAPON_CFG[key] = { state: "normal" };
    else       delete WEAPON_CFG[key];
  } else if (state === "disabled") {
    WEAPON_CFG[key] = { state: "disabled" };
  } else if (state === "forced") {
    _seedFromJson(key);
    const prev = WEAPON_CFG[key]?.ships || [];
    WEAPON_CFG[key] = { state: "forced", ships: prev };
  }
  saveJSON(WEAPON_KEY, WEAPON_CFG);
  render();
}

function addForcedShip(key, shipName) {
  if (!shipName) return;
  _seedFromJson(key);
  const cur = WEAPON_CFG[key] || { state: "forced", ships: [] };
  cur.state = "forced";
  cur.ships = cur.ships || [];
  if (!cur.ships.includes(shipName)) cur.ships.push(shipName);
  WEAPON_CFG[key] = cur;
  saveJSON(WEAPON_KEY, WEAPON_CFG);
  render();
}

function removeForcedShip(key, shipName) {
  _seedFromJson(key);
  const cur = WEAPON_CFG[key];
  if (!cur?.ships) return;
  cur.ships = cur.ships.filter(s => s !== shipName);
  if (cur.ships.length === 0) {
    // Empty list → drop the local override, JSON-baked restriction (if any) resumes.
    delete WEAPON_CFG[key];
  } else {
    WEAPON_CFG[key] = cur;
  }
  saveJSON(WEAPON_KEY, WEAPON_CFG);
  render();
}

// --- ship ops ---
function getShipState(name) { return SHIP_CFG[name]?.state    || "normal"; }
/** Effective state — localStorage wins, else the baked-in disabled tag. */
function getEffectiveShipState(s) {
  const local = SHIP_CFG[s.name]?.state;
  if (local) return { state: local, source: "local" };
  if (s.disabled) return { state: "disabled", source: "build" };
  return { state: "normal", source: "default" };
}
function getShipNote(name)  { return SHIP_CFG[name]?.note     || ""; }
function getShipOverride(name) {
  return SHIP_CFG[name]?.hardpoints_override || null;
}
/** Salvage flag: localStorage wins, else baked-in ships.json value. */
function getShipSalvage(name, ship) {
  const local = SHIP_CFG[name]?.salvage;
  if (local !== undefined) return !!local;
  return !!ship?.salvage;
}
/** Component accessibility: "yes" | "no" | "" (unknown). localStorage wins. */
function getShipAccessible(name, ship) {
  const local = SHIP_CFG[name]?.components_accessible;
  if (local !== undefined) return local || "";
  return ship?.components_accessible || "";
}

/** Merge-update a ship's config. Removes the entry if all fields end up default.
 *  An explicit "normal" state is KEPT when the ship is baked-disabled, so the
 *  local config can re-enable a ship the data files ship as disabled. */
function updateShip(name, patch) {
  const cur  = SHIP_CFG[name] || {};
  const next = { ...cur, ...patch };
  const baked = SHIPS.find(s => s.name === name);
  const bakedDisabled = !!baked?.disabled;
  if ((next.state === "normal" && !bakedDisabled) || !next.state) delete next.state;
  if (!next.note)                              delete next.note;
  if (!next.hardpoints_override?.length)       delete next.hardpoints_override;
  if (!next.salvage)                           delete next.salvage;
  if (!next.components_accessible)             delete next.components_accessible;
  if (Object.keys(next).length === 0) delete SHIP_CFG[name];
  else                                SHIP_CFG[name] = next;
  saveJSON(SHIP_KEY, SHIP_CFG);
}

/** Trigger a JSON-file download from in-memory data. */
function downloadJSON(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Overrides file — the COMPLETE effective curation (your local edits layered
 *  over what the data files already bake in). Because it is a full snapshot,
 *  it is always safe to replace the previous overrides file with this one. */
function exportOverrides() {
  const ships = {};
  for (const s of SHIPS) {
    const o = {};
    const cfg = SHIP_CFG[s.name] || {};
    if (getEffectiveShipState(s).state === "disabled") o.disabled = true;
    const note = cfg.note || s.note;
    if (note) o.note = note;
    if (getShipSalvage(s.name, s)) o.salvage = true;
    const acc = getShipAccessible(s.name, s);
    if (acc === "yes" || acc === "no") o.components_accessible = acc;
    // Hardpoint corrections: local override wins; else re-emit a baked one.
    if (cfg.hardpoints_override?.length) {
      o.hardpoints = cfg.hardpoints_override;
    } else if (s._override_hardpoints) {
      o.hardpoints = hardpointsToGroups(s.hardpoints);
    }
    if (Object.keys(o).length) ships[s.name] = o;
  }
  // Keep config entries for ships no longer in the data (stale but intentional).
  for (const [name, cfg] of Object.entries(SHIP_CFG)) {
    if (ships[name] || SHIPS.some(s => s.name === name)) continue;
    const o = {};
    if (cfg.state === "disabled") o.disabled = true;
    if (cfg.note) o.note = cfg.note;
    if (cfg.salvage) o.salvage = true;
    if (cfg.components_accessible) o.components_accessible = cfg.components_accessible;
    if (cfg.hardpoints_override?.length) o.hardpoints = cfg.hardpoints_override;
    if (Object.keys(o).length) ships[name] = o;
  }

  const weapons = {};
  for (const w of WEAPONS) {
    const key = weaponKey(w);
    const eff = getEffectiveWeaponState(key, w);
    const o = {};
    if (eff.state === "disabled") o.disabled = true;
    if (eff.state === "forced" && eff.ships.length) o.force_to_ships = eff.ships;
    if (Object.keys(o).length) weapons[key] = o;
  }
  for (const [key, cfg] of Object.entries(WEAPON_CFG)) {
    if (weapons[key] || WEAPONS.some(w => weaponKey(w) === key)) continue;
    const o = {};
    if (cfg.state === "disabled") o.disabled = true;
    if (cfg.state === "forced") {
      const allow = cfg.ships || (cfg.ship ? [cfg.ship] : []);
      if (allow.length) o.force_to_ships = allow;
    }
    if (Object.keys(o).length) weapons[key] = o;
  }

  const payload = {
    schema:      "sc-loadout-overrides",
    version:     1,
    exported_at: new Date().toISOString(),
    ships,
    weapons,
  };
  downloadJSON("overrides.json", payload);
  alert(`Wrote overrides.json — ${Object.keys(ships).length} ship overrides, ${Object.keys(weapons).length} weapon overrides.\n\nThis is a complete snapshot — safe to replace the previous file.`);
}

/** Full backup — every entry as it sits in localStorage, restorable as-is. */
function exportConfig() {
  const payload = {
    schema:        "sc-loadout-config",
    version:       1,
    exported_at:   new Date().toISOString(),
    weapon_config: loadJSON(WEAPON_KEY),
    ship_config:   loadJSON(SHIP_KEY),
  };
  downloadJSON(`hardpoint-config-${new Date().toISOString().slice(0,10)}.json`, payload);
  const w = Object.keys(payload.weapon_config).length;
  const s = Object.keys(payload.ship_config).length;
  alert(`Backup exported — ${w} weapon entries + ${s} ship entries.`);
}

function importConfig(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (typeof data !== "object" || data === null) throw new Error("not a JSON object");

      let w, s, label;
      if (data.schema === "sc-loadout-overrides") {
        // Translate the lossy overrides format back into internal config schema.
        w = {}; s = {};
        for (const [name, o] of Object.entries(data.ships || {})) {
          const c = {};
          if (o.disabled)             c.state = "disabled";
          if (o.note)                 c.note = o.note;
          if (o.salvage)              c.salvage = true;
          if (o.components_accessible === "yes" || o.components_accessible === "no") {
            c.components_accessible = o.components_accessible;
          }
          if (Array.isArray(o.hardpoints) && o.hardpoints.length) c.hardpoints_override = o.hardpoints;
          if (Object.keys(c).length) s[name] = c;
        }
        for (const [key, o] of Object.entries(data.weapons || {})) {
          const c = {};
          if (o.disabled)                                  c.state = "disabled";
          else if (Array.isArray(o.force_to_ships) && o.force_to_ships.length) {
            c.state = "forced";
            c.ships = o.force_to_ships;
          }
          if (Object.keys(c).length) w[key] = c;
        }
        label = "overrides";
      } else if (!data.schema || data.schema === "sc-loadout-config") {
        w = data.weapon_config || {};
        s = data.ship_config   || {};
        label = "backup";
      } else {
        throw new Error(`unexpected schema "${data.schema}"`);
      }

      if (!confirm(`Import this ${label} file? Will REPLACE current config.\n\n` +
                   `  ${Object.keys(WEAPON_CFG).length} → ${Object.keys(w).length} weapon entries\n` +
                   `  ${Object.keys(SHIP_CFG).length} → ${Object.keys(s).length} ship entries`)) return;

      WEAPON_CFG = w;
      SHIP_CFG   = s;
      saveJSON(WEAPON_KEY, WEAPON_CFG);
      saveJSON(SHIP_KEY,   SHIP_CFG);
      migrateWeaponConfig();
      render();
      alert(`Imported ${Object.keys(w).length} weapon + ${Object.keys(s).length} ship entries from ${label}.`);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function attach() {
  for (const b of document.querySelectorAll(".tab-btn")) {
    b.addEventListener("click", () => {
      CURRENT_TAB = b.dataset.tab;
      for (const btn of document.querySelectorAll(".tab-btn")) {
        btn.classList.toggle("active", btn === b);
      }
      // Hide weapon-only filters when on ships tab.
      for (const el of document.querySelectorAll(".tab-only-weapons")) {
        el.style.display = (CURRENT_TAB === "weapons") ? "" : "none";
      }
      render();
    });
  }
  $("#search").addEventListener("input", render);
  $("#size-filter").addEventListener("change", render);
  $("#state-filter").addEventListener("change", render);
  $("#reset-all").addEventListener("click", () => {
    const tab = CURRENT_TAB === "weapons" ? "weapon" : "ship";
    if (!confirm(`Reset all ${tab} configurations to Normal?`)) return;
    if (CURRENT_TAB === "weapons") {
      WEAPON_CFG = {};
      saveJSON(WEAPON_KEY, WEAPON_CFG);
    } else {
      SHIP_CFG = {};
      saveJSON(SHIP_KEY, SHIP_CFG);
    }
    render();
  });
  $("#export-backup-btn"  ).addEventListener("click", exportConfig);
  $("#export-override-btn").addEventListener("click", exportOverrides);
  $("#import-input").addEventListener("change", e => {
    const file = e.target.files?.[0];
    if (file) importConfig(file);
    e.target.value = "";  // reset so re-selecting the same file fires change
  });
}

function currentFilters() {
  return {
    q:     ($("#search").value || "").trim().toLowerCase(),
    size:  $("#size-filter").value,
    state: $("#state-filter").value,
  };
}

function render() {
  if (CURRENT_TAB === "weapons") renderWeapons();
  else                            renderShips();
}

function renderWeapons() {
  const f = currentFilters();
  const ships = SHIPS.map(s => s.name).sort();
  let rows = WEAPONS.slice();
  if (f.q)     rows = rows.filter(w => (w.name || "").toLowerCase().includes(f.q) || (w.manufacturer || "").toLowerCase().includes(f.q));
  if (f.size)  rows = rows.filter(w => String(w.size) === f.size);
  if (f.state) rows = rows.filter(w => getEffectiveWeaponState(weaponKey(w), w).state === f.state);
  rows.sort((a, b) => (a.size - b.size) || (a.name || "").localeCompare(b.name || ""));

  const fmt = n => typeof n === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—";

  const trs = rows.map(w => {
    const key = weaponKey(w);
    const eff = getEffectiveWeaponState(key, w);  // localStorage OR JSON-baked
    const dataKey = key.replace(/"/g, "&quot;");

    // Chips for each currently-effective forced ship.
    const shipChips = eff.ships.map(s => `
      <span class="ship-chip" title="${s}">
        ${s}
        <button class="ship-chip-x" data-key="${dataKey}" data-ship="${s.replace(/"/g, "&quot;")}" title="Remove">&times;</button>
      </span>`).join("");

    // Visual hint when the restriction comes from the bundled data rather than
    // the user's own config — so they know editing creates a local override.
    const sourceBadge = eff.source === "build"
      ? `<span class="tag" style="background:rgba(88,166,255,0.10);border-color:rgba(88,166,255,0.30);color:var(--accent);margin-left:6px;">built-in</span>`
      : "";

    return `<tr class="state-${eff.state}">
      <td><span class="size-pill">S${w.size}</span></td>
      <td class="weapon-name">${w.name}<span class="mfg">${w.manufacturer || ""}</span></td>
      <td>${w.type || ""}</td>
      <td class="num">${fmt(w.alpha)}</td>
      <td class="num">${fmt(w.dps_sustained_60s)}</td>
      <td>
        <select class="weapon-state-pick" data-key="${dataKey}">
          <option value="normal"   ${eff.state === "normal"   ? "selected" : ""}>Normal</option>
          <option value="forced"   ${eff.state === "forced"   ? "selected" : ""}>Force to ships…</option>
          <option value="disabled" ${eff.state === "disabled" ? "selected" : ""}>Disabled</option>
        </select>${sourceBadge}
      </td>
      <td>
        ${eff.state === "forced" ? `
          <div class="ship-chips">${shipChips}</div>
          <input type="text" list="all-ships-datalist" class="weapon-ship-add"
                 data-key="${dataKey}" placeholder="+ add ship (type to filter)…"
                 autocomplete="off" />
        ` : ""}
      </td>
    </tr>`;
  }).join("");

  $("#catalog-table").innerHTML = `
    <table class="loadout cfg-table">
      <thead><tr>
        <th>Size</th><th>Weapon</th><th>Type</th>
        <th class="num">Alpha</th><th class="num">DPS&nbsp;60s</th>
        <th>State</th><th>Forced ship</th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;

  const total = WEAPONS.length;
  const forced   = Object.values(WEAPON_CFG).filter(c => c.state === "forced").length;
  const disabled = Object.values(WEAPON_CFG).filter(c => c.state === "disabled").length;
  $("#status").textContent =
    `Weapons: ${rows.length} shown of ${total} · ${forced} forced · ${disabled} disabled`;

  for (const sel of document.querySelectorAll(".weapon-state-pick")) {
    sel.addEventListener("change", e => {
      setWeaponState(e.target.dataset.key, e.target.value);
    });
  }
  // The ship-add input commits on Enter, blur, or when an option is picked
  // (which fires a "change" event in most browsers).
  for (const inp of document.querySelectorAll(".weapon-ship-add")) {
    const commit = (e) => {
      const key  = e.target.dataset.key;
      const ship = (e.target.value || "").trim();
      if (!ship) return;
      // Only accept exact ship names (avoids creating bogus entries from partial typing).
      const known = SHIPS.some(s => s.name === ship);
      if (!known) {
        e.target.style.borderColor = "var(--bad)";
        return;
      }
      e.target.value = "";
      addForcedShip(key, ship);
    };
    inp.addEventListener("change", commit);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") commit(e); });
    inp.addEventListener("input", e => { e.target.style.borderColor = ""; });   // clear error tint
  }
  for (const btn of document.querySelectorAll(".ship-chip-x")) {
    btn.addEventListener("click", e => {
      const key  = e.target.dataset.key;
      const ship = e.target.dataset.ship;
      removeForcedShip(key, ship);
    });
  }
}

function renderShips() {
  const f = currentFilters();
  let rows = SHIPS.slice();
  if (f.q)     rows = rows.filter(s => (s.name || "").toLowerCase().includes(f.q) || (s.manufacturer || "").toLowerCase().includes(f.q));
  if (f.state) rows = rows.filter(s => getEffectiveShipState(s).state === f.state);
  rows.sort((a, b) =>
    (a.manufacturer || "").localeCompare(b.manufacturer || "") ||
    (a.name || "").localeCompare(b.name || "")
  );

  const trs = rows.map(s => {
    const effShip  = getEffectiveShipState(s);
    const st       = effShip.state;
    const stBadge  = effShip.source === "build"
      ? ` <span class="tag" style="background:rgba(88,166,255,0.10);border-color:rgba(88,166,255,0.30);color:var(--accent);">built-in</span>`
      : "";
    const dataName = s.name.replace(/"/g, "&quot;");
    const note     = getShipNote(s.name) || s.note || "";
    const hasOverride = !!getShipOverride(s.name);
    const gunCount = (s.hardpoints || []).filter(h => ["gun","pilot_gun","weapon"].includes(h.type)).length;
    const editorOpen = EDITING_SHIP === s.name;

    const salvage    = getShipSalvage(s.name, s);
    const accessible = getShipAccessible(s.name, s);

    let html = `<tr class="state-${st} ${hasOverride ? "has-override" : ""}">
      <td>${s.size != null ? `<span class="size-pill">S${s.size}</span>` : ""}</td>
      <td class="weapon-name">${s.name}${hasOverride ? ' <span class="tag warn">override</span>' : ""}<span class="mfg">${s.manufacturer || ""}</span></td>
      <td class="num">${gunCount}</td>
      <td>
        <select class="ship-state-pick" data-name="${dataName}">
          <option value="normal"   ${st === "normal"   ? "selected" : ""}>Normal</option>
          <option value="disabled" ${st === "disabled" ? "selected" : ""}>Disabled</option>
        </select>${stBadge}
      </td>
      <td class="center">
        <input type="checkbox" class="ship-salvage" data-name="${dataName}" ${salvage ? "checked" : ""} title="Shows up in salvage missions" />
      </td>
      <td>
        <select class="ship-accessible" data-name="${dataName}" title="Can components be physically removed?">
          <option value=""    ${accessible === ""    ? "selected" : ""}>unknown</option>
          <option value="yes" ${accessible === "yes" ? "selected" : ""}>removable</option>
          <option value="no"  ${accessible === "no"  ? "selected" : ""}>sealed</option>
        </select>
      </td>
      <td>
        <input type="text" class="ship-note" data-name="${dataName}" value="${(note || "").replace(/"/g, "&quot;")}" placeholder="optional note..." />
      </td>
      <td>
        <button class="btn edit-hp-btn ${editorOpen ? "active" : ""}" data-name="${dataName}">
          ${editorOpen ? "Close editor" : "Edit hardpoints"}
        </button>
      </td>
    </tr>`;
    if (editorOpen) html += renderHardpointEditor(s);
    return html;
  }).join("");

  $("#catalog-table").innerHTML = `
    <table class="loadout cfg-table ships-cfg-table">
      <thead><tr>
        <th>Size</th><th>Ship</th>
        <th class="num">Guns</th><th>State</th>
        <th>Salvage</th><th>Components</th>
        <th>Note</th><th>Hardpoints</th>
      </tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;

  const total       = SHIPS.length;
  const disabled    = Object.values(SHIP_CFG).filter(c => c.state === "disabled").length;
  const overridden  = Object.values(SHIP_CFG).filter(c => c.hardpoints_override?.length).length;
  $("#status").textContent =
    `Ships: ${rows.length} shown of ${total} · ${disabled} disabled · ${overridden} with hardpoint overrides`;

  wireShipEvents();
}

function wireShipEvents() {
  for (const sel of document.querySelectorAll(".ship-state-pick")) {
    sel.addEventListener("change", e => {
      updateShip(e.target.dataset.name, { state: e.target.value });
      render();
    });
  }
  for (const inp of document.querySelectorAll(".ship-note")) {
    inp.addEventListener("input", e => {
      updateShip(e.target.dataset.name, { note: e.target.value });
      // Note-only edits don't need a re-render
    });
  }
  for (const cb of document.querySelectorAll(".ship-salvage")) {
    cb.addEventListener("change", e => {
      updateShip(e.target.dataset.name, { salvage: e.target.checked });
    });
  }
  for (const sel of document.querySelectorAll(".ship-accessible")) {
    sel.addEventListener("change", e => {
      updateShip(e.target.dataset.name, { components_accessible: e.target.value });
    });
  }
  for (const btn of document.querySelectorAll(".edit-hp-btn")) {
    btn.addEventListener("click", e => {
      const name = e.target.dataset.name;
      if (EDITING_SHIP === name) {
        // Close editor (discard unsaved buffer).
        EDITING_SHIP = null;
        EDIT_BUFFER  = null;
      } else {
        EDITING_SHIP = name;
        const ship = SHIPS.find(s => s.name === name);
        const existing = getShipOverride(name);
        // Seed buffer: existing override OR baseline groups from ships.json
        EDIT_BUFFER = existing
          ? existing.map(g => ({ ...g }))
          : hardpointsToGroups(ship?.hardpoints || []);
      }
      render();
    });
  }
  // Editor inputs (only present when EDITING_SHIP set)
  wireEditorEvents();
}

function renderHardpointEditor(ship) {
  const buf = EDIT_BUFFER || [];
  const sizeOpts = HP_SIZES.map(n => `<option value="${n}">S${n}</option>`).join("");
  const typeOpts = HP_TYPES.map(t => `<option value="${t}">${t}</option>`).join("");
  const rows = buf.map((g, i) => `
    <tr data-idx="${i}">
      <td><input type="text" class="hp-port"  value="${(g.parent_port || "").replace(/"/g,"&quot;")}" placeholder="hardpoint_..." /></td>
      <td><input type="number" class="hp-count" value="${g.count ?? 1}" min="1" max="20" /></td>
      <td>
        <select class="hp-size">
          ${HP_SIZES.map(n => `<option value="${n}" ${g.size === n ? "selected" : ""}>S${n}</option>`).join("")}
        </select>
      </td>
      <td>
        <select class="hp-type">
          ${HP_TYPES.map(t => `<option value="${t}" ${g.type === t ? "selected" : ""}>${t}</option>`).join("")}
        </select>
      </td>
      <td><input type="text" list="all-weapons-datalist" class="hp-default"
                 value="${(g.default_weapon || "").replace(/"/g,"&quot;")}"
                 placeholder="default weapon (Base mode)…" autocomplete="off" /></td>
      <td><button class="btn hp-del" title="Remove this row">&times;</button></td>
    </tr>`).join("");

  return `<tr class="hp-editor-row">
    <td colspan="6">
      <div class="hp-editor">
        <div class="hp-editor-header">
          <strong>Hardpoint groups for ${ship.name}</strong>
          <span class="muted">Each row = N guns sharing one parent slot. Override replaces ship.hardpoints entirely.</span>
        </div>
        <table class="hp-edit-table">
          <thead><tr><th>Parent port</th><th>Count</th><th>Size</th><th>Type</th><th>Default weapon</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="hp-editor-actions">
          <button class="btn hp-add">+ Add hardpoint group</button>
          <button class="btn hp-save" >Save override</button>
          <button class="btn hp-reset">Reset to baseline</button>
          <button class="btn hp-cancel">Cancel</button>
        </div>
        <div class="muted" style="margin-top:6px;font-size:11px;">
          Note: Base-mode default weapons are tied to the original port names and may not apply to overridden slots.
        </div>
      </div>
    </td>
  </tr>`;
}

function wireEditorEvents() {
  if (!EDITING_SHIP) return;

  // Sync inputs back into EDIT_BUFFER on change
  const syncRow = (tr) => {
    const idx = +tr.getAttribute("data-idx");
    if (!EDIT_BUFFER[idx]) return;
    EDIT_BUFFER[idx].parent_port    = tr.querySelector(".hp-port").value;
    EDIT_BUFFER[idx].count          = Math.max(1, +tr.querySelector(".hp-count").value || 1);
    EDIT_BUFFER[idx].size           = +tr.querySelector(".hp-size").value;
    EDIT_BUFFER[idx].type           = tr.querySelector(".hp-type").value;
    EDIT_BUFFER[idx].default_weapon = (tr.querySelector(".hp-default")?.value || "").trim();
  };
  for (const tr of document.querySelectorAll(".hp-editor-row tr[data-idx]")) {
    for (const inp of tr.querySelectorAll("input,select")) {
      inp.addEventListener("change", () => syncRow(tr));
      inp.addEventListener("input",  () => syncRow(tr));
    }
    const delBtn = tr.querySelector(".hp-del");
    if (delBtn) delBtn.addEventListener("click", () => {
      const idx = +tr.getAttribute("data-idx");
      EDIT_BUFFER.splice(idx, 1);
      render();
    });
  }
  const addBtn  = document.querySelector(".hp-add");
  const saveBtn = document.querySelector(".hp-save");
  const reset   = document.querySelector(".hp-reset");
  const cancel  = document.querySelector(".hp-cancel");
  if (addBtn) addBtn.addEventListener("click", () => {
    EDIT_BUFFER.push({ parent_port: "", count: 1, size: 3, type: "gun", default_weapon: "" });
    render();
  });
  if (saveBtn) saveBtn.addEventListener("click", () => {
    // Filter out rows with no port name; drop empty default_weapon fields.
    const clean = EDIT_BUFFER
      .filter(g => (g.parent_port || "").trim().length > 0)
      .map(g => {
        const out = { ...g };
        if (!out.default_weapon) delete out.default_weapon;
        return out;
      });
    updateShip(EDITING_SHIP, { hardpoints_override: clean });
    EDITING_SHIP = null;
    EDIT_BUFFER  = null;
    render();
  });
  if (reset) reset.addEventListener("click", () => {
    if (!confirm(`Reset hardpoints for ${EDITING_SHIP} to the baseline from XML?`)) return;
    updateShip(EDITING_SHIP, { hardpoints_override: [] });
    EDITING_SHIP = null;
    EDIT_BUFFER  = null;
    render();
  });
  if (cancel) cancel.addEventListener("click", () => {
    EDITING_SHIP = null;
    EDIT_BUFFER  = null;
    render();
  });
}

load().catch(err => {
  console.error(err);
  $("#status").innerHTML = `<span style="color:var(--bad)">load error: ${err.message}</span>`;
});
