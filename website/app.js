/* SC Loadout v1 — vanilla JS, single file.
 *
 * Data model (recap from session):
 *   - ships.json:   ship metadata + weapon-type hardpoints (port, type, size)
 *   - weapons.json: weapon catalog with alpha & DPS per damage type
 *   - armor.json:   per-ship armor with deflection threshold + durability mult
 *
 * Algorithm:
 *   Per gun-class hardpoint on selected ship, filter weapons that fit the slot
 *   (size match), then apply target-tier filter (Max / Same class / Punch up):
 *
 *     Max         -> ignore target. Rank by sustained DPS.
 *     Same class  -> weapon's alpha for its damage type must exceed the
 *                    deflection threshold of the SELECTED ship's armor for
 *                    that same damage type. Rank by sustained DPS.
 *     Punch up    -> same gate, but threshold is the median for ships ONE
 *                    class above (Light -> Medium -> Heavy).
 *
 *   Then secondary "pref":
 *     Most power   -> just take rank 1.
 *     Closest pips -> anchor on highest-DPS pick for largest slot; for each
 *                     subsequent slot pick highest-DPS weapon whose ammo_speed
 *                     is within +/- PIP_TOLERANCE m/s of the anchor.
 *
 * All defaults are constants at the top — change here to retune.
 */

const PIP_TOLERANCE = 100;          // m/s window for "closest pips"
const REFERENCE_TOF = 0.5;          // seconds; below this, hit factor caps at 1.0
const CLASS_ORDER = ["Light", "Medium", "Heavy"];

/* Coarse type-specific range factor — until we extract real damage falloff
 * curves from AmmoParams XMLs. Key matched case-insensitively against the
 * weapon's "type" string. Default = 1.0 (no penalty). */
const WEAPON_TYPE_RANGE_FACTORS = {
  scattergun: 0.30,                 // scatterguns die hard past ~30% of nominal
  // repeater: 0.85,                // (uncomment to retune)
};

// ---- load ---------------------------------------------------------------

let SHIPS = [], WEAPONS = [], ARMOR = [];
let ARMOR_BY_SHIP = {};             // ship name -> armor row
let CLASS_THRESHOLDS = {};          // class -> {damageType -> median threshold}
let WEAPON_CONFIG = {};             // {weaponKey: {state, ship?}} loaded from localStorage
let SHIP_CONFIG   = {};             // {shipName: {state}} loaded from localStorage

/* Per-side state. Each side has its own manual-pick map and last-ship memo
 * so the two panels in VS mode can hold different ships independently. */
const STATES = {
  left:  { manuals: new Map(), lastShip: null, vulnFilter: { can: "", cant: "" } },
  right: { manuals: new Map(), lastShip: null, vulnFilter: { can: "", cant: "" } },
};
const SIDES = ["left", "right"];

// v2: bumped key (was v1) — v1 keyed by name only, which collapsed
// distinct same-named weapons (e.g. S3 Anvil vs S4 Apocalypse "Revenant Gatling").
const CONFIG_STORAGE_KEY      = "sc-loadout-weapon-config-v2";
const SHIP_CONFIG_STORAGE_KEY = "sc-loadout-ship-config-v1";

/** Unique identifier per weapon row — name + size + manufacturer. */
function weaponKey(w) {
  return `${w.name}|S${w.size}|${w.manufacturer || ""}`;
}

function loadWeaponConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY)) || {};
  } catch (_) { return {}; }
}
function loadShipConfig() {
  try {
    return JSON.parse(localStorage.getItem(SHIP_CONFIG_STORAGE_KEY)) || {};
  } catch (_) { return {}; }
}
/** Effective disabled state — personal config wins, else the baked-in tag. */
function isShipDisabled(ship) {
  const local = SHIP_CONFIG[ship.name]?.state;
  if (local) return local === "disabled";
  return !!ship.disabled;
}

/** Salvage flag — personal config wins, else the baked-in data value. */
function isShipSalvage(ship) {
  const local = SHIP_CONFIG[ship.name]?.salvage;
  if (local !== undefined) return !!local;
  return !!ship.salvage;
}

/** Component accessibility: "yes" | "no" | "" (unknown). Personal config wins. */
function shipAccessibility(ship) {
  const local = SHIP_CONFIG[ship.name]?.components_accessible;
  if (local !== undefined) return local || "";
  return ship.components_accessible || "";
}

function isSalvageView() {
  return !!document.getElementById("salvage-toggle")?.checked;
}

/** Expand a hardpoint-override group [{parent_port, count, size, type}] into
 *  the flat hardpoints[] shape app.js expects. */
function expandHardpointGroups(groups) {
  const out = [];
  for (const g of groups || []) {
    if (!g?.parent_port || !g.count || !g.size) continue;
    for (let i = 0; i < g.count; i++) {
      out.push({
        port:                `${g.parent_port}/override_${i}`,
        parent_port:         g.parent_port,
        type:                g.type || "weapon",
        size:                g.size,
        size_inferred:       false,
        default_weapon_name: g.default_weapon || null,
        override:            true,
      });
    }
  }
  return out;
}

/** Walk SHIPS, replace ship.hardpoints with the override (if any). Called after
 *  ships.json is loaded and SHIP_CONFIG is read. */
function applyHardpointOverrides() {
  for (const s of SHIPS) {
    const override = SHIP_CONFIG[s.name]?.hardpoints_override;
    if (override && override.length > 0) {
      s.hardpoints = expandHardpointGroups(override);
      s._overridden = true;
    }
  }
}

