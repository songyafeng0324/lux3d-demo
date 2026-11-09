"""T16 pavilion (D3: structure, materials and Lux3D props): one source for the render GLB AND the walking/camera data.

Run headless from the repo root (Blender 4.5), after `node scripts/fetch-t16-textures.mjs`:
  ~/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python scripts/blender/build_t16.py

Every part is declared once in Web coordinates (metres, Y up, north = -Z, entrance south) through
t16_kit, which emits the render faces (with UVs) and, as flagged, walking colliders, jump ceilings
("air") and camera blockers. Walk surfaces are declared next to the slabs/treads that carry them. The
layout JSON written here is the navigation contract read by apps/web/src/game/navigation.ts; nothing
is transcribed by hand. Materials (Poly Haven CC0 + the user's patterns) come from t16_materials; the
Lux3D props (prepared by prep_t16_props.py) are placed as instances through t16_props.
The export fails if any two audited parts interpenetrate or two box faces z-fight.
"""
import bpy, bmesh, math, json, hashlib, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import t16_kit as kit
from t16_kit import (box, cylinder, lathe, prism, frustum, annulus_xy, annulus_y, disc_xy, slab_with_hole, sloped_bar,
                     surface, nav_box, nav_circle, light, uid, r4, NAV, PARTS, MESH, LIGHTS)
import t16_materials as mats
import t16_props as props

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets/t16'; OUT.mkdir(parents=True, exist_ok=True)
NAME = 'T16_Pavilion_D3'

# ---------------------------------------------------------------- parameters (see docs/design/T16)
HX, ZN, ZS, WT = 22.0, -32.0, 28.0, 0.6          # interior half width, north/south inner wall faces, wall thickness
UP, SLAB = 9.0, 0.6                                 # upper floor top, slab thickness
CEIL = 18.0                                         # underside of the upper ceiling slab
ATR = (-11.0, 11.0, -12.0, 16.0)                    # atrium opening x0,x1,z0,z1
COLZ = [-12.0, -5.0, 2.0, 9.0, 16.0]                # atrium column rows (x = ±11); the 8 bays between them hold T03–T10
HALL_Z = 22.0                                       # entrance-hall columns on the same x = ±11 line, ground floor only
RISE, RUN, NT = 0.18, 0.32, 24                      # 24 treads + landing/floor per flight
ZSTAIR = -15.0                                      # foot of the central flight / top of the side flights
ZLAND = ZSTAIR - NT * RUN                           # south edge of the landing (-22.68)
YLAND = 4.5
CX, SX0, SX1 = 2.8, 7.2, 11.0                       # central flight half width; side flights x range
RAIL_H, RAIL_T = 1.1, 0.2
TERRACE = (-10.0, 10.0, ZS, 36.0)                   # outside platform x0,x1,z0,z1
DOOR = 4.0                                          # door half width (frame posts inside it)
COL_R, BAND_R = 0.8, 0.86                           # column shaft and gilt band radius (the collider covers the bands)
DRESS = 0.12                                        # wall dressing depth (pilasters); its collider/camera box
ALCOVES = {0: (-9, -2, 5, 12, 19), UP: (-26, -14, -2, 10, 22)}

MAT = mats.make_materials()                         # also sets kit.TILE, needed before any geometry


# ---------------------------------------------------------------- building helpers
def carpet_uv(axis, c0, width):
    """Runner top: u across the runner (0..1), v along it, one A5 repeat per 6 m (A5 is 2:3)."""
    if axis == 'z': return lambda p: ((p[0] - c0) / width, -p[2] / 6)
    return lambda p: ((p[2] - c0) / width, p[0] / 6)


def gilt(side, length, height=1.0):
    """faces/fit kwargs for a box face carrying the A2 band (3:2) at its natural aspect."""
    return {'faces': {side: 'GoldBand'}, 'fit': {side: (max(1, round(length / (1.5 * height))), 1)}}


def ring(name, y0, y1, outer, inner, mat='Ceiling'):
    """Four boards framing a rectangular opening; the riser facing the opening is gilt."""
    (ox0, ox1, oz0, oz1), (ix0, ix1, iz0, iz1) = outer, inner
    h = y1 - y0
    box(name, mat, ox0, ox1, y0, y1, oz0, iz0, nav=('cam',), **gilt('+z', ix1 - ix0, h))
    box(name, mat, ox0, ox1, y0, y1, iz1, oz1, nav=('cam',), **gilt('-z', ix1 - ix0, h))
    box(name, mat, ox0, ix0, y0, y1, iz0, iz1, nav=('cam',), **gilt('+x', iz1 - iz0, h))
    box(name, mat, ix1, ox1, y0, y1, iz0, iz1, nav=('cam',), **gilt('-x', iz1 - iz0, h))


def finial(name, x, z, y):
    """Gilt bulb on a post top; never wider than the 0.2 m post, so end posts against walls stay clean."""
    lathe(name, 'Gold', x, z, [(0.07, y), (0.1, y + 0.07), (0.085, y + 0.15), (0.03, y + 0.22), (0.0, y + 0.26)], sides=12)


POST, POST_H = 0.22, 1.22


def balustrade(name, axis, a0, a1, c0, c1, y, mat='Lacquer', panel='GoldBand', every=2.0):
    """Straight balustrade on a level floor. axis = run direction; c0..c1 = thickness (the collider,
    unchanged from the D1 rail). Posts with gilt finials, a carved panel low, an open band above it
    and a handrail: the atrium stays visible through it. One collider for the run, plus a camera box
    up to the finial tops."""
    a0, a1 = sorted((a0, a1)); c0, c1 = sorted((c0, c1)); L = a1 - a0; t = c1 - c0; cm = (c0 + c1) / 2
    n = max(1, math.ceil((L - POST) / every)); pitch = (L - POST) / n
    starts = [a0 + k * pitch for k in range(n + 1)]
    def B(nm, m, p0, p1, q0, q1, yy0, yy1, **kw):
        return box(nm, m, q0, q1, yy0, yy1, p0, p1, **kw) if axis == 'z' else box(nm, m, p0, p1, yy0, yy1, q0, q1, **kw)
    long_sides = ('+x', '-x') if axis == 'z' else ('+z', '-z')
    for s in starts:
        B(name + '-post', mat, s, s + POST, c0, c1, y, y + POST_H)
        cx, cz = (cm, s + POST / 2) if axis == 'z' else (s + POST / 2, cm)
        finial(name + '-finial', cx, cz, y + POST_H)
    for s, e in zip(starts, starts[1:]):
        p0, p1 = s + POST, e
        B(name + '-sill', mat, p0, p1, cm - t * .4, cm + t * .4, y, y + 0.1)
        ru = max(1, round((p1 - p0) / .78))
        B(name + '-panel', mat, p0, p1, cm - t * .25, cm + t * .25, y + 0.1, y + 0.62,
          faces={sd: panel for sd in long_sides}, fit={sd: (ru, 1) for sd in long_sides})
        B(name + '-rail', mat, p0, p1, cm - t * .42, cm + t * .42, y + 0.98, y + 1.1)
    i = uid(name)
    lo = (c0, a0) if axis == 'z' else (a0, c0); hi = (c1, a1) if axis == 'z' else (a1, c1)
    nav_box('colliders', i, lo[0], hi[0], y, y + RAIL_H, lo[1], hi[1])
    nav_box('cameraBlockers', i + '-cam', lo[0], hi[0], y, y + POST_H + 0.26, lo[1], hi[1])
    return i


