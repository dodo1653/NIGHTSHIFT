# The trading floor, rendered in Blender for the site. One isometric orthographic camera for everything, so every
# layer lines up pixel for pixel:
#   room      the shell: floor, walls, night windows, the Scope wall, the launch kiosk (opaque background)
#   desk      one desk + monitor at the reference spot (transparent; the site repeats it per seat)
#   agent     chair + seated agent typing, N frames per look (transparent)
#   empty     the empty chair for a free seat
#   anchors   JSON: pixel positions of every seat and the 4 corners of each screen (for live overlays)
# blender -b --factory-startup --python art/floor_scene.py -- <mode> <outdir> [samples] [look] [frames]
import bpy, bmesh, math, json, sys, os, random
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
MODE = argv[0] if argv else "room"
OUT = os.path.abspath(argv[1]) if len(argv) > 1 else os.path.abspath("out")
SAMPLES = int(argv[2]) if len(argv) > 2 else 96
LOOK = int(argv[3]) if len(argv) > 3 else 0
FRAMES = int(argv[4]) if len(argv) > 4 else 8
RES_X, RES_Y = 2400, 1500
os.makedirs(OUT, exist_ok=True)

for o in list(bpy.data.objects): bpy.data.objects.remove(o)
sc = bpy.context.scene

W, D, H = 26.0, 18.0, 5.2                     # room: x 0..W, y 0..D; back walls at x=0 and y=D
COLS, ROWS = 4, 3
SEATS = [(5.2 + c * 4.6, 4.2 + r * 4.1) for r in range(ROWS) for c in range(COLS)]   # desk centres (x, y)
REF = SEATS[0]

# ---------------------------------------------------------------- materials
def mat(name, color, rough=0.5, metal=0.0, emit=None, strength=0.0, alpha=1.0):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        k = "Emission Color" if "Emission Color" in b.inputs else "Emission"
        b.inputs[k].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = strength
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
    return m

def srgb(h):
    h = h.lstrip("#"); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

# ---------------------------------------------------------------- v2: a real trading office at night
# (spliced into floor_scene.py in place of the v1 materials and pieces; same camera, seats and anchors)
def shader(name, base, rough=0.5, metal=0.0, emit=None, strength=0.0, alpha=1.0, coat=0.0, sss=0.0, noise=0.0, nscale=60.0, bump=0.0, transmission=0.0):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*base, 1); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if emit:
        k = "Emission Color" if "Emission Color" in b.inputs else "Emission"
        b.inputs[k].default_value = (*emit, 1); b.inputs["Emission Strength"].default_value = strength
    if alpha < 1: b.inputs["Alpha"].default_value = alpha
    c = b.inputs.get("Coat Weight") or b.inputs.get("Clearcoat")
    if c and coat: c.default_value = coat
    if sss:
        w = b.inputs.get("Subsurface Weight") or b.inputs.get("Subsurface")
        if w: w.default_value = sss
    if transmission:
        t = b.inputs.get("Transmission Weight") or b.inputs.get("Transmission")
        if t: t.default_value = transmission
    if noise or bump:
        tc = nt.nodes.new("ShaderNodeTexCoord"); nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = nscale; nz.inputs["Detail"].default_value = 8
        nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
        if noise:
            mx = nt.nodes.new("ShaderNodeMixRGB"); mx.blend_type = "MULTIPLY"; mx.inputs["Fac"].default_value = noise
            mx.inputs["Color1"].default_value = (*base, 1); nt.links.new(nz.outputs["Color"], mx.inputs["Color2"]); nt.links.new(mx.outputs["Color"], b.inputs["Base Color"])
        if bump:
            bp = nt.nodes.new("ShaderNodeBump"); bp.inputs["Strength"].default_value = bump; bp.inputs["Distance"].default_value = 0.01
            nt.links.new(nz.outputs["Fac"], bp.inputs["Height"]); nt.links.new(bp.outputs["Normal"], b.inputs["Normal"])
    return m

