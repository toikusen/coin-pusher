"""Build public/models/cabinet.glb - the coin pusher's outer shell.

Run headless:
    /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/build_cabinet.py

Design: docs/superpowers/specs/2026-09-08-cabinet-shell-design.md

Coordinates. Every number below is either a world x/y (which never moves) or a model-local z.
layoutGeometry() mounts this model at z = lowerCenterZ and scales it by lowerLength / 9.06
(CABINET_BED_LENGTH in config.js - the authored length, not the default bed's), so
    z_world = lowerCenterZ + (lowerLength / 9.06) * z_local
and because 9.06 / 2 = 4.53, z_local -4.53 is ALWAYS the bed's front lip and +4.53 always its
back lip, whatever the geometry panel says. That is why the front face sits at exactly -4.53:
machineGeometryFor() guarantees the bed lip never crosses the launcher muzzle at -5.2, so
everything at z_local >= -4.53 inherits that guarantee. Move the front face forward of -4.53 and
a long bed pushes it in front of the muzzle, spawning coins inside the panel.

Blender is Z-up, glTF is Y-up, so authoring happens in Blender space:
    bx = wx,  by = -z_local,  bz = wy
"""

import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_lib import (  # noqa: E402  - needs the path above
    ROOT, box, clear_scene, export, linear_rgb, make_material, mirrored, palette, standard_materials,
)

OUT = ROOT / "public" / "models" / "cabinet.glb"

# The fence stops at the pin board's sill (dropZoneZ - 0.1 at the default bed, z_local 2.01) with a
# newel, rather than running on to the back shell: on a foldable the sill sits on the crease, and a
# rail carried past it was drawn up the standing half, so the crease bent it. Six bays still, for
# the lamp chase (CoinPusher.js FENCE_LAMP_BAYS).
FENCE_END = 2.01
FENCE_NEWELS = tuple(-4.38 + (FENCE_END + 4.38) / 6 * j for j in range(7))
FENCE_BAYS = tuple((a + b) / 2 for a, b in zip(FENCE_NEWELS, FENCE_NEWELS[1:]))


def mirror_x(x, side):
    return x if side > 0 else (-x[1], -x[0])


def joined(name, parts):
    """Keep each multi-material fixture in one addressable node."""
    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    parts[0].name = name
    return parts[0]