def stair_balustrade(name, c0, c1, bands, to_floor=False, every=4):
    """Balustrade up a flight. bands: [(z0, z1, walk_y)] per tread, bottom → top. Walking collider per
    tread as in D1 (to_floor: the flight is a solid mass beside open floor, so it reaches y=0). Render:
    a post every `every` treads, a carved panel on the others and a sloped handrail between post tops,
    checked analytically to clear the panels."""
    c0, c1 = sorted((c0, c1)); t = c1 - c0; cm = (c0 + c1) / 2
    posts = sorted(set(list(range(0, len(bands), every)) + [len(bands) - 1]))
    for k, (z0, z1, y) in enumerate(bands):
        i = uid(name)
        nav_box('colliders', i, c0, c1, 0 if to_floor else y, y + RAIL_H, z0, z1)
        nav_box('cameraBlockers', i + '-cam', c0, c1, y, y + POST_H + 0.26, z0, z1)
        if k in posts:
            box(name + '-post', 'Lacquer', c0, c1, y, y + POST_H, z0, z1)
            finial(name + '-finial', cm, (z0 + z1) / 2, y + POST_H)
        else:
            box(name + '-panel', 'Lacquer', cm - t * .25, cm + t * .25, y, y + 0.55, z0, z1,
                faces={'+x': 'GoldBand', '-x': 'GoldBand'}, fit={'+x': (1, 1), '-x': (1, 1)})
    for a, b in zip(posts, posts[1:]):
        (za0, za1, ya), (zb0, zb1, yb) = bands[a], bands[b]
        zca, zcb = (za0 + za1) / 2, (zb0 + zb1) / 2; dz = zcb - zca
        sgn = 1 if dz > 0 else -1
        A = zca + sgn * (za1 - za0) / 2; Bz = zcb - sgn * (zb1 - zb0) / 2      # post faces
        line = lambda z: ya + 1.0 + (yb - ya) * (z - zca) / dz
        for k in range(a + 1, b):                                            # clears every panel between
            z0, z1, y = bands[k]
            assert min(line(z0), line(z1)) > y + 0.55 + 0.05, (name, k)
        sloped_bar('Lacquer', (cm, line(A), A), (cm, line(Bz), Bz), t * .8, 0.1)


def dress_wall(side, fixed, a0, a1, y0, y1, exclude=()):
    """Interior wall dressing on a wall face: lacquer dado, carved cloud-relief panels between
    pilasters, a gilt frieze on top. side: the face normal into the room ('+x' west wall, '-x' east,
    '+z' north, '-z' south); fixed = the wall face coordinate; a0..a1 the run along the wall.
    exclude: [(b0, b1, ytop)] spans kept clear below ytop (alcoves); a relief panel fills the span
    above it. One collider + camera box covers the run."""
    axis_n = side[1]; s = 1 if side[0] == '+' else -1
    back = ('-' if s > 0 else '+') + axis_n
    def B(nm, m, p0, p1, depth, yy0, yy1, **kw):
        q0, q1 = sorted((fixed, fixed + s * depth))
        if axis_n == 'x': return box(nm, m, q0, q1, yy0, yy1, p0, p1, skip=(back,), **kw)
        return box(nm, m, p0, p1, yy0, yy1, q0, q1, skip=(back,), **kw)
    D0, P0, P1, FR = y0 + 1.0, y0 + 1.2, y1 - 1.2, y1 - 0.8          # dado top, panel bottom/top, frieze bottom
    spans, cur = [], a0
    for b0, b1, _ in sorted(exclude):
        if b0 > cur: spans.append((cur, b0))
        cur = max(cur, b1)
    if cur < a1: spans.append((cur, a1))
    for b0, b1 in spans:                                                # dado, pilasters, panels
        B('dado', 'Lacquer', b0, b1, 0.08, y0, D0)
        L = b1 - b0; n = max(1, math.ceil((L - 0.3) / 3.4)); pitch = (L - 0.3) / n
        for k in range(n + 1):
            p = b0 + k * pitch
            B('pilaster', 'Lacquer', p, p + 0.3, DRESS, D0, FR)
            if k < n: B('relief', 'Relief', p + 0.3, b0 + (k + 1) * pitch, 0.05, P0, P1)
    for b0, b1, ytop in exclude:                                        # relief above the kept-clear spans
        if ytop + 0.3 < P1: B('relief', 'Relief', b0, b1, 0.05, ytop + 0.3, P1)
    B('frieze', 'Lacquer', a0, a1, 0.06, FR, y1, **gilt(side, a1 - a0, 0.8))   # full length, above every excluded span
    q0, q1 = sorted((fixed, fixed + s * DRESS)); i = uid('wall-dressing')
    if axis_n == 'x':
        nav_box('colliders', i, q0, q1, y0, y1, a0, a1); nav_box('cameraBlockers', i + '-cam', q0, q1, y0, y1, a0, a1)
    else:
        nav_box('colliders', i, a0, a1, y0, y1, q0, q1); nav_box('cameraBlockers', i + '-cam', a0, a1, y0, y1, q0, q1)


# ---------------------------------------------------------------- ground floor + terrace
fl = lambda x0, x1, z0, z1: box('floor', 'Floor', x0, x1, -0.4, 0, z0, z1, skip=('-y',))
def runner(x0, x1, z0, z1):
    box('carpet', 'Floor', x0, x1, -0.4, 0, z0, z1, skip=('-y',), faces={'+y': 'Carpet'}, uvf={'+y': carpet_uv('z', x0, x1 - x0)})