/** Is this weapon allowed for the currently selected ship?
 *
 *  Two layers compose:
 *    1. localStorage WEAPON_CONFIG  → personal user override (wins when set)
 *    2. weapon.force_to_ships in the data file → baked-in restriction
 *
 *  Disabled → never. Forced → only when current ship is in the allow-list. */
function isWeaponAllowed(weapon, currentShipName) {
  const cfg = WEAPON_CONFIG[weaponKey(weapon)];

  // Layer 1: explicit user config in localStorage takes precedence.
  if (cfg) {
    if (cfg.state === "disabled") return false;
    if (cfg.state === "forced") {
      const allow = cfg.ships || (cfg.ship ? [cfg.ship] : []);
      return allow.includes(currentShipName);
    }
    if (cfg.state === "normal") return true;
  }

  // Layer 2: data-level restrictions (baked into the data files).
  if (weapon.disabled) return false;
  if (Array.isArray(weapon.force_to_ships) && weapon.force_to_ships.length > 0) {
    return weapon.force_to_ships.includes(currentShipName);
  }

  return true;
}

const $ = sel => document.querySelector(sel);
/** Side-scoped query — finds an element inside .panel[data-side="left|right"]. */
const $$ = (side, sel) => document.querySelector(`.panel[data-side="${side}"] ${sel}`);
const $$all = (side, sel) => document.querySelectorAll(`.panel[data-side="${side}"] ${sel}`);

/** Instantiate the panel template for one side. Suffixes radio names with
 *  -{side} so left/right radio groups don't collide. */
function instantiatePanel(side) {
  const tmpl = document.getElementById("panel-template");
  const node = tmpl.content.firstElementChild.cloneNode(true);
  node.setAttribute("data-side", side);
  for (const inp of node.querySelectorAll("input[name]")) {
    inp.name = `${inp.name}-${side}`;
  }
  document.querySelector("main.panels").appendChild(node);
}

async function load() {
  // Cache-busting: append timestamp so each load gets fresh JSON.
  // Without this, browsers happily serve stale ships.json between rebuilds.
  const cb = `?v=${Date.now()}`;
  [SHIPS, WEAPONS, ARMOR] = await Promise.all([
    fetch("ships.json" + cb).then(r => r.json()),
    fetch("weapons.json" + cb).then(r => r.json()),
    fetch("armor.json" + cb).then(r => r.json()),
  ]);
  ARMOR_BY_SHIP = Object.fromEntries(ARMOR.map(a => [a.ship, a]));
  SHIPS_BY_NAME = Object.fromEntries(SHIPS.map(s => [s.name, s]));
  CLASS_THRESHOLDS = computeClassThresholds(ARMOR);
  WEAPON_CONFIG = loadWeaponConfig();
  SHIP_CONFIG   = loadShipConfig();
  applyHardpointOverrides();   // mutates SHIPS in place — must run before render

  // Mount both panels (right is hidden via CSS until body.vs-mode).
  for (const side of SIDES) instantiatePanel(side);

  for (const side of SIDES) populateShipPicker(side);
  attach();
  for (const side of SIDES) render(side);
}

// ---- helpers ------------------------------------------------------------

/** Median per damage-type deflection threshold for each ship class. */
function computeClassThresholds(armorRows) {
  const out = {};
  const DAMAGE_TYPES = ["physical", "energy", "distortion", "thermal", "biochemical", "stun"];
  for (const cls of new Set(armorRows.map(a => a.class).filter(Boolean))) {
    out[cls] = {};
    const group = armorRows.filter(a => a.class === cls);
    for (const dt of DAMAGE_TYPES) {
      const vals = group.map(a => a.deflection_threshold?.[dt])
                        .filter(v => typeof v === "number");
      vals.sort((a, b) => a - b);
      out[cls][dt] = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
    }
  }
  return out;
}

/** Infer the weapon's primary damage type from its alpha breakdown.
 *  Returns 'physical'|'energy'|'distortion'|'unknown'. */
function damageType(w) {
  const cands = [
    ["physical",   w.alpha_physical],
    ["energy",     w.alpha_energy],
    ["distortion", w.alpha_distortion],
  ].filter(([, v]) => typeof v === "number" && v > 0);
  if (!cands.length) return "unknown";
  cands.sort((a, b) => b[1] - a[1]);
  return cands[0][0];
}

/** Weapon's alpha for its primary damage type. */
function primaryAlpha(w) {
  const dt = damageType(w);
  if (dt === "physical")   return w.alpha_physical   ?? 0;
  if (dt === "energy")     return w.alpha_energy     ?? 0;
  if (dt === "distortion") return w.alpha_distortion ?? 0;
  return w.alpha ?? 0;
}

/** True if this weapon can break this armor profile for its damage type. */
function canBreak(weapon, deflThresholds) {
  const dt = damageType(weapon);
  if (dt === "unknown") return true;          // unclassified -> don't block
  const a = primaryAlpha(weapon);
  const t = deflThresholds?.[dt];
  if (typeof t !== "number") return true;     // missing threshold -> don't block
  return a > t;
}

