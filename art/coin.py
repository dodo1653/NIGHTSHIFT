# Nightshift's coin image: a real neon sign on a dark brick wall. An amber crescent moon, three green candles rising
# inside it, glass tubes on standoffs with their cable, the glow falling on the bricks.
# blender -b --factory-startup --python art/coin.py -- <out.png> [samples] [res]
import bpy, math, sys, os
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0]) if argv else os.path.abspath("coin.png")
SAMPLES = int(argv[1]) if len(argv) > 1 else 256
RES = int(argv[2]) if len(argv) > 2 else 1500
for o in list(bpy.data.objects): bpy.data.objects.remove(o)
sc = bpy.context.scene

def srgb(h):
    h = h.lstrip("#"); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)
def principled(m):
    return next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

# ---- the wall: dark bricks with worn mortar, bumpy and a little damp
wall = bpy.data.materials.new("wall"); wall.use_nodes = True; nt = wall.node_tree; b = principled(wall)
tc = nt.nodes.new("ShaderNodeTexCoord"); br = nt.nodes.new("ShaderNodeTexBrick")
br.inputs["Scale"].default_value = 1.6; br.inputs["Mortar Size"].default_value = 0.018; br.inputs["Mortar Smooth"].default_value = 0.25
br.inputs["Brick Width"].default_value = 0.5; br.inputs["Row Height"].default_value = 0.18
br.inputs["Color1"].default_value = (*srgb("#2a1f1c"), 1); br.inputs["Color2"].default_value = (*srgb("#1c1615"), 1); br.inputs["Mortar"].default_value = (*srgb("#0e0c0c"), 1)
nz = nt.nodes.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 18; nz.inputs["Detail"].default_value = 10
mix = nt.nodes.new("ShaderNodeMixRGB"); mix.blend_type = "MULTIPLY"; mix.inputs["Fac"].default_value = 0.55
nt.links.new(tc.outputs["Object"], br.inputs["Vector"]); nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
nt.links.new(br.outputs["Color"], mix.inputs["Color1"]); nt.links.new(nz.outputs["Color"], mix.inputs["Color2"])
nt.links.new(mix.outputs["Color"], b.inputs["Base Color"])
rgh = nt.nodes.new("ShaderNodeMapRange"); rgh.inputs["To Min"].default_value = 0.55; rgh.inputs["To Max"].default_value = 0.9
nt.links.new(nz.outputs["Fac"], rgh.inputs["Value"]); nt.links.new(rgh.outputs["Result"], b.inputs["Roughness"])
bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.6; bump.inputs["Distance"].default_value = 0.02
fine = nt.nodes.new("ShaderNodeTexNoise"); fine.inputs["Scale"].default_value = 140; fine.inputs["Detail"].default_value = 8
hmix = nt.nodes.new("ShaderNodeMath"); hmix.operation = "ADD"
nt.links.new(tc.outputs["Object"], fine.inputs["Vector"])
sub = nt.nodes.new("ShaderNodeMath"); sub.operation = "MULTIPLY"; sub.inputs[1].default_value = 0.25
nt.links.new(fine.outputs["Fac"], sub.inputs[0]); nt.links.new(br.outputs["Fac"], hmix.inputs[0]); nt.links.new(sub.outputs["Value"], hmix.inputs[1])
nt.links.new(hmix.outputs["Value"], bump.inputs["Height"]); nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
bpy.ops.mesh.primitive_plane_add(size=14, location=(0, 0.06, 0), rotation=(math.radians(90), 0, 0))
bpy.context.active_object.data.materials.append(wall)

# ---- neon: a glass tube with a hot core
def neon(name, hexcol, strength):
    m = bpy.data.materials.new(name); m.use_nodes = True; p = principled(m)
    col = srgb(hexcol)
    p.inputs["Base Color"].default_value = (*col, 1); p.inputs["Roughness"].default_value = 0.15
    k = "Emission Color" if "Emission Color" in p.inputs else "Emission"
    p.inputs[k].default_value = (*col, 1); p.inputs["Emission Strength"].default_value = strength
    c = p.inputs.get("Coat Weight") or p.inputs.get("Clearcoat")
    if c: c.default_value = 1.0
    return m
