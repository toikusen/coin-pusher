"""Build public/models/chest.glb - the bonus chest that rides the machine.

Run headless:
    /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/build_chest.py

Replaces the downloaded low_poly_treasure_chest.glb, styled after a Tripo concept (navy planks,
gold straps over a barrel lid, teal padlock) but authored here so the palette and emissive come
from this project.

Coordinates are local to the chest group. fitProp() scales the model by its X extent to
GAME.chestWidth and re-origins it, and the physics body is that model's bounding box. So the box
is load-bearing and copies the old model's measured bounds exactly:

    width  1.15  = GAME.chestWidth, so fitProp's scale is 1.0
    depth  0.847 = 0.737 x width. physics.test.js assumes 0.74: deeper and the scraper can no
                   longer clear the chest off the upper tray.
    height 0.964 = 0.838 x width. The tuned payout times (config.js chestMass) were measured with
                   this body; a taller box tumbles differently.

The lock faces -Z, towards the player.
"""

import math
import sys
from pathlib import Path

import bmesh
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_lib import (  # noqa: E402  - needs the path above
    ROOT, assign, box, clear_scene, export, linear_rgb, make_material, mirrored, palette,
    standard_materials,
)

OUT = ROOT / "public" / "models" / "chest.glb"

HALF_WIDTH = 0.575
BODY_HALF_DEPTH = 0.40
LID_Y = 0.58             # where the barrel lid springs from the body
LID_RISE = 0.364         # body + rise + strap gauge = 0.964
STRAP = 0.02             # how far a strap stands proud of what it wraps
LID_SEGMENTS = 8


def arch(name, material, x, base_y, half_depth, rise, segments=LID_SEGMENTS):
    """Half-elliptic prism along x, springing from base_y: the barrel lid and its straps."""
    ring = [
        (half_depth * math.cos(math.pi * i / segments), base_y + rise * math.sin(math.pi * i / segments))
        for i in range(segments + 1)
    ]
    count = len(ring)
    # Blender space: bx = x, by = -z_local, bz = y.
    vertices = [(xi, -z, y) for xi in x for z, y in ring]
    faces = [(i, i + 1, count + i + 1, count + i) for i in range(count - 1)]
    faces.append((count - 1, 0, count, 2 * count - 1))  # flat underside
    faces.append(tuple(reversed(range(count))))
    faces.append(tuple(range(count, 2 * count)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.validate()
    # Winding above is by hand; let bmesh point every face outward rather than trust it.
    shell = bmesh.new()
    shell.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(shell, faces=shell.faces)
    shell.to_mesh(mesh)
    shell.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    assign(obj, material)
    return obj


def build():
    clear_scene()
    materials = standard_materials()
    # The chest stands inside the machine under the playfield lights, so it takes the matte
    # treatment the slot machine does - but in shellRaised, not shellDeep: it has to separate from
    # a bed of dark felt and a pile of gold coins, and near-black disappears into the felt.
    wood = make_material("chest_wood", linear_rgb(palette()["shellRaised"]), 0.62, 0.10)
    gold = materials["trim_gold_matte"]
    lock = materials["neon_teal_soft"]

    box("chest_foot", gold, (-HALF_WIDTH, HALF_WIDTH), (0.0, 0.07), (-0.41, 0.41))
    box("chest_body", wood, (-0.545, 0.545), (0.07, LID_Y), (-BODY_HALF_DEPTH, BODY_HALF_DEPTH),
        bevel=0.015)
    arch("chest_lid", wood, (-0.545, 0.545), LID_Y, BODY_HALF_DEPTH, LID_RISE)
    box("chest_seam", gold, (-0.555, 0.555), (LID_Y - 0.03, LID_Y + 0.03), (-0.41, 0.41))

    # Three straps over the lid and down both faces, as on the concept.
    strap_depth = BODY_HALF_DEPTH + STRAP / 2
    for name, x in (("chest_strap_C", (-0.05, 0.05)), ("chest_strap_L", (-0.53, -0.44)),
                    ("chest_strap_R", (0.44, 0.53))):
        box(f"{name}_face", gold, x, (0.07, LID_Y), (-strap_depth, strap_depth))
        arch(f"{name}_lid", gold, x, LID_Y, strap_depth, LID_RISE + STRAP)

    # Hasp and padlock on the front. The padlock is the one lit part: it is what marks the box as
    # a prize from the camera's height, where the straps alone read as stripes.
    box("chest_hasp", gold, (-0.075, 0.075), (0.46, 0.66), (-0.425, -0.41))
    box("chest_padlock", lock, (-0.065, 0.065), (0.30, 0.46), (-0.437, -0.41), bevel=0.012)
    mirrored("chest_rivet", gold, (0.30, 0.34), (0.36, 0.40), (-0.411, -0.40))

    export(OUT)


if __name__ == "__main__":
    build()