/** What deflection thresholds should we test against, given mode & ship? */
function targetThresholds(ship, mode) {
  if (mode === "max") return null;            // no gating
  const armor = ARMOR_BY_SHIP[ship.name];
  const myClass = armor?.class || "Medium";
  if (mode === "same") {
    return armor?.deflection_threshold || CLASS_THRESHOLDS[myClass] || {};
  }
  // "up" -> one class above (capped at Heavy)
  const idx = CLASS_ORDER.indexOf(myClass);
  const upClass = CLASS_ORDER[Math.min(idx + 1, CLASS_ORDER.length - 1)];
  return CLASS_THRESHOLDS[upClass] || {};
}

/** Weapons that fit a given slot: size match, gun-like type. */
const GUN_TYPES = /Cannon|Repeater|Gatling|ScatterGun|Distortion|Beam|MassDriver|Laser/i;
function candidatesForSlot(slot, opts = {}) {
  const { currentShipName = null, dmgType = "any" } = opts;
  return WEAPONS.filter(w =>
    w.size === slot.size &&
    GUN_TYPES.test(w.type || "") &&
    typeof w.dps_sustained_60s === "number" &&
    w.dps_sustained_60s > 0 &&
    matchesDmgType(w, dmgType) &&
    isWeaponAllowed(w, currentShipName)
  );
}

function matchesDmgType(w, dmgType) {
  if (!dmgType || dmgType === "any") return true;
  if (dmgType === "ballistic") {
    return (w.alpha_physical ?? 0) > 0 || /Ballistic|MassDriver/i.test(w.type || "");
  }
  if (dmgType === "energy") {
    return (w.alpha_energy ?? 0) > 0 || /Laser|Beam/i.test(w.type || "");
  }
  return true;
}

/** Returns the user-selected manual override for this group on this side, or null.
 *  Manual picks are stored by weaponKey() (name|size|mfg) so same-named
 *  different-size weapons (e.g. S3 vs S4 Revenant Gatling) don't collide. */
function getManualPick(side, groupKey) {
  const wk = STATES[side].manuals.get(groupKey);
  if (!wk) return null;
  return WEAPONS.find(w => weaponKey(w) === wk) || null;
}

/** Stable identifier per slot group — used to key manual overrides. */
function groupKey(group) {
  return `${group.parent}|S${group.size}|n${group.count}`;
}

/** Time-of-flight in seconds at given range; null if no ammo_speed. */
function timeOfFlight(weapon, range) {
  if (!range || typeof weapon.ammo_speed !== "number" || weapon.ammo_speed <= 0) return null;
  return range / weapon.ammo_speed;
}

/** Effective range — nominal ammo_range scaled by weapon-type falloff factor. */
function effectiveRange(weapon) {
  const nominal = weapon.ammo_range;
  if (typeof nominal !== "number" || nominal <= 0) return null;
  const t = (weapon.type || "").toLowerCase();
  for (const key in WEAPON_TYPE_RANGE_FACTORS) {
    if (t.includes(key)) return nominal * WEAPON_TYPE_RANGE_FACTORS[key];
  }
  return nominal;
}

/** Hit factor at given range (0..1).
 *  - 0 if out of effective range
 *  - 1 if ToF <= REFERENCE_TOF
 *  - REFERENCE_TOF / ToF otherwise
 *  - 1 if range==0 (feature disabled) */
function hitFactor(weapon, range) {
  if (!range) return 1;
  const effRng = effectiveRange(weapon);
  if (effRng != null && range > effRng) return 0;
  const tof = timeOfFlight(weapon, range);
  if (tof == null) return 0.5;            // unknown velocity -> moderate penalty
  if (tof <= REFERENCE_TOF) return 1;
  return REFERENCE_TOF / tof;
}

/** Sustained DPS adjusted for hit factor at range. */
function effectiveDps(weapon, range) {
  const base = weapon.dps_sustained_60s ?? 0;
  return base * hitFactor(weapon, range);
}

/** Sort by effective DPS desc (range-aware), break ties by alpha. */
function rankByDps(arr, range = 0) {
  return arr.slice().sort((a, b) =>
    (effectiveDps(b, range) - effectiveDps(a, range)) ||
    ((b.alpha ?? 0) - (a.alpha ?? 0))
  );
}

// ---- core: pick weapons for a ship --------------------------------------

/** Group leaves by parent_port for display.
 *  Returns [{parent, count, size, leaves[]}] sorted by size desc. */
function groupHardpoints(hardpoints) {
  const groups = new Map();
  for (const hp of hardpoints) {
    // Group key: parent_port if set (turret/mount with multiple sub-guns), else port itself.
    const key = hp.parent_port || hp.port;
    if (!groups.has(key)) groups.set(key, { parent: key, size: hp.size, leaves: [] });
    groups.get(key).leaves.push(hp);
  }
  for (const g of groups.values()) {
    g.count = g.leaves.length;
    // If sizes differ within a group, take the max
    g.size = g.leaves.reduce((s, l) => Math.max(s, l.size ?? 0), 0) || null;
  }
  return [...groups.values()].sort((a, b) => (b.size || 0) - (a.size || 0));
}

