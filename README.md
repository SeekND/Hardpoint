# Hardpoint

Star Citizen ship-loadout analyser. Per-slot best-weapon picker with engagement-range,
time-to-kill, and "can / can't damage" analysis vs every other ship.

Live → https://seeknd.github.io/Hardpoint/

## Features

- **Per-slot best-weapon picker** with three target tiers — Base, Same class, Punch up
- **Engagement-range model** — 200 m / 1 km / 2 km / 3 km. Time-of-flight × hit-factor adjusts effective DPS; out-of-range weapons drop from the pool
- **Pip alignment** — "Closest pips" mode anchors on manual picks
- **Damage-type filter** — Any / Ballistic / Energy
- **Per-slot manual override** with a dropdown listing every fitting weapon
- **Vulnerability analysis** — live-filtered "Can damage" (sorted by TTK) and "Can't damage" lists
- **VS mode** — compare two ships side-by-side, each with independent state
- **Catalog config** (`catalog.html`) — disable ships, force weapons to specific ships, edit hardpoints, export/import config

## Disclaimer

Unofficial Star Citizen fansite, not affiliated with Cloud Imperium Games. All ship/weapon/armor names, stats, and identifiers are property of CIG.
