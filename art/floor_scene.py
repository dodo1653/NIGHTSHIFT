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

M = {
    "floor": mat("floor", srgb("#3a3f4b"), 0.32),
    "floorline": mat("floorline", srgb("#454b58"), 0.4),
    "wall": mat("wall", srgb("#d9d2c5"), 0.8),
    "wallDark": mat("wallDark", srgb("#3a3f4a"), 0.7),
    "trim": mat("trim", srgb("#1d2027"), 0.4),
    "wood": mat("wood", srgb("#b07a4f"), 0.45),
    "woodDark": mat("woodDark", srgb("#6e4a30"), 0.5),
    "steel": mat("steel", srgb("#b9bec8"), 0.3, 0.9),
    "black": mat("black", srgb("#121318"), 0.35),
    "screen": mat("screen", srgb("#05070a"), 0.2, emit=srgb("#0b1a14"), strength=0.6),
    "green": mat("green", srgb("#4ade80"), 0.4, emit=srgb("#4ade80"), strength=3.0),
    "glass": mat("glass", srgb("#88aacc"), 0.05, alpha=0.25),
    "plant": mat("plant", srgb("#3f7a3a"), 0.6),
    "pot": mat("pot", srgb("#e8e2d6"), 0.5),
    "chair": mat("chair", srgb("#24262d"), 0.55),
    "fabric": mat("fabric", srgb("#3b4252"), 0.9),
    "warm": mat("warm", srgb("#ffd9a0"), 0.5, emit=srgb("#ffcf8a"), strength=8.0),
    "city": mat("city", srgb("#0d1424"), 0.9),
    "tower": mat("tower", srgb("#1b2540"), 0.9),
    "rug": mat("rug", srgb("#6b3b2e"), 0.95),
    "neon": mat("neon", srgb("#ffb547"), 0.4, emit=srgb("#ffb547"), strength=14.0),
}

def box(name, size, loc, m, bevel=0.03, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        b = o.modifiers.new("bev", "BEVEL"); b.width = bevel; b.segments = 3; b.limit_method = "ANGLE"
    o.data.materials.append(m)
    for p in o.data.polygons: p.use_smooth = True
    return o

def cyl(name, r, d, loc, m, rot=(0, 0, 0), verts=32):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d, location=loc, rotation=rot, vertices=verts)
    o = bpy.context.active_object; o.name = name; o.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    return o

def sphere(name, r, loc, m, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=32, ring_count=16)
    o = bpy.context.active_object; o.name = name; o.scale = scale; o.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    return o

# ---------------------------------------------------------------- pieces
def desk(x, y, tag=""):
    parts = []
    parts.append(box("top" + tag, (2.6, 1.25, 0.08), (x, y + 0.35, 0.78), M["wood"], 0.02))
    for dx in (-1.2, 1.2):
        parts.append(box("leg" + tag, (0.08, 1.1, 0.74), (x + dx, y + 0.35, 0.37), M["black"], 0.01))
    parts.append(box("modesty" + tag, (2.3, 0.04, 0.45), (x, y + 0.93, 0.5), M["woodDark"], 0.01))
    # monitor facing the seat (−y), raised so it shows over the agent's shoulder
    parts.append(box("stand" + tag, (0.08, 0.08, 0.42), (x, y + 0.8, 1.02), M["steel"], 0.01))
    parts.append(box("foot" + tag, (0.4, 0.25, 0.03), (x, y + 0.8, 0.83), M["steel"], 0.01))
    mon = box("monitor" + tag, (1.5, 0.07, 0.9), (x, y + 0.82, 1.62), M["black"], 0.03)
    parts.append(mon)
    scr = box("screen" + tag, (1.38, 0.01, 0.78), (x, y + 0.775, 1.62), M["screen"], 0)
    parts.append(scr)
    parts.append(box("kbd" + tag, (0.8, 0.26, 0.03), (x, y + 0.1, 0.835), M["trim"], 0.01))
    parts.append(box("mouse" + tag, (0.08, 0.13, 0.03), (x + 0.6, y + 0.12, 0.835), M["trim"], 0.01))
    parts.append(cyl("mug" + tag, 0.07, 0.14, (x - 0.95, y + 0.55, 0.89), M["pot"]))
    return parts, scr