def wood_mat(name, light, dark, rough=0.38):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tc = nt.nodes.new("ShaderNodeTexCoord"); wv = nt.nodes.new("ShaderNodeTexWave"); wv.inputs["Scale"].default_value = 7.0
    wv.inputs["Distortion"].default_value = 6; wv.inputs["Detail"].default_value = 4; wv.bands_direction = "X"
    rp = nt.nodes.new("ShaderNodeValToRGB"); rp.color_ramp.elements[0].color = (*dark, 1); rp.color_ramp.elements[1].color = (*light, 1)
    nt.links.new(tc.outputs["Object"], wv.inputs["Vector"]); nt.links.new(wv.outputs["Fac"], rp.inputs["Fac"]); nt.links.new(rp.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    c = b.inputs.get("Coat Weight") or b.inputs.get("Clearcoat")
    if c: c.default_value = 0.25
    return m

def city_mat(name, seed, warm=True):
    # a tower face: a grid of windows, a random share lit (brick texture, its own random bias per brick)
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tc = nt.nodes.new("ShaderNodeTexCoord"); mp = nt.nodes.new("ShaderNodeMapping"); mp.inputs["Rotation"].default_value = (0, math.radians(90), 0)
    mp.inputs["Location"].default_value = (seed * 3.1, seed * 1.7, 0)
    br = nt.nodes.new("ShaderNodeTexBrick"); br.inputs["Scale"].default_value = 3.2; br.inputs["Mortar Size"].default_value = 0.06; br.inputs["Bias"].default_value = 0.72
    br.inputs["Brick Width"].default_value = 0.5; br.inputs["Row Height"].default_value = 0.5; br.offset = 0
    br.inputs["Color1"].default_value = (*(srgb("#ffcf8a") if warm else srgb("#bfe3ff")), 1); br.inputs["Color2"].default_value = (0.0, 0.0, 0.0, 1); br.inputs["Mortar"].default_value = (0, 0, 0, 1)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"]); nt.links.new(mp.outputs["Vector"], br.inputs["Vector"])
    b.inputs["Base Color"].default_value = (*srgb("#0b1020"), 1); b.inputs["Roughness"].default_value = 0.6
    k = "Emission Color" if "Emission Color" in b.inputs else "Emission"
    nt.links.new(br.outputs["Color"], b.inputs[k]); b.inputs["Emission Strength"].default_value = 1.1
    return m

M = {
    "floor": shader("floor", srgb("#2b2f36"), 0.24, noise=0.35, nscale=6, bump=0.05),           # polished concrete
    "floorline": shader("floorline", srgb("#22262c"), 0.4),
    "carpet": shader("carpet", srgb("#121519"), 0.95, noise=0.35, nscale=220, bump=0.2),
    "brass": shader("brass", srgb("#c9a15a"), 0.28, 1.0),
    "wall": shader("wall", srgb("#1a1f28"), 0.85, noise=0.15, nscale=12),
    "wallDark": shader("wallDark", srgb("#14181f"), 0.8),
    "slat": wood_mat("slat", srgb("#6b4529"), srgb("#3d2615"), 0.55),
    "trim": shader("trim", srgb("#0d0f13"), 0.35),
    "wood": wood_mat("wood", srgb("#d2b48e"), srgb("#bf9d74")),                                  # white oak desk tops
    "woodDark": wood_mat("woodDark", srgb("#4a3020"), srgb("#2e1d13"), 0.45),
    "steel": shader("steel", srgb("#c3c7cf"), 0.25, 1.0),
    "black": shader("black", srgb("#0e0f12"), 0.32, coat=0.3),
    "frame": shader("frame", srgb("#17191e"), 0.45, 0.6),
    "screen": shader("screen", srgb("#05070a"), 0.15, emit=srgb("#0d1a24"), strength=1.2),
    "green": shader("green", srgb("#4ade80"), 0.4, emit=srgb("#4ade80"), strength=4.0),
    "glass": shader("glass", srgb("#a8c4e0"), 0.03, transmission=1.0, alpha=0.18),
    "plant": shader("plant", srgb("#2f6b35"), 0.5, sss=0.25, noise=0.3, nscale=30),
    "plant2": shader("plant2", srgb("#3f8a3f"), 0.5, sss=0.25, noise=0.3, nscale=30),
    "pot": shader("pot", srgb("#2a2c30"), 0.6, noise=0.2, nscale=40, bump=0.1),
    "chair": shader("chair", srgb("#1b1d22"), 0.6, noise=0.2, nscale=300, bump=0.2),
    "mesh": shader("mesh", srgb("#24272e"), 0.8, noise=0.4, nscale=500, bump=0.3),
    "fabric": shader("fabric", srgb("#3b4252"), 0.9),
    "warm": shader("warm", srgb("#ffd9a0"), 0.5, emit=srgb("#ffcf8a"), strength=8.0),
    "city": shader("city", srgb("#070b16"), 0.9),
    "tower": shader("tower", srgb("#0d1426"), 0.9),
    "neon": shader("neon", srgb("#ff8a1f"), 0.3, emit=srgb("#ff8a1f"), strength=9.0),
    "led": shader("led", srgb("#9ad8ff"), 0.3, emit=srgb("#9ad8ff"), strength=6.0),
    "rubber": shader("rubber", srgb("#121316"), 0.85),
    "ceramic": shader("ceramic", srgb("#efeae2"), 0.25, coat=0.4),
    "white": shader("white", srgb("#e9e6df"), 0.4),
}

def box(name, size, loc, m, bevel=0.03, rot=(0, 0, 0), seg=4):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        b = o.modifiers.new("bev", "BEVEL"); b.width = bevel; b.segments = seg; b.limit_method = "ANGLE"
        try: b.harden_normals = True
        except Exception: pass
    o.data.materials.append(m)
    for p in o.data.polygons: p.use_smooth = True
    return o

def soft(name, size, loc, m, rot=(0, 0, 0), level=2, bevel=0.35):
    # a soft, rounded block (bevelled cube + subdivision): cushions, torsos, sneakers
    o = box(name, size, loc, m, min(size) * bevel, rot, 3)
    s = o.modifiers.new("sub", "SUBSURF"); s.levels = level; s.render_levels = level
    return o

def cyl(name, r, d, loc, m, rot=(0, 0, 0), verts=32):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d, location=loc, rotation=rot, vertices=verts)
    o = bpy.context.active_object; o.name = name; o.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    return o

def sphere(name, r, loc, m, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=40, ring_count=20)
    o = bpy.context.active_object; o.name = name; o.scale = scale; o.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    return o