fl(-HX, -2, ZN, ZS); fl(2, HX, ZN, ZS); fl(-2, 2, ZN, ZSTAIR); fl(-2, 2, -2, 6)
runner(-2, 2, ZSTAIR, -2); runner(-2, 2, 6, ZS)
surface('ground', -HX, HX, ZN, ZS, 0)
lathe('array-inlay', 'Gold', 0, 2, [(5.0, 0.0), (5.0, 0.01)], sides=64, cap_mat='Array')   # the Treasure's array: an inlay, not a step
box('threshold', 'Marble', -DOOR, DOOR, -0.4, 0, ZS, ZS + WT, skip=('-y',))
box('terrace', 'Marble', TERRACE[0], TERRACE[1], -0.4, 0, ZS + WT, TERRACE[3], skip=('-y',))
box('terrace-podium', 'Stone', TERRACE[0], TERRACE[1], -6, -0.4, ZS + WT, TERRACE[3], skip=('+y',))
surface('terrace', TERRACE[0], TERRACE[1], ZS, TERRACE[3], 0)
for sx in (-1, 1):
    balustrade('terrace-rail', 'z', ZS + WT, TERRACE[3], sx * (TERRACE[1] - RAIL_T), sx * TERRACE[1], 0, mat='Marble', panel='Marble')
    # Lux3D guardian lions (B1, facing out; the east one mirrored) on marble pedestals, and two pairs
    # of Lux3D stone lamps (B2) with a glowing core in the openwork chamber.
    box('lion-pedestal', 'Marble', sx * 5.7, sx * 7.3, 0, 0.8, 32.7, 34.3, nav=('block',))
    props.place('B1', sx * 6.5, 0.8, 33.5, 2.2, mirror=sx > 0, name='lion')
    for lz in (30.5, 34.9):
        props.place('B2', sx * 8.7, 0, lz, 2.4, name='stone-lamp')
        box('stone-lamp-light', 'Glow', sx * 8.7 - .12, sx * 8.7 + .12, 1.58, 1.82, lz - .12, lz + .12, pierce=True)
balustrade('terrace-rail', 'x', TERRACE[0] + RAIL_T, TERRACE[1] - RAIL_T, TERRACE[3] - RAIL_T, TERRACE[3], 0, mat='Marble', panel='Marble')
light('terrace', (0, 6, 33), (.75, .82, 1), 300)

# ---------------------------------------------------------------- outer walls, door, plaques
H = CEIL + SLAB
for sx in (-1, 1):
    box('wall-side', 'WallWood', sx * HX, sx * (HX + WT), -0.4, H, ZN - WT, ZS + WT, nav=('block',))
box('wall-north', 'WallWood', -HX, HX, -0.4, H, ZN - WT, ZN, nav=('block',))
for sx in (-1, 1):
    box('wall-south', 'WallWood', sx * DOOR, sx * HX, -0.4, H, ZS, ZS + WT, nav=('block',))
box('door-lintel', 'WallWood', -DOOR, DOOR, 7.0, H, ZS, ZS + WT, nav=('block',))
for sx in (-1, 1):
    box('door-post', 'Gold', sx * (DOOR - 0.4), sx * DOOR, 0, 7.0, ZS - 0.2, ZS + WT + 0.2, nav=('block',))
    box('door-leaf', 'Door', sx * DOOR, sx * (DOOR + 3.6), 0, 7.0, ZS - 0.2, ZS, nav=('block',))
    box('door-lattice', 'Lattice', sx * (DOOR + 0.3), sx * (DOOR + 3.3), 3.4, 6.6, ZS - 0.24, ZS - 0.2, nav=('cam',), fit={'-z': (2, 2)})
box('door-head', 'Gold', -(DOOR - 0.4), DOOR - 0.4, 6.6, 7.0, ZS - 0.2, ZS + WT + 0.2, nav=('cam',))
box('plaque-outside', 'Gold', -2.5, 2.5, 8.0, 8.0 + 5 / 1.5, ZS + WT, ZS + WT + 0.2, nav=('cam',), faces={'+z': 'Plaque'}, fit={'+z': (1, 1)})
box('plaque-inside', 'Gold', -2.0, 2.0, 12.0, 12.0 + 4 / 1.5, ZS - 0.2, ZS, nav=('cam',), faces={'-z': 'Plaque'}, fit={'-z': (1, 1)})

# Interior wall dressing, ground floor (0..8.4) and upper floor (9..17.2).
for y0, y1 in ((0, UP - SLAB), (UP, CEIL - 0.8)):
    al = [(z - 1.7, z + 1.7, y0 + 4.7) for z in ALCOVES[y0]]
    dress_wall('+x', -HX, ZN + DRESS, ZS - DRESS, y0, y1, al)
    dress_wall('-x', HX, ZN + DRESS, ZS - DRESS, y0, y1, al)
for sx in (-1, 1):
    span = lambda a, b: (min(sx * a, sx * b), max(sx * a, sx * b))
    dress_wall('+z', ZN, *span(SX1, HX - DRESS), 0, UP - SLAB)                 # beside the landing podium
    dress_wall('+z', ZN, *span(SX1 + RAIL_T, HX - DRESS), UP, CEIL - 0.8)     # beside the stair-hall rail
    dress_wall('-z', ZS, *span(DOOR + 3.6, HX - DRESS), 0, UP - SLAB)         # beside the open door leaves
    dress_wall('-z', ZS, *span(2.3, HX - DRESS), UP, CEIL - 0.8)              # beside the inside plaque

# ---------------------------------------------------------------- columns
def column(x, z, top, atrium=True):
    prism('column-plinth', 'Marble', x, z, 1.25, 0, 0.3, sides=8, phase=0)
    lathe('column-base', 'Gold', x, z, [(1.12, 0.3), (1.12, 0.38), (0.98, 0.5), (0.9, 0.6)], sides=32)
    nav_circle('colliders', uid('column-foot'), x, z, 1.25, 0, 0.6)
    nav_circle('colliders', uid('column'), x, z, BAND_R, 0.6, top)
    seg = lambda y0, y1, pierce=False: cylinder('column-shaft', 'Lacquer', x, z, COL_R, y0, y1, sides=24, pierce=pierce)
    band = lambda y0, y1: cylinder('column-band', 'GoldBand', x, z, BAND_R, y0, y1, sides=24, band=True, u_repeat=3)
    seg(0.6, 1.2); band(1.2, 2.2)
    if atrium:
        seg(2.2, 7.4); band(7.4, 8.4); seg(8.4, 16.4, pierce=True); band(16.4, 17.2)
        # Capital: a gilt bearing block, crossed bracket arms (joinery: they pass through each other), a top block.
        box('capital-block', 'Gold', x - .85, x + .85, 17.2, 17.55, z - .85, z + .85)
        box('capital-arm', 'Lacquer', x - 1.5, x + 1.5, 17.55, 17.8, z - .15, z + .15, pierce=True, **gilt('+z', 3, .25))
        box('capital-arm', 'Lacquer', x - .13, x + .13, 17.57, 17.78, z - 1.5, z + 1.5, pierce=True)   # a hair slimmer: no shared planes
        box('capital-top', 'Gold', x - 1.0, x + 1.0, 17.8, CEIL, z - 1.0, z + 1.0)
        nav_box('cameraBlockers', uid('capital'), x - 1.5, x + 1.5, 17.2, CEIL, z - 1.5, z + 1.5)
    else:
        seg(2.2, 7.0); band(7.0, 7.9)
        box('column-cap', 'Gold', x - .85, x + .85, 7.9, top, z - .85, z + .85, nav=('cam',))