def chair(x, y, tag=""):
    p = []
    p.append(box("seat" + tag, (0.62, 0.58, 0.1), (x, y - 0.55, 0.52), M["chair"], 0.05))
    p.append(box("back" + tag, (0.62, 0.1, 0.7), (x, y - 0.86, 0.95), M["chair"], 0.05, rot=(math.radians(-8), 0, 0)))
    p.append(cyl("post" + tag, 0.04, 0.4, (x, y - 0.55, 0.28), M["steel"]))
    for a in range(5):
        t = a * 2 * math.pi / 5
        p.append(box("spoke" + tag, (0.36, 0.05, 0.04), (x + 0.18 * math.cos(t), y - 0.55 + 0.18 * math.sin(t), 0.07), M["black"], 0.01, rot=(0, 0, t)))
    return p

LOOKS = [  # shirt, hair, skin, trousers
    ("#e8e2d6", "#2a211c", "#e9b896", "#2b2f3a"), ("#3b6e8f", "#7a4a2a", "#c98e64", "#23262e"),
    ("#4ade80", "#111111", "#8d5a3b", "#1f2229"), ("#c0504d", "#d8b47a", "#f1c8a8", "#2b2f3a"),
    ("#2f3542", "#5a3a24", "#e2a882", "#1b1d23"), ("#e3b04b", "#1a1a1a", "#b9785a", "#2b2f3a"),
    ("#7b5fb5", "#a33b2b", "#f0c19e", "#23262e"), ("#f2f2f2", "#9a9a9a", "#d79f7b", "#3a3f4a"),
]

def limb(a, b, r, m):
    a, b = Vector(a), Vector(b); d = b - a
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=max(0.01, d.length), location=(a + b) / 2)
    o = bpy.context.active_object; o.rotation_mode = "QUATERNION"; o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d)
    o.data.materials.append(m); bpy.ops.object.shade_smooth(); return o

def look_mats(look):
    shirt, hair, skin, pants = [srgb(c) for c in LOOKS[look % len(LOOKS)]]
    return (mat("shirt%d" % look, shirt, 0.8), mat("hair%d" % look, hair, 0.6), mat("skin%d" % look, skin, 0.55), mat("pants%d" % look, pants, 0.8))

def agent(x, y, look, phase, pose="type"):
    ms, mh, mk, mp = look_mats(look)
    w = math.sin(phase * 2 * math.pi)
    bob = 0.012 * w if pose == "type" else (0.05 * abs(w) if pose == "cheer" else -0.03)
    sy = y - 0.6
    hz, hy = 1.36 + bob, sy + 0.04
    if pose == "slump": hz, hy = 1.27, sy + 0.16
    p = []
    p.append(box("torso", (0.52, 0.3, 0.55), (x, sy + (0.05 if pose == "slump" else 0), 0.92 + bob), ms, 0.12))
    p.append(sphere("head", 0.2, (x, hy, hz), mk))
    p.append(sphere("hair", 0.215, (x, hy - 0.06, hz + 0.04), mh, (1, 1, 0.92)))
    for side in (-1, 1):
        p.append(box("thigh", (0.18, 0.5, 0.16), (x + side * 0.13, sy + 0.25, 0.62), mp, 0.06))
        p.append(box("shin", (0.15, 0.15, 0.5), (x + side * 0.13, sy + 0.5, 0.36), mp, 0.05))
        sh = Vector((x + side * 0.3, sy + 0.02, 1.08 + bob))
        if pose == "cheer":
            hand = Vector((x + side * (0.38 + 0.04 * w), sy + 0.02, 1.78 + bob + 0.05 * abs(w)))
        elif pose == "slump":
            hand = Vector((x + side * 0.2, sy + 0.32, 0.74))
        else:
            tap = 0.025 * max(0, math.sin((phase + (0 if side < 0 else 0.5)) * 2 * math.pi))
            hand = Vector((x + side * 0.22, y + 0.06, 0.88 + tap))
        p.append(limb(sh, hand, 0.07, ms))
        p.append(sphere("hand", 0.07, tuple(hand), mk))
    piv = Vector((x, sy, 0.45))
    for o in p:
        o.scale = o.scale * 1.22; o.location = piv + (o.location - piv) * 1.22
    return p

