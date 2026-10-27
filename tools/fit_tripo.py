"""Fit a Tripo-generated GLB into the game as public/models/<kind>_tripo.glb.

Run headless:
    /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/fit_tripo.py -- chest <source.glb>
    /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/fit_tripo.py -- slot <source.glb>

A generated model cannot go in as it comes. Each kind has a box the game depends on:

    chest  The bounding box is the physics body (see build_chest.py), so the model is squashed
           non-uniformly onto exactly the box build_chest.py authors - Tripo's chests come out
           0.83-0.88 deep for every 1 wide, past the 0.74 the scraper can clear.
    slot   fitProp() scales it uniformly by width, so only the width is fixed; the height has a
           ceiling (build_slot.py: 1.24, or the camera crops it). buildBonusStage() finds the reel
           window by GAME.slotReelMaterial, so a reel_glass pane is added over the window.

Both are turned to face the player at -Z (Tripo exports them facing +Z) and get their textures
downsized - 2K is wasted on a prop a few hundred pixels across - and graded towards the machine.
Tripo paints saturated, glossy colour and has no emissive channel, so its blues can read
violet-bright against the navy cabinet and its gloss mirrors the hall (the milky haze
blender_lib.py's matte materials exist to avoid). Blue texels are brought to shellRaised's
brightness and saturation, only ever down; warm ones are pulled from orange to PALETTE.gold.

Tripo's mint is only paint, so it sits flat next to the cabinet's lit columns. The art is prompted
with solid flat #00C8B4 for exactly this reason: texels that read as mint are copied into an
emissive map of their own, and those parts light the way blender_lib.py's neon does.
"""

import math
import sys
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blender_lib import ROOT, box, clear_scene, standard_materials  # noqa: E402  - needs the path above

TEXTURE_SIZE = 1024
# shellRaised 0x142235 is value 0.21, saturation 0.62. The value target sits a little above it:
# a painted texture's median includes its highlights.
BLUE_VALUE_TARGET = 0.28
BLUE_SATURATION_TARGET = 0.62
ROUGHNESS_FLOOR = 0.55   # trim_gold_matte's roughness
METAL_SCALE = 0.5
GOLD_GREEN = 0.78        # green-to-red floor on warm texels, just under PALETTE.gold's 0.83
# Mint texels: green dominant over red, blue close behind green. Measured on both generations the
# matches are 1% (the chest's padlock) and 4% (the slot's pillars), and the slot's dark-teal reel
# glass, #1D5C66, falls well under the green floor.
MINT_GREEN_FLOOR = 0.45
# Emission strength per kind. The padlock is the chest's one lit part and reads small from the
# camera; the slot's pillars stay under the reel readout (build_slot.py: nothing there is bright).
GLOW_STRENGTH = {"chest": 1.2, "slot": 0.6}

# Blender space (Z-up): x width, y depth (+y is the player's side, local -z), z height.
CHEST_BOX = (1.15, 0.847, 0.964)   # build_chest.py
SLOT_WIDTH = 2.24                  # GAME.slotWidth
SLOT_MAX_HEIGHT = 1.24             # build_slot.py
# The reel window inside the gold frame, as fractions of the fitted model's width and height,
# measured off an orthographic front render of this one generation. Regenerate the slot and these
# have to be measured again.
SLOT_WINDOW_X = (0.127, 0.875)
SLOT_WINDOW_Z = (0.157, 0.785)


def source_image(socket):
    """The image texture feeding a BSDF input, through the importer's Separate Color if any."""
    node = socket.links[0].from_node if socket.links else None
    while node is not None and node.type != "TEX_IMAGE":
        node = node.inputs[0].links[0].from_node if node.inputs and node.inputs[0].links else None
    return node.image if node else None


def edit_pixels(image, change):
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    pixels = pixels.reshape(-1, 4)
    change(pixels)
    image.pixels.foreach_set(pixels.ravel())
    image.update()


def grade_base(pixels):
    rgb = pixels[:, :3]
    blue = (rgb[:, 2] > rgb[:, 0]) & (rgb[:, 2] > rgb[:, 1])
    if blue.any():
        texels = rgb[blue]
        value = texels.max(axis=1)
        saturation = (value - texels.min(axis=1)) / np.maximum(value, 1e-6)
        darken = min(1.0, BLUE_VALUE_TARGET / float(np.median(value)))
        desaturate = min(1.0, BLUE_SATURATION_TARGET / float(np.median(saturation)))
        grey = texels.mean(axis=1, keepdims=True)
        rgb[blue] = (grey + (texels - grey) * desaturate) * darken
        print(f"[grade] blue texels x{darken:.2f} value, x{desaturate:.2f} saturation")
    warm = (rgb[:, 0] > rgb[:, 1]) & (rgb[:, 1] > rgb[:, 2])
    rgb[warm, 1] = np.maximum(rgb[warm, 1], rgb[warm, 0] * GOLD_GREEN)


def grade_metal_roughness(pixels):
    # glTF packs roughness in G and metalness in B.
    pixels[:, 1] = np.maximum(pixels[:, 1], ROUGHNESS_FLOOR)
    pixels[:, 2] *= METAL_SCALE