for sx in (-1, 1):
    for z in COLZ: column(sx * 11, z, CEIL - 0.8)
    column(sx * 11, HALL_Z, UP - SLAB, atrium=False)   # entrance hall: in line with the atrium columns, carries the upper slab only

# ---------------------------------------------------------------- upper floor (slab + surfaces + jump ceilings)
UPPER = [('upper-west', -HX, -11, ZN, ZS), ('upper-east', 11, HX, ZN, ZS), ('upper-south', -11, 11, ATR[3], ZS), ('upper-bridge', -11, 11, ZSTAIR, ATR[2])]
for n, x0, x1, z0, z1 in UPPER:
    nav_box('airColliders', uid(n), x0, x1, UP - SLAB, UP, z0, z1)
    surface(n, x0, x1, z0, z1, UP)
RUN_X, RUN_Z = (14.3, 16.7), (21.3, 23.7)            # carpet runners: along each side gallery, across the south gallery
def slab_piece(x0, x1, z0, z1, carpet=None):
    kw = {'faces': {'-y': 'Ceiling', '+y': 'Slab'}}
    if carpet == 'z': kw = {'faces': {'-y': 'Ceiling', '+y': 'Carpet'}, 'uvf': {'+y': carpet_uv('z', x0, x1 - x0)}}
    if carpet == 'x': kw = {'faces': {'-y': 'Ceiling', '+y': 'Carpet'}, 'uvf': {'+y': carpet_uv('x', z0, z1 - z0)}}
    box('upper-slab', 'Lacquer', x0, x1, UP - SLAB, UP, z0, z1, **kw)
for sx in (-1, 1):
    X = lambda a, b: (min(sx * a, sx * b), max(sx * a, sx * b))
    slab_piece(*X(RUN_X[1], HX), ZN, ZS); slab_piece(*X(RUN_X[0], RUN_X[1]), ZN, ZS, 'z')
    slab_piece(*X(11, RUN_X[0]), ZN, RUN_Z[0]); slab_piece(*X(11, RUN_X[0]), *RUN_Z, 'x'); slab_piece(*X(11, RUN_X[0]), RUN_Z[1], ZS)
slab_piece(-11, 11, ATR[3], RUN_Z[0]); slab_piece(-11, 11, *RUN_Z, 'x'); slab_piece(-11, 11, RUN_Z[1], ZS)
slab_piece(-11, 11, ZSTAIR, ATR[2])
# Gilt fascia beams under the slab edges round the atrium, between the columns.
for sx in (-1, 1):
    for a, b in zip(COLZ, COLZ[1:]):
        box('fascia', 'Lacquer', sx * 10.7, sx * 11.3, 7.8, UP - SLAB, a + 0.9, b - 0.9, nav=('cam',), **gilt('+x' if sx < 0 else '-x', b - a - 1.8, 0.6))
box('fascia', 'Lacquer', -10.1, 10.1, 7.8, UP - SLAB, ATR[3] - 0.3, ATR[3] + 0.3, nav=('cam',), **gilt('-z', 20.2, 0.6))
box('fascia', 'Lacquer', -10.1, 10.1, 7.8, UP - SLAB, ATR[2] - 0.3, ATR[2] + 0.3, nav=('cam',), **gilt('+z', 20.2, 0.6))
# Cross beams over the side galleries: under the upper slab (ground floor) and under the ceiling (upper floor).
for sx in (-1, 1):
    for z in COLZ + [-19.0, -26.0, HALL_Z]:
        end = 11.9 if z in COLZ or z == HALL_Z else 11.0
        box('beam', 'Lacquer', sx * (HX - 0.06), sx * end, 7.6, UP - SLAB, z - .25, z + .25, nav=('cam',), **gilt('-y', HX - 0.06 - end, 0.5))
    for z in COLZ + [-19.0, -26.0, 22.5]:
        end = 12.0 if z in COLZ else 11.0
        box('beam', 'Lacquer', sx * HX, sx * end, CEIL - 0.8, CEIL, z - .25, z + .25, nav=('cam',), **gilt('-y', HX - end, 0.5))

# ---------------------------------------------------------------- ceiling, clerestory, inner eaves, caisson, roofs
for n, x0, x1, z0, z1 in [('ceiling-west', -HX, -11, ZN, ZS), ('ceiling-east', 11, HX, ZN, ZS), ('ceiling-south', -11, 11, ATR[3], ZS), ('ceiling-north', -11, 11, ZN, ATR[2])]:
    box(n, 'Ceiling', x0, x1, CEIL, CEIL + SLAB, z0, z1, nav=('air',))
TOP = CEIL + SLAB
for n, x0, x1, z0, z1 in [('clerestory-n', -11.6, 11.6, -12.6, -12), ('clerestory-s', -11.6, 11.6, 16, 16.6), ('clerestory-w', -11.6, -11, -12, 16), ('clerestory-e', 11, 11.6, -12, 16)]:
    box(n, 'WallWood', x0, x1, TOP, 26, z0, z1, nav=('cam',))
