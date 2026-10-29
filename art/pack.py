# Packs the Blender renders for the site.
#   seat sprites (desk, empty chair, agents typing / cheering / slumping) share one crop box, so they all sit on
#   the seat with the same offset; walkers get their own box, one sheet per look (rows = 4 directions).
#   Faint shadow-catcher haze (alpha under 10) is cleared so sprites don't show boxes on the floor.
# python art/pack.py   ->  site/assets/*.png, room.jpg, manifest.json
import json, os, glob
from PIL import Image

ART = os.path.join(os.path.dirname(__file__), "out")
SITE = os.path.join(os.path.dirname(__file__), "..", "assets")
os.makedirs(SITE, exist_ok=True)

SPRITE_BOX = (240, 840, 800, 1240)   # floor_scene.py renders every seat sprite inside this box
_fade = {}
def fade_mask(size, box, edge=70):
    # soft shadows reach the render border: fade them to nothing over the last `edge` pixels so no box shows
    key = (size, box)
    if key not in _fade:
        from PIL import ImageDraw, ImageFilter
        m = Image.new("L", size, 0); ImageDraw.Draw(m).rectangle((box[0] + edge, box[1] + edge, box[2] - edge, box[3] - edge), fill=255)
        _fade[key] = m.filter(ImageFilter.GaussianBlur(edge / 2.2))
    return _fade[key]

def load(f):
    im = Image.open(os.path.join(ART, f)).convert("RGBA")
    a = im.getchannel("A")
    if not f.startswith("walk"):
        from PIL import ImageChops
        # keep solid pixels as they are; only faint shadow (alpha under 90) is faded toward the border
        m = fade_mask(im.size, SPRITE_BOX)
        faded = ImageChops.multiply(a, m)
        a = Image.composite(a, faded, a.point(lambda v: 255 if v >= 90 else 0))
    a = a.point(lambda v: 0 if v < 10 else v)
    im.putalpha(a)
    return im

def union(files):
    box = None
    for f in files:
        bb = load(f).getchannel("A").point(lambda v: 255 if v > 3 else 0).getbbox()
        if bb: box = bb if box is None else (min(box[0], bb[0]), min(box[1], bb[1]), max(box[2], bb[2]), max(box[3], bb[3]))
    return (max(0, box[0] - 4), max(0, box[1] - 4), box[2] + 4, box[3] + 4)

def sheet(files, box, cols):
    w, h = box[2] - box[0], box[3] - box[1]
    rows = (len(files) + cols - 1) // cols
    out = Image.new("RGBA", (w * cols, h * rows))
    for i, f in enumerate(files):
        out.paste(load(f).crop(box), ((i % cols) * w, (i // cols) * h))
    return out

A = json.load(open(os.path.join(ART, "anchors.json")))
names = lambda pat: sorted(os.path.basename(p) for p in glob.glob(os.path.join(ART, pat)))

seat = ["desk.png", "empty.png"] + names("agent*_*.png") + names("cheer*_*.png") + names("slump*_*.png")
box = union(seat)
w, h = box[2] - box[0], box[3] - box[1]
load("desk.png").crop(box).save(os.path.join(SITE, "desk.png"), optimize=True)
load("empty.png").crop(box).save(os.path.join(SITE, "empty.png"), optimize=True)
looks = sorted({int(f[5:f.index("_")]) for f in names("agent*_*.png")})
for L in looks:
    for kind in ("agent", "cheer", "slump"):
        fs = names("%s%d_*.png" % (kind, L))
        if fs: sheet(fs, box, len(fs)).save(os.path.join(SITE, "%s%d.png" % (kind, L)), optimize=True)
A["sprite"] = {"x": box[0], "y": box[1], "w": w, "h": h, "frames": len(names("agent%d_*.png" % looks[0])),
               "react": len(names("cheer%d_*.png" % looks[0])), "looks": looks}

walk = names("walk*_*_*.png")
if walk:
    wb = union(walk)
    wl = sorted({int(f[4:f.index("_")]) for f in walk})
    frames = len(names("walk%d_0_*.png" % wl[0]))
    for L in wl:
        fs = [f for d in range(4) for f in names("walk%d_%d_*.png" % (L, d))]
        sheet(fs, wb, frames).save(os.path.join(SITE, "walk%d.png" % L), optimize=True)
    A["walk"] = {"x": wb[0], "y": wb[1], "w": wb[2] - wb[0], "h": wb[3] - wb[1], "frames": frames, "looks": wl}

room = Image.open(os.path.join(ART, "room.png")).convert("RGB")
room.save(os.path.join(SITE, "room.jpg"), quality=90, optimize=True, progressive=True)
json.dump(A, open(os.path.join(SITE, "manifest.json"), "w"), indent=1)
print("packed", len(looks), "looks; seat box", box, "; walkers", A.get("walk"))
