"""Build public/models/cabinet.glb - the coin pusher's outer shell.

Run headless:
    /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/build_cabinet.py

Design: docs/superpowers/specs/2026-09-08-cabinet-shell-design.md

Coordinates. Every number below is either a world x/y (which never moves) or a model-local z.
layoutGeometry() mounts this model at z = lowerCenterZ and scales it by lowerLength / 9.06, so
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
    ROOT, assign, box, clear_scene, ellipse_ring, export, mirrored, standard_materials,
)

OUT = ROOT / "public" / "models" / "cabinet.glb"

WALL_COLUMNS = (-2.50, -0.50, 1.50, 3.50)
WALL_SPAN = (-4.50, 5.22)    # inner wall, from the front glow's back face to the back shell
PANEL_Y = (0.30, 1.90)
PANEL_INSET = 0.14           # where the frame's opening stands off the column either side
FRAME_GAP = 0.06             # extra opening beyond PANEL_Y / PANEL_INSET
FRAME_BAR = 0.03


def wall_bays():
    """(z0, z1) of each open stretch of inner wall between the light columns."""
    edges = [WALL_SPAN[0]]
    for centre in WALL_COLUMNS:
        edges += [centre - 0.06, centre + 0.06]
    edges.append(WALL_SPAN[1])
    return list(zip(edges[::2], edges[1::2]))


def frame_bars(z0, z1):
    """Four (x, y, z) bars framing a bay's panel, on the +x wall."""
    x = (4.53, 4.55)
    inner_z = (z0 + PANEL_INSET - FRAME_GAP, z1 - PANEL_INSET + FRAME_GAP)
    inner_y = (PANEL_Y[0] - FRAME_GAP, PANEL_Y[1] + FRAME_GAP)
    outer_z = (inner_z[0] - FRAME_BAR, inner_z[1] + FRAME_BAR)
    outer_y = (inner_y[0] - FRAME_BAR, inner_y[1] + FRAME_BAR)
    return [
        (x, (outer_y[0], inner_y[0]), outer_z),
        (x, (inner_y[1], outer_y[1]), outer_z),
        (x, inner_y, (outer_z[0], inner_z[0])),
        (x, inner_y, (inner_z[1], outer_z[1])),
    ]


def mirror_x(x, side):
    return x if side > 0 else (-x[1], -x[0])


def joined(name, parts):
    """Join already-placed boxes into one node, so a frame is one part and not four."""
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
    neon_gold_soft = materials["neon_gold_soft"]

    # --- body -------------------------------------------------------------------------------
    mirrored("shell_side", shell_dark, (4.55, 4.85), (-2.55, 2.60), (-4.53, 5.22), bevel=0.05)
    # Light on the INNER faces, not the outer ones. The camera sits on the centre line, so it
    # never sees the outer faces at all - and because the vertical fov is what is fixed, a
    # near-square viewport crops the machine's full width until about z -3.6, which is why the
    # columns start behind that and not at the front.
    #
    # The rail is one continuous line along the top of each wall, above the glass. Two of them
    # converging on the vanishing point is the backdrop's corridor, seen from inside it.
    mirrored("wall_rail", neon_gold_soft, (4.53, 4.55), (2.15, 2.29), (-4.53, 5.22))
    # Columns read through the side glass, which sits 0.26 inboard at 15% opacity - the backdrop's
    # side-wall columns, at the only depth this camera can actually see them.
    for index, centre in enumerate(WALL_COLUMNS, start=1):
        mirrored(
            f"wall_column_{index}", neon_teal,
            (4.51, 4.55), (0.05, 2.15), (centre - 0.06, centre + 0.06),
        )
        # Gold capital and base, a step wider than the shaft, so each light column reads as a
        # mounted fixture rather than a stripe painted on the wall.
        for side in (1, -1):
            joined(f"wall_column_{index}_caps_{'R' if side > 0 else 'L'}", [
                box("cap", trim_gold, mirror_x((4.49, 4.55), side), y, (centre - 0.10, centre + 0.10))
                for y in ((0.05, 0.15), (2.05, 2.15))
            ])
    # Gold frames in the bays between the columns. A flat texture on these walls was tried and
    # read as nothing: the camera sees them almost edge-on, where painted detail collapses to a
    # line and only lit relief survives. A bevelled raised panel inside each frame was tried too
    # and did not show at all, so the frames stand alone, 0.02 proud of the wall and well outboard
    # of the side glass at 4.25 (cabinet.test.js envelopes).
    for index, (z0, z1) in enumerate(wall_bays(), start=1):
        for side in (1, -1):
            joined(f"wall_frame_{index}_{'R' if side > 0 else 'L'}", [
                box("frame", trim_gold, mirror_x(x, side), y, z)
                for x, y, z in frame_bars(z0, z1)
            ])
    for label, centre_y in (("lo", 0.00), ("hi", 2.45)):
        mirrored(
            f"trim_gold_rail_{label}", trim_gold,
            (4.84, 4.86), (centre_y - 0.025, centre_y + 0.025), (-4.53, 5.22),
        )
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

    # --- marquee: concentric rings, no text - the backdrop prompt says no text, no logos -------
    # Rectangular, not the elliptical disc the design first called for. An ellipse butted
    # against a straight-topped back wall only touches it at x = 0: rendered, the marquee hung in
    # the air with a gap that opened to the full 1.05 minor axis at the tips. A panel whose bottom
    # edge is the wall's top edge is attached everywhere, and the rings carry the motif regardless
    # of what they are mounted on.
    box("marquee_panel", shell_dark, (-4.70, 4.70), (3.30, 5.40), (5.22, 5.42),
        bevel=0.09, bevel_segments=3)
    RING_ASPECT = 0.214  # ry / rx, one ratio for all of them so they read as concentric
    ellipse_ring("marquee_ring_teal", neon_teal, 4.35, 4.30, 4.30 * RING_ASPECT, 0.020, 5.19)
    for index, rx in enumerate((3.74, 3.18, 2.62, 2.06, 1.50), start=1):
        ellipse_ring(f"marquee_ring_g{index}", neon_gold, 4.35, rx, rx * RING_ASPECT, 0.0275, 5.19)

    export(OUT)


if __name__ == "__main__":
    build()