# Clerestory inner faces: gilt fascia, a bracket row under the inner eave, lattice windows lit from behind.
EAVE_Y0, EAVE_Y1, EAVE_IN = 21.0, 20.2, 1.2
FAC = (19.2, 19.8); WIN = (21.6, 25.4)
def clerestory_face(side, fixed, a0, a1, n_win):
    s = 1 if side[0] == '+' else -1; axis_n = side[1]
    def B(nm, m, p0, p1, d0, d1, yy0, yy1, **kw):
        q0, q1 = sorted((fixed + s * d0, fixed + s * d1))
        return box(nm, m, q0, q1, yy0, yy1, p0, p1, **kw) if axis_n == 'x' else box(nm, m, p0, p1, yy0, yy1, q0, q1, **kw)
    B('eave-fascia', 'Lacquer', a0, a1, 0, 0.12, *FAC, **gilt(side, a1 - a0, 0.6))
    c = a0 + 1.6
    while c <= a1 - 1.6 + 1e-6:
        B('bracket-arm', 'Lacquer', c - .12, c + .12, 0, 0.25, FAC[1], 20.15)
        B('bracket', 'Gold', c - .17, c + .17, 0, 0.4, 20.15, 20.5)
        c += 1.4
    B('window-sill', 'Lacquer', a0, a1, 0, 0.15, WIN[0] - 0.2, WIN[0])
    B('window-head', 'Lacquer', a0, a1, 0, 0.15, WIN[1], WIN[1] + 0.2)
    pitch = (a1 - a0) / n_win; edges = [a0]
    for k in range(n_win):
        m = a0 + pitch * (k + .5)
        B('window-glow', 'WindowGlow', m - 1.2, m + 1.2, 0, 0.03, *WIN)
        B('window-lattice', 'Lattice', m - 1.2, m + 1.2, 0.05, 0.08, *WIN, fit={side: (1, 1.5)})
        edges += [m - 1.2, m + 1.2]
    edges.append(a1)
    for p0, p1 in zip(edges[::2], edges[1::2]):
        if p1 - p0 > 1e-3: B('window-mullion', 'Lacquer', p0, p1, 0, 0.15, *WIN)
clerestory_face('+x', -11, -11.85, 15.85, 9); clerestory_face('-x', 11, -11.85, 15.85, 9)
clerestory_face('+z', -12, -11, 11, 7); clerestory_face('-z', 16, -11, 11, 7)
frustum('RoofTile', [(-11, 11, -12, 16, EAVE_Y0), (-11 + EAVE_IN, 11 - EAVE_IN, -12 + EAVE_IN, 16 - EAVE_IN, EAVE_Y1)], inward=True)
# Caisson: two stepped boards, then the painted octagonal caisson (A3) round the oculus.
R0, R1, SQ = (-11.6, 11.6, -12.6, 16.6), (-8.5, 8.5, -9.5, 13.5), (-7.0, 7.0, -5.0, 9.0)
ring('caisson-1', 26, 26.6, R0, R1); ring('caisson-2', 26.6, 27.2, R1, SQ)
HR = 14.0 * mats.caisson_hole_fraction()
slab_with_hole('caisson', 'Caisson', SQ[0], SQ[1], SQ[2], SQ[3], 27.2, 27.4, 0, 2, HR)
annulus_y('Gold', 0, 2, 27.4, 29.5, HR, HR + 0.3)
light('sky', (0, 40, 2), (.80, .87, 1), 1)
# Exterior roofs: lower hip skirt to the clerestory, upper hip to the oculus; eave undersides in wood.
lower = [(-HX - 2.5, HX + 2.5, ZN - 2.5, ZS + 2.5, TOP - 0.6), (-HX - WT, HX + WT, ZN - WT, ZS + WT, TOP), (-11.6, 11.6, -12.6, 16.6, 21.6)]
upper = [(-12.8, 12.8, -13.8, 17.8, 25.6), (-11.6, 11.6, -12.6, 16.6, 26.6), (-HR - 0.3, HR + 0.3, 2 - HR - 0.3, 2 + HR + 0.3, 29.5)]
frustum('RoofTile', lower); frustum('Ceiling', lower[:2], inward=True)
frustum('RoofTile', upper); frustum('Ceiling', upper[:2], inward=True)

# ---------------------------------------------------------------- north hall: central flight, landing, side flights
central = []
for i in range(1, NT + 1):
    z1, z0, y = ZSTAIR - (i - 1) * RUN, ZSTAIR - i * RUN, i * RISE
    box('central-tread', 'Stone', -CX, CX, 0, y, z0, z1, nav=('cam',), skip=('-y',))   # solid steps: the boom must not enter them from the side
    surface('central-tread', -CX, CX, z0, z1, y); central.append((z0, z1, y))
for sx in (-1, 1):
    stair_balustrade('central-rail', sx * (CX - RAIL_T), sx * CX, central, to_floor=True)
    # Newel posts with lamps at the foot of the central flight.
    nx0, nx1 = sorted((sx * 2.55, sx * 3.05))
    box('newel', 'Lacquer', nx0, nx1, 0, 1.5, ZSTAIR, ZSTAIR + 0.5, **gilt('+z', .5, .5))
    box('newel-lamp', 'Glow', nx0 + .07, nx1 - .07, 1.5, 1.85, ZSTAIR + .07, ZSTAIR + .43)
    box('newel-cap', 'Gold', nx0 - .03, nx1 + .03, 1.85, 1.97, ZSTAIR - .03, ZSTAIR + .53)
    nav_box('colliders', uid('newel'), nx0 - .03, nx1 + .03, 0, 1.97, ZSTAIR - .03, ZSTAIR + .53)
    nav_box('cameraBlockers', uid('newel-cam'), nx0 - .03, nx1 + .03, 0, 1.97, ZSTAIR - .03, ZSTAIR + .53)
box('landing', 'Stone', -SX1, SX1, 0, YLAND, ZN, ZLAND, nav=('block',), skip=('-y',))
surface('landing', -SX1, SX1, ZN, ZLAND, YLAND)
for sx in (-1, 1):
    balustrade('landing-rail', 'x', sx * CX, sx * SX0, ZLAND - RAIL_T, ZLAND, YLAND)
    balustrade('landing-rail', 'z', ZN, ZLAND, sx * (SX1 - RAIL_T), sx * SX1, YLAND)
    side = []
    for j in range(1, NT + 1):
        z0, z1, y = ZLAND + (j - 1) * RUN, ZLAND + j * RUN, YLAND + j * RISE
        box('side-tread', 'Stone', sx * SX0, sx * SX1, y - 0.6, y, z0, z1, nav=('air',))
        surface('side-tread', min(sx * SX0, sx * SX1), max(sx * SX0, sx * SX1), z0, z1, y); side.append((z0, z1, y))
    stair_balustrade('side-rail', sx * SX0, sx * (SX0 + RAIL_T), side)
    stair_balustrade('side-rail', sx * (SX1 - RAIL_T), sx * SX1, side)
    j = 12; zb0, zb1 = ZLAND + (j - 1) * RUN, ZLAND + j * RUN
    box('side-pier', 'Stone', sx * 8.8, sx * 9.4, 0, YLAND + j * RISE - 0.6, zb0, zb1, nav=('block',))
    balustrade('stairhall-rail', 'z', ZN, ZSTAIR, sx * SX1, sx * (SX1 + RAIL_T), UP)   # upper floor edge over the stair hall
