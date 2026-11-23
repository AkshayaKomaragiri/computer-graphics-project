# Mars Atlas

A browser-based Mars terrain field station built on the `heightmap` branch. Explore seven regional heightmaps, inspect terrain measurements, and draw elevation cross-sections in one integrated interface.

Development branch: `terrian-analysis-integration`.

## Run locally

From this repository, run:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). The app needs a WebGL-capable browser. No build or package installation is required. Serve over HTTP rather than opening `index.html` as a local file.

Three.js 0.168.0 and OrbitControls are vendored with their MIT license. Google Fonts are optional; the interface falls back to system fonts when offline. All terrain and analysis work locally.

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
