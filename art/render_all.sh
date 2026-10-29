# Renders every layer of the floor into art/out (then: python art/pack.py)
B="/c/Program Files (x86)/Steam/steamapps/common/Blender/blender.exe"; O="D:/cooks/floor/art/out"; S=${1:-48}
r() { "$B" -b --factory-startup --python D:/cooks/floor/art/floor_scene.py -- "$@" > /dev/null 2>&1 || echo "FAILED $*"; }
rm -rf "$O"; mkdir -p "$O"
r room "$O" 128; r anchors "$O"; r desk "$O" $S; r empty "$O" $S
for L in 0 1 2 3 4 5 6 7; do r agent "$O" $S $L 8; r cheer "$O" $S $L 4; r slump "$O" $S $L 4; done
for L in 1 3 5 7; do r walk "$O" $S $L 8; done
echo "rendered $(ls "$O" | wc -l) files"
