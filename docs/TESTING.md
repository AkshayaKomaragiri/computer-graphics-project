# Testing notes

## Automated numerical checks

Run `node --test tests/*.test.mjs` with Node.js 20 or later. No test dependencies are installed.

- A constant elevation grid has zero slope and negligible numerical roughness, including edges.
- A plane with an analytical 10° incline recovers 10° slope and negligible roughness.
- A local bump produces a nonzero plane-residual roughness measurement.
- Bilinear sampling preserves north-up orientation, corner heights, and center interpolation, and clamps out-of-bounds coordinates.
- A flat cross-section includes both endpoints, preserves altitude, and integrates the expected geographic distance.
- Invalid grid sizes and inverted bounds fail explicitly.
- The seven-region catalog has unique entries, existing PNG assets, matching image dimensions and bit depths, valid ranges, and complete bounds.

## Browser verification during implementation

Checked in the in-app browser against the locally served branch:

- All seven region buttons load the corresponding model and update the title, overview, and statistics.
- All four visualization layers update the mesh colors and legend.
- Point inspection and the map-center alternative report coordinates, elevation, slope, and roughness.
- Gentle-ground search selects a point and shows its analysis.
- A manually selected two-point cross-section produces a visible line, endpoint markers, geographic length, and elevation chart; clearing it removes the result.
- The west-to-east example cross-section for Jezero measures approximately **44.5 km**, with an endpoint elevation change of approximately **−513 m**.
- Moving Jezero's slope limit from **1° to 25°** changes the gentle-area statistic from approximately **23.9% to 100.0%**.
- Increasing vertical relief leaves the displayed point analysis unchanged.
- Field-note JSON downloaded successfully and was parsed and checked for region, sample coordinates, profile length, all 129 samples, source, and analysis summary.
- Responsive layouts were checked at desktop (1440 × 1000) and phone (390 × 844) sizes. The region and analysis drawers, region switching, sampling, and field guide work in the phone layout.

## Data and verification limits

Browser testing verifies this implementation and the supplied files. It does not independently validate the upstream heightmaps, metadata, geographic registration, or NASA attribution. Eight-bit quantization and the assumed sample registration limit the precision of the measurements; see `ANALYSIS.md`.