function pickLoadout(side, ship, mode, pref, range, dmgType) {
  const thresholds = targetThresholds(ship, mode);
  const gunHps = ship.hardpoints.filter(h =>
    h.type === "gun" || h.type === "pilot_gun" || h.type === "weapon"
  );
  const groups = groupHardpoints(gunHps);

  const picks = [];
  // If user has manual picks AND prefers closest pips, anchor on the manuals'
  // median velocity so auto picks align to what the user has already chosen.
  let anchorSpeed = null;
  if (pref === "pips") {
    const manualSpeeds = groups
      .map(g => getManualPick(side, groupKey(g)))
      .filter(w => w && typeof w.ammo_speed === "number")
      .map(w => w.ammo_speed)
      .sort((a, b) => a - b);
    if (manualSpeeds.length) {
      anchorSpeed = manualSpeeds[Math.floor(manualSpeeds.length / 2)];
    }
  }

  for (const g of groups) {
    if (!g.size) {
      picks.push({ group: g, weapon: null, poolSize: 0, reason: "unknown size" });
      continue;
    }

    let autoChosen, poolSize;
    const filterOpts = { currentShipName: ship.name, dmgType };
    if (mode === "base") {
      // Use the stock default weapon for this slot.
      // Respect weapon config: skip if disabled or forced-to-other-ship.
      const defaultName = g.leaves[0]?.default_weapon_name;
      let candidate = defaultName
        ? (WEAPONS.find(w => w.name === defaultName && w.size === g.size)
           || WEAPONS.find(w => w.name === defaultName)
           || null)
        : null;
      if (candidate && !isWeaponAllowed(candidate, ship.name)) candidate = null;
      autoChosen = candidate;
      poolSize = candidatesForSlot({ size: g.size }, filterOpts).length;
    } else {
      // "same" / "up" — alpha-gate filter, then rank by DPS.
      let pool = candidatesForSlot({ size: g.size }, filterOpts);
      pool = pool.filter(w => canBreak(w, thresholds));
      if (range > 0) {
        pool = pool.filter(w => hitFactor(w, range) > 0);
      }
      let ranked = rankByDps(pool, range);

      if (pref === "pips" && anchorSpeed != null) {
        const near = ranked.filter(w =>
          typeof w.ammo_speed === "number" &&
          Math.abs(w.ammo_speed - anchorSpeed) <= PIP_TOLERANCE
        );
        if (near.length) ranked = near;
      }
      autoChosen = ranked[0] || null;
      poolSize = pool.length;
    }

    // Manual override (if any) wins
    const manualChosen = getManualPick(side, groupKey(g));
    const chosen = manualChosen || autoChosen;
    if (chosen && anchorSpeed == null && typeof chosen.ammo_speed === "number") {
      anchorSpeed = chosen.ammo_speed;
    }

    picks.push({
      group:      g,
      weapon:     chosen,
      autoWeapon: autoChosen,
      isManual:   !!manualChosen,
      poolSize,
    });
  }

  // Surface non-gun slots so the user sees them (grouped too)
  const otherHps = ship.hardpoints.filter(h =>
    !["gun", "pilot_gun", "weapon"].includes(h.type)
  );
  const otherGroups = groupHardpoints(otherHps);

  return { picks, otherGroups, anchorSpeed };
}

// ---- render -------------------------------------------------------------

/** Sort once, then expose helpers that filter on every change. */
let SHIPS_SORTED = [];
let SHIPS_BY_NAME = {};

function populateShipPicker(side) {
  // Single alphabetical sort — fixes the "two sections" issue where CSV-matched
  // ships and auto-discovered ships were ordered separately. Computed lazily once.
  if (SHIPS_SORTED.length === 0) {
    SHIPS_SORTED = SHIPS.slice().sort((a, b) => a.name.localeCompare(b.name));
  }

  // Populate this side's manufacturer dropdown with every distinct mfg.
  const mfgSel = $$(side, ".mfg-filter");
  if (mfgSel.options.length <= 1) {
    const mfgs = [...new Set(SHIPS_SORTED.map(s => s.manufacturer).filter(Boolean))].sort();
    for (const m of mfgs) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      mfgSel.appendChild(opt);
    }
  }
  refreshShipPicker(side);
}

/** Re-render this side's ship dropdown applying its search + manufacturer filters. */
function refreshShipPicker(side) {
  const sel = $$(side, ".ship-pick");
  const prev = sel.value;
  const q    = ($$(side, ".ship-search").value || "").trim().toLowerCase();
  const mfg  = $$(side, ".mfg-filter").value;

  const salvageOnly = isSalvageView();
  const filtered = SHIPS_SORTED.filter(s => {
    if (isShipDisabled(s)) return false;
    if (salvageOnly && !isShipSalvage(s)) return false;
    if (mfg && s.manufacturer !== mfg) return false;
    if (q && !s.name.toLowerCase().includes(q)) return false;
    return true;
  });

  sel.innerHTML = "";
  for (const s of filtered) {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = s.name;
    sel.appendChild(opt);
  }
  if (filtered.some(s => s.name === prev)) {
    sel.value = prev;
  } else if (filtered.length) {
    sel.selectedIndex = 0;
  }
  updateStatus();
}

function updateStatus() {
  const visibleSides = SIDES.filter(s => isSideVisible(s));
  const totals = visibleSides.map(side => {
    const sel = $$(side, ".ship-pick");
    return `${sel.options.length}`;
  }).join(" / ");
  $("#status").textContent =
    `${totals} ship${visibleSides.length > 1 ? " (L/R)" : "s"} shown of ${SHIPS_SORTED.length} · ${WEAPONS.length} weapons · ${ARMOR.length} armor rows`;
}

function isSideVisible(side) {
  if (side === "left") return true;
  return document.body.classList.contains("vs-mode");
}