AMBER = neon("amber", "#ff6a00", 2.1); GREEN = neon("green", "#14ff58", 2.2); RED = neon("red", "#ff2a2a", 2.2)
dark = bpy.data.materials.new("dark"); dark.use_nodes = True; principled(dark).inputs["Base Color"].default_value = (0.01, 0.01, 0.01, 1); principled(dark).inputs["Roughness"].default_value = 0.4
steel = bpy.data.materials.new("steel"); steel.use_nodes = True; ps = principled(steel); ps.inputs["Base Color"].default_value = (0.6, 0.6, 0.62, 1); ps.inputs["Metallic"].default_value = 1; ps.inputs["Roughness"].default_value = 0.3

def tube(name, pts, m, r=0.045, closed=False):
    cu = bpy.data.curves.new(name, "CURVE"); cu.dimensions = "3D"; cu.bevel_depth = r; cu.bevel_resolution = 6; cu.use_fill_caps = True
    sp = cu.splines.new("POLY"); sp.points.add(len(pts) - 1)
    for i, (x, z) in enumerate(pts): sp.points[i].co = (x, -0.12, z, 1)
    sp.use_cyclic_u = closed
    o = bpy.data.objects.new(name, cu); sc.collection.objects.link(o); o.data.materials.append(m)
    return o
def standoff(x, z):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.022, depth=0.14, location=(x, -0.02, z), rotation=(math.radians(90), 0, 0))
    o = bpy.context.active_object; o.data.materials.append(steel); bpy.ops.object.shade_smooth()

# the crescent: an outer arc and an inner arc whose centre sits up and to the right
R, cx, cz = 1.55, -0.25, 0.05
ox, oz, r2 = 0.62, 0.42, 1.28
def on_circle(a, ccx, ccz, rr): return (ccx + rr * math.cos(a), ccz + rr * math.sin(a))
# walk the outer circle where it's outside the inner one, then the inner circle where it's inside the outer one
icx, icz = cx + ox, cz + oz
inside = lambda x, z, ccx, ccz, rr: (x - ccx) ** 2 + (z - ccz) ** 2 < rr * rr
def arc(ccx, ccz, rr, keep, mid, step=math.radians(0.5)):
    a0 = a1 = mid
    while keep(*on_circle(a0 - step, ccx, ccz, rr)) and a0 - mid > -math.pi: a0 -= step
    while keep(*on_circle(a1 + step, ccx, ccz, rr)) and a1 - mid < math.pi: a1 += step
    n = max(2, int((a1 - a0) / step))
    return [on_circle(a0 + (a1 - a0) * i / n, ccx, ccz, rr) for i in range(n + 1)]
away = math.atan2(-oz, -ox)
outer = arc(cx, cz, R, lambda x, z: not inside(x, z, icx, icz, r2), away)
inner = arc(icx, icz, r2, lambda x, z: inside(x, z, cx, cz, R), away)
pts = outer + inner[::-1]
tube("moon", pts, AMBER, 0.06, closed=True)
for (x, z) in [(cx - R * 0.7, cz + R * 0.71), (cx - R, cz), (cx - R * 0.6, cz - R * 0.8)]: standoff(x, z)

# three candles rising inside the crescent: two green, the middle one a small red pullback
def candle(x, z0, z1, w, wick, m):
    tube("c", [(x - w, z0), (x + w, z0), (x + w, z1), (x - w, z1)], m, 0.04, closed=True)
    tube("w", [(x, z1), (x, z1 + wick)], m, 0.03); tube("w", [(x, z0), (x, z0 - wick * 0.6)], m, 0.03)