def seat_light(x, y):
    # a warm pendant over each desk (the fixture is above the frame), plus the screen's cool spill on the agent
    l = bpy.data.lights.new("pend", "AREA"); l.shape = "RECTANGLE"; l.size = 2.4; l.size_y = 0.4; l.energy = 300; l.color = (1.0, 0.86, 0.68)
    o = bpy.data.objects.new("pend", l); sc.collection.objects.link(o); o.location = (x, y + 0.2, 4.6)
    s = bpy.data.lights.new("spill", "AREA"); s.size = 1.6; s.size_y = 0.7; s.shape = "RECTANGLE"; s.energy = 45; s.color = (0.55, 0.75, 1.0)
    so = bpy.data.objects.new("spill", s); sc.collection.objects.link(so); so.location = (x, y + 0.74, 1.6)
    so.rotation_euler = (math.radians(90), 0, 0)   # facing -y, toward the seat
    r = bpy.data.lights.new("rim", "AREA"); r.size = 1.2; r.energy = 90; r.color = (0.8, 0.88, 1.0)     # a soft light from behind the chair
    try: r.use_shadow = False
    except Exception: pass
    try: r.cycles.cast_shadow = False
    except Exception: pass
    ro = bpy.data.objects.new("rim", r); sc.collection.objects.link(ro); ro.location = (x + 0.8, y - 2.6, 3.0)
    ro.rotation_euler = (Vector((x, y - 0.6, 1.1)) - ro.location).to_track_quat("-Z", "Y").to_euler()

# ---------------------------------------------------------------- pieces
def desk(x, y, tag=""):
    parts = []
    parts.append(box("top" + tag, (2.7, 1.3, 0.05), (x, y + 0.35, 0.765), M["wood"], 0.012))
    for dx in (-1.22, 1.22):   # black steel sled legs
        parts.append(box("legF" + tag, (0.06, 0.06, 0.74), (x + dx, y - 0.22, 0.37), M["black"], 0.008))
        parts.append(box("legB" + tag, (0.06, 0.06, 0.74), (x + dx, y + 0.92, 0.37), M["black"], 0.008))
        parts.append(box("legT" + tag, (0.06, 1.2, 0.05), (x + dx, y + 0.35, 0.72), M["black"], 0.008))
        parts.append(box("legS" + tag, (0.06, 1.2, 0.05), (x + dx, y + 0.35, 0.02), M["black"], 0.008))
    parts.append(box("tray" + tag, (2.0, 0.16, 0.08), (x, y + 0.86, 0.66), M["black"], 0.01))       # cable tray
    # an ultrawide monitor on an arm
    parts.append(box("clamp" + tag, (0.12, 0.1, 0.1), (x, y + 0.96, 0.84), M["frame"], 0.01))
    parts.append(cyl("pole" + tag, 0.025, 0.55, (x, y + 0.96, 1.12), M["frame"]))
    parts.append(box("arm" + tag, (0.06, 0.12, 0.05), (x, y + 0.92, 1.38), M["frame"], 0.01))
    mon = box("monitor" + tag, (2.02, 0.05, 0.86), (x, y + 0.88, 1.62), M["black"], 0.018)
    parts.append(mon)
    scr = box("screen" + tag, (1.96, 0.006, 0.8), (x, y + 0.853, 1.62), M["screen"], 0)
    parts.append(scr)
    # keyboard with keys, a mouse on a pad, a ceramic mug, a phone, headphones on a stand
    parts.append(box("kbd" + tag, (0.84, 0.26, 0.022), (x, y + 0.1, 0.80), M["frame"], 0.008))
    for r in range(4):
        parts.append(box("keys" + tag, (0.78, 0.045, 0.012), (x, y + 0.01 + r * 0.06, 0.815), M["trim"], 0.004))
    parts.append(box("pad" + tag, (0.36, 0.28, 0.004), (x + 0.68, y + 0.12, 0.79), M["carpet"], 0.002))
    parts.append(soft("mouse" + tag, (0.07, 0.12, 0.035), (x + 0.68, y + 0.12, 0.81), M["black"]))
    parts.append(cyl("mug" + tag, 0.055, 0.12, (x - 1.0, y + 0.5, 0.85), M["ceramic"]))
    parts.append(box("phone" + tag, (0.08, 0.16, 0.01), (x - 0.72, y + 0.12, 0.795), M["black"], 0.006, rot=(0, 0, math.radians(12))))
    parts.append(box("notebook" + tag, (0.3, 0.22, 0.02), (x + 1.0, y + 0.55, 0.8), M["woodDark"], 0.004, rot=(0, 0, math.radians(-8))))
    return parts, scr

def chair(x, y, tag=""):
    p = []
    p.append(soft("seat" + tag, (0.6, 0.56, 0.12), (x, y - 0.55, 0.5), M["chair"], level=2, bevel=0.45))
    back = soft("back" + tag, (0.56, 0.08, 0.78), (x, y - 0.88, 1.02), M["mesh"], rot=(math.radians(-10), 0, 0), level=2, bevel=0.45)
    p.append(back)
    p.append(soft("head" + tag, (0.36, 0.08, 0.16), (x, y - 0.95, 1.5), M["chair"], rot=(math.radians(-10), 0, 0)))
    for side in (-1, 1):
        p.append(box("armPost" + tag, (0.04, 0.04, 0.2), (x + side * 0.33, y - 0.55, 0.62), M["black"], 0.01))
        p.append(soft("armPad" + tag, (0.07, 0.28, 0.03), (x + side * 0.33, y - 0.52, 0.73), M["chair"]))
    p.append(cyl("post" + tag, 0.035, 0.36, (x, y - 0.55, 0.27), M["steel"]))
    for a in range(5):
        t = a * 2 * math.pi / 5
        p.append(box("spoke" + tag, (0.34, 0.05, 0.035), (x + 0.17 * math.cos(t), y - 0.55 + 0.17 * math.sin(t), 0.08), M["black"], 0.01, rot=(0, 0, t)))
        p.append(sphere("wheel" + tag, 0.035, (x + 0.33 * math.cos(t), y - 0.55 + 0.33 * math.sin(t), 0.035), M["rubber"]))
    return p