function attach() {
  for (const side of SIDES) attachSide(side);

  // VS toggle — controls whether the right panel is visible.
  $("#vs-toggle").addEventListener("change", e => {
    document.body.classList.toggle("vs-mode", e.target.checked);
    // When enabling, render right side fresh so it picks up latest state.
    if (e.target.checked) render("right");
    updateStatus();
  });

  // Salvage view — filters every ship picker down to salvage-tagged ships.
  const salvageToggle = $("#salvage-toggle");
  if (salvageToggle) salvageToggle.addEventListener("change", () => {
    for (const side of SIDES) {
      if (isSideVisible(side)) { refreshShipPicker(side); render(side); }
    }
  });
}

function attachSide(side) {
  $$(side, ".ship-pick").addEventListener("change", () => render(side));
  $$(side, ".ship-search").addEventListener("input", () => { refreshShipPicker(side); render(side); });
  $$(side, ".mfg-filter").addEventListener("change", () => { refreshShipPicker(side); render(side); });
  for (const r of $$all(side, `input[name="mode-${side}"], input[name="pref-${side}"], input[name="range-${side}"], input[name="dmgtype-${side}"]`)) {
    r.addEventListener("change", () => render(side));
  }
}

function getMode(side)    { return $$(side, `input[name="mode-${side}"]:checked`).value; }
function getPref(side)    { return $$(side, `input[name="pref-${side}"]:checked`).value; }
function getRange(side)   { return parseInt($$(side, `input[name="range-${side}"]:checked`).value, 10); }
function getDmgType(side) { return $$(side, `input[name="dmgtype-${side}"]:checked`).value; }

function renderShipInfo(side, ship, armor) {
  if (!ship) {
    $$(side, ".ship-info").innerHTML = '<div class="empty">no ship selected</div>';
    return;
  }
  const tr = (k, v) => `<div class="stat"><span class="k">${k}</span><span>${v ?? "—"}</span></div>`;
  const dmg = (label) =>
    armor?.deflection_threshold?.[label] != null
      ? `<div class="dmg-row"><span>${label}</span>` +
        `<span class="num">${armor.deflection_threshold[label]}</span>` +
        `<span class="num">${armor.durability_multiplier?.[label] ?? "—"}</span></div>`
      : "";
  // Components & cargo section — what the ship carries (strippable on a wreck).
  const acc = shipAccessibility(ship);
  const accBadge =
    acc === "yes" ? `<span class="tag good">components removable</span>` :
    acc === "no"  ? `<span class="tag bad">components sealed</span>` :
                    `<span class="tag">access unverified</span>`;
  const salvageBadge = isShipSalvage(ship) ? ` <span class="tag warn">salvage</span>` : "";
  const compRows = (ship.components || []).map(c =>
    `<div class="stat"><span class="k">${c.type}</span><span>${c.count > 1 ? `${c.count}× ` : ""}${c.full}</span></div>`
  ).join("");
  const cargoVal = (ship.cargo_scu || 0) > 0 ? `${ship.cargo_scu} SCU` : "none";

  $$(side, ".ship-info").innerHTML = `
    <h2>${ship.name}${salvageBadge}</h2>
    ${tr("Class", armor?.class)}
    ${tr("Manufacturer", armor?.manufacturer)}
    ${tr("Size", ship.size)}
    ${tr("Armor HP", armor?.health)}
    ${tr("Pen reduction", armor?.penetration_reduction)}
    ${tr("Gun hardpoints", ship.hardpoints.filter(h => ["gun","pilot_gun","weapon"].includes(h.type)).length)}
    <div class="section-title">Deflection threshold · Durability mult</div>
    <div class="dmg-row"><span class="h">type</span><span class="h num">thresh</span><span class="h num">dur×</span></div>
    ${["physical","energy","distortion","thermal","biochemical","stun"].map(dmg).join("")}
    <div class="section-title">Components &amp; cargo &nbsp;${accBadge}</div>
    ${compRows || '<div class="stat"><span class="k muted">no component data</span><span></span></div>'}
    ${tr("Cargo grid", cargoVal)}
  `;
}

/** Render the per-slot weapon dropdown. Pre-selects the current weapon
 *  (auto pick OR manual override). On change, updates STATES[side].manuals and re-renders. */
function renderPicker(side, group, currentWeapon, autoWeapon, gKey, ctx = {}) {
  // All gun-type weapons of the slot's size, sorted by DPS desc.
  // Respect damage-type + weapon-config filters so the user can't manually
  // pick a disabled/forced/wrong-type weapon either.
  let candidates = candidatesForSlot({ size: group.size }, ctx)
    .slice()
    .sort((a, b) => (b.dps_sustained_60s ?? 0) - (a.dps_sustained_60s ?? 0));

  const isAuto = !STATES[side].manuals.has(gKey);
  const currentKey = currentWeapon ? weaponKey(currentWeapon) : null;

  // If the user's manual pick is filtered out by current dmgType/weapon-config,
  // still include it in the dropdown so they don't appear to lose it.
  if (!isAuto && currentWeapon && !candidates.some(c => weaponKey(c) === currentKey)) {
    candidates = [currentWeapon, ...candidates];
  }

  const fmt = n => typeof n === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—";
  const labelFor = w => `${w.name} — α ${fmt(w.alpha)} · ${fmt(w.dps_sustained_60s)} DPS · ${w.manufacturer || ""}`;

  const autoLabel = autoWeapon ? labelFor(autoWeapon) : "(no auto pick)";
  const opts = [`<option value="" ${isAuto ? "selected" : ""}>↳ Auto: ${autoLabel}</option>`]
    .concat(candidates.map(w => {
      const wk = weaponKey(w);
      const sel = (!isAuto && wk === currentKey) ? "selected" : "";
      return `<option value="${wk.replace(/"/g, "&quot;")}" ${sel}>${labelFor(w)}</option>`;
    }))
    .join("");

  const mfgChip = currentWeapon?.manufacturer
    ? `<div class="mfg">${currentWeapon.manufacturer}${!isAuto ? ' <span class="tag warn">manual</span>' : ""}</div>`
    : "";

  return `<select class="weapon-picker" data-slot="${gKey}">${opts}</select>${mfgChip}`;
}

