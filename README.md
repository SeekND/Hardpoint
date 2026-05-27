# HARDPOINT

A ship loadout analyser for **Star Citizen**. Pick a ship, see the best weapon for every hardpoint at your chosen engagement range, and find out which ships you can — and can't — punch through.

Live site: [seeknd.github.io/Hardpoint](https://seeknd.github.io/Hardpoint)

---

## Features

### Per-Slot Best-Weapon Picker
For every hardpoint on the selected ship, Hardpoint recommends the highest-output weapon that fits. Three target tiers shape the recommendation:

- **Base** — pure DPS, no opponent assumption
- **Same class** — optimized for fighting ships of equal weight class
- **Punch up** — optimized for taking on heavier ships

### Engagement Range Model
Pick 200 m, 1 km, 2 km, or 3 km and weapons are reranked by *effective* DPS — time-of-flight and hit factor reduce the score for slower projectiles, and out-of-range weapons drop out of the pool entirely.

### Preference Modes
- **Most power** — pure DPS optimization
- **Closest pips** — anchors recommendations on manually picked weapons so the rest of the loadout matches the same capacitor pip cost

### Damage-Type Filter
Restrict the picker to *Any*, *Ballistic*, or *Energy*. Useful when you want to play to a specific tactic or counter a specific enemy.

### Per-Slot Manual Override
Click any slot's weapon dropdown to override the recommendation with any other fitting weapon. The rest of the loadout updates around it.

### Vulnerability Analysis
A live "Can damage" list (sorted by time-to-kill) shows every ship your current loadout can armor-strip, and a "Can't damage" list shows everything resistant to your damage type. Filter both by name, manufacturer, or class.

### VS Mode
Toggle *Compare 2 ships* to load a second ship panel side-by-side, each with independent target tier, preference, range, and damage type. Useful for matchup analysis.

### Catalog Config
The `Catalog config →` page lets you disable ships you don't care about, force specific weapons to specific ships, edit hardpoints, and export/import the config.

---

## Data

The site loads three JSONs at startup — `ships.json`, `weapons.json`, and `armor.json` — containing every ship's hardpoint layout, every weapon's alpha/DPS profile, and per-ship armor stats. These files are updated each patch.

All user data (catalog config, overrides) is stored in your browser's local storage — nothing is sent to a server.

---

## Tech

Pure static site — HTML, CSS, vanilla JS. No frameworks, no build tools, no server. Hosted on GitHub Pages.

---

## Related

- [Forge](https://seeknd.github.io/Forge) — crafting calculator for the RediMake Item Fabricator
- [Strata](https://seeknd.github.io/Strata) — mining reference and route planner
- [Wikelo](https://seeknd.github.io/Wikelo) — Banu trader reference
- [Star Citizen](https://robertsspaceindustries.com) — the game itself

---

## Disclaimer

This site is not endorsed by or affiliated with Cloud Imperium Games or Roberts Space Industries. All game content and materials are copyright Cloud Imperium Rights LLC and Cloud Imperium Rights Ltd. Star Citizen®, Squadron 42®, Roberts Space Industries®, and Cloud Imperium® are registered trademarks of Cloud Imperium Rights LLC.
