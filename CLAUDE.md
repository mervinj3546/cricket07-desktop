# Notes for working on this app

Electron wrapper around Dhaiwat's Cricket 07 browser port (https://cricket07.dhaiwat.com,
https://github.com/Dhaiwat10/cricket07-browser). Players are mostly non-technical: keep the README and
in-app text simple.

## Hard rules
- **No EA game files in this repo** (no `.wasm`, `data.gob`, `.cdf`, videos). They download from Dhaiwat's site on first launch.
- **Never modify the engine.** All changes go through `main.js` (page adjustments) and `enhance.js` (WebGPU hooks).
- **Every enhancement must have a Settings toggle and fall back safely** (switch itself off on any GPU error).
- **Test on a scratch `userData` folder, never a player's real data.** Two copies sharing storage once wiped the game files (OPFS).
  The single-instance lock doesn't protect a test script with a different entry point.

## How it fits together
| File | What it does |
|---|---|
| `main.js` | `c07://` scheme (COOP/COEP headers for threads), `adapt()` edits the fetched page (removes analytics, injects CSS + `enhance.js`, widescreen `sizeCanvas`), `startGame()` (backup, names, skip intro, click Play), shortcuts in `before-input-event` (the game swallows keys), Settings window, update toasts, single-instance lock. `DEFAULTS` = setting defaults. |
| `enhance.js` | Graphics, by wrapping WebGPU calls. Options come from the page URL (`gfxQuery`): `fxaa aniso mips sharpen vivid wide msaa upscale`. Post chain on the final frame copy (FXAA/sharpen/vivid/stretch); 4× MSAA via multisampled twins of render targets and pipelines; 2× Catmull-Rom upscale of textures ≤ 512 px; widescreen via viewport scaling + a shader patch. |
| `names.js` | Real names: patches the player table `113964e05e69ab31d264fb8f15c58e5c.cdf` inside `Data/data.gob` (EA BIGF + RefPack) in OPFS, using `real-names.json`. Appends the patched file and repoints the index; `.names-original.json` marks the original so 'original' restores it byte-for-byte. |
| `updates.js` | App updates (GitHub releases API) and engine updates (HEAD ETag = MD5; `index.html` compared with Cloudflare's per-download tag stripped). Engine update downloads to `engine.new`, verifies, keeps `engine.previous`. Restore original names before restarting after an engine update, or the game re-downloads 341 MB. |
| `saves.js`, `screenshot.js` | Save backups (Documents/`<app> Saves`), screenshots (Pictures/`<app> Screenshots`). |
| `settings.html`, `settings-preload.js` | Settings window (⌘, / Ctrl+,). |
| `test/smoke.js`, `.github/workflows/windows-test.yml` | Windows end-to-end test on GitHub (software WebGPU via SwiftShader). Runs on every published release, or manually. |

Storage under `userData`: `engine/` (page + engine), `manifest.json` (game-file list), `settings.json`, `updates.json`; game files in OPFS (`c07game`).
Skip intro = rename OPFS `Data/eaep.vp6` → `eaep.vp6.skip` before the game starts.

## Lessons
- Mip levels: an upscaled texture's level 1 must be the game's texture unchanged (it's what's drawn at normal
  size); distant levels raise alpha only at cut-out edges. Otherwise see-through shading gets heavier (1.4.1 fix).
- Measure picture changes, don't eyeball them: menus and match conditions are random between runs, so compare
  inside one session (live toggles, or read textures back from the GPU) or on a paused frame.
- Post effects must not shift brightness (most of this game's picture is below mid-grey, so a contrast boost darkens it).

## Releasing
1. Bump `version` in `package.json`, commit, push.
2. `npm run dist` (Mac zips) and `npm run dist:win` (Windows installer); both build on a Mac.
3. Rename for the README's fixed "latest" links: `Cricket07-Mac-arm64.zip` → `Cricket07-Mac-Apple-Chip.zip`,
   `Cricket07-Mac-x64.zip` → `Cricket07-Mac-Intel.zip`; Windows is `Cricket07-Windows-Setup.exe`.
4. `gh release create vX.Y.Z <files> --notes "…"` (plain-language notes). Publishing triggers the Windows test;
   check it with `gh run list --workflow windows-test.yml`.
5. Build scripts use `--publish never` (CI has no publish token).

## Known limits
- Online multiplayer doesn't work in the app.
- The licence screen at startup is a still image in the game, not skippable like the intro movie.
- Dhaiwat hasn't replied to https://github.com/Dhaiwat10/cricket07-browser/issues/1 (credit/permission note).
