# Mars Atlas

A browser-based Mars terrain field station built on the `heightmap` branch. Explore seven regional heightmaps, inspect terrain measurements, and draw elevation cross-sections in one integrated interface.

Development branch: `terrian-analysis-integration`.

## Open online — no setup

**[Explore the updated Mars Atlas](https://mars-atlas-explorer.rick-1354.chatgpt.site/#Jezero%20Crater)**

Share this link with anyone who wants to try the app. They do not need Git, Python, or a downloaded project folder. This is the published Mars Atlas app; the earlier MarsPath prototype has a separate link.

## Which way should I open it?

| Method | What opens | When to use it |
| --- | --- | --- |
| Hosted link above (`https://…chatgpt.site`) | The published copy, served over the internet | Exploring or sharing with others; works while your computer is off |
| Local launcher (`http://127.0.0.1:…`) | The files in your own downloaded project folder | Developing and testing changes; keep the launcher running |
| Double-click `index.html` (`file://…`) | A file directly from your disk | The full app cannot load this way because browsers restrict its module and data requests; use the online link or launcher instead |

`127.0.0.1` (also called `localhost`) means **the computer opening the link**. Sending your local address to a teammate will not open your app on their computer. Each teammate can run their own local copy, or everyone can use the hosted link.

The hosted app is a published snapshot. Pulling or pushing this GitHub branch does **not** automatically update the hosted site; it must be published again. Local edits affect only your local copy until committed and pushed, and teammates must pull those commits to receive them.

## Run locally

To get the latest branch updates, open a terminal in your existing `computer-graphics-project` folder and run:

```sh
git fetch origin
git switch terrian-analysis-integration
git pull --ff-only origin terrian-analysis-integration
```

Use Python 3 and launch the complete project folder:

- **Mac:** double-click `start.command`.
- **Windows:** double-click `start.bat`.
- **Terminal (Mac/Linux):** `python3 start.py`.
- **Terminal (Windows):** `py start.py`.

The launcher opens the app in your browser and prints its local address. Keep its window open while exploring. It serves the project directory regardless of your terminal's current folder, sets the correct JavaScript types for module files, and automatically chooses another local port if 8765 is busy. No packages need to be installed.

Do not double-click `index.html`: browsers block the module and terrain-data requests from a `file://` page. The app now explains how to launch instead of leaving the loading screen spinning.

For an existing static web server, serve this directory over HTTP and ensure `.mjs` and `.js` files use a JavaScript content type (for example, `text/javascript`). The app reports failed imports and a stalled startup with recovery instructions and expandable error details. Direct relative imports avoid requiring import-map support.

Three.js 0.168.0 and OrbitControls are vendored with their MIT license. OrbitControls has one local import-path adjustment so it shares the same Three.js module as the app. Google Fonts are optional; the interface falls back to system fonts when offline. The app needs a WebGL-capable browser.

## Explore

- **Regions:** Jezero Crater, Olympus Mons, Valles Marineris, Gale Crater, Hellas Planitia, Elysium Mons, and Argyre Planitia. Existing project assets are integrated through `data/sites.json`.
- **Four layers:** surface, elevation, physical ground slope, and local roughness, with matching legends.
- **Inspection:** click the terrain for geographic coordinates, elevation, slope, and roughness. The analysis panel also offers an accessible map-center sample.
- **Gentler ground:** change the slope limit to see the share of mapped area below that limit. Find gentle ground ranks local neighborhoods by slope and roughness and places an inspection marker.
- **Cross-sections:** choose Profile, then click a start and end point. A line on the terrain and an elevation chart show the result. “Trace across this region” offers an alternative to pointer selection.
- **Scene controls:** drag to orbit, right-drag to pan, scroll/pinch to zoom, use the overhead view or flyover, change the light direction, toggle contours, and adjust vertical exaggeration (default 4×). Press **R** to reset the camera and **?** for the field guide.
- **Export:** field notes download as JSON, including source metadata, methods, regional statistics, the selected sample, and all profile points.
- **Responsive interface:** desktop sidebars become keyboard-accessible drawers on smaller screens. Region URLs can be bookmarked using their fragment.

## Analysis and data quality

Measurements use decoded original heightmaps and geographic bounds, independently of visual exaggeration, lighting, and interpolation of the display mesh. No procedural height noise is added to the terrain. See [analysis methods](docs/ANALYSIS.md) for formulas, assumptions, and limitations.

The project-supplied maps are labeled NASA MOLA MEG128, encoded as 8-bit grayscale, and distributed with regional elevation ranges. They are suitable for exploratory comparisons, not mission planning or landing/rover safety decisions. The source rasters have not been independently revalidated against NASA products in this change.

## Test

With Node.js 20 or later:

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p "test_*.py"
```

Analytical fixtures test flat terrain, a known tilted plane, local bumps, geographic orientation, interpolation, profile distance, and invalid inputs. Catalog tests check that every region has its heightmap and spatial metadata. See [testing notes](docs/TESTING.md) for the browser checks.

## Project structure

| File                      | Purpose                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| `index.html`              | Semantic interface, inline icon definitions, and module imports             |
| `app.css`                 | Visual design, responsive layouts, focus states, and reduced-motion support |
| `js/app.mjs`              | Three.js scene, interaction, resource cleanup, charts, and export           |
| `js/terrain-analysis.mjs` | Pure numerical analysis, independent of the renderer                        |
| `data/sites.json`         | Integrated catalog and bounds for all seven regions                         |
| `data/`, `output/`        | Original project heightmaps and metadata                                    |
| `vendor/three/`           | Pinned rendering dependency and license                                     |
| `tests/`                  | Dependency-free Node tests                                                  |

The upstream `heightmap` and `main` branches are not modified. Integration work is isolated on the development branch.
