"""T16 D3 props: the Lux3D pieces prepared by prep_t16_props.py, placed as instances.

Each prop GLB is imported once (bottom centre at the origin, front = Web +z, see props-manifest.json);
place() records an instance in Web coordinates, scaled uniformly to a target height and turned by a
yaw about Y. Like every kit part, an instance registers its world AABB with the interpenetration gate
(as a non-box part: no coplanar check) and, as asked, a walking collider and/or a camera blocker of the
same box. A mirrored instance gets its own mesh copy with the winding flipped, so the web build, which
bakes world matrices into merged geometry, never sees a negative-scale node.
"""
import bpy, json, math
from pathlib import Path
from mathutils import Matrix
import t16_kit as kit

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / 'assets/t16/props/props-manifest.json').read_text())
PROPS = MANIFEST['props']
_MESH = {}
PLACED = []          # (mesh, Blender world matrix, name)


def _mesh(pid, mirror=False):
    key = (pid, mirror)
    if key in _MESH: return _MESH[key]
    if (pid, False) not in _MESH:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(ROOT / PROPS[pid]['file']))
        new = [o for o in bpy.data.objects if o not in before]
        me = next(o.data for o in new if o.type == 'MESH')
        for o in new: bpy.data.objects.remove(o)
        me.name = f'Prop_{pid}'; _MESH[(pid, False)] = me
    if mirror:
        me = _MESH[(pid, False)].copy(); me.name = f'Prop_{pid}_mirror'
        me.transform(Matrix.Scale(-1, 4, (1, 0, 0))); me.flip_normals()
        _MESH[key] = me
    return _MESH[key]


def size(pid, height):
    """Web (width, height, depth) of the prop scaled to `height`, before yaw."""
    w, h, d = PROPS[pid]['size']; s = height / h
    return w * s, height, d * s


def place(pid, x, y, z, height, yaw=0.0, nav=('block', 'cam'), mirror=False, name=None, pierce=False):
    """Stand prop `pid` on (x, y, z) Web, `height` metres tall, front turned from +z by `yaw` (about +Y).
    Returns the Web AABB (lo, hi)."""
    w, h, d = size(pid, height)
    s = height / PROPS[pid]['size'][1]
    c, sn = abs(math.cos(yaw)), abs(math.sin(yaw))
    hx, hz = (c * w + sn * d) / 2, (sn * w + c * d) / 2
    lo, hi = (x - hx, y, z - hz), (x + hx, y + h, z + hz)
    i = kit.uid(name or f'prop-{pid}')
    # Web yaw about +Y equals a Blender rotation about +Z by the same angle (web +z = Blender -Y).
    mw = Matrix.Translation(kit.bl((x, y, z))) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Scale(s, 4)
    PLACED.append((_mesh(pid, mirror), mw, i))
    box = (lo[0], hi[0], lo[1], hi[1], lo[2], hi[2])
    if 'block' in nav: kit.nav_box('colliders', i, *box)
    if 'cam' in nav: kit.nav_box('cameraBlockers', i + '-cam', *box)
    kit.PARTS.append((i, lo, hi, pierce, False))
    return lo, hi


def triangles():
    total = 0
    for me, _, _ in PLACED:
        me.calc_loop_triangles(); total += len(me.loop_triangles)
    return total


def objects(collection):
    """Link one object per placed instance (instances share mesh data, so the GLB stores each mesh once)."""
    out = []
    for me, mw, name in PLACED:
        ob = bpy.data.objects.new(f'T16_{name}', me); ob.matrix_world = mw
        collection.objects.link(ob); out.append(ob)
    return out
