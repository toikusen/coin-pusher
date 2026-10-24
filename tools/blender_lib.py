"""Shared Blender helpers for the model build scripts in this directory.

Coordinates. Every build script authors in the space its loader expects, expressed as
(world x, world y, local z) and converted here:

    bx = x,  by = -z,  bz = y

which is Blender's Z-up laid out so a +Y-up glTF export lands the model back in three.js space
with no rotation, no fit and no offset. What "local z" means is the loader's business: for the
cabinet it is world z + 0.17, for the launcher it is world z + 5.9.
"""

import math
import re
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parent.parent

# ellipse_ring path segments and bevel sides. The slot's crown rings are a large share of that
# model's triangle budget; this is the first dial to turn if a file needs to be smaller.
RING_SPANS = 8           # per Bezier span, x4 spans = 32 path segments
RING_BEVEL_RES = 1       # 6 sides, flats facing z


def palette():
    """Read PALETTE's hex values out of config.js so the colours have one source of truth."""
    source = (ROOT / "src" / "game" / "config.js").read_text()
    block = re.search(r"export const PALETTE = Object\.freeze\(\{(.*?)\n\}\);", source, re.S)
    if not block:
        raise SystemExit("PALETTE block not found in src/game/config.js")
    found = dict(re.findall(r"^\s*(\w+):\s*0x([0-9a-fA-F]{6}),", block.group(1), re.M))
    if not found:
        raise SystemExit("PALETTE block matched but held no 0xRRGGBB entries")
    return found


def srgb_to_linear(channel):
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def linear_rgb(hex_string):
    value = int(hex_string, 16)
    return tuple(srgb_to_linear(((value >> shift) & 0xFF) / 255) for shift in (16, 8, 0))


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, colour, roughness, metallic, emission=None, strength=0.0):
    # No use_nodes = True: new materials already ship a node tree, and the flag is on its way out.
    material = bpy.data.materials.new(name)
    bsdf = material.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*colour, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    return material


def standard_materials():
    """The machine's whole material set, so every model in it is made of the same four things.

    Colours come from config.js PALETTE (see palette()); nothing here invents one. Emissive goes
    out as KHR_materials_emissive_strength, which three.js reads straight into emissiveIntensity,
    and the scene's bloom pass takes it from there.
    """
    hexes = palette()
    return {
        "shell_dark": make_material("shell_dark", linear_rgb(hexes["shellDeep"]), 0.18, 0.85),
        # A lighter body tone for props that stand against nothing. shell_dark works on the
        # cabinet because the lit hall sits behind it and the silhouette is cut by contrast; the
        # launcher hangs in an empty foreground, where near-black has no edge to be read by.
        # Matte, the tray inlays' finish: at 0.70 metal / 0.30 rough it was mostly a mirror, and
        # since the environment became the neon hall, whose brightest thing is a white panel
        # overhead, what it mirrored was flat grey - a grey block in a navy and gold machine.
        "shell_raised": make_material("shell_raised", linear_rgb(hexes["shellRaised"]), 0.55, 0.25),
        "rail_brass": make_material("rail_brass", linear_rgb(hexes["gold"]), 0.34, 0.80),
        "trim_gold": make_material(
            "trim_gold", linear_rgb(hexes["gold"]), 0.26, 0.92,
            emission=linear_rgb(hexes["gold"]), strength=0.35,
        ),
        "neon_teal": make_material(
            "neon_teal", linear_rgb(hexes["mint"]), 0.40, 0.0,
            emission=linear_rgb(hexes["mint"]), strength=3.0,
        ),
        "neon_gold": make_material(
            "neon_gold", linear_rgb(hexes["gold"]), 0.40, 0.0,
            emission=linear_rgb(hexes["gold"]), strength=2.5,
        ),
        # Softer variants, for emissive that lands close to the camera or covers a long run.
        # Apparent area, not world size, is what drives bloom: the launcher sits about 5.5 along
        # the view axis where the machine's middle sits at 12, so the same strip covers roughly
        # (12/5.5)^2 - call it five times - the screen area there that it does on the cabinet.
        "neon_teal_soft": make_material(
            "neon_teal_soft", linear_rgb(hexes["mint"]), 0.40, 0.0,
            emission=linear_rgb(hexes["mint"]), strength=1.2,
        ),
        # Its own, dimmer gold. Intensity has to fall as lit area grows: the cabinet's wall rails
        # are nine and a half units each, and at the rings' 2.5 they cross the bloom threshold
        # along their whole length and read as one thick white band.
        "neon_gold_soft": make_material(
            "neon_gold_soft", linear_rgb(hexes["gold"]), 0.40, 0.0,
            emission=linear_rgb(hexes["gold"]), strength=1.4,
        ),
        # Near-matte body, for anything standing inside the machine rather than around it. The
        # two tones above are polished: at metallic 0.7-0.85 and roughness 0.18-0.30 they are
        # mostly a mirror, and what they mirror is envMap - the lit hall - which is fine on the
        # cabinet's walls, seen at a grazing angle from the centre line. Head-on it is a milky
        # grey haze with a specular hot spot in it, and the slot machine is the one thing here
        # that faces the camera square. Rough and barely metallic keeps its own colour instead.
        "shell_matte": make_material("shell_matte", linear_rgb(hexes["shellDeep"]), 0.62, 0.12),
        # Its gold counterpart, and for the same reason plus one: playfieldFill is a 5.2-intensity
        # point light 1.5 units in front of the slot machine, on the centre line. trim_gold at
        # metallic 0.92 / roughness 0.26 answers that with a mirror highlight at the exact centre
        # of every horizontal bar, bright enough to clear the bloom threshold - a gold line with a
        # flare pinned to the middle of it. Rougher spreads the lobe until there is no pinpoint.
        "trim_gold_matte": make_material(
            "trim_gold_matte", linear_rgb(hexes["gold"]), 0.55, 0.55,
            emission=linear_rgb(hexes["gold"]), strength=0.30,
        ),
        # And the teal, at a strength that lights the strip without lighting anything around it.
        # neon_teal_soft's 1.2 is the launcher's number, and the launcher is allowed to be the
        # brightest thing in its own corner of the frame. Nothing on the slot machine is: it is a
        # readout in a box, and the box has to stay behind the readout.
        "trim_teal_matte": make_material(
            "trim_teal_matte", linear_rgb(hexes["mint"]), 0.55, 0.20,
            emission=linear_rgb(hexes["mint"]), strength=0.45,
        ),
        # The slot machine's reel panes. Its only job is to be a surface the loader can find by
        # material name (GAME.slotReelMaterial) and measure, so the canvas readout knows where to
        # go; the readout then covers it completely. Unlit and unique to that one part.
        "reel_glass": make_material("reel_glass", linear_rgb(hexes["glassTint"]), 0.15, 0.0),
    }