balustrade('bridge-rail', 'x', -SX0, SX0, ZSTAIR, ZSTAIR + RAIL_T, UP)
# Moon gate on the north wall above the landing, the painted portal inside, couplet banners beside it.
GATE_R, GATE_Y = 4.6, YLAND + 4.6
annulus_xy('Gold', 0, GATE_Y, ZN, ZN + 0.6, 3.8, GATE_R)
nav_box('colliders', 'moon-gate', -GATE_R, GATE_R, YLAND, GATE_Y + GATE_R, ZN, ZN + 0.6)
disc_xy('Portal', 0, GATE_Y, ZN + 0.02, 3.8, 1)
light('portal', (0, GATE_Y, ZN + 2), (.6, .78, 1), 180)
for sx, b in ((1, 'Banner1'), (-1, 'Banner2')):        # 万宝归藏 on the right (east) as one faces north
    x0, x1 = sorted((sx * 6.3, sx * 8.7))
    box('wall-banner', 'Lacquer', x0, x1, 11.0, 14.6, ZN, ZN + 0.04, faces={'+z': b}, fit={'+z': (1, 1)}, skip=('-z',))
    box('wall-banner-rod', 'Gold', x0 - .2, x1 + .2, 14.6, 14.72, ZN, ZN + 0.08, skip=('-z',))

# ---------------------------------------------------------------- atrium guards on the upper floor, hanging banners
balustrade('atrium-rail', 'x', -10.2, 10.2, ATR[2] - RAIL_T, ATR[2], UP)
balustrade('atrium-rail', 'x', -10.2, 10.2, ATR[3], ATR[3] + RAIL_T, UP)
for sx in (-1, 1):
    for a, b in zip(COLZ, COLZ[1:]):
        balustrade('atrium-rail', 'z', a + 0.8, b - 0.8, sx * 11, sx * (11 + RAIL_T), UP)
for sx in (-1, 1):
    for z, b in ((-1.5, 'Banner1' if sx > 0 else 'Banner2'), (5.5, 'Banner2' if sx > 0 else 'Banner1')):
        x = sx * 9.9
        box('atrium-banner', 'Lacquer', x - .02, x + .02, 12.0, 15.6, z - 1.2, z + 1.2, faces={'+x': b, '-x': b}, fit={'+x': (1, 1), '-x': (1, 1)})
        box('atrium-banner-bar', 'Gold', x - .05, x + .05, 15.6, 15.7, z - 1.3, z + 1.3)
        box('atrium-banner-rod', 'Gold', x - .03, x + .03, 15.7, 20.1, z - .03, z + .03)
        nav_box('cameraBlockers', uid('atrium-banner'), x - .1, x + .1, 12.0, 20.1, z - 1.3, z + 1.3)

# ---------------------------------------------------------------- exhibits: 1 S, 9 A, 20 B (slot n = marker T0n)
SLOTS = []
def slot(tier, label, x, y, z, yaw, footprint, fit, target):
    sid = f'T{len(SLOTS) + 1:02d}'
    SLOTS.append({'id': sid, 'floor': 1 if y >= UP - 0.2 else 0, 'tier': tier, 'label': label, 'position': [r4(x), r4(y), r4(z)],
                  'footprint': list(footprint), 'yaw': r4(yaw), 'fit': {'maxSize': fit[0], 'restY': r4(fit[1])}, 'target': {'y0': r4(target[0]), 'y1': r4(target[1])}})
# The Treasure sits on its own dais (a sumeru base, a lotus rim, the array on top), a little taller
# than the 0.8 m lotus pedestals around it.
DAIS_R, DAIS_H = 3.2, 1.2
lathe('dais-base', 'Marble', 0, 2, [(3.2, 0.01), (3.2, 0.22), (3.0, 0.3), (2.75, 0.42), (2.75, 0.72), (2.95, 0.85)], sides=64)
lathe('dais', 'Gold', 0, 2, [(2.95, 0.85), (3.18, 0.98), (3.05, 1.1), (2.9, DAIS_H)], sides=64, petals=16, petal_depth=.06, cap_mat='Array')
nav_circle('colliders', 'dais-guard', 0, 2, DAIS_R, 0, DAIS_H)
slot('S', '天井 · 镇阁之宝', 0, 0, 2, 0, (2 * DAIS_R, 2 * DAIS_R), (5.0, DAIS_H + 0.15), (0, DAIS_H + 2.5))
def lotus(label, x, y, z, yaw):
    lathe('lotus-base', 'Stone', x, z, [(1.2, y), (1.2, y + 0.15), (1.02, y + 0.22), (0.9, y + 0.3)], sides=32, nav=('block',))
    lathe('lotus', 'Marble', x, z, [(0.9, y + 0.3), (1.0, y + 0.45), (1.18, y + 0.7), (1.05, y + 0.8)], sides=48, petals=12, petal_depth=.1, cap_mat='Gold')
    nav_circle('colliders', uid('lotus-guard'), x, z, 1.2, y, y + 0.8)
    slot('A', label, x, y, z, yaw, (2.4, 2.4), (2.5, y + 0.95), (y, y + 1.25))
