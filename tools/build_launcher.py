"""Build public/models/launcher.glb - the coin launcher that sits in front of the machine.

Run headless:
    /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/build_launcher.py

Design: docs/superpowers/specs/2026-09-08-cabinet-shell-design.md, section 16.

Coordinates are local to the launcher group, which buildLauncher() places at
(launcherX, 0, GAME.launcherZ = -5.9). So local y IS world y, and local z + 5.9 = world z. Two
numbers are load-bearing rather than aesthetic:

    max local z = 0.70   = launcherMuzzleZ - launcherZ. Coins are released at that plane, so the
                           barrel has to end exactly there or they spawn inside or in front of it.
    min local y = -0.25  = launcherMountY.

Shape follows sight. The camera stands at y 5.4 and z -9.4, so it looks DOWN at this thing and
from BEHIND - the muzzle points away, into the machine. What it can see is the top deck and the
back, and only above y = -0.107, which is where the frame's bottom edge crosses z -5.9. Everything
below that is out of shot; everything above 1.10 starts eating the bed at the longest geometry
setting. So the whole design lives in a 1.2-unit band, and the plan silhouette does the talking.
"""

import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_lib import (  # noqa: E402  - needs the path above
    ROOT, assign, box, clear_scene, export, mirrored, standard_materials, tapered_box,
)

OUT = ROOT / "public" / "models" / "launcher.glb"

MUZZLE_Z = 0.70          # launcherMuzzleZ - launcherZ
MOUNT_Y = -0.25          # launcherMountY
FIN_TOP = 1.05           # see the note on sight above


def ring(name, material, radius, tube, y, z, segments=20, sides=8):
    """Torus in the XY plane, facing the player, for the muzzle."""
    bpy.ops.mesh.primitive_torus_add(
        major_radius=radius, minor_radius=tube,
        major_segments=segments, minor_segments=sides,
        rotation=(0, 0, 0),
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = (1.5707963267948966, 0, 0)
    obj.location = (0, -z, y)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    assign(obj, material)
    return obj


def build():
    clear_scene()
    materials = standard_materials()
    # Every material here is the soft variant. This is the nearest object in the frame, so its
    # emissive covers about five times the screen area the same strip does on the cabinet, and at
    # the cabinet's strengths it blooms over its own body until there is no launcher left to look
    # at - only two bright bars. The body takes shell_raised for the same reason in reverse:
    # nothing lit sits behind it, so near-black leaves it with no silhouette at all.
    body = materials["shell_raised"]
    neon_teal = materials["neon_teal_soft"]
    neon_gold = materials["neon_gold_soft"]

    # Chassis, tapering towards the muzzle. In plan this is an arrow, which is the only thing that
    # tells a player looking straight down at it which way it is pointing - a plain box says
    # nothing, and the barrel itself is too short to read at this distance.
    tapered_box("launcher_chassis", body, (MOUNT_Y, 0.16), (-0.92, 0.62), 0.40, 0.17)
    # Gold down the spine, teal up the fins: the same split the cabinet uses, where every
    # horizontal run is gold and every upright is teal.
    tapered_box("launcher_channel", neon_gold, (0.16, 0.20), (-0.80, 0.66), 0.14, 0.07)

    # Breech block and fins. The fins are the only part of this that clears the frame's bottom
    # edge by any margin, so they carry the silhouette.
    # Mass where the frame can see it. The first cut put the block at y 0.16..0.58 and the chassis
    # below that, which is under the frame's bottom edge at this depth - so the only thing left in
    # the visible band was a pair of 0.06-thick fins, seen edge-on from a camera on the centre
    # line, with no projected area at all. Two glowing caps floating over nothing is exactly what
    # that produced. The block now fills the band, and its rear face is what the player looks at.
    box("launcher_breech", body, (-0.30, 0.30), (0.16, 0.95), (-0.92, -0.34), bevel=0.04)
    # Lit on the rear face, not on top: a -z face still carries cos 0.58 of the view direction,
    # where the top caps that used to do this job sat above a body nobody could see.
    # Matte gold, not neon: the rear face is the launcher's largest surface square to the camera,
    # and at neon_gold_soft its bloom burned it to white and the launcher read as a lamp. Lit
    # lightly it reads as a gold plate, and the code's breathing pulse still has an emissive to ride.
    box("launcher_core", materials["trim_gold_matte"], (-0.11, 0.11), (0.34, 0.80), (-0.96, -0.92))
    mirrored("launcher_vent", neon_teal, (0.19, 0.26), (0.28, 0.86), (-0.95, -0.92))
    # Wings forward of the block, along the barrel, stepping the silhouette down towards the
    # muzzle. Their caps are a thin line now rather than the pair of bars that read as the whole
    # launcher.
    mirrored("launcher_fin", body, (0.24, 0.30), (0.16, FIN_TOP), (-0.34, 0.20), bevel=0.03)
    mirrored("launcher_fin_glow", neon_teal, (0.24, 0.30), (FIN_TOP, FIN_TOP + 0.03), (-0.34, 0.20))

    # Barrel and muzzle. The ring's far face lands on MUZZLE_Z exactly.
    box("launcher_barrel", body, (-0.13, 0.13), (-0.06, 0.18), (0.20, 0.66))
    ring("launcher_muzzle", neon_teal, 0.125, 0.028, 0.06, MUZZLE_Z - 0.028)

    export(OUT)


if __name__ == "__main__":
    build()