def assign(obj, material):
    obj.data.materials.clear()
    obj.data.materials.append(material)


def box(name, material, x, y, z, bevel=0.0, bevel_segments=1):
    """Axis-aligned box from (world x, world y, local z) ranges, each a (min, max) pair."""
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.active_object
    obj.name = name
    # Blender Y is -z_local, so the local-z range flips.
    spans = [x, (-z[1], -z[0]), y]
    obj.location = tuple((lo + hi) / 2 for lo, hi in spans)
    obj.scale = tuple(max(hi - lo, 1e-6) for lo, hi in spans)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if bevel > 0:
        modifier = obj.modifiers.new("bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = bevel_segments
        modifier.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    assign(obj, material)
    return obj


def mirrored(name, material, x, y, z, bevel=0.0, bevel_segments=1):
    """Two boxes at -x and +x. `x` is the positive-side (min, max)."""
    return [
        box(f"{name}_L", material, (-x[1], -x[0]), y, z, bevel, bevel_segments),
        box(f"{name}_R", material, x, y, z, bevel, bevel_segments),
    ]



def tapered_box(name, material, y, z, x_back, x_front):
    """A box that narrows towards +z. Eight vertices, six quads, no modifier.

    The launcher reads mostly from above and behind, so its silhouette in plan is most of what it
    communicates - and a plain box in plan says nothing about which way it points.
    """
    (y0, y1), (z0, z1) = y, z
    corners = []
    for zi, half in ((z0, x_back), (z1, x_front)):
        for yi in (y0, y1):
            corners.append((-half, -zi, yi))
            corners.append((half, -zi, yi))
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 2, 6, 4), (1, 5, 7, 3), (0, 4, 5, 1), (2, 3, 7, 6)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(corners, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    assign(obj, material)
    return obj


def ellipse_ring(name, material, centre_y, rx, ry, tube, z_local):
    """Uniform-gauge tube swept along an elliptical path, facing the player.

    The ellipse is baked into the curve's control points and the tube comes from bevel_depth, so
    the gauge stays uniform all the way round. Scaling a torus object by ry/rx instead (0.214
    here) would squash the tube to 0.012 and the ring would read as a hairline, not neon.
    """
    bpy.ops.curve.primitive_bezier_circle_add(radius=1)
    obj = bpy.context.active_object
    obj.name = name
    curve = obj.data
    points = curve.splines[0].bezier_points
    # Freeze the handles BEFORE scaling. A bezier circle ships AUTO handles, and AUTO means
    # Blender recomputes them from the control points on every edit - so scaling co into an
    # ellipse gets the handles re-derived by the auto-smoothing rule, which overshoots the short
    # axis by 20% at this aspect ratio (measured: ry 0.92 came out 1.124). FREE keeps the circle's
    # own handles, and scaling all three vectors together is then an exact affine map of the
    # circle - which is exactly an ellipse, because Bezier curves are affine-invariant.
    for point in points:
        point.handle_left_type = "FREE"
        point.handle_right_type = "FREE"
    for point in points:
        for attribute in ("co", "handle_left", "handle_right"):
            vector = getattr(point, attribute)
            vector.x *= rx
            vector.y *= ry
    curve.resolution_u = RING_SPANS
    curve.bevel_mode = "ROUND"
    curve.bevel_depth = tube
    curve.bevel_resolution = RING_BEVEL_RES
    curve.use_fill_caps = True
    # Curve local XY (the ellipse plane) -> world XY, normal towards the player.
    obj.rotation_euler = (math.pi / 2, 0, 0)
    obj.location = (0, -z_local, centre_y)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.active_object
    obj.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    assign(obj, material)
    return obj


def export(out_path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(out_path),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
    )
    triangles = sum(
        len(obj.data.loop_triangles)
        for obj in bpy.data.objects
        if obj.type == "MESH" and (obj.data.calc_loop_triangles() or True)
    )
    print(f"[{out_path.stem}] {len(bpy.data.objects)} nodes, {triangles} tris -> {out_path}")