function renderLoadout(side, result, ship, armor, range) {
  const fmt = n => typeof n === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : "—";
  const fmt2 = n => typeof n === "number" ? n.toFixed(2) : "—";
  const rows = [];

  const dpsHeader = range > 0 ? `DPS @ ${range >= 1000 ? `${range/1000} km` : `${range} m`}` : "DPS&nbsp;60s";
  const filterCtx = { currentShipName: ship.name, dmgType: getDmgType(side) };

  // Pretty-print a parent port name: trim "hardpoint_" prefix and replace underscores.
  const prettyPort = s => (s || "").replace(/^hardpoint_/i, "").replace(/_/g, " ");

  for (const { group, weapon, autoWeapon, isManual, poolSize } of result.picks) {
    const countLabel = group.count > 1 ? `${group.count}× ` : "";
    const slotCell = `<span class="slot-mult">${countLabel}</span><span class="muted">${prettyPort(group.parent)}</span>`;
    const gKey = groupKey(group);

    // Build dropdown of all candidate weapons for this slot size
    const pickerHtml = group.size ? renderPicker(side, group, weapon, autoWeapon, gKey, filterCtx) : "";

    if (!weapon) {
      rows.push(`<tr>
        <td><span class="size-pill">${group.size ? `S${group.size}` : "S?"}</span></td>
        <td>${slotCell}</td>
        <td colspan="7" class="muted"><em>${group.size ? `no fitting weapon (${poolSize} in pool)` : "unknown slot size"}</em></td>
      </tr>`);
      continue;
    }
    const dt = damageType(weapon);
    const dthr = armor?.deflection_threshold?.[dt];
    const willPen = canBreak(weapon, armor?.deflection_threshold);
    const dpsAfter = (typeof armor?.durability_multiplier?.[dt] === "number")
      ? weapon.dps_sustained_60s * armor.durability_multiplier[dt]
      : null;

    const tof = timeOfFlight(weapon, range);
    const hf  = hitFactor(weapon, range);
    const effDpsOne = range > 0 ? effectiveDps(weapon, range) : weapon.dps_sustained_60s;
    const effDpsTotal = effDpsOne * group.count;

    let tofCell;
    if (range === 0) {
      tofCell = `<span class="muted">—</span>`;
    } else if (hf === 0) {
      tofCell = `<span class="tag bad">out</span>`;
    } else if (tof != null) {
      const tofClass = tof <= 0.5 ? "good" : tof <= 1.0 ? "warn" : "bad";
      tofCell = `<span class="tag ${tofClass}">${fmt2(tof)}s</span>` +
                (hf < 1 ? ` <span class="muted">×${fmt2(hf)}</span>` : "");
    } else {
      tofCell = `<span class="muted">—</span>`;
    }

    rows.push(`<tr${isManual ? ' class="manual-pick"' : ""}>
      <td><span class="size-pill">S${group.size}</span></td>
      <td>${slotCell}</td>
      <td class="weapon-name">${pickerHtml}</td>
      <td><span class="dtype ${dt}">${dt}</span></td>
      <td class="num">${fmt(weapon.alpha)}${group.count > 1 ? ` <span class="muted">(×${group.count}=${fmt(weapon.alpha * group.count)})</span>` : ""}</td>
      <td class="num">${fmt(effDpsTotal)}${group.count > 1 ? ` <span class="muted">(${fmt(effDpsOne)}×${group.count})</span>` : (range > 0 && effDpsOne !== weapon.dps_sustained_60s ? ` <span class="muted">(${fmt(weapon.dps_sustained_60s)})</span>` : "")}</td>
      <td class="num">${fmt(weapon.ammo_speed)} m/s</td>
      <td class="num">${tofCell}</td>
      <td>${
        willPen
          ? `<span class="tag good">pen</span>${dpsAfter ? ` <span class="muted">→ ${fmt(dpsAfter * group.count)} eff.</span>` : ""}`
          : `<span class="tag bad">blocked</span>${typeof dthr === "number" ? ` <span class="muted">α=${fmt(weapon.alpha)} ≤ ${fmt(dthr)}</span>` : ""}`
      }</td>
    </tr>`);
  }

  // Non-gun slot groups
  if (result.otherGroups.length) {
    rows.push(`<tr><td colspan="9" class="muted" style="background:var(--panel-2);padding:4px 10px;font-size:10px;text-transform:uppercase;letter-spacing:0.05em">Other slots (no weapon catalogue)</td></tr>`);
    for (const g of result.otherGroups) {
      const countLabel = g.count > 1 ? `${g.count}× ` : "";
      rows.push(`<tr>
        <td><span class="size-pill">${g.size ? `S${g.size}` : "S?"}</span></td>
        <td><span class="slot-mult">${countLabel}</span><span class="slot-type">${g.leaves[0]?.type || ""}</span> <span class="muted">${prettyPort(g.parent)}</span></td>
        <td colspan="7" class="muted">—</td>
      </tr>`);
    }
  }

  // Totals row
  const totalDps = result.picks.reduce((s, p) => {
    if (!p.weapon) return s;
    const e = range > 0 ? effectiveDps(p.weapon, range) : p.weapon.dps_sustained_60s;
    return s + e * p.group.count;
  }, 0);
  const totalGuns = result.picks.reduce((s, p) => s + p.group.count, 0);

  $$(side, ".loadout-box").innerHTML = rows.length ? `
    <table class="loadout">
      <thead><tr>
        <th>Size</th><th>Slot</th><th>Weapon</th><th>Type</th>
        <th class="num">Alpha</th><th class="num">${dpsHeader} (total)</th><th class="num">Velocity</th>
        <th class="num">ToF</th>
        <th>Vs. target armor</th>
      </tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
    <div class="muted" style="padding:6px 12px;font-size:11px;border-top:1px solid var(--border)">
      <strong>Total: ${totalGuns} gun${totalGuns === 1 ? "" : "s"} · ${fmt(totalDps)} DPS${range > 0 ? ` @ ${range >= 1000 ? `${range/1000} km` : `${range} m`}` : ""}</strong>
      ${result.anchorSpeed != null ? ` &nbsp;·&nbsp; pip anchor ${result.anchorSpeed} m/s (±${PIP_TOLERANCE})` : ""}
      ${range > 0 ? ` &nbsp;·&nbsp; ref ToF ${REFERENCE_TOF}s` : ""}
    </div>
  ` : `<div class="empty">no weapon hardpoints on this ship</div>`;
}