def walker(x, y, look, phase, heading):
    """A colleague walking, built facing +y and turned to `heading` (radians about z)."""
    ms, mh, mk, mp = look_mats(look)
    sw = math.sin(phase * 2 * math.pi)
    bob = 0.03 * abs(math.cos(phase * 2 * math.pi))
    p = []
    p.append(box("torso", (0.5, 0.3, 0.62), (x, y, 1.2 + bob), ms, 0.12))
    p.append(sphere("head", 0.2, (x, y, 1.72 + bob), mk))
    p.append(sphere("hair", 0.215, (x, y - 0.04, 1.77 + bob), mh, (1, 1, 0.92)))
    for side in (-1, 1):
        hip = Vector((x + side * 0.12, y, 0.9 + bob))
        foot = Vector((x + side * 0.12, y + side * 0.28 * sw, 0.08))
        p.append(limb(hip, foot, 0.085, mp))
        p.append(box("shoe", (0.14, 0.24, 0.08), (foot.x, foot.y + 0.05, 0.05), M["black"], 0.03))
        sh = Vector((x + side * 0.31, y, 1.42 + bob))
        hand = Vector((x + side * 0.36, y - side * 0.22 * sw, 0.95 + bob))
        p.append(limb(sh, hand, 0.065, ms))
        p.append(sphere("hand", 0.065, tuple(hand), mk))
    piv = Vector((x, y, 0))
    from mathutils import Matrix
    rot = Matrix.Rotation(heading, 4, "Z")
    for o in p:
        o.scale = o.scale * 1.18
        o.location = piv + (rot @ ((o.location - piv) * 1.18))
        o.rotation_mode = "QUATERNION"; o.rotation_quaternion = rot.to_quaternion() @ (o.rotation_quaternion if o.rotation_mode == "QUATERNION" else o.rotation_euler.to_quaternion())
    return p

def plant(x, y, s=1.0):
    cyl("pot", 0.28 * s, 0.5 * s, (x, y, 0.25 * s), M["pot"])
    for i in range(9):
        a = i * 2.4
        sphere("leaf", 0.22 * s, (x + 0.18 * s * math.cos(a), y + 0.18 * s * math.sin(a), (0.75 + 0.12 * (i % 3)) * s), M["plant"], (1, 1, 1.5))

