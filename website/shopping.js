// ============================================================
// Hardpoint — shopping.js  (loadout "shopping list" modal)
// Collects the weapons currently chosen for a ship's hardpoints and shows a
// modal with Cornerstone (cstone.space) "where to buy" deep-links, an
// open-all-in-tabs action, and copy-as-text. Mirrors Strata's shopping list.
// Relies on app.js globals: SHIPS, pickLoadout, weaponKey, getMode/getPref/
// getRange/getDmgType, $$.
// ============================================================

// cstone ship-weapon links: { internal_lower: cstone_id }. Lazy-loaded once,
// so the first modal open has the URLs ready before "open all" fires.
let _cstoneWeaponLinks = null;
async function _ensureCstoneLinks() {
  if (_cstoneWeaponLinks) return _cstoneWeaponLinks;
  try {
    _cstoneWeaponLinks = await fetch('cstone_weapon_links.json?v=' + Date.now()).then(r => r.json());
  } catch (_) {
    _cstoneWeaponLinks = {};   // tolerate a missing file (older deploys)
  }
  return _cstoneWeaponLinks;
}

const CSTONE_WEAPONS_BROWSE = 'https://finder.cstone.space/ShipWeapons';
function cstoneWeaponUrl(internal) {
  const id = _cstoneWeaponLinks && _cstoneWeaponLinks[(internal || '').toLowerCase()];
  return id ? `https://finder.cstone.space/ShipWeapons1/${id}` : null;
}

/** Aggregate the weapons chosen for a side's ship into { ship, items:[{w,count}] }. */
function collectLoadout(side) {
  const sel = $$(side, '.ship-pick');
  const ship = SHIPS.find(s => s.name === (sel && sel.value));
  if (!ship) return null;
  const result = pickLoadout(side, ship, getMode(side), getPref(side), getRange(side), getDmgType(side));
  const byKey = new Map();
  for (const p of result.picks) {
    if (!p.weapon) continue;
    const k = weaponKey(p.weapon);
    if (!byKey.has(k)) byKey.set(k, { w: p.weapon, count: 0 });
    byKey.get(k).count += (p.group.count || 1);
  }
  const items = [...byKey.values()].sort(
    (a, b) => (b.w.size || 0) - (a.w.size || 0) || a.w.name.localeCompare(b.w.name));
  return { ship, items };
}

async function openWeaponShopping(side) {
  await _ensureCstoneLinks();
  const kit = collectLoadout(side);
  if (!kit || !kit.items.length) { _shopToast('No weapons selected for this ship'); return; }
  openShoppingModal(kit);
}

function openShoppingModal(kit) {
  closeShoppingModal();
  const allUrls = [];
  const totalGuns = kit.items.reduce((s, i) => s + i.count, 0);
  const textLines = [`Hardpoint loadout — ${kit.ship.name} (${totalGuns} weapon${totalGuns === 1 ? '' : 's'})`];

  const rowsHtml = kit.items.map(({ w, count }) => {
    const url = cstoneWeaponUrl(w.internal);
    if (url) allUrls.push(url);
    const qty = count > 1 ? `${count}× ` : '';
    const dps = typeof w.dps_sustained_60s === 'number'
      ? ` · ${Math.round(w.dps_sustained_60s).toLocaleString()} DPS` : '';
    textLines.push(`• ${qty}${w.name} (S${w.size} ${w.type})${url ? ` — ${url}` : ''}`);
    const badge = url
      ? '<span style="font-size:14px">🛒</span>'
      : '<span style="color:var(--text-dim);font-size:10px">browse cstone</span>';
    return `<a href="${url || CSTONE_WEAPONS_BROWSE}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;margin-top:4px;background:var(--panel-2);border:1px solid var(--border);border-radius:4px">
        <div><strong>${qty}${w.name}</strong>
          <div style="font-size:11px;color:var(--text-dim);margin-top:2px">S${w.size} · ${w.type}${dps}</div>
        </div><div>${badge}</div>
      </div></a>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.id = 'hp-shop-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow:auto';
  overlay.addEventListener('click', e => { if (e.target === overlay) closeShoppingModal(); });

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--panel);border:1px solid var(--border);border-radius:8px;max-width:560px;width:100%;padding:20px;box-shadow:0 8px 32px rgba(0,0,0,0.5)';
  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
      <div>
        <div style="font-size:18px;font-weight:700;color:var(--text)">🛒 Shopping list</div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:4px">${kit.ship.name} · ${totalGuns} weapon${totalGuns === 1 ? '' : 's'}</div>
      </div>
      <button type="button" id="hp-shop-close" style="background:transparent;border:1px solid var(--border);color:var(--text-dim);width:30px;height:30px;cursor:pointer;border-radius:4px;font-size:16px;line-height:1">×</button>
    </div>
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">Click an item to open its Cornerstone (cstone.space) page.</div>
    ${rowsHtml}
    <div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
      <button type="button" id="hp-shop-open-all" style="background:var(--accent);color:#fff;border:none;padding:8px 14px;border-radius:4px;cursor:pointer;font-weight:600;font-size:13px">Open all in new tabs (${allUrls.length})</button>
      <button type="button" id="hp-shop-copy" style="background:transparent;border:1px solid var(--border);color:var(--text);padding:8px 14px;border-radius:4px;cursor:pointer;font-size:13px">Copy as text</button>
    </div>`;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  document.getElementById('hp-shop-close').addEventListener('click', closeShoppingModal);
  const openAll = document.getElementById('hp-shop-open-all');
  if (!allUrls.length) { openAll.disabled = true; openAll.style.opacity = '0.5'; openAll.style.cursor = 'default'; }
  openAll.addEventListener('click', () => openShoppingTabs(allUrls));
  document.getElementById('hp-shop-copy').addEventListener('click', () => copyShoppingList(textLines.join('\n')));

  const esc = e => { if (e.key === 'Escape') { closeShoppingModal(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
}

function closeShoppingModal() {
  document.getElementById('hp-shop-overlay')?.remove();
}

function openShoppingTabs(urls) {
  // Open EVERY tab synchronously inside the click gesture. Browsers attribute all
  // synchronous window.open() calls to the originating user gesture and allow them;
  // deferring any with setTimeout detaches it and the pop-up blocker kills it
  // (that was the Strata "open all (4) only opens 2" bug). Rows stay clickable.
  if (!urls.length) return;
  for (const url of urls) window.open(url, '_blank', 'noopener');
}

function copyShoppingList(text) {
  navigator.clipboard.writeText(text).then(() => _shopToast('✓ Copied to clipboard'))
    .catch(() => prompt('Copy shopping list:', text));
}

function _shopToast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--accent);color:#fff;padding:10px 16px;border-radius:4px;z-index:10000;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,0.4)';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}