LOOKS = [  # hoodie, hair, skin, trousers, headset
    ("#3a4150", "#1d1612", "#e9b896", "#1d2027", "#0f1013"), ("#2c5282", "#5a3a22", "#c98e64", "#202329", "#e7e3db"),
    ("#e8e1d4", "#111111", "#8d5a3b", "#24272e", "#0f1013"), ("#5b2b30", "#c9a46a", "#f1c8a8", "#1d2027", "#0f1013"),
    ("#3f4a3a", "#3a2618", "#e2a882", "#191b20", "#c9a15a"), ("#c26a2c", "#1a1a1a", "#b9785a", "#1d2027", "#0f1013"),
    ("#4a3f6b", "#8f2f22", "#f0c19e", "#202329", "#e7e3db"), ("#7d8794", "#9a9a9a", "#d79f7b", "#2a2e36", "#0f1013"),
]

def limb(a, b, r, m):
    a, b = Vector(a), Vector(b); d = b - a
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=max(0.01, d.length), location=(a + b) / 2, vertices=24)
    o = bpy.context.active_object; o.rotation_mode = "QUATERNION"; o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d)
    o.data.materials.append(m); bpy.ops.object.shade_smooth()
    return o

def look_mats(look):
    hood, hair, skin, pants, hs = [srgb(c) for c in LOOKS[look % len(LOOKS)]]
    return (shader("hoodie%d" % look, hood, 0.92, noise=0.25, nscale=380, bump=0.25),
            shader("hair%d" % look, hair, 0.55, noise=0.4, nscale=900, bump=0.3),
            shader("skin%d" % look, skin, 0.5, sss=0.18),
            shader("pants%d" % look, pants, 0.85, noise=0.2, nscale=400, bump=0.2),
            shader("hs%d" % look, hs, 0.3, coat=0.5))

def head_parts(x, hy, hz, look, mk, mh, mhs, facing=1):
    # a head with hair, an over-ear headset and its mic boom
    p = [sphere("head", 0.19, (x, hy, hz), mk, (1, 1, 1.06))]
    p.append(sphere("hair", 0.2, (x, hy - 0.035 * facing, hz + 0.045), mh, (1.02, 1.02, 0.9)))
    if look % 3 == 1: p.append(sphere("bun", 0.08, (x, hy - 0.17 * facing, hz + 0.12), mh))
    bpy.ops.mesh.primitive_torus_add(major_radius=0.215, minor_radius=0.022, location=(x, hy, hz + 0.02), rotation=(math.radians(90), 0, math.radians(90)))
    band = bpy.context.active_object; band.data.materials.append(mhs); bpy.ops.object.shade_smooth()
    bm = band.modifiers.new("cut", "BOOLEAN")
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, hy, hz - 0.25)); cutter = bpy.context.active_object; cutter.scale = (0.6, 0.6, 0.5)
    bm.object = cutter; bpy.context.view_layer.objects.active = band; bpy.ops.object.modifier_apply(modifier="cut"); bpy.data.objects.remove(cutter)
    p.append(band)
    for side in (-1, 1):
        p.append(cyl("cup", 0.085, 0.07, (x + side * 0.2, hy, hz - 0.01), mhs, rot=(0, math.radians(90), 0)))
    p.append(limb((x - 0.22, hy, hz - 0.04), (x - 0.12, hy + 0.15 * facing, hz - 0.13), 0.012, mhs))
    return p

def agent(x, y, look, phase, pose="type"):
    mh_, mhair, mk, mp, mhs = look_mats(look)
    w = math.sin(phase * 2 * math.pi)
    bob = 0.012 * w if pose == "type" else (0.05 * abs(w) if pose == "cheer" else -0.03)
    sy = y - 0.6
    hz, hy = 1.38 + bob, sy + 0.05
    if pose == "slump": hz, hy = 1.28, sy + 0.17
    p = []
    p.append(soft("torso", (0.5, 0.3, 0.56), (x, sy + (0.05 if pose == "slump" else 0), 0.93 + bob), mh_, level=2, bevel=0.42))
    p.append(soft("hood", (0.36, 0.14, 0.16), (x, sy - 0.13, 1.17 + bob), mh_, rot=(math.radians(18), 0, 0)))   # the hood, down on the back
    p.append(soft("pocket", (0.3, 0.04, 0.12), (x, sy + 0.15, 0.8 + bob), mh_))
    p.append(cyl("neck", 0.07, 0.12, (x, hy, hz - 0.21), mk))
    p += head_parts(x, hy, hz, look, mk, mhair, mhs)
    for side in (-1, 1):
        p.append(soft("thigh", (0.19, 0.5, 0.17), (x + side * 0.13, sy + 0.25, 0.6), mp, level=1))
        p.append(soft("shin", (0.15, 0.15, 0.48), (x + side * 0.13, sy + 0.5, 0.34), mp, level=1))
        p.append(soft("shoe", (0.15, 0.26, 0.09), (x + side * 0.13, sy + 0.56, 0.06), M["white"], level=2))
        sh = Vector((x + side * 0.28, sy + 0.02, 1.1 + bob))
        if pose == "cheer":
            hand = Vector((x + side * (0.38 + 0.04 * w), sy + 0.02, 1.8 + bob + 0.05 * abs(w)))
        elif pose == "slump":
            hand = Vector((x + side * 0.2, sy + 0.32, 0.74))
        else:
            tap = 0.025 * max(0, math.sin((phase + (0 if side < 0 else 0.5)) * 2 * math.pi))
            hand = Vector((x + side * 0.22, y + 0.06, 0.86 + tap))
        el = sh + (hand - sh) * 0.5 + Vector((side * 0.06, -0.08, -0.08))
        p.append(limb(sh, el, 0.075, mh_)); p.append(sphere("elbow", 0.075, tuple(el), mh_))
        p.append(limb(el, hand, 0.068, mh_)); p.append(sphere("cuff", 0.07, tuple(hand + (el - hand).normalized() * 0.05), mh_))
        p.append(sphere("hand", 0.058, tuple(hand), mk, (1, 1.2, 0.8)))
    piv = Vector((x, sy, 0.45))
    for o in p:
        o.scale = o.scale * 1.22; o.location = piv + (o.location - piv) * 1.22
    return p