lotus('北殿平台 · 甲', 0, YLAND, -28, 0)                                   # T02
BAYS = [(a + b) / 2 for a, b in zip(COLZ, COLZ[1:])]                        # -8.5, -1.5, 5.5, 12.5
for z in BAYS: lotus('西柱间 · 甲', -11, 0, z, math.pi / 2)                   # T03–T06, north → south
for z in BAYS: lotus('东柱间 · 甲', 11, 0, z, -math.pi / 2)                   # T07–T10
def alcove(label, sx, y, z):
    """Wall niche on the side wall x = sx·22, opening toward the hall (+x for the west wall)."""
    w = sx * HX; inw = -sx                                        # inward direction
    X = lambda d: w + inw * d                                     # point d metres in from the wall face
    front = '+x' if inw > 0 else '-x'
    box('alcove-back', 'Relief', X(0), X(0.1), y, y + 4.0, z - 1.2, z + 1.2)
    for s in (-1, 1): box('alcove-pillar', 'Lacquer', X(0), X(1.8), y, y + 4.2, z + s * 1.2, z + s * 1.5, nav=('block',))
    box('alcove-lintel', 'Lacquer', X(0), X(2.1), y + 4.2, y + 4.4, z - 1.7, z + 1.7, **gilt(front, 3.4, .2))
    nav_box('cameraBlockers', uid('alcove-canopy'), X(0), X(2.1), y + 4.2, y + 4.7, z - 1.7, z + 1.7)
    # tiled canopy: a slope from the lintel's front edge up to the wall, closed at both ends
    a, b = (X(2.1), y + 4.4), (X(0), y + 4.7)
    pts = [(a[0], a[1], z - 1.7), (a[0], a[1], z + 1.7), (b[0], b[1], z + 1.7), (b[0], b[1], z - 1.7)]
    kit.face('RoofTile', pts, [kit.world_uv('RoofTile', p, (0, 0, 1), (-inw, 1, 0)) for p in pts], out=(inw * 0.3, 2.1, 0))
    for s in (-1, 1):
        tri = [(a[0], a[1], z + s * 1.7), (b[0], b[1], z + s * 1.7), (b[0], a[1], z + s * 1.7)]
        kit.face('Lacquer', tri, [(0, 0), (1, 0), (1, .3)], out=(0, 0, s))
    box('alcove-lamp', 'Glow', X(0.8), X(1.2), y + 3.9, y + 4.2, z - 0.2, z + 0.2, nav=('cam',))
    box('alcove-plinth', 'Lacquer', X(0.4), X(1.6), y, y + 0.9, z - 0.7, z + 0.7, nav=('block',), faces={front: 'GoldBand'}, fit={front: (1, 1)})
    slot('B', label, X(1.0), y, z, inw * math.pi / 2, (1.2, 1.4), (1.6, y + 1.05), (y, y + 1.25))
for z in ALCOVES[0]: alcove('西侧殿 · 乙', -1, 0, z)
for z in ALCOVES[0]: alcove('东侧殿 · 乙', 1, 0, z)
for z in ALCOVES[UP]: alcove('二层西展厅 · 乙', -1, UP, z)
for z in ALCOVES[UP]: alcove('二层东展厅 · 乙', 1, UP, z)
assert len(SLOTS) == 30

# ---------------------------------------------------------------- Lux3D furnishings: hall censers, curio cabinets
# A pair of bronze censers (B3) on octagonal stone bases flanks the entrance-hall carpet.
for sx in (-1, 1):
    prism('censer-base', 'Marble', sx * 5, 21, 0.85, 0, 0.3, sides=8, phase=0)
    nav_circle('colliders', uid('censer'), sx * 5, 21, 0.85, 0, 1.8)
    props.place('B3', sx * 5, 0.3, 21, 1.5, nav=('cam',), name='censer')

CURIOS = ['B4', 'B5', 'B6', 'B7', 'B8', 'B9']
CAB_W, CAB_H, CAB_D, CAB_T = 3.0, 3.4, 0.5, 0.08                 # width along the wall, height, depth, side panel
def curio_cabinet(sx, y, zc, k):
    """Duobao curio cabinet against a side wall (x = sx·22), standing on the pilaster faces: a plinth,
    side panels, a back, two shelves with staggered dividers (three rows, two bays each) and a gilt top.
    Lux3D curios (B4–B9, rotated per cabinet) stand in the bays facing the hall."""
    inw = -sx; X = lambda d: sx * HX + inw * d
    front = '+x' if inw > 0 else '-x'; back = '-x' if inw > 0 else '+x'
    d0, d1 = DRESS, DRESS + CAB_D; z0, z1 = zc - CAB_W / 2, zc + CAB_W / 2
    def B(nm, m, da, db, ya, yb, za, zb, **kw): return box(nm, m, X(da), X(db), ya, yb, za, zb, **kw)
    B('cabinet-plinth', 'Lacquer', d0, d1, y, y + 0.15, z0, z1, skip=(back,))
    for za, zb in ((z0, z0 + CAB_T), (z1 - CAB_T, z1)): B('cabinet-side', 'Lacquer', d0, d1, y + 0.15, y + CAB_H - 0.15, za, zb, skip=(back,))
    B('cabinet-top', 'Lacquer', d0, d1 + 0.04, y + CAB_H - 0.15, y + CAB_H, z0 - 0.04, z1 + 0.04, skip=(back,), **gilt(front, CAB_W, 0.15))
    B('cabinet-back', 'Relief', d0, d0 + 0.04, y + 0.15, y + CAB_H - 0.15, z0 + CAB_T, z1 - CAB_T, skip=(back,))
    rows = [(y + 0.15, y + 1.15), (y + 1.2, y + 2.2), (y + 2.25, y + CAB_H - 0.15)]
    for (_, top), (bottom, _) in zip(rows, rows[1:]): B('cabinet-shelf', 'Lacquer', d0 + 0.04, d1, top, bottom, z0 + CAB_T, z1 - CAB_T)
    inner = (z0 + CAB_T, z1 - CAB_T); span = inner[1] - inner[0]
    for r, ((ya, yb), split) in enumerate(zip(rows, (0.42, 0.6, 0.34))):
        zd = inner[0] + span * split
        B('cabinet-divider', 'Lacquer', d0 + 0.04, d1, ya, yb, zd - 0.025, zd + 0.025)
        for b, (za, zb) in enumerate(((inner[0], zd - 0.025), (zd + 0.025, inner[1]))):
            pid = CURIOS[(k + 2 * r + b) % len(CURIOS)]
            w, h, dp = props.size(pid, 1.0)
            hgt = min(0.72, (zb - za - 0.12) / w, (CAB_D - 0.08) / dp)           # fit the bay: wall-wise width, depth, height
            props.place(pid, X((d0 + 0.04 + d1) / 2), ya, (za + zb) / 2, hgt, yaw=inw * math.pi / 2, nav=(), name='curio')
    nav_box('colliders', uid('cabinet'), X(d0), X(d1 + 0.04), y, y + CAB_H, z0 - 0.04, z1 + 0.04)
    nav_box('cameraBlockers', uid('cabinet-cam'), X(d0), X(d1 + 0.04), y, y + CAB_H, z0 - 0.04, z1 + 0.04)
k = 0
for sx in (-1, 1):
    for z in (-5.5, 1.5, 8.5, 15.5): curio_cabinet(sx, 0, z, k); k += 1         # ground floor: between the alcoves
    for z in (-20, -8, 4, 16): curio_cabinet(sx, UP, z, k); k += 1             # upper floor: between the alcoves

