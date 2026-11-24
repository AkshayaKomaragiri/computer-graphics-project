# Terrain analysis methods

## Provenance and decoding

The source assets and metadata already exist in the upstream project. Jezero's geographic bounds come from `data/elevation_metadata.json`; the other six regions use `output/mars_sites_metadata.json`. `data/sites.json` combines these records and points to the original image paths.

For grayscale channel value **g** and the supplied regional elevation range:

```text
height (m) = minimum + (g / 255) × (maximum − minimum)
```

For a given image, the actual decoded minimum and maximum may not reach the supplied endpoints. The interface reports the actual decoded range. Quantization steps range from about 5.9 m for Jezero to about 93.4 m for Olympus Mons. These coarse elevation steps can yield artificial plateaus and zero slopes; the interface's gentle-ground ranking must be read in that context.

The geographic model assumes north is the top row and east the right column, with the first and last sample centers located at the metadata bounds. A full raster geotransform is not supplied. No synthetic height perturbations enter analysis or the displayed mesh.

## Physical slope

Use a spherical Mars with radius **R = 3,389,500 m**. At each row's latitude **φ**, sample spacings are:

```text
dx = R × cos(φ) × longitude span in radians / (width − 1)
dz = R × latitude span in radians / (height − 1)
```

Estimate east-west and north-south derivatives with centered differences. Use one-sided differences on image boundaries. Then:

```text
slope (degrees) = atan(sqrt((dh/dx)² + (dh/dz)²)) × 180 / π
```

This is the slope of the sampled elevation field. It is not the angle of the visually exaggerated mesh. The slope color scale runs from 0° to 15°; values above 15° share the highest color. Point readings retain the full value.

## Local roughness

Fit a plane `h = a x + b z + c` to the available samples in each 3 × 3 neighborhood using least squares and physical sample spacing. Roughness is the root mean squared residual height in meters. Removing planar tilt prevents a smooth slope from being labeled rough simply because it is inclined.

This metric depends on image resolution and geographic footprint. Direct roughness comparisons between differently scaled regions require care. Each region's roughness layer is color-scaled to its own 95th percentile (minimum display ceiling 1 m), with larger values sharing the highest color. Reported point values are not clipped.

## Regional statistics

Mean elevation, mean slope, and the fraction of terrain below the selected slope limit use latitude weights (`cos φ`) and trapezoidal edge weights to approximate area coverage. The gentle-area percentage is an estimate from classified raster samples, not an exact geometric integration of an interpolated surface.

Total mapped area is the spherical rectangle area:

```text
area = R² × longitude span × (sin(north) − sin(south))
```

The elevation distribution histogram uses the same weights.

## Gentle-ground search

Scan interior 3 × 3 neighborhoods and minimize the average of:

```text
slope in degrees + 5 × roughness / max(regional roughness95, 0.01 m)
```

Return the neighborhood center. This exploratory ranking is intentionally separate from the user-selected slope threshold, which controls the area statistic. The search excludes the outer two rows and columns. It does not account for rocks below raster resolution, soil, illumination history, obstacles, vehicle limits, or other operational hazards.

## Cross-sections

Interpolate 129 samples along a straight line between the endpoints in normalized map coordinates. Sample elevations bilinearly from the original raster. Compute each segment's spherical geographic distance with the haversine formula and sum those distances. The path is straight in map coordinates, rather than a great-circle route or a least-cost rover path.

The displayed elevation change is endpoint B minus endpoint A; it is not cumulative ascent. Distances are horizontal geographic distances, not distances along the rendered 3D surface. Sampling more densely improves the line's display, not the raster's underlying information content.

## Rendering and exports

The display uses two bilinear mesh segments per source interval. Horizontal aspect ratio comes from regional ground extents at the middle latitude. Vertical relief defaults to 4× and is independently adjustable. Contours show 20 equal divisions of the region's decoded elevation range. The closed sides and base are display framing, not inferred subsurface geology.

Field-note JSON contains the source path and bounds, supplied encoding range, meters per grayscale level, regional measurements, chosen threshold, selected point, profile samples, display parameters, methods, and limitations. No cloud service is involved in analysis or export.