def walker(x, y, look, phase, heading):
    """A colleague walking, built facing +y and turned to `heading` (radians about z)."""
    mh_, mhair, mk, mp, mhs = look_mats(look)
    sw = math.sin(phase * 2 * math.pi)
    bob = 0.03 * abs(math.cos(phase * 2 * math.pi))
    p = []
    p.append(soft("torso", (0.5, 0.3, 0.64), (x, y, 1.22 + bob), mh_, level=2, bevel=0.42))
    p.append(soft("hood", (0.36, 0.14, 0.16), (x, y - 0.14, 1.5 + bob), mh_, rot=(math.radians(18), 0, 0)))
    p.append(cyl("neck", 0.07, 0.12, (x, y, 1.6 + bob), mk))
    p += head_parts(x, y, 1.76 + bob, look, mk, mhair, mhs)
    for side in (-1, 1):
        hip = Vector((x + side * 0.12, y, 0.92 + bob))
        foot = Vector((x + side * 0.12, y + side * 0.28 * sw, 0.1))
        p.append(limb(hip, foot, 0.09, mp))
        p.append(soft("shoe", (0.15, 0.27, 0.1), (foot.x, foot.y + 0.05, 0.05), M["white"], level=2))
        sh = Vector((x + side * 0.3, y, 1.44 + bob))
        hand = Vector((x + side * 0.35, y - side * 0.22 * sw, 0.97 + bob))
        p.append(limb(sh, hand, 0.072, mh_))
        p.append(sphere("hand", 0.058, tuple(hand), mk, (1, 1.2, 0.8)))
    piv = Vector((x, y, 0))
    from mathutils import Matrix
    rot = Matrix.Rotation(heading, 4, "Z")
    for o in p:
        o.scale = o.scale * 1.18
        o.location = piv + (rot @ ((o.location - piv) * 1.18))
        o.rotation_mode = "QUATERNION"; o.rotation_quaternion = rot.to_quaternion() @ (o.rotation_quaternion if o.rotation_mode == "QUATERNION" else o.rotation_euler.to_quaternion())
    return p

def plant(x, y, s=1.0):
    # a tall potted plant: a concrete planter and long leaves fanning out
    cyl("pot", 0.3 * s, 0.6 * s, (x, y, 0.3 * s), M["pot"], verts=48)
    cyl("soil", 0.27 * s, 0.02, (x, y, 0.6 * s), M["rubber"])
    random.seed(int(x * 10 + y))
    for i in range(16):
        a = i * 2.399 + random.random() * 0.3; tilt = 0.35 + 0.5 * (i % 4) / 3; L = (0.55 + random.random() * 0.45) * s
        base = Vector((x, y, 0.6 * s)); tip = base + Vector((math.cos(a) * math.sin(tilt), math.sin(a) * math.sin(tilt), math.cos(tilt))) * L * 1.6
        limb(base + (tip - base) * 0.05, base + (tip - base) * 0.55, 0.008 * s, M["plant"])
        lf = sphere("leaf", 0.5, tuple(base + (tip - base) * 0.75), M["plant2"] if i % 2 else M["plant"], (0.13 * s, 0.32 * s, 0.03 * s))
        lf.rotation_mode = "QUATERNION"; lf.rotation_quaternion = Vector((0, 1, 0)).rotation_difference(tip - base)