# ---------------------------------------------------------------- palace lanterns (render + camera blockers + light markers)
def lantern(role, x, z, y_bottom, size, height, hang_to, power, paper='LanternPaperSmall'):
    r = size / 2; h = height
    prism('lantern-foot', 'Gold', x, z, r * .6, y_bottom, y_bottom + .15 * h, r_top=r * 1.12)
    prism('lantern', 'Gold', x, z, r, y_bottom + .15 * h, y_bottom + .85 * h, side_mat=paper, fit_sides=True)
    prism('lantern-hat', 'Gold', x, z, r * 1.12, y_bottom + .85 * h, y_bottom + h, r_top=r * .45)
    box('lantern-tassel', 'LanternRed', x - .04, x + .04, y_bottom - .35 * h, y_bottom, z - .04, z + .04)
    box('lantern-rod', 'Gold', x - 0.04, x + 0.04, y_bottom + h, hang_to, z - 0.04, z + 0.04, nav=('cam',))
    nav_box('cameraBlockers', uid('lantern'), x - r * 1.12, x + r * 1.12, y_bottom - .35 * h, y_bottom + h, z - r * 1.12, z + r * 1.12)
    light(role, (x, y_bottom + h / 2, z), (1, .62, .28), power)
for sx in (-1, 1):
    for z in (-10.5, 14.5): lantern('atrium', sx * 9.8, z, 13.8, 1.6, 2.4, EAVE_Y1 - 0.2, 900, paper='LanternPaper')
    for z in (-5.5, 1.5, 8.5, 15.5): lantern('hall', sx * 19.25, z, 5.6, 0.8, 1.2, UP - SLAB, 160)
    for z in (-22.5, -8.5, 5.5, 19.5): lantern('upper', sx * 19.25, z, 14.6, 0.8, 1.2, CEIL, 160)
    lantern('entry', sx * 3, 25, 5.6, 0.8, 1.2, UP - SLAB, 160)

# ---------------------------------------------------------------- export gates
OVERLAPS = kit.overlaps()
COPLANAR = kit.coplanar()

# ---------------------------------------------------------------- Blender scene, GLB, layout
for s in list(bpy.data.scenes):
    if s.name == NAME: bpy.data.scenes.remove(s)
scene = bpy.data.scenes.new(NAME); bpy.context.window.scene = scene
col = bpy.data.collections.new('T16_Render'); scene.collection.children.link(col)
objs = []
for material, (vs, fs, uvs, sm) in MESH.items():
    if not vs: continue
    me = bpy.data.meshes.new(f'T16_{material}'); me.from_pydata(vs, [], fs)
    uvl = me.uv_layers.new(name='UVMap')
    uvl.data.foreach_set('uv', [c for fu in uvs for uv in fu for c in uv])
    me.polygons.foreach_set('use_smooth', sm)
    if any(sm):
        # Weld the vertices of smooth faces (lathes, bands) so they shade round; sharp profile corners stay sharp.
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=list({v for f in bm.faces if f.smooth for v in f.verts}), dist=1e-5)
        for e in bm.edges:
            if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(35): e.smooth = False
        bm.to_mesh(me); bm.free()
    me.materials.append(MAT[material]); me.update()
    ob = bpy.data.objects.new(f'T16_{material}', me); col.objects.link(ob); objs.append(ob)
objs += props.objects(col)
# Nav debug collection (not exported): surfaces as thin sheets, so the contract can be eyeballed in Blender.
navc = bpy.data.collections.new('T16_Nav_Debug'); scene.collection.children.link(navc)
dv, df = [], []
for s in NAV['surfaces']:
    n = len(dv); dv += [kit.bl(p) for p in [(s['x0'], s['y'] + .02, s['z0']), (s['x1'], s['y'] + .02, s['z0']), (s['x1'], s['y'] + .02, s['z1']), (s['x0'], s['y'] + .02, s['z1'])]]; df.append((n, n + 1, n + 2, n + 3))
me = bpy.data.meshes.new('T16_Nav_Walk'); me.from_pydata(dv, [], df); ob = bpy.data.objects.new('T16_Nav_Walk', me); navc.objects.link(ob); ob.hide_render = True; ob.hide_set(True)

cam = bpy.data.cameras.new('T16_Entry'); cam.lens = 22; cam.clip_end = 400
camo = bpy.data.objects.new('T16_Entry', cam); scene.collection.objects.link(camo); camo.location = kit.bl((0, 1.6, 24)); camo.rotation_euler = (math.radians(92), 0, 0)
scene.camera = camo
bpy.ops.object.select_all(action='DESELECT')
for o in objs: o.select_set(True)
glb = OUT / 'pavilion-t16.glb'
bpy.ops.export_scene.gltf(filepath=str(glb), export_format='GLB', use_selection=True, export_yup=True, export_apply=True, export_lights=False,
                          export_cameras=False, export_extras=False, export_image_format='JPEG', export_jpeg_quality=85, export_image_quality=85)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'pavilion-t16.blend'))

src = b''.join(p.read_bytes() for p in (Path(__file__), Path(kit.__file__), Path(mats.__file__), Path(props.__file__), props.ROOT / 'assets/t16/props/props-manifest.json'))
layout = {
    'version': 't16-d3', 'scene': NAME, 'source': 'scripts/blender/build_t16.py',
    'sourceSHA256': hashlib.sha256(src).hexdigest(),
    'coordinates': 'Web metres, Y up, north = -Z; Blender (x,-z,y)',
    'upperY': UP, 'floorY': 0, 'entry': {'x': 0, 'y': 0, 'z': 24}, 'entryYaw': 0,
    'exhibitSlots': SLOTS, **NAV, 'lights': LIGHTS,
    'oculus': {'x': 0, 'z': 2, 'r': r4(HR), 'y': 27.4},   # the open skylight: the web light shaft starts here
    'stats': {'glbBytes': glb.stat().st_size, 'triangles': sum(sum(len(f) - 2 for f in fs) for _, fs, _, _ in MESH.values()) + props.triangles(),
              'props': len(props.PLACED),
              'materials': len([m for m, (v, *_) in MESH.items() if v]), 'renderParts': len(PARTS),
              'surfaces': len(NAV['surfaces']), 'colliders': len(NAV['colliders']), 'airColliders': len(NAV['airColliders']),
              'cameraBlockers': len(NAV['cameraBlockers']), 'overlaps': OVERLAPS, 'coplanar': COPLANAR},
}
(OUT / 'pavilion-layout.json').write_text(json.dumps(layout, ensure_ascii=False, indent=1) + '\n')
print(json.dumps({k: (v if not isinstance(v, list) else len(v)) for k, v in layout['stats'].items()}, ensure_ascii=False))
if OVERLAPS or COPLANAR:
    print('OVERLAPS', len(OVERLAPS), OVERLAPS[:30]); print('COPLANAR', len(COPLANAR), COPLANAR[:30]); sys.exit(1)