def add_glow(model, strength):
    """Copy the mint texels of the base colour into an emissive map and wire it up."""
    tree = model.active_material.node_tree
    bsdf = next(node for node in tree.nodes if node.type == "BSDF_PRINCIPLED")
    base = source_image(bsdf.inputs["Base Color"])
    width, height = base.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    base.pixels.foreach_get(pixels)
    pixels = pixels.reshape(-1, 4)
    red, green, blue = pixels[:, 0], pixels[:, 1], pixels[:, 2]
    mint = (green > MINT_GREEN_FLOOR) & (red < 0.5 * green) & (blue > 0.6 * green)
    pixels[~mint, :3] = 0.0
    pixels[:, 3] = 1.0
    glow = bpy.data.images.new(f"{model.name}_glow", width, height)
    glow.pixels.foreach_set(pixels.ravel())
    glow.pack()
    node = tree.nodes.new("ShaderNodeTexImage")
    node.image = glow
    # Same UVs as the base colour: the importer feeds that texture straight off UVMap.
    tree.links.new(node.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = strength
    print(f"[glow] {mint.mean():.1%} of texels lit at {strength}")


def extent(obj):
    corners = np.array([v.co[:] for v in obj.data.vertices])
    return corners.min(axis=0), corners.max(axis=0)


def import_single_mesh(source):
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=source)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if len(meshes) != 1:
        raise SystemExit(f"expected one mesh, found {len(meshes)}")
    model = meshes[0]
    for obj in [obj for obj in bpy.context.scene.objects if obj is not model]:
        bpy.data.objects.remove(obj)
    bpy.context.view_layer.objects.active = model
    model.select_set(True)
    # Some exports nest the mesh under a root node; flatten it so the bounds are the mesh's own.
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    # glTF import leaves objects in QUATERNION mode, where rotation_euler is silently ignored.
    model.rotation_mode = "XYZ"
    model.rotation_euler.z += math.pi
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return model


def fit_box(model, size):
    """Scale onto `size` (None keeps that axis proportional to x), centre x/y, stand on z = 0."""
    low, high = extent(model)
    span = high - low
    uniform = size[0] / span[0]
    model.scale = tuple(uniform if s is None else s / span[axis] for axis, s in enumerate(size))
    bpy.ops.object.transform_apply(scale=True)
    low, high = extent(model)
    offset = (-(low[0] + high[0]) / 2, -(low[1] + high[1]) / 2, -low[2])
    for vertex in model.data.vertices:
        vertex.co.x += offset[0]
        vertex.co.y += offset[1]
        vertex.co.z += offset[2]


def grade_textures(model):
    for image in bpy.data.images:
        if max(image.size) > TEXTURE_SIZE:
            image.scale(TEXTURE_SIZE, TEXTURE_SIZE)
    bsdf = next(node for node in model.active_material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    edit_pixels(source_image(bsdf.inputs["Base Color"]), grade_base)
    edit_pixels(source_image(bsdf.inputs["Roughness"]), grade_metal_roughness)


def add_reel_pane(model):
    """A reel_glass pane on the window's own surface, for the loader to measure.

    The window sits recessed behind its gold frame. buildBonusStage() lays the readout 0.01 in
    front of the pane, so the pane goes on the recessed surface - found by casting a ray at the
    window's centre from the player's side - and the frame stays in front of the readout, as the
    mullions do on build_slot.py's machine.
    """
    low, high = extent(model)
    width, height = high[0] - low[0], high[2] - low[2]
    x = tuple(low[0] + f * width for f in SLOT_WINDOW_X)
    z = tuple(low[2] + f * height for f in SLOT_WINDOW_Z)
    origin = ((x[0] + x[1]) / 2, high[1] + 1.0, (z[0] + z[1]) / 2)
    hit, location, *_ = bpy.context.scene.ray_cast(
        bpy.context.evaluated_depsgraph_get(), origin, (0.0, -1.0, 0.0))
    if not hit:
        raise SystemExit("no window surface behind the reel window's centre")
    surface = location[1]  # +y is the player's side
    # box() takes (world x, world y, local z); local z = -blender y.
    box("slot_reel_glass", standard_materials()["reel_glass"], x, z, (-surface - 0.004, -surface))


def fit():
    kind, source = sys.argv[sys.argv.index("--") + 1:][:2]
    if kind not in ("chest", "slot"):
        raise SystemExit(f"unknown kind {kind!r}: chest or slot")
    model = import_single_mesh(source)
    model.name = f"{kind}_tripo"
    fit_box(model, CHEST_BOX if kind == "chest" else (SLOT_WIDTH, None, None))
    grade_textures(model)
    add_glow(model, GLOW_STRENGTH[kind])
    if kind == "slot":
        low, high = extent(model)
        if high[2] - low[2] > SLOT_MAX_HEIGHT:
            raise SystemExit(f"slot is {high[2] - low[2]:.2f} tall, the camera crops past {SLOT_MAX_HEIGHT}")
        if SLOT_WINDOW_X[1] > SLOT_WINDOW_X[0]:
            add_reel_pane(model)

    out = ROOT / "public" / "models" / f"{kind}_tripo.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(out), export_format="GLB", export_yup=True, export_apply=True,
        export_cameras=False, export_lights=False,
    )
    print(f"[{kind}_tripo] {len(model.data.polygons)} faces -> {out}")


if __name__ == "__main__":
    fit()