candle(0.08, -0.45, 0.05, 0.13, 0.18, GREEN)
candle(0.55, -0.15, 0.18, 0.13, 0.14, RED)
candle(1.02, -0.02, 0.82, 0.13, 0.22, GREEN)

# the cable: down from the moon, off the bottom edge
bpy.ops.curve.primitive_bezier_curve_add(location=(0, 0, 0))
cab = bpy.context.active_object; spn = cab.data.splines[0]
spn.bezier_points[0].co = (cx - 0.4, -0.04, cz - R + 0.02); spn.bezier_points[0].handle_left = (cx - 0.4, -0.04, cz - R + 0.3); spn.bezier_points[0].handle_right = (cx - 0.4, -0.04, cz - R - 0.5)
spn.bezier_points[1].co = (cx + 0.1, -0.03, -3.4); spn.bezier_points[1].handle_left = (cx - 0.5, -0.03, -2.3); spn.bezier_points[1].handle_right = (cx + 0.3, -0.03, -4)
cab.data.bevel_depth = 0.016; cab.data.materials.append(dark)

# ---- a glow on the wall behind each tube (soft area lights the colour of the neon)
def glow(x, z, size, color, energy):
    bpy.ops.object.light_add(type="AREA", location=(x, -0.45, z)); l = bpy.context.active_object
    l.data.size = size; l.data.color = color; l.data.energy = energy; l.rotation_euler = (math.radians(-90), 0, 0)
glow(cx - 0.6, cz, 2.8, (1.0, 0.45, 0.1), 600)
glow(0.55, 0.15, 1.6, (0.2, 1.0, 0.45), 200)

world = bpy.data.worlds.new("w"); sc.world = world; world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.004, 0.005, 0.008, 1)
bpy.ops.object.light_add(type="AREA", location=(2.5, -4, 3)); k = bpy.context.active_object; k.data.size = 4; k.data.energy = 60; k.data.color = (0.6, 0.7, 1.0)
k.rotation_euler = (Vector((0, 0, 0)) - k.location).to_track_quat("-Z", "Y").to_euler()

bpy.ops.object.camera_add(location=(0.45, -6.2, 0.35)); cam = bpy.context.active_object; sc.camera = cam
cam.rotation_euler = (Vector((-0.3, 0, 0.05)) - cam.location).to_track_quat("-Z", "Y").to_euler(); cam.data.lens = 46
cam.data.dof.use_dof = True; cam.data.dof.focus_distance = 6.1; cam.data.dof.aperture_fstop = 4.0

sc.render.engine = "CYCLES"
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for dt in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = dt; prefs.get_devices()
            if any(d.type == dt for d in prefs.devices):
                for d in prefs.devices: d.use = d.type == dt
                sc.cycles.device = "GPU"; break
        except TypeError: pass
except Exception: pass
sc.cycles.samples = SAMPLES; sc.cycles.use_denoising = True
sc.render.resolution_x = sc.render.resolution_y = RES; sc.render.image_settings.file_format = "PNG"
try: sc.view_settings.view_transform = "Standard"; sc.view_settings.look = "None"; sc.view_settings.exposure = 0.2
except TypeError: pass
sc.use_nodes = True
try:
    tree = sc.node_tree; rl = tree.nodes.get("Render Layers"); comp = tree.nodes.get("Composite")
    gl = tree.nodes.new("CompositorNodeGlare"); gl.glare_type = "FOG_GLOW"; gl.quality = "HIGH"; gl.threshold = 0.8; gl.size = 9
    try: gl.mix = -0.35
    except Exception: pass
    tree.links.new(rl.outputs["Image"], gl.inputs["Image"]); tree.links.new(gl.outputs["Image"], comp.inputs["Image"])
except Exception as e: print("no glare", e)
sc.render.filepath = OUT; bpy.ops.render.render(write_still=True)
print("done")