# ---------------------------------------------------------------- room
def room():
    box("floor", (W, D, 0.2), (W / 2, D / 2, -0.1), M["floor"], 0)
    for i in range(1, int(W / 2.6) + 1):     # large concrete slabs
        box("seam", (0.012, D, 0.002), (i * 2.6, D / 2, 0.001), M["floorline"], 0)
    for j in range(1, int(D / 2.6) + 1):
        box("seam", (W, 0.012, 0.002), (W / 2, j * 2.6, 0.001), M["floorline"], 0)
    box("carpet", (18.6, 12.6, 0.02), (12.1, 8.3, 0.012), M["carpet"], 0.01)
    for (sx, sy_, lx, ly) in [(18.66, 0.03, 12.1, 2.0), (18.66, 0.03, 12.1, 14.6), (0.03, 12.66, 2.8, 8.3), (0.03, 12.66, 21.4, 8.3)]:
        box("inlay", (sx, sy_, 0.006), (lx, ly, 0.022), M["brass"], 0)
    # the left wall is glass, floor to ceiling, the city behind it
    box("sill", (0.4, D, 0.12), (-0.1, D / 2, 0.06), M["trim"], 0)
    box("head", (0.4, D, 0.14), (-0.1, D / 2, H - 0.07), M["trim"], 0)
    for i in range(9):
        box("mullion", (0.1, 0.07, H), (0.02, i * D / 8, H / 2), M["frame"], 0.01)
    box("pane", (0.02, D, H), (0.0, D / 2, H / 2), M["glass"], 0)
    random.seed(7)
    cx = -0.35
    yy = -0.2
    while yy < D + 0.2:                       # towers beyond the glass: rooftops below, lit windows
        bw = 0.7 + random.random() * 1.5; top = 1.2 + random.random() * 4.4
        d = 0.6 + random.random() * 1.6
        tx = cx - d / 2 - random.random() * 1.5
        box("tower", (d, bw - 0.08, top), (tx, yy + bw / 2, top / 2 - 0.02), city_mat("city%d" % int(random.random() * 6), random.random() * 9, random.random() < 0.8), 0)
        box("roof", (d + 0.04, bw - 0.04, 0.06), (tx, yy + bw / 2, top), shader("roof", srgb("#10131a"), 0.8), 0)
        if random.random() < 0.4: box("beacon", (0.06, 0.06, 0.06), (cx - 0.3, yy + bw / 2, top + 0.02), shader("beacon", srgb("#ff3b30"), 0.4, emit=srgb("#ff3b30"), strength=12), 0)
        yy += bw
    box("ground", (40, D + 20, 0.1), (-20.5, D / 2, -0.06), shader("street", srgb("#06080d"), 0.9), 0)
    # the back wall: dark acoustic slats, a thin-bezel LED wall (the Scope), the neon sign, the ticker
    box("wallL", (0.3, D, H), (-0.45, D / 2, H / 2), M["wall"], 0)   # behind the city, only fills gaps
    box("wallB", (W, 0.3, H), (W / 2, D + 0.15, H / 2), M["wall"], 0)
    for i in range(int(W / 0.16)):
        if 10.6 < i * 0.16 < 20.4: continue      # the LED wall goes there
        box("slatB", (0.09, 0.05, H - 0.4), (0.08 + i * 0.16, D - 0.02, H / 2 + 0.1), M["slat"], 0.004)
    box("baseB", (W, 0.1, 0.12), (W / 2, D - 0.06, 0.06), M["trim"], 0)
    box("scopeFrame", (9.3, 0.16, 3.4), (15.5, D - 0.04, 2.75), M["frame"], 0.02)
    scope = box("scope", (9.1, 0.02, 3.2), (15.5, D - 0.13, 2.75), M["screen"], 0)
    box("scopeLed", (9.3, 0.04, 0.025), (15.5, D - 0.14, 1.03), M["led"], 0)
    # the launch kiosk and its gate, by the right edge
    box("kiosk", (1.2, 0.8, 1.1), (23.4, 15.2, 0.55), M["black"], 0.06)
    box("kioskTop", (1.24, 0.84, 0.03), (23.4, 15.2, 1.115), M["wood"], 0.01)
    kscr = box("kioskScreen", (1.0, 0.02, 0.62), (23.4, 14.79, 1.45), M["screen"], 0, rot=(math.radians(-14), 0, 0))
    box("kioskPost", (0.1, 0.1, 0.5), (23.4, 15.0, 1.1), M["frame"], 0.01)
    for gx in (21.6, 25.2):
        box("gate", (0.16, 0.16, 2.4), (gx, 13.6, 1.2), M["frame"], 0.02)
        box("gateLed", (0.03, 0.04, 2.2), (gx - 0.09 if gx > 23 else gx + 0.09, 13.6, 1.2), M["green"], 0)
    box("gateTop", (3.8, 0.16, 0.16), (23.4, 13.6, 2.45), M["frame"], 0.02)
    # the coffee bar: walnut and steel, stools, a lit drinks fridge
    box("counter", (3.6, 0.8, 1.0), (3.2, D - 0.6, 0.5), M["woodDark"], 0.02)
    box("counterTop", (3.7, 0.85, 0.05), (3.2, D - 0.6, 1.025), shader("stone", srgb("#d9d6cf"), 0.2, noise=0.25, nscale=8, coat=0.3), 0.01)
    box("espresso", (0.6, 0.45, 0.55), (2.3, D - 0.65, 1.33), M["steel"], 0.04)
    box("espTray", (0.5, 0.2, 0.03), (2.3, D - 0.9, 1.08), M["frame"], 0.01)
    for sx in (2.0, 3.0, 4.0):
        cyl("stoolPost", 0.03, 0.75, (sx, D - 1.35, 0.38), M["frame"]); cyl("stoolSeat", 0.2, 0.06, (sx, D - 1.35, 0.78), M["chair"], verts=40); cyl("stoolFoot", 0.18, 0.02, (sx, D - 1.35, 0.01), M["frame"], verts=40)
    box("fridge", (0.9, 0.8, 2.1), (0.7, D - 3.0, 1.05), M["frame"], 0.03)
    box("fridgeGlass", (0.02, 0.7, 1.8), (1.16, D - 3.0, 1.1), shader("fridgeLit", srgb("#cfe7ff"), 0.2, emit=srgb("#d8ecff"), strength=1.6), 0)
    for (px_, py, s) in [(1.0, 1.0, 1.15), (24.8, 1.2, 1.05), (8.6, D - 0.8, 1.25), (21.0, D - 0.9, 1.05), (1.0, 9.0, 0.95)]:
        plant(px_, py, s)
    for (x, y) in SEATS: seat_light(x, y)
    # the neon sign on the back wall, on a dark panel
    font = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts", "BigShouldersDisplay-800.ttf")
    box("signBack", (6.4, 0.06, 1.5), (6.6, D - 0.05, 3.72), M["trim"], 0.03)
    bpy.ops.object.text_add(location=(6.6, D - 0.1, 3.35), rotation=(math.radians(90), 0, 0))
    t = bpy.context.active_object; t.data.body = "NIGHTSHIFT"; t.data.align_x = "CENTER"; t.data.size = 1.05; t.data.extrude = 0.02
    if os.path.exists(font): t.data.font = bpy.data.fonts.load(font)
    t.data.materials.append(M["neon"])
    nl = bpy.data.lights.new("neonglow", "AREA"); nl.size = 5; nl.energy = 260; nl.color = (1.0, 0.55, 0.18)
    no = bpy.data.objects.new("neonglow", nl); sc.collection.objects.link(no); no.location = (6.6, D - 1.2, 3.7); no.rotation_euler = (math.radians(-90), 0, 0)
    sl = bpy.data.lights.new("scopeglow", "AREA"); sl.size = 9; sl.size_y = 3; sl.shape = "RECTANGLE"; sl.energy = 220; sl.color = (0.6, 0.8, 1.0)
    so = bpy.data.objects.new("scopeglow", sl); sc.collection.objects.link(so); so.location = (15.5, D - 0.6, 2.75); so.rotation_euler = (math.radians(-90), 0, 0)
    ticker = box("ticker", (24.0, 0.03, 0.42), (13.0, D - 0.05, 4.82), M["screen"], 0)
    box("tickerFrame", (24.2, 0.06, 0.52), (13.0, D - 0.02, 4.82), M["frame"], 0.01)
    cyl("clockRim", 0.55, 0.06, (10.2, D - 0.06, 3.4), M["frame"], rot=(math.radians(90), 0, 0), verts=64)
    clock = box("clock", (0.9, 0.01, 0.9), (10.2, D - 0.11, 3.4), M["screen"], 0)
    return scope, kscr, ticker, clock