/** Format TTK in seconds → "12.3s" / "2m 30s" / ">10m". */
function fmtTTK(t) {
  if (t == null || !isFinite(t)) return "?";
  if (t < 10)  return `${t.toFixed(1)}s`;
  if (t < 60)  return `${Math.round(t)}s`;
  if (t < 600) return `${Math.floor(t/60)}m ${Math.round(t%60)}s`;
  return ">10m";
}

/** TTK to strip the target's armor (we don't model hull HP).
 *  Returns null if no weapon can damage the target. */
function computeArmorTTK(picks, targetArmor, range) {
  if (!targetArmor || !targetArmor.health) return null;
  let totalDps = 0;
  for (const { weapon, group } of picks) {
    if (!weapon) continue;
    const dt = damageType(weapon);
    if (dt === "unknown") continue;
    const alphaForType = weapon[`alpha_${dt}`] || 0;
    const threshold    = targetArmor.deflection_threshold?.[dt] || 0;
    if (alphaForType <= threshold) continue;        // alpha-gate fails
    const baseDps = weapon.dps_sustained_60s || 0;
    const hf      = hitFactor(weapon, range);
    const durMult = targetArmor.durability_multiplier?.[dt] ?? 1;
    totalDps += baseDps * hf * durMult * group.count;
  }
  if (totalDps <= 0) return null;
  return targetArmor.health / totalDps;
}