def build():
    clear_scene()
    materials = standard_materials()
    shell_dark = materials["shell_dark"]
    trim_gold = materials["trim_gold"]
    neon_teal = materials["neon_teal"]
    neon_gold = materials["neon_gold"]
    rail_brass = materials["rail_brass"]
    mint = linear_rgb(palette()["mint"])
    fence_lamp = make_material("fence_lamp", mint, 0.40, 0.0, emission=mint, strength=0.6)

    # --- body -------------------------------------------------------------------------------
    mirrored("shell_side", shell_dark, (4.55, 4.85), (-2.55, 1.58), (-4.53, 5.22), bevel=0.05)
    # Relief stays outboard of the glass; all exposed fence edges share a soft bevel.
    for j, centre in enumerate(FENCE_NEWELS):
        for side in (1, -1):
            joined(f"fence_newel_{j}_{'R' if side > 0 else 'L'}", [
                box("shaft", shell_dark, mirror_x((4.56, 4.76), side),
                    (1.58, 2.30), (centre - 0.10, centre + 0.10), bevel=0.015),
                box("capital", rail_brass, mirror_x((4.54, 4.78), side),
                    (2.30, 2.40), (centre - 0.12, centre + 0.12), bevel=0.015),
                box("finial", shell_dark, mirror_x((4.58, 4.74), side),
                    (2.40, 2.46), (centre - 0.08, centre + 0.08), bevel=0.015),
            ])
    for side in (1, -1):
        joined(f"fence_handrail_{'R' if side > 0 else 'L'}", [
            box("handrail", shell_dark, mirror_x((4.60, 4.78), side),
                (2.25, 2.35), (-4.50, FENCE_END + 0.12), bevel=0.015),
            box("inboard_lip", rail_brass, mirror_x((4.56, 4.60), side),
                (2.29, 2.35), (-4.50, FENCE_END + 0.12), bevel=0.015),
            box("top_bead", rail_brass, mirror_x((4.60, 4.64), side),
                (2.35, 2.375), (-4.50, FENCE_END + 0.12), bevel=0.008),
        ])
    mirrored("fence_lower_rail", shell_dark, (4.50, 4.76), (1.72, 1.80),
             (-4.38, FENCE_END), bevel=0.015)
    for bay, centre in enumerate(FENCE_BAYS, start=1):
        for side in (1, -1):
            joined(f"fence_baluster_{bay}_{'R' if side > 0 else 'L'}", [
                box("baluster", rail_brass, mirror_x((4.50, 4.58), side),
                    (1.80, 2.25), (centre - 0.035, centre + 0.035), bevel=0.015),
                box("neck", rail_brass, mirror_x((4.50, 4.64), side),
                    (2.21, 2.25), (centre - 0.035, centre + 0.035), bevel=0.015),
            ])
        mirrored(f"fence_lamp_{bay}", fence_lamp, (4.49, 4.55), (2.16, 2.24),
                 (centre - 0.16, centre + 0.16), bevel=0.015)
    mirrored("trim_gold_rail_lo", trim_gold, (4.84, 4.86), (-0.025, 0.025), (-4.53, 5.22))
    box("back_shell", shell_dark, (-4.85, 4.85), (-2.55, 3.30), (5.22, 5.42))

    # --- front face: four solid blocks around a |x| <= 4.55, y 0..2.20 opening ---------------
    # Split rather than boolean-cut for one reason: the clearance test reads each node's AABB,
    # and a single panel with a hole in it has an AABB that covers the hole.
    # No member across the top of the opening, at any height. The camera sits at y 5.4 and looks
    # down 26.57 degrees, so a sight line to the bed passes the front plane HIGH and the bed's own
    # far end needs y >= 3.52 to clear, the scraper's top 4.15, the backglass 4.34 - all of them
    # above the shell's own 2.60 roof. A bezel at 2.20..2.60 hid the bed from z -1.30 to -0.14, a
    # 1.16-wide strip across the middle of the payout area. This is also why the downloaded
    # cabinet's window_metal_frame was one of the seven entries in the old cabinetHide list.
    mirrored("front_bezel", shell_dark, (4.55, 4.85), (-2.00, 2.60), (-4.53, -4.33), bevel=0.04)
    box("front_panel_lower", shell_dark, (-4.85, 4.85), (-2.00, 0.00), (-4.53, -4.33))
    # No lit strip along the top of the opening. The camera dips 26.57 degrees, so the opening's
    # top edge sits near the camera and projects across the MIDDLE of the frame - a lit one read as
    # a bright teal bar cutting the machine in half, and horizontal teal is not in the backdrop's
    # language anyway (its horizontals are thin and gold, its teal is vertical). The dark bezel
    # above the opening defines the edge on its own. The two uprights stay: those are the
    # backdrop's light columns, and they read as them.
    mirrored("front_glow", neon_teal, (4.51, 4.55), (0.00, 2.60), (-4.53, -4.50))

    # --- plinth: inset 0.5 so the body overhangs, with the gold ring on the three seen sides --
    box("plinth", shell_dark, (-4.35, 4.35), (-2.76, -2.55), (-4.43, 4.97))
    # The glow marking the body's underside sits on the same plane as the two gold rails above it,
    # 4.84..4.86, not tucked into the plinth's inset. Rendered from the inset it was invisible:
    # 0.08 tall and buried 0.30 behind the body's overhang, lighting nothing, because nothing here
    # casts light - the emissive is a surface the player has to be able to see. Flush on the outer
    # face it reads as the base line the backdrop's planters have. No back leg: the camera lives in
    # front of the machine, so the rear one was geometry nobody could ever see.
    mirrored("plinth_glow", neon_gold, (4.84, 4.86), (-2.52, -2.44), (-4.43, 4.97))

    # No marquee. It was a panel standing on the back shell carrying six concentric neon rings
    # that echoed the backdrop's ceiling rings. Both went when the backdrop's horizon moved up to
    # the camera's eye height: the ceiling rings left the frame, the rings round the slot machine
    # read as a target, and the bare panel was a black block between the slot and the lit hall.

    export(OUT)


if __name__ == "__main__":
    build()