# ---------------------------------------------------------------- room
def room():
    box("floor", (W, D, 0.2), (W / 2, D / 2, -0.1), M["floor"], 0)
    for i in range(1, int(W)):     # plank seams
        box("seam", (0.015, D, 0.002), (i, D / 2, 0.001), M["floorline"], 0)
    box("rug", (18.6, 12.6, 0.02), (12.1, 8.3, 0.012), M["rug"], 0.01)
    # back walls (x=0 and y=D) with a dark base and a trim
    box("wallL", (0.3, D, H), (-0.15, D / 2, H / 2), M["wall"], 0)
    box("wallB", (W, 0.3, H), (W / 2, D + 0.15, H / 2), M["wall"], 0)
    box("baseL", (0.32, D, 0.25), (-0.12, D / 2, 0.125), M["trim"], 0)
    box("baseB", (W, 0.32, 0.25), (W / 2, D + 0.12, 0.125), M["trim"], 0)
    # windows on the left wall: the city at night
    for i in range(4):
        cy = 2.5 + i * 4.2
        box("winframe", (0.12, 3.2, 2.8), (0.02, cy, 2.6), M["trim"], 0.02)
        box("night", (0.05, 3.0, 2.6), (0.1, cy, 2.6), M["city"], 0)
        random.seed(i)
        bx = cy - 1.45
        while bx < cy + 1.4:              # a skyline: towers with lit window grids
            bw = 0.35 + random.random() * 0.5; bw = min(bw, cy + 1.45 - bx)
            top = 1.6 + random.random() * 2.2
            box("tower", (0.02, bw - 0.04, top - 1.3), (0.125, bx + bw / 2, 1.3 + (top - 1.3) / 2), M["tower"], 0)
            for wy in [bx + 0.08 + j * 0.11 for j in range(int((bw - 0.1) / 0.11))]:
                for wz in [1.45 + j * 0.16 for j in range(int((top - 1.55) / 0.16))]:
                    if random.random() < 0.38:
                        box("lit", (0.02, 0.05, 0.07), (0.14, wy, wz), M["warm"] if random.random() < 0.85 else M["green"], 0)
            bx += bw
        box("mullion", (0.06, 0.05, 2.6), (0.12, cy, 2.6), M["trim"], 0)
    # the Scope wall on the back wall: a big screen for live launches
    box("scopeFrame", (9.2, 0.2, 3.3), (15.5, D - 0.02, 2.75), M["black"], 0.05)
    scope = box("scope", (8.8, 0.02, 2.95), (15.5, D - 0.13, 2.75), M["screen"], 0)
    box("scopeLed", (8.9, 0.05, 0.04), (15.5, D - 0.15, 1.08), M["green"], 0)
    # launch kiosk by the right edge: the anti-vamp gate
    box("kiosk", (1.2, 0.8, 1.1), (23.4, 15.2, 0.55), M["black"], 0.06)
    kscr = box("kioskScreen", (1.0, 0.02, 0.62), (23.4, 14.79, 1.45), M["screen"], 0, rot=(math.radians(-14), 0, 0))
    box("kioskPost", (0.1, 0.1, 0.5), (23.4, 15.0, 1.1), M["steel"], 0.01)
    for gx in (21.6, 25.2):
        box("gate", (0.18, 0.18, 2.4), (gx, 13.6, 1.2), M["steel"], 0.04)
        box("gateLed", (0.05, 0.05, 2.2), (gx - 0.1 if gx > 23 else gx + 0.1, 13.6, 1.2), M["green"], 0)
    box("gateTop", (3.8, 0.18, 0.18), (23.4, 13.6, 2.45), M["steel"], 0.04)
    # coffee corner and plants
    box("counter", (3.6, 0.8, 1.0), (3.2, D - 0.6, 0.5), M["woodDark"], 0.04)
    box("counterTop", (3.7, 0.85, 0.06), (3.2, D - 0.6, 1.03), M["steel"], 0.01)
    box("espresso", (0.6, 0.45, 0.55), (2.3, D - 0.65, 1.33), M["steel"], 0.04)
    box("fridge", (0.9, 0.8, 2.1), (0.7, D - 3.0, 1.05), M["steel"], 0.04)
    for (px, py, s) in [(1.0, 1.0, 1.1), (24.8, 1.2, 1.0), (8.5, D - 0.8, 1.2), (21.0, D - 0.9, 1.0), (1.0, 9.0, 0.9)]:
        plant(px, py, s)
    # ceiling lights are off camera: soft panels over every row
    for r in range(ROWS):
        for c in range(COLS):
            x, y = SEATS[r * COLS + c]
            l = bpy.data.lights.new("panel", "AREA"); l.size = 2.6; l.energy = 650; l.color = (1.0, 0.92, 0.8)
            o = bpy.data.objects.new("panel", l); sc.collection.objects.link(o); o.location = (x, y + 0.3, 6.0)
    # the neon sign on the back wall, left of the Scope
    font = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts", "BigShouldersDisplay-800.ttf")
    bpy.ops.object.text_add(location=(6.6, D - 0.06, 3.35), rotation=(math.radians(90), 0, 0))
    t = bpy.context.active_object; t.data.body = "NIGHTSHIFT"; t.data.align_x = "CENTER"; t.data.size = 1.05; t.data.extrude = 0.03
    if os.path.exists(font): t.data.font = bpy.data.fonts.load(font)
    t.data.materials.append(M["neon"])
    box("signBack", (6.4, 0.05, 1.5), (6.6, D - 0.02, 3.72), M["trim"], 0.05)
    nl = bpy.data.lights.new("neonglow", "AREA"); nl.size = 5; nl.energy = 160; nl.color = (1.0, 0.62, 0.25)
    no = bpy.data.objects.new("neonglow", nl); sc.collection.objects.link(no); no.location = (6.6, D - 1.2, 3.7); no.rotation_euler = (math.radians(-90), 0, 0)
    # the ticker strip under the ceiling line and a clock face
    ticker = box("ticker", (24.0, 0.03, 0.42), (13.0, D - 0.05, 4.82), M["screen"], 0)
    box("tickerFrame", (24.2, 0.06, 0.52), (13.0, D - 0.02, 4.82), M["black"], 0.02)
    cyl("clockRim", 0.55, 0.08, (10.2, D - 0.06, 3.4), M["trim"], rot=(math.radians(90), 0, 0), verts=48)
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
    w.node_tree.nodes["Background"].inputs["Strength"].default_value = 3.0
    sun = bpy.data.lights.new("moon", "SUN"); sun.energy = 0.35; sun.color = (0.7, 0.8, 1.0); sun.angle = math.radians(8)
    so = bpy.data.objects.new("moon", sun); sc.collection.objects.link(so); so.rotation_euler = (math.radians(55), 0, math.radians(-40))
    fill = bpy.data.lights.new("fill", "AREA"); fill.size = 20; fill.energy = 1800; fill.color = (0.85, 0.9, 1.0)
    fo = bpy.data.objects.new("fill", fill); sc.collection.objects.link(fo); fo.location = (W / 2 + 10, -8, 14)
    fo.rotation_euler = (Vector((W / 2, D / 2, 0)) - fo.location).to_track_quat("-Z", "Y").to_euler()

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
