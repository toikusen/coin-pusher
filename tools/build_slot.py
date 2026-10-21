"""Build public/models/slot.glb - the bonus stage's slot machine.

Run headless:
    /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/build_slot.py

Replaces the downloaded "stylized jackpot slot machine", which was a beige-and-red arcade cabinet
standing in the middle of a navy neon hall. Same reasoning as the cabinet (design doc section 1):
authoring it here means the palette, the emissive strengths and the reel window all come from this
project rather than being fitted around someone else's model.

Coordinates are local to the slot group. fitProp() scales the model by its own X extent to
GAME.slotWidth, re-origins it centred in x and z and standing on y = 0, then places the group at
(0, GAME.slotY, GAME.slotZ). Authoring x at exactly +-1.12 makes that scale 1.0, so every number
below is world units, local y IS metres above slotY, and local z + slotZ is world z.

Three fixed facts drive the shape:

    height <= 1.24   The camera (0, 5.4, -9.4) dipping 26.57 degrees sees up to y 5.82 at z -4,
                     and the machine stands on slotY 4.55. Anything taller is cropped.
    faces -Z         The player is at -Z, so this model is authored facing them and GAME.slotYaw
                     is 0. The downloaded one faced +Z, which is what that PI was for.
    reel_glass       One pane, x +-0.60, carrying the material buildBonusStage() looks for. It
                     measures that pane's box and lays the canvas readout 0.01 in front of it, so
                     the pane's width is what the three symbols get divided across - which is why
                     the mullions sit on exact thirds of it and not on some cosmetic spacing.

Nothing here is bright. The readout is an unlit canvas plane whose brightness cannot be turned
up, so it only reads as the focal point while everything around it stays under it: the body is the
matte pair rather than the cabinet's polished one, the only real neon is the two teal uprights,
and the crown's rings are a thin outline instead of the marquee's gauge. See the notes at each.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_lib import (  # noqa: E402  - needs the path above
    ROOT, box, clear_scene, ellipse_ring, export, mirrored, standard_materials,
)

OUT = ROOT / "public" / "models" / "slot.glb"

HALF_WIDTH = 1.12        # GAME.slotWidth / 2 - fixes the fit scale at 1.0
WINDOW = (-0.70, 0.70)   # reel pane, divided in three by the readout
WINDOW_Y = (0.40, 0.85)
FACE_Z = (-0.28, -0.12)  # front plates; their back face is the recess floor


def build():
    clear_scene()
    materials = standard_materials()
    body = materials["shell_matte"]
    trim_gold = materials["trim_gold_matte"]
    trim_teal = materials["trim_teal_matte"]

    # --- plinth ---------------------------------------------------------------------------
    # The machine hangs in the cabinet's opening with the lit hall behind it, so its underside is
    # the one edge that needs drawing: a gold line on the front face, as the cabinet's plinth has.
    # trim_gold like the rail above it. The cabinet's plinth_glow is real neon because it marks the
    # base of a 9-unit body seen at 12 units; the same strip on a 1.2-unit body at 6 is a bar as
    # wide as the reel window and twice its brightness, sitting directly under it. Nothing on this
    # machine is allowed to be brighter than the readout - that is the whole point of the object.
    box("slot_plinth", body, (-HALF_WIDTH, HALF_WIDTH), (0.00, 0.09), (-0.34, 0.32),
        bevel=0.02)
    box("slot_plinth_glow", trim_gold, (-0.86, 0.86), (0.03, 0.05), (-0.35, -0.34))

    # --- body: a solid core with the front face split around the reel opening ---------------
    # Split rather than boolean-cut, for the same reason the cabinet's front face is: the model
    # tests read one AABB per node, and a panel with a hole in it has an AABB covering the hole.
    box("slot_core", body, (-1.00, 1.00), (0.09, 0.94), (-0.12, 0.30), bevel=0.04)
    box("slot_face_lower", body, (-1.00, 1.00), (0.09, 0.40), FACE_Z, bevel=0.03)
    box("slot_face_upper", body, (-1.00, 1.00), (0.85, 0.94), FACE_Z, bevel=0.03)
    mirrored("slot_face_side", body, (0.72, 1.00), (0.40, 0.85), FACE_Z, bevel=0.03)
    # No gold line under the window. There were three, then two, then one, and every version of
    # it did the same thing: a horizontal bar directly under the reels, on the centre line, is
    # exactly where playfieldFill puts its highlight, so whatever the material it ends up as a
    # bright pool between the reels and the skirt. The skirt is matte and dark now, which is the
    # only state in which nothing competes with the readout. The base line below and the crown's
    # rings above are the horizontals this machine gets.

    # --- reel bay -------------------------------------------------------------------------
    # The pane sits 0.15 back from the face, so the opening reads as a recess. At this camera the
    # window is nearly edge-on in elevation (2.3 degrees below the eye), so that depth costs about
    # 0.006 of the visible pane - a recess you can see the depth of without losing the readout.
    box("slot_reel_glass", materials["reel_glass"], WINDOW, WINDOW_Y, (-0.13, -0.12))
    # Mullions on the exact thirds of the pane, standing 0.015 proud of the canvas readout, so the
    # three symbols look like three drums rather than one strip of text. Metal trim, not neon: a
    # divider that glows competes with the win glow it is supposed to be framing.
    third = (WINDOW[1] - WINDOW[0]) / 6
    mirrored("slot_mullion", trim_gold, (third - 0.012, third + 0.012), WINDOW_Y, (-0.17, -0.155))

    # --- side pylons ------------------------------------------------------------------------
    # The teal uprights. On the front face rather than the outer flanks: the camera stands on the
    # centre line, so it never sees an outward-facing surface on a model this narrow.
    mirrored("slot_pylon", body, (1.00, HALF_WIDTH), (0.09, 1.00), (-0.30, 0.30), bevel=0.03)
    mirrored("slot_pylon_glow", trim_teal, (1.03, 1.09), (0.16, 0.92), (-0.32, -0.30))

    # --- crown: the marquee's concentric rings, at the size that survives here ---------------
    # Two rings, not the marquee's six. The cabinet's are 4.3 wide and 12 units away; these are a
    # fifth of that at half the distance, and a third ring inside these two closes to a 0.03 hole
    # that renders as a filled gold pill.
    #
    # Gauge is the whole game up here. At the cabinet's 0.020-0.0275 tube these two rings put more
    # bloomed area on screen than the reel window does, and the machine reads as a glowing halo
    # with a slot somewhere under it - the crown is meant to frame the reels, not outrank them.
    # Halving the tube halves the emissive area and, because bloom spill scales with the energy
    # behind it, cuts the glow around it by more than that. Thin and bright is neon; thick and
    # bright is a lamp.
    box("slot_crown", body, (-0.94, 0.94), (0.94, 1.18), (-0.24, 0.28),
        bevel=0.05, bevel_segments=3)
    RING_ASPECT = 0.13   # ry / rx - flatter than the marquee's 0.214, which is all the crown has
    ellipse_ring("slot_ring_teal", trim_teal, 1.06, 0.84, 0.84 * RING_ASPECT, 0.011, -0.25)
    # The inner one is gold TRIM, not gold neon. Two concentric emitters 0.3 apart bloom into each
    # other whatever their gauge, and gold is the brighter of the two by luminance.
    ellipse_ring("slot_ring_gold", trim_gold, 1.06, 0.52, 0.52 * RING_ASPECT, 0.014, -0.25)

    export(OUT)


if __name__ == "__main__":
    build()
