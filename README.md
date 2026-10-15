# Hearthvale

A browser town that grows into a city over 150 years. You are its council. You don't place buildings or roads. You rule on what the town's people and institutions bring to you, and the town grows its own way from there. Roads wear in where people walk. Institutions form when the town needs them. Early choices compound, so every valley ends up different.

## Run

```sh
npm install
npm run dev        # open http://127.0.0.1:5173
```

Requires WebGL 2. The local decision model and narrator are optional: without them, residents use local rules and notes use template text. To connect them, copy `local.env.example` to `local.env` and add the key. The key stays on the local Node server and never reaches the browser.

## Play

- **Docket (right rail):** requests that need your ruling, one crest per institution. Click a crest to open it; click again to tuck it away. Drag the panel's edge to resize it. `C` toggles it.
- **Views (left rail):** the Rule Book, People, Tensions, Chronicle, Places and Map.
- **Time:** pause, 1×, 3× and 8×. Space pauses.
- **Tap a person or building** to read a short note about them. A small refresh icon lights up when something has changed.
- **Keys:** `F` toggles full screen, `H` gives a clean view without the interface.
- **On phones:** use the icon strip at the bottom of the sheet. Add the game to your Home Screen to play full screen.
- **Saves:** the game saves itself in the browser (IndexedDB). Settings has export, import, "start from seed", and new town.

## Develop

```sh
npm test                    # node test suite
npm run build
node scripts/boot-check.js  # fails if the game doesn't boot on the real renderer
```

See [HANDOFF.md](HANDOFF.md) for the architecture, decision-model details, known gaps and tooling. `docs/design/` holds the design specs.

`PERFORMANCE.md` describes the earlier version of the game and is kept for history.