function renderVulnerability(side, result, ship) {
  const weapons = result.picks.map(p => p.weapon).filter(Boolean);
  if (!weapons.length) {
    $$(side, ".vulnerability-box").innerHTML = "";
    return;
  }
  const range = getRange(side);

  // Split ARMOR rows into kill-list (with TTK) and immune-list.
  const canHit  = [];
  const cantHit = [];
  for (const a of ARMOR) {
    if (a.ship === ship.name) continue;            // don't list yourself
    const target = SHIPS_BY_NAME[a.ship];
    if (target && isShipDisabled(target)) continue; // hidden ships stay out of the lists
    const ttk = computeArmorTTK(result.picks, a, range);
    if (ttk == null) cantHit.push(a);
    else             canHit.push({ armor: a, ttk });
  }
  canHit.sort((a, b) => a.ttk - b.ttk);             // fastest kill first
  cantHit.sort((a, b) =>
    (CLASS_ORDER.indexOf(b.class) - CLASS_ORDER.indexOf(a.class)) ||
    a.ship.localeCompare(b.ship)
  );

  // Build chip HTML with a data-search attribute we can match in client-side filter.
  const searchKey = a => (`${a.ship} ${a.manufacturer || ""} ${a.class || ""}`).toLowerCase()
    .replace(/"/g, "&quot;");
  const greenChips = canHit.map(({armor: a, ttk}) => `
    <span class="chip good" data-search="${searchKey(a)}" title="${a.ship} · ${a.class} · armor ${a.health} HP · TTK ${ttk.toFixed(2)}s">
      <span class="cls">${a.class?.[0] || "?"}</span> ${a.ship}
      <span class="ttk">${fmtTTK(ttk)}</span>
    </span>`).join("");

  const redChips = cantHit.map(a => `
    <span class="chip" data-search="${searchKey(a)}" title="${a.ship} · ${a.class} · deflection: P${a.deflection_threshold.physical} E${a.deflection_threshold.energy} D${a.deflection_threshold.distortion}">
      <span class="cls">${a.class?.[0] || "?"}</span> ${a.ship}
    </span>`).join("");

  // Ensure filter state exists (defensive — could be loaded from older session).
  if (!STATES[side].vulnFilter) STATES[side].vulnFilter = { can: "", cant: "" };
  const f = STATES[side].vulnFilter;
  const esc = s => String(s || "").replace(/"/g, "&quot;");

  $$(side, ".vulnerability-box").innerHTML = `
    <div class="header-row good-row">
      <span>Can damage <span class="muted">(TTK = time to strip armor; hull not modeled)</span></span>
      <span class="count vuln-count-can ${canHit.length ? "good" : ""}">${canHit.length} target${canHit.length === 1 ? "" : "s"}</span>
    </div>
    ${canHit.length ? `
      <div class="vuln-filter-row">
        <input type="search" class="vuln-filter vuln-filter-can" placeholder="filter by ship / manufacturer / class..." value="${esc(f.can)}" autocomplete="off" />
      </div>
      <div class="list vuln-list-can">${greenChips}</div>
    ` : '<div class="empty-list">no targets reachable with this loadout</div>'}
    <div class="header-row">
      <span>Can't damage with this loadout</span>
      <span class="count vuln-count-cant ${cantHit.length === 0 ? "good" : ""}">${
        cantHit.length === 0
          ? `✓ none — this loadout threatens every ship`
          : `${cantHit.length} immune`
      }</span>
    </div>
    ${cantHit.length ? `
      <div class="vuln-filter-row">
        <input type="search" class="vuln-filter vuln-filter-cant" placeholder="filter by ship / manufacturer / class..." value="${esc(f.cant)}" autocomplete="off" />
      </div>
      <div class="list vuln-list-cant">${redChips}</div>
    ` : ""}
  `;

  // Wire input events. Filter changes do CSS display toggling — no re-render —
  // so typing keeps focus and doesn't recompute the loadout.
  const canIn  = $$(side, ".vuln-filter-can");
  const cantIn = $$(side, ".vuln-filter-cant");
  if (canIn) canIn.addEventListener("input", e => {
    STATES[side].vulnFilter.can = e.target.value;
    applyVulnFilter(side, "can");
  });
  if (cantIn) cantIn.addEventListener("input", e => {
    STATES[side].vulnFilter.cant = e.target.value;
    applyVulnFilter(side, "cant");
  });

  // Apply current filter on initial render (preserves filter across re-renders).
  applyVulnFilter(side, "can");
  applyVulnFilter(side, "cant");
}

/** Toggle CSS display on chips matching the filter, update the count badge.
 *  No DOM rebuild — keeps the <input> focused while the user types. */
function applyVulnFilter(side, which) {
  const q = (STATES[side].vulnFilter?.[which] || "").trim().toLowerCase();
  const listEl = $$(side, which === "can" ? ".vuln-list-can" : ".vuln-list-cant");
  if (!listEl) return;
  let total = 0, shown = 0;
  for (const chip of listEl.querySelectorAll(".chip")) {
    total++;
    const text = chip.getAttribute("data-search") || "";
    const matches = !q || text.includes(q);
    chip.style.display = matches ? "" : "none";
    if (matches) shown++;
  }
  const countEl = $$(side, which === "can" ? ".vuln-count-can" : ".vuln-count-cant");
  if (!countEl) return;
  if (which === "can") {
    countEl.textContent = q
      ? `${shown} of ${total} shown`
      : `${total} target${total === 1 ? "" : "s"}`;
  } else {
    if (total === 0) {
      countEl.textContent = `✓ none — this loadout threatens every ship`;
    } else {
      countEl.textContent = q ? `${shown} of ${total} shown` : `${total} immune`;
    }
  }
}

function render(side) {
  // Default: render both visible sides if no arg.
  if (side === undefined) {
    for (const s of SIDES) if (isSideVisible(s)) render(s);
    return;
  }
  const sel = $$(side, ".ship-pick");
  const shipName = sel.value;
  const ship = SHIPS.find(s => s.name === shipName) || SHIPS_SORTED[0] || SHIPS[0];
  // Clear this side's manual picks when its ship changes (slots differ across ships).
  if (ship && STATES[side].lastShip !== ship.name) {
    STATES[side].manuals.clear();
    STATES[side].lastShip = ship.name;
  }
  const armor = ship ? ARMOR_BY_SHIP[ship.name] : null;
  renderShipInfo(side, ship, armor);
  if (!ship) {
    $$(side, ".loadout-box").innerHTML = '<div class="empty">no ship selected</div>';
    $$(side, ".vulnerability-box").innerHTML = "";
    return;
  }
  const mode = getMode(side), pref = getPref(side), range = getRange(side), dmgType = getDmgType(side);
  const result = pickLoadout(side, ship, mode, pref, range, dmgType);
  renderLoadout(side, result, ship, armor, range);
  renderVulnerability(side, result, ship);
  wirePickerEvents(side);
}

/** Attach change handlers to a side's per-slot dropdowns. Called after every render of that side. */
function wirePickerEvents(side) {
  for (const sel of $$all(side, "select.weapon-picker")) {
    sel.addEventListener("change", e => {
      const slotKey = e.target.getAttribute("data-slot");
      const value = e.target.value;
      if (value === "") {
        STATES[side].manuals.delete(slotKey);   // back to auto
      } else {
        STATES[side].manuals.set(slotKey, value);
      }
      render(side);
    });
  }
}

load().catch(err => {
  console.error(err);
  $("#status").innerHTML = `<span style="color:var(--bad)">load error: ${err.message}</span>`;
});