# ---------------------------------------------------------------- camera, light, render
def camera():
    # three-quarter front view: the screens and the Scope wall face the camera, the left wall shows its windows
    cam = bpy.data.cameras.new("cam"); cam.type = "ORTHO"; cam.ortho_scale = 30.5
    co = bpy.data.objects.new("cam", cam); sc.collection.objects.link(co); sc.camera = co
    target = Vector((W / 2 + 0.3, D / 2 + 1.6, 2.4))
    yaw, pitch = math.radians(16), math.radians(47)
    co.location = target + 60 * Vector((math.sin(-yaw) * math.cos(pitch) * -1, -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    co.rotation_euler = (target - co.location).to_track_quat("-Z", "Y").to_euler()
    return co

def lights():
    w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.012, 0.016, 0.03, 1)
    w.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.4
    sun = bpy.data.lights.new("moon", "SUN"); sun.energy = 0.35; sun.color = (0.7, 0.8, 1.0); sun.angle = math.radians(8)
    so = bpy.data.objects.new("moon", sun); sc.collection.objects.link(so); so.rotation_euler = (math.radians(55), 0, math.radians(-40))
    fill = bpy.data.lights.new("fill", "AREA"); fill.size = 20; fill.energy = 700; fill.color = (0.75, 0.82, 1.0)
    fo = bpy.data.objects.new("fill", fill); sc.collection.objects.link(fo); fo.location = (W / 2 + 10, -8, 14)
    fo.rotation_euler = (Vector((W / 2, D / 2, 0)) - fo.location).to_track_quat("-Z", "Y").to_euler()
    if MODE not in ("room", "anchors", "walk"): seat_light(*REF)

def setup_render(transparent):
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
    sc.render.resolution_x, sc.render.resolution_y = RES_X, RES_Y
    sc.render.film_transparent = transparent
    sc.render.image_settings.file_format = "PNG"; sc.render.image_settings.color_mode = "RGBA" if transparent else "RGB"
    try: sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Medium High Contrast"
    except TypeError: pass

def px(co, p):
    v = world_to_camera_view(sc, co, Vector(p))
    return [round(v.x * RES_X, 1), round((1 - v.y) * RES_Y, 1)]

def corners(co, o):
    # the screen face toward −y (in the object's own axes): its 4 corners in pixels (tl, tr, br, bl as seen)
    vs = [v.co.copy() for v in o.data.vertices]
    ymin = min(v.y for v in vs)
    face = [v for v in vs if abs(v.y - ymin) < 1e-4] or vs
    zmax, zmin = max(v.z for v in face), min(v.z for v in face)
    xmin, xmax = min(v.x for v in face), max(v.x for v in face)
    pick = lambda xx, zz: o.matrix_world @ min(face, key=lambda v: (v.x - xx) ** 2 + (v.z - zz) ** 2)
    return [px(co, pick(xmin, zmax)), px(co, pick(xmax, zmax)), px(co, pick(xmax, zmin)), px(co, pick(xmin, zmin))]

WREF = (13.0, 1.9)                   # where walker sprites are rendered (a point in the front aisle)
SPRITE_BOX = (240, 840, 800, 1240)   # pixels around the reference seat: every sprite renders inside it
def sprite_region():
    sc.render.use_border = True; sc.render.use_crop_to_border = False
    x0, y0, x1, y1 = SPRITE_BOX
    sc.render.border_min_x, sc.render.border_max_x = x0 / RES_X, x1 / RES_X
    sc.render.border_min_y, sc.render.border_max_y = 1 - y1 / RES_Y, 1 - y0 / RES_Y

def shadow_catcher():
    box("catch", (W * 2, D * 2, 0.02), (W / 2, D / 2, -0.01), M["floor"], 0).is_shadow_catcher = True

co = camera(); lights()
if MODE == "room":
    scope, kscr, ticker, clock = room()
    setup_render(False); sc.render.filepath = os.path.join(OUT, "room.png")
    bpy.ops.render.render(write_still=True)
elif MODE == "anchors":
    sc.render.resolution_x, sc.render.resolution_y = RES_X, RES_Y
    scope, kscr, ticker, clock = room()
    parts, scr = desk(*REF)
    # the kiosk screen is tilted back 14 degrees: its corners straight from its centre, size and tilt
    from mathutils import Matrix
    kc, rx = Vector((23.4, 14.79, 1.45)), Matrix.Rotation(math.radians(-14), 3, "X")
    kq = [px(co, kc + rx @ Vector((sx, -0.011, sz))) for sx, sz in ((-0.5, 0.31), (0.5, 0.31), (0.5, -0.31), (-0.5, -0.31))]
    info = {"size": [RES_X, RES_Y], "seats": [], "scope": corners(co, scope), "kiosk": kq, "gate": px(co, (23.4, 13.6, 1.2))}
    base = px(co, (REF[0], REF[1], 0))
    for (x, y) in SEATS:
        p = px(co, (x, y, 0))
        info["seats"].append({"origin": p, "offset": [round(p[0] - base[0], 1), round(p[1] - base[1], 1)], "label": px(co, (x, y - 0.6, 1.9))})
    info["screen"] = corners(co, scr)    # the reference seat's monitor; add a seat's offset for the others
    info["ticker"] = corners(co, ticker); info["clock"] = corners(co, clock)
    # the floor plane is an affine map in an orthographic view: pixel = o + x * ex + y * ey (z = 0)
    o0, ex, ey = px(co, (0, 0, 0)), px(co, (1, 0, 0)), px(co, (0, 1, 0))
    info["floor"] = {"o": o0, "ex": [ex[0] - o0[0], ex[1] - o0[1]], "ey": [ey[0] - o0[0], ey[1] - o0[1]]}
    info["walkRef"] = {"x": WREF[0], "y": WREF[1], "px": px(co, (WREF[0], WREF[1], 0))}
    info["room"] = {"W": W, "D": D, "seats": SEATS}
    json.dump(info, open(os.path.join(OUT, "anchors.json"), "w"), indent=1)
    print("anchors written")
elif MODE == "desk":
    desk(*REF); shadow_catcher(); setup_render(True); sprite_region()
    sc.render.filepath = os.path.join(OUT, "desk.png"); bpy.ops.render.render(write_still=True)
elif MODE == "empty":
    chair(*REF); shadow_catcher(); setup_render(True); sprite_region()
    sc.render.filepath = os.path.join(OUT, "empty.png"); bpy.ops.render.render(write_still=True)
elif MODE in ("cheer", "slump"):
    sc.render.resolution_x, sc.render.resolution_y = RES_X, RES_Y
    setup_render(True); shadow_catcher(); sprite_region()
    for f in range(FRAMES):
        for o in [o for o in bpy.data.objects if o.type == "MESH" and o.name != "catch"]:
            bpy.data.objects.remove(o)
        chair(*REF); agent(REF[0], REF[1], LOOK, f / FRAMES, MODE)
        sc.render.filepath = os.path.join(OUT, "%s%d_%02d.png" % (MODE, LOOK, f)); bpy.ops.render.render(write_still=True)
elif MODE == "walk":
    sc.render.resolution_x, sc.render.resolution_y = RES_X, RES_Y
    setup_render(True); shadow_catcher()
    pts = [px(co, (WREF[0] + dx, WREF[1] + dy, z)) for dx in (-0.9, 0.9) for dy in (-0.9, 0.9) for z in (0, 2.4)]
    xs, ys = [q[0] for q in pts], [q[1] for q in pts]
    sc.render.use_border = True; sc.render.use_crop_to_border = False
    sc.render.border_min_x, sc.render.border_max_x = (min(xs) - 20) / RES_X, (max(xs) + 20) / RES_X
    sc.render.border_min_y, sc.render.border_max_y = 1 - (max(ys) + 20) / RES_Y, 1 - (min(ys) - 20) / RES_Y
    for d, heading in enumerate((0.0, math.pi, -math.pi / 2, math.pi / 2)):   # away, toward, +x, -x
        for f in range(FRAMES):
            for o in [o for o in bpy.data.objects if o.type == "MESH" and o.name != "catch"]:
                bpy.data.objects.remove(o)
            walker(WREF[0], WREF[1], LOOK, f / FRAMES, heading)
            sc.render.filepath = os.path.join(OUT, "walk%d_%d_%02d.png" % (LOOK, d, f)); bpy.ops.render.render(write_still=True)
elif MODE == "agent":
    sc.render.resolution_x, sc.render.resolution_y = RES_X, RES_Y
    setup_render(True); shadow_catcher(); sprite_region()
    for f in range(FRAMES):
        for o in [o for o in bpy.data.objects if o.type == "MESH" and o.name != "catch"]:
            bpy.data.objects.remove(o)
        chair(*REF); agent(REF[0], REF[1], LOOK, f / FRAMES)
        sc.render.filepath = os.path.join(OUT, "agent%d_%02d.png" % (LOOK, f)); bpy.ops.render.render(write_still=True)
print("done", MODE)
