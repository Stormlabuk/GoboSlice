# GoboSlice

GoboSlice is a slicer for mask-projection resin printers (DLP and µSL) that runs in the browser. It was built for the
**BMF microArch S140**, and printer profiles let it drive other projectors too.

It ships as a single HTML file, [`dist/goboslice.html`](dist/goboslice.html). There is nothing to install: download the
file and open it in a current Chrome, Edge, Firefox or Safari. All work happens on your machine, and no model data
leaves the browser.

- STL import (binary and ASCII, millimetres). Files that are inside out are fixed automatically.
- 3D view: orbit, pan and zoom. You can move, rotate, scale and mirror parts, lay them flat, select several at once
  and make arrays.
- Supports: added automatically or by hand. A **Platform only** mode keeps every column clear of the part.
- **Magic wand**: orients, arranges and supports every part in one step.
- Sliced-layer preview, with an optional cut of the 3D view at the chosen layer.
- **Design check** before every slice, against the S140 design guide (see [Design check](#design-check)).
- **Seam-aware placement** on stitched profiles: parts lying across an overlap strip between exposure fields get a
  *Seam* badge. Arrange, Magic and newly added parts keep clear of the strips wherever a part fits inside one field.
- Slicing runs in Web Workers, with a main-thread fallback. Undo/redo, a context menu and a built-in self-test are
  included.

## Output

Download ZIP gives you a flat archive:

```
1.png  2.png  3.png  …  preview.png
```

- One PNG per layer, at the projector's native resolution. **White means exposed.** Each PNG is 8-bit greyscale or
  1-bit, as set in the profile.
- Numbering starts at the profile's *First file number*. Zero-padding is optional.
- `preview.png` is a rendered picture of the plate with a caption. It is optional and never used for exposure.

### Pixel mapping

Image row 0 is the **back** edge of the plate (+Y), and column 0 is the **left** edge (−X). The profile's
*Mirror image* setting is applied after that. Each layer is cut at its mid-height, `(n + 0.5) × layer height`.

## Using it

1. Pick a printer profile in the top bar, or open **Printer settings** to edit one.
2. **Open STL** or drag files onto the view. The *test shape* links on the empty plate load built-in samples.
3. Place the parts by hand, or press **Magic**.
4. Check the masks in **Layer preview**. Tick *Cut the 3D view at this layer* to see the same section in 3D.
5. Press **Slice**. The design check runs first; if it finds problems it lists them and asks before slicing.
   Then **Download ZIP**.

Profiles and support settings are kept in the browser's `localStorage`. You can also save them to a JSON file with
*Export JSON* and *Import JSON* in Printer settings.

GoboSlice was previously called Microslice. On first load, profiles and support settings saved under the old
`microslice.*` keys are copied to the new `goboslice.*` keys, unless those already exist.

| Action        | Mouse                                | Touch          |
| ------------- | ------------------------------------ | -------------- |
| Orbit         | drag                                 | one finger     |
| Pan           | right-drag, middle-drag, Shift-drag  | two fingers    |
| Zoom          | wheel                                | pinch          |
| Select        | click (Shift/Ctrl/⌘ to add)          | tap            |
| Move a part   | drag a selected part                 |                |
| Context menu  | right-click                          | long press     |
| Copy / paste  | Ctrl+C / Ctrl+V (⌘ on a Mac): copies land in free space, paste as often as you like | context menu |
| Duplicate     | Ctrl+D                               | context menu   |

## Design check

Before every slice (*Check before every slice*), or on its own with *Run check*, GoboSlice checks the plate against
the S140 design guide at full resolution, without slicing; a typical plate takes about a second. Choose **Recommended**
(prints reliably) or **Advanced** (pushes the process; tick *Rigid material* for 10 mm bridges). Every value can be
changed under *Rule values*, and *Reset to guide values* puts them back.

The check measures each layer, then groups what it finds into **features of the 3D parts**: one thin wall, one gap,
one hole, however many layers it spans. Two lists show the results:

- **Design check**: the parts' own features, whatever their orientation or supports. Each feature is listed under its
  rule with the part it belongs to, its measured size and the limit it breaks, for example
  *thin wall: Too thin: about 0.03 mm, minimum 0.05 mm; 2 × 0.03 × 0.5 mm*. In the 3D view the surfaces of each
  feature are painted in the rule's colour, with a box round it. Click a feature to select its part, frame it and show
  only that feature; click a rule to show only that rule.
- **Print setup**: how the plate is set up to print (orientation, supports and settings), shown as dots in the 3D
  view and circles in Layer preview. *Supports to guide values* sets 0.1 mm cone tops, 0.25 mm cone bases and the
  guide's overhang angle.

| Part design | Recommended | Advanced | Measured as |
| --- | --- | --- | --- |
| Maximum part size | 94 × 52 × 45 mm | | part and supports against the build volume |
| Minimum part size | 1 mm³ | 0.5 mm³ | mesh volume |
| Minimum feature, supported wall | 0.05 mm | 0.01 / 0.02 mm | widest disk that fits the region (error) |
| Minimum unsupported wall | 0.1 mm | 0.05 mm | the same (warning: fine only where supported on both sides) |
| Feature clearance, part spacing | 0.1 mm | 0.05 mm | width of open gaps between features or parts |
| Vertical hole | 0.05 mm | 0.04 mm | width of enclosed holes |
| Horizontal hole | 0.15 mm | 0.1 mm | height of gaps under overhanging part material |
| Pins and pillars | 40 : 1 | 100 : 1 above ø0.1 mm | slender regions followed up the layers |
| Channels | 100 : 1 | 500 : 1 above ø0.1 mm | enclosed holes followed up the layers (vertical channels only) |

| Print setup | Recommended | Advanced | How it is checked |
| --- | --- | --- | --- |
| Islands | none | | each layer region against the layer below, supports included |
| Non-bridged overhang | 0.3 mm | 0.5 mm | new pixels further than this from anything supported below |
| Bridged overhang | 1.5 mm | 5 mm / 10 mm rigid | the same, with support on two opposite sides |
| Unsupported overhang angle | 30° | 20° | downward faces flatter than this with no support contact within half a bridge |
| Layer height | 0.01 – 0.05 mm | | profile |
| Support cone top / base | 0.08 – 0.2 / 0.1 – 1 mm, cone | | support settings |
| Support pillars | 40 : 1 | 100 : 1 above ø0.1 mm | pillar length against its diameter |

- Widths are measured with a disk the nearest odd number of pixels across, so they are reported as *about* a value,
  to within one pixel (10 µm on the S140), and a wall at the minimum passes. Limits under three pixels (the Advanced
  0.01 and 0.02 mm walls on the S140) cannot be measured that way and are not checked; the report says so.
- The part-design rules look at the parts only, so supports touching a part are not gaps. A finding must carry on into
  a neighbouring layer and be a whole feature or at least three minimum widths long, so the rounded-off tips of sharp
  corners and the last slivers of curved surfaces are not reported.
- The check never changes the masks.

## BMF microArch S140 notes

Two presets ship with GoboSlice. *Restore defaults* in Printer settings puts them back as shipped.

| Preset          | Image         | Build volume (X × Y × Z) | Pixel    | Mirror        | Tiling                                   |
| --------------- | ------------- | ------------------------ | -------- | ------------- | ---------------------------------------- |
| **S140 Stitch** | 9400 × 5200 px | 94 × 52 × 45 mm         | 10 µm    | left to right | 5 × 5 fields of 19.2 × 10.8 mm           |
| **S140 Single** | 1920 × 1080 px | 19.2 × 10.8 × 45 mm     | 10 µm    | left to right | none                                     |

- **Stitch.** The 94 × 52 mm image is exposed as a 5 × 5 grid of 19.2 × 10.8 mm projector fields. The fields overlap
  by (5 × 19.2 − 94) / 4 = **0.5 mm** across and (5 × 10.8 − 52) / 4 = **0.5 mm** front to back, which is 50 px each
  way. The overlap strips are shaded on the 3D plate, and the field outlines appear in the layer-preview overlay.
  GoboSlice writes one whole stitched image per layer.
- **Seams.** A part lying across an overlap strip is exposed partly by one field and partly by the next. With
  *Keep parts clear of field seams* (Move panel, on by default) Arrange packs parts into the 18.2–18.7 × 9.8–10.3 mm
  areas between the strips, Magic does the same with room left for support bases, and new parts are dropped clear of
  them. A part bigger than one field has to cross a seam; the *Seam* badge in the parts list shows which ones do.
- **Single.** One 1920 × 1080 field covers 19.2 × 10.8 mm, with no stitching.
- The default layer height is 10 µm. At 45 mm of build height that allows up to 4,500 layers.
- A full Stitch layer is 48.9 megapixels. At 8-bit each PNG is still small, because masks compress well, but slicing
  a tall part takes a while. Every layer goes through the workers, and the progress bar shows how far along it is.
- The overlay in Layer preview (grid, field numbers) is drawn for checking only. It is never written to the PNGs.

### Mirror check

Run this once per printer, and again whenever the optical path is changed.

1. Choose the profile, then load **mirror test** from the empty-plate links. It is an asymmetric "F" made of three
   boxes, 0.4 mm thick.
2. Press **Top** in the view buttons. You are now looking down on the plate, and the F reads normally: the upright on
   the left, the arms pointing right.
3. Slice and print it.
4. Lay the print on the table with its first layer (the side that was on the platform) facing down, and look at it
   from above. **It must read as a normal F, exactly as in the Top view.** If it comes out reversed, change *Mirror
   image* in Printer settings and print again.

With *Mirror image* set to left to right, the **Layer preview** shows the F reversed. That is expected, because the
preview shows the mask as it is sent to the projector.

## Developing

The source lives in `src/` and is joined into `dist/goboslice.html` by a small dependency-free script:

```
src/head.html      licence comment, <head>, all CSS
src/body.html      markup and the three.js <script> tag
src/core.js        gobosliceCore(): CRC, zlib, PNG, rasteriser, worker entry
src/app/*.js       the application, one file per group of sections
build.js           concatenates src/ in a fixed order
```

```sh
npm run build      # write dist/goboslice.html
npm run check      # fail if dist/ is out of date
```

### Tests

```sh
npm install        # dev only: Playwright and three@0.128.0
npm test           # build, then the Node core tests and the browser tests
npm run test:core  # Node only, no browser: rasteriser, PNG, pixel mapping, speed
npm run test:browser
```

- **Node tests** (`test/`) load the real `src/core.js` and the app's pixel-mapping code into a VM:
  - 20,000 px for the 2 × 1 × 1 mm box at z = 1.505 mm on S140 Single (8-bit and 1-bit), checked by decoding the PNG
  - the same mask when the winding is inside out
  - 30,000 px with no holes for two overlapping solids
  - the row/column/mirror mapping, pinned
  - a full 9400 × 5200 layer in well under 1 s
  - island finding: none on the plate, one for a floating box on its first layer only, none for a 45° overhang
  - every design rule on synthetic parts just inside and just outside its limit, and the same results when checked in
    chunks as in one pass
- **Browser tests** (`e2e/`) run `dist/goboslice.html` in Chromium with the real three.js. The page's cdnjs request is
  answered with the identical r128 build from `node_modules/three`, so the tests also run offline. They:
  - slice the sample shapes on both presets, run `unzip -t`, and check PNG count, size, bit depth and lit pixels
  - check that Magic lays the plate flat (0.3 mm) and stands the rod on end (6 mm)
  - close the Printer settings and confirm dialogs every way, including inside sandboxed iframes without
    `allow-forms`
  - run the built-in self-test
  - check the `microslice.*` → `goboslice.*` storage migration
  - check the design check (each rule, Advanced vs Recommended, edited values, Slice asking first, workers and the
    main-thread fallback agreeing) and seam-aware placement
  - check the 3D view: grid lines close up, labels hidden by parts, no section colour at part edges, click-select,
    exact drag-move, orbit, pan and zoom, lay-flat hover, the layer cut, and preview.png

`npm run screenshots` drives the 3D view in Chromium (plate, ruler, orbit, pan, zoom, select, drag, lay flat, supports,
cut view, preview.png, dark theme) and writes screenshots plus a `report.json` of what each interaction did to
`screenshots/`.

`gobosliceCore()` must stay fully self-contained, with no references to anything outside it. Its source text is
copied into the Web Worker blob.

### Dependencies

At runtime GoboSlice loads only **three.js r128** (MIT) from cdnjs and the *Atkinson Hyperlegible Next* font from
Google Fonts. The font falls back to the system font. STL parsing, slicing, PNG encoding and ZIP writing are all
written by hand, in the file.

## Licence

MIT. See [LICENSE](LICENSE).
