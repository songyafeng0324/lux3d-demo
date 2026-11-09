"""T16 geometry kit: every render part is declared once in Web coordinates (metres, Y up, north = -Z)
and emits, as flagged, (a) render faces with UVs, (b) walking colliders, (c) jump ceilings ("air"),
(d) camera-only blockers. Walk surfaces are declared next to the parts that carry them.

Faces are wound outward explicitly (no normal recalculation at export), so single-sided panels,
banners and caps face the right way. Every audited part goes into PARTS for the export gate:
  * interpenetration: two audited AABBs may touch but not overlap (pierce = declared joinery,
    e.g. a column passing through a slab or a bracket tenon through a column);
  * coplanar faces: two box faces pointing the same way in the same plane with overlapping area
    would z-fight, so the build fails.
"""
import math
from collections import defaultdict

MESH = defaultdict(lambda: ([], [], [], []))         # material -> (verts, faces, uvs per face, smooth per face)
NAV = {'surfaces': [], 'colliders': [], 'airColliders': [], 'cameraBlockers': []}
PARTS = []                                           # (id, lo, hi, pierce, faces) for the audits; faces only for boxes
IDS = defaultdict(int)
LIGHTS = []
TILE = {}                                            # material -> world UV tile size (metres), set by t16_materials


def uid(name):
    IDS[name] += 1
    return f'{name}-{IDS[name]}' if IDS[name] > 1 else name


def bl(p):  # Web (x,y,z) -> Blender (x,-z,y); a proper rotation, so winding is preserved
    return (p[0], -p[2], p[1])


def r4(v): return round(v, 4)


def _sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def _dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def newell(pts):
    n = [0.0, 0.0, 0.0]
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1])
    return n


def face(mat, pts, uvs, out=None, smooth=False):
    """One polygon. `out` = a vector the face must point along (flips the winding if needed)."""
    pts, uvs = list(pts), list(uvs)
    if out is not None and _dot(newell(pts), out) < 0: pts.reverse(); uvs.reverse()
    v, f, u, s = MESH[mat]; n = len(v)
    v.extend(bl(p) for p in pts); f.append(tuple(range(n, n + len(pts)))); u.append(tuple(uvs)); s.append(smooth)


def world_uv(mat, p, right, up):
    t = TILE.get(mat, 1.0)
    return (_dot(p, right) / t, _dot(p, up) / t)


# ---------------------------------------------------------------- nav records
def nav_box(kind, id_, x0, x1, y0, y1, z0, z1, solid=False):
    c = {'id': id_, 'kind': 'box', 'x0': r4(min(x0, x1)), 'x1': r4(max(x0, x1)), 'z0': r4(min(z0, z1)), 'z1': r4(max(z0, z1)), 'y0': r4(y0), 'y1': r4(y1)}
    if solid: c['solid'] = True
    NAV[kind].append(c)


def nav_circle(kind, id_, x, z, r, y0, y1):
    NAV[kind].append({'id': id_, 'kind': 'circle', 'x': r4(x), 'z': r4(z), 'r': r4(r), 'y0': r4(y0), 'y1': r4(y1)})


def surface(id_, x0, x1, z0, z1, y):
    NAV['surfaces'].append({'id': uid(id_), 'x0': r4(x0), 'x1': r4(x1), 'z0': r4(z0), 'z1': r4(z1), 'y': r4(y)})


def light(role, p, color, power):
    LIGHTS.append({'role': role, 'position': [r4(v) for v in p], 'color': list(color), 'power': power})


def _nav(i, nav, x0, x1, y0, y1, z0, z1):
    if 'block' in nav or 'solid' in nav: nav_box('colliders', i, x0, x1, y0, y1, z0, z1, solid='solid' in nav)
    if 'air' in nav: nav_box('airColliders', i, x0, x1, y0, y1, z0, z1)
    if 'cam' in nav: nav_box('cameraBlockers', i, x0, x1, y0, y1, z0, z1)


# ---------------------------------------------------------------- box
# side -> (outward normal, right, up): the texture reads upright and unmirrored seen from outside.
SIDES = {
    '+x': ((1, 0, 0), (0, 0, -1), (0, 1, 0)), '-x': ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
    '+z': ((0, 0, 1), (1, 0, 0), (0, 1, 0)), '-z': ((0, 0, -1), (-1, 0, 0), (0, 1, 0)),
    '+y': ((0, 1, 0), (1, 0, 0), (0, 0, -1)), '-y': ((0, -1, 0), (-1, 0, 0), (0, 0, -1)),
}


def _corners(side, x0, x1, y0, y1, z0, z1):
    return {
        '+x': [(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)], '-x': [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)],
        '+z': [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], '-z': [(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)],
        '+y': [(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)], '-y': [(x1, y0, z1), (x0, y0, z1), (x0, y0, z0), (x1, y0, z0)],
    }[side]


def box(name, mat, x0, x1, y0, y1, z0, z1, nav=(), audit=True, pierce=False, faces=None, fit=None, skip=(), uvf=None):
    """Axis-aligned solid. nav ⊂ {'block','solid','air','cam'}; 'solid' = blocker with no step-up.
    faces: {side: material} overrides; fit: {side: (ru, rv)} maps that face 0..ru × 0..rv instead of
    world tiling; uvf: {side: fn(point) -> (u, v)}; skip: sides never seen (against a wall), not emitted."""
    x0, x1 = sorted((x0, x1)); z0, z1 = sorted((z0, z1)); y0, y1 = sorted((y0, y1))
    faces, fit = faces or {}, fit or {}
    for side, (n, right, up) in SIDES.items():
        if side in skip: continue
        m = faces.get(side, mat); pts = _corners(side, x0, x1, y0, y1, z0, z1)
        if uvf and side in uvf:
            uv = [uvf[side](p) for p in pts]
        elif side in fit:
            ru, rv = fit[side]; us = [_dot(p, right) for p in pts]; vs = [_dot(p, up) for p in pts]
            uv = [((a - min(us)) / (max(us) - min(us)) * ru, (b - min(vs)) / (max(vs) - min(vs)) * rv) for a, b in zip(us, vs)]
        else:
            uv = [world_uv(m, p, right, up) for p in pts]
        face(m, pts, uv, out=n)
    i = uid(name)
    _nav(i, nav, x0, x1, y0, y1, z0, z1)
    if audit: PARTS.append((i, (x0, y0, z0), (x1, y1, z1), pierce, True))
    return i


# ---------------------------------------------------------------- solids of revolution and prisms
def lathe(name, mat, x, z, profile, sides=32, nav=(), pierce=False, audit=True, petals=0, petal_depth=0.0, cap_mat=None, u_repeat=None, phase=0.0):
    """Revolve [(r, y), ...] (bottom → top) about the vertical axis through (x, z). The open ends are
    closed with flat caps when r > 0 there (cap_mat for the top cap). petals: scallop the radius
    r·(1 - depth·(1-|cos(petals·θ/2)|)) for lotus rims."""
    def rad(r, k):
        if not petals: return r
        th = k * math.tau / sides
        return r * (1 - petal_depth * (1 - abs(math.cos(petals * th / 2))))
    t = TILE.get(mat, 1.0); U = u_repeat or max(1, round(math.tau * max(r for r, _ in profile) / t))
    acc = [0.0]
    for (ra, ya), (rb, yb) in zip(profile, profile[1:]): acc.append(acc[-1] + math.hypot(rb - ra, yb - ya))
    for j in range(len(profile) - 1):
        (ra, ya), (rb, yb) = profile[j], profile[j + 1]
        if ra == 0 and rb == 0: continue
        for k in range(sides):
            a0, a1 = (k + phase) * math.tau / sides, (k + 1 + phase) * math.tau / sides
            p = lambda r, y, a, kk: (x + rad(r, kk) * math.cos(a), y, z + rad(r, kk) * math.sin(a))
            pts = [p(ra, ya, a0, k), p(ra, ya, a1, k + 1), p(rb, yb, a1, k + 1), p(rb, yb, a0, k)]
            uv = [(k / sides * U, acc[j] / t), ((k + 1) / sides * U, acc[j] / t), ((k + 1) / sides * U, acc[j + 1] / t), (k / sides * U, acc[j + 1] / t)]
            mid = (a0 + a1) / 2; dr, dy = rb - ra, yb - ya
            face(mat, pts, uv, out=(dy * math.cos(mid), -dr, dy * math.sin(mid)), smooth=True)
    for (r, y), up, m in ((profile[0], -1, mat), (profile[-1], 1, cap_mat or mat)):
        if r <= 0: continue
        pts = [(x + rad(r, k) * math.cos((k + phase) * math.tau / sides), y, z + rad(r, k) * math.sin((k + phase) * math.tau / sides)) for k in range(sides)]
        if cap_mat and up == 1:   # fitted disc (e.g. the array on the dais)
            uv = [((p[0] - x) / (2 * r) + .5, (z - p[2]) / (2 * r) + .5) for p in pts]
        else:
            uv = [world_uv(m, p, (1, 0, 0), (0, 0, -1)) for p in pts]
        face(m, pts, uv, out=(0, up, 0))
    rr = max(r for r, _ in profile); y0, y1 = profile[0][1], profile[-1][1]
    i = uid(name)
    if 'block' in nav: nav_circle('colliders', i, x, z, rr, y0, y1)
    if 'cam' in nav: nav_circle('cameraBlockers', i, x, z, rr, y0, y1)
    if audit: PARTS.append((i, (x - rr, y0, z - rr), (x + rr, y1, z + rr), pierce, False))
    return i


def cylinder(name, mat, x, z, r, y0, y1, sides=24, nav=(), pierce=False, r_top=None, audit=True, cap_mat=None, u_repeat=None, band=False):
    """band: map the side 0..1 vertically (u wraps u_repeat times), for gold bands round a column."""
    rt = r if r_top is None else r_top
    if band:
        U = u_repeat or 3
        for k in range(sides):
            a0, a1 = k * math.tau / sides, (k + 1) * math.tau / sides
            pts = [(x + r * math.cos(a0), y0, z + r * math.sin(a0)), (x + r * math.cos(a1), y0, z + r * math.sin(a1)),
                   (x + rt * math.cos(a1), y1, z + rt * math.sin(a1)), (x + rt * math.cos(a0), y1, z + rt * math.sin(a0))]
            # u runs against θ so the band reads left→right seen from outside
            uv = [(1 - k / sides) * U, 0], [(1 - (k + 1) / sides) * U, 0], [(1 - (k + 1) / sides) * U, 1], [(1 - k / sides) * U, 1]
            mid = (a0 + a1) / 2
            face(mat, pts, [tuple(q) for q in uv], out=(math.cos(mid), 0, math.sin(mid)), smooth=True)
        for rr, y, up in ((r, y0, -1), (rt, y1, 1)):
            pts = [(x + rr * math.cos(k * math.tau / sides), y, z + rr * math.sin(k * math.tau / sides)) for k in range(sides)]
            face(cap_mat or 'Gold', pts, [world_uv('Gold', p, (1, 0, 0), (0, 0, -1)) for p in pts], out=(0, up, 0))
        i = uid(name); rr = max(r, rt)
        if 'block' in nav: nav_circle('colliders', i, x, z, rr, y0, y1)
        if 'cam' in nav: nav_circle('cameraBlockers', i, x, z, rr, y0, y1)
        if audit: PARTS.append((i, (x - rr, y0, z - rr), (x + rr, y1, z + rr), pierce, False))
        return i
    return lathe(name, mat, x, z, [(r, y0), (rt, y1)], sides=sides, nav=nav, pierce=pierce, audit=audit, cap_mat=cap_mat, u_repeat=u_repeat)


def prism(name, mat, x, z, r, y0, y1, sides=6, r_top=None, side_mat=None, nav=(), audit=True, fit_sides=False, phase=0.5):
    """Regular polygon prism/frustum (hex lantern bodies, octagonal plinths). fit_sides: each side face
    maps 0..1 (lantern paper)."""
    rt = r if r_top is None else r_top
    ang = lambda k: (k + phase) * math.tau / sides
    for k in range(sides):
        a0, a1 = ang(k), ang(k + 1)
        pts = [(x + r * math.cos(a0), y0, z + r * math.sin(a0)), (x + r * math.cos(a1), y0, z + r * math.sin(a1)),
               (x + rt * math.cos(a1), y1, z + rt * math.sin(a1)), (x + rt * math.cos(a0), y1, z + rt * math.sin(a0))]
        m = side_mat or mat; mid = (a0 + a1) / 2; o = (math.cos(mid), 0, math.sin(mid))
        if fit_sides: uv = [(1, 0), (0, 0), (0, 1), (1, 1)]
        else:
            right = (-math.sin(mid), 0, math.cos(mid)); uv = [world_uv(m, p, right, (0, 1, 0)) for p in pts]
        face(m, pts, uv, out=o)
    for rr, y, up in ((r, y0, -1), (rt, y1, 1)):
        if rr <= 0: continue
        pts = [(x + rr * math.cos(ang(k)), y, z + rr * math.sin(ang(k))) for k in range(sides)]
        face(mat, pts, [world_uv(mat, p, (1, 0, 0), (0, 0, -1)) for p in pts], out=(0, up, 0))
    i = uid(name); rr = max(r, rt)
    _nav(i, nav, x - rr, x + rr, y0, y1, z - rr, z + rr)
    if audit: PARTS.append((i, (x - rr, y0, z - rr), (x + rr, y1, z + rr), False, False))
    return i


def frustum(mat, loops, inward=False):
    """Rect loops [(x0,x1,z0,z1,y), ...] joined by quads (hip-roof bands). Render only.
    Faces point up/out (roofs seen from above) unless inward (eaves seen from below)."""
    for (ax0, ax1, az0, az1, ay), (bx0, bx1, bz0, bz1, by) in zip(loops, loops[1:]):
        A = [(ax0, ay, az0), (ax1, ay, az0), (ax1, ay, az1), (ax0, ay, az1)]
        B = [(bx0, by, bz0), (bx1, by, bz0), (bx1, by, bz1), (bx0, by, bz1)]
        cx, cz = (ax0 + ax1) / 2, (az0 + az1) / 2
        for j in range(4):
            pts = [A[j], A[(j + 1) % 4], B[(j + 1) % 4], B[j]]
            mx = sum(p[0] for p in pts) / 4 - cx; mz = sum(p[2] for p in pts) / 4 - cz
            s = -1 if inward else 1
            out = (s * mx, s, s * mz)                     # roofs: outward and up; eaves: inward and down
            edge = _sub(A[(j + 1) % 4], A[j]); L = math.hypot(edge[0], edge[2]) or 1
            right = (edge[0] / L, 0, edge[2] / L)
            face(mat, pts, [world_uv(mat, p, right, (0, 1, 0)) for p in pts], out=out)


def annulus_xy(mat, cx, cy, z0, z1, r_in, r_out, sides=48, rim_mat=None):
    """Ring standing in an XY plane (moon gate), extruded from z0 to z1."""
    P = lambda r, k, z: (cx + r * math.cos(k * math.tau / sides), cy + r * math.sin(k * math.tau / sides), z)
    for k in range(sides):
        a, b = k, k + 1; mid = (k + .5) * math.tau / sides; radial = (math.cos(mid), math.sin(mid), 0)
        for z, nz in ((z0, -1), (z1, 1)):
            pts = [P(r_in, a, z), P(r_out, a, z), P(r_out, b, z), P(r_in, b, z)]
            face(mat, pts, [world_uv(mat, p, (1, 0, 0), (0, 1, 0)) for p in pts], out=(0, 0, nz))
        for r, s in ((r_out, 1), (r_in, -1)):
            pts = [P(r, a, z0), P(r, b, z0), P(r, b, z1), P(r, a, z1)]
            face(rim_mat or mat, pts, [(k / sides * 8, 0), ((k + 1) / sides * 8, 0), ((k + 1) / sides * 8, .3), (k / sides * 8, .3)], out=tuple(s * c for c in radial), smooth=True)


def annulus_y(mat, cx, cz, y0, y1, r_in, r_out, sides=48):
    """Horizontal ring (oculus frame), a tube from y0 to y1."""
    P = lambda r, k, y: (cx + r * math.cos(k * math.tau / sides), y, cz + r * math.sin(k * math.tau / sides))
    for k in range(sides):
        a, b = k, k + 1; mid = (k + .5) * math.tau / sides; radial = (math.cos(mid), 0, math.sin(mid))
        for y, ny in ((y0, -1), (y1, 1)):
            pts = [P(r_in, a, y), P(r_out, a, y), P(r_out, b, y), P(r_in, b, y)]
            face(mat, pts, [world_uv(mat, p, (1, 0, 0), (0, 0, -1)) for p in pts], out=(0, ny, 0))
        for r, s in ((r_out, 1), (r_in, -1)):
            pts = [P(r, a, y0), P(r, b, y0), P(r, b, y1), P(r, a, y1)]
            face(mat, pts, [(k / sides * 6, y0 / 2), ((k + 1) / sides * 6, y0 / 2), ((k + 1) / sides * 6, y1 / 2), (k / sides * 6, y1 / 2)], out=tuple(s * c for c in radial), smooth=True)


def disc_xy(mat, cx, cy, z, r, facing, sides=48):
    """Flat disc in an XY plane, facing ±z, mapped 0..1 (the portal view)."""
    pts = [(cx + r * math.cos(k * math.tau / sides), cy + r * math.sin(k * math.tau / sides), z) for k in range(sides)]
    face(mat, pts, [((p[0] - cx) / (2 * r) * facing + .5, (p[1] - cy) / (2 * r) + .5) for p in pts], out=(0, 0, facing))


def slab_with_hole(name, mat, x0, x1, z0, z1, y0, y1, hx, hz, hr, sides=32, fit_bottom=True):
    """Square panel with a round hole (the caisson board). The underside maps 0..1 over the square;
    the hole edge is a short tube. Render + audit by its square."""
    def ring(y):
        return [(hx + hr * math.cos(k * math.tau / sides), y, hz + hr * math.sin(k * math.tau / sides)) for k in range(sides)]
    W, D = x1 - x0, z1 - z0
    assert abs(W - D) < 1e-6 and sides % 8 == 0
    uvb = lambda p: ((p[0] - x0) / W, (z1 - p[2]) / D)   # looking up: x right, -z up... texture is symmetric
    for y, up in ((y0, -1), (y1, 1)):
        R = ring(y)
        for k in range(sides):
            # project each ring point radially onto the square (sides % 8 == 0 puts a ring vertex on each corner)
            def onsq(p):
                dx, dz = p[0] - hx, p[2] - hz; s = min((W / 2) / abs(dx) if dx else 1e9, (D / 2) / abs(dz) if dz else 1e9)
                return (hx + dx * s, y, hz + dz * s)
            pa, pb = R[k], R[(k + 1) % sides]
            pts = [pa, pb, onsq(pb), onsq(pa)]
            uv = [uvb(p) for p in pts] if (fit_bottom and up == -1) else [world_uv('Ceiling', p, (1, 0, 0), (0, 0, -1)) for p in pts]
            face(mat if up == -1 else 'Ceiling', pts, uv, out=(0, up, 0))
    for k in range(sides):
        a0, a1 = k * math.tau / sides, (k + 1) * math.tau / sides
        p = lambda a, y: (hx + hr * math.cos(a), y, hz + hr * math.sin(a))
        mid = (a0 + a1) / 2
        face('Gold', [p(a0, y0), p(a1, y0), p(a1, y1), p(a0, y1)], [(0, 0), (1, 0), (1, 1), (0, 1)], out=(-math.cos(mid), 0, -math.sin(mid)))
    i = uid(name)
    PARTS.append((i, (x0, y0, z0), (x1, y1, z1), False, False))
    return i


def sloped_bar(mat, a, b, w, h):
    """Bar of width w (horizontal, across) and height h (vertical) from point a to b (its bottom-centre
    line); used for stair handrails. Not AABB-audited: the caller checks tread clearance analytically."""
    dx, dz = b[0] - a[0], b[2] - a[2]; L = math.hypot(dx, dz)
    nx, nz = -dz / L * w / 2, dx / L * w / 2
    P = lambda p, s, y: (p[0] + s * nx, p[1] + y, p[2] + s * nz)
    A = [P(a, -1, 0), P(a, 1, 0), P(a, 1, h), P(a, -1, h)]; B = [P(b, -1, 0), P(b, 1, 0), P(b, 1, h), P(b, -1, h)]
    c = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + h / 2, (a[2] + b[2]) / 2)
    along = (dx / L, (b[1] - a[1]) / L, dz / L)
    for j in range(4):
        pts = [A[j], A[(j + 1) % 4], B[(j + 1) % 4], B[j]]
        m = [sum(q[i] for q in pts) / 4 for i in range(3)]
        face(mat, pts, [world_uv(mat, p, along, (0, 1, 0)) for p in pts], out=_sub(m, c))
    face(mat, A, [world_uv(mat, p, (nx, 0, nz), (0, 1, 0)) for p in A], out=(-dx, 0, -dz))
    face(mat, B, [world_uv(mat, p, (nx, 0, nz), (0, 1, 0)) for p in B], out=(dx, 0, dz))


# ---------------------------------------------------------------- export gates
def overlaps():
    bad = []
    for a in range(len(PARTS)):
        ia, lo_a, hi_a, pa, _ = PARTS[a]
        for b in range(a + 1, len(PARTS)):
            ib, lo_b, hi_b, pb, _ = PARTS[b]
            if pa or pb: continue
            if all(min(hi_a[k], hi_b[k]) - max(lo_a[k], lo_b[k]) > 1e-3 for k in range(3)): bad.append([ia, ib])
    return bad


def coplanar():
    """Same-direction box faces in one plane with overlapping area z-fight."""
    planes = defaultdict(list)
    for i, lo, hi, _, is_box in PARTS:
        if not is_box: continue
        for axis in range(3):
            o = [k for k in range(3) if k != axis]
            for sgn, val in ((-1, lo[axis]), (1, hi[axis])):
                planes[(axis, sgn, round(val, 4))].append((i, (lo[o[0]], hi[o[0]]), (lo[o[1]], hi[o[1]])))
    bad = []
    for key, fs in planes.items():
        for a in range(len(fs)):
            for b in range(a + 1, len(fs)):
                (ia, ua, va), (ib, ub, vb) = fs[a], fs[b]
                if min(ua[1], ub[1]) - max(ua[0], ub[0]) > 1e-3 and min(va[1], vb[1]) - max(va[0], vb[0]) > 1e-3: bad.append([ia, ib])
    return bad


# ---------------------------------------------------------------- reach audit (D3, after the stair-jump bug)
# Body constants mirrored from apps/web/src/game/navigation.ts (BODY); the web tests check they still match.
BODY_R, BODY_H, STEP_UP, JUMP_REACH = 0.3, 1.7, 0.3, 1.75


def _body_fits(p, R, walking):
    """Can a body standing on (walking) or jumping from walk surface R = (x0, x1, z0, z1, y) put its centre
    within BODY_R of point p without overlapping a collider active at its height? Candidate centres: the
    point of R nearest p and eight more around p, all clipped into R."""
    px, py, pz = p; x0, x1, z0, z1, ry = R
    feet = ry if walking else max(ry, py - BODY_H)
    lst = NAV['colliders'] + ([] if walking else NAV['airColliders'])
    act = [c for c in lst if c['y1'] > feet + (1e-6 if c.get('solid') else STEP_UP) and c['y0'] < feet + BODY_H]
    clip = lambda x, z: (min(x1, max(x0, x)), min(z1, max(z0, z)))
    cands = [clip(px, pz)] + [clip(px + BODY_R * .999 * math.cos(a), pz + BODY_R * .999 * math.sin(a)) for a in [k * math.pi / 4 for k in range(8)]]
    for cx, cz in cands:
        if math.hypot(cx - px, cz - pz) > BODY_R: continue
        free = True
        for c in act:
            if c['kind'] == 'circle':
                if math.hypot(cx - c['x'], cz - c['z']) < BODY_R + c['r'] - 1e-3: free = False; break
            else:
                qx, qz = min(c['x1'], max(c['x0'], cx)), min(c['z1'], max(c['z0'], cz))
                if math.hypot(cx - qx, cz - qz) < BODY_R - 1e-3: free = False; break
        if free: return True
    return False


def reach_gaps(margin=0.05, step=0.12):
    """Every render part a visitor can touch must be solid to the walker.

    A sample point inside a part (shrunk by `margin`, a single sample across any dimension thinner than
    that; round parts sampled inside their inscribed ellipse) is reachable from a walk surface R when it
    lies within R's rect grown by the body radius, between R and head height (walking) or up to jump reach
    (airborne). It is then safe only if it is inside a walking collider (airborne band: or a jump ceiling),
    or shielded: inside the rect of a walk surface S whose top is above the point but less than a body
    height above R. navigation.ts treats such an S as solid mass (lift onto it within a step, a wall
    otherwise), so a body coming from R can never pass under S's top there. Upper floors far above R
    shield nothing (2026-11-10 cross-model review: the first version exempted everything under any
    surface). Parts at most STEP_UP proud of the floor they sit on are stepped over and exempt."""
    import numpy as np
    S = np.array([(s['x0'], s['x1'], s['z0'], s['z1'], s['y'] if s.get('y') is not None else max(s['ramp']['y0'], s['ramp']['y1']))
                  for s in NAV['surfaces']], float)
    def colls(lst):
        b = np.array([(c['x0'], c['x1'], c['z0'], c['z1'], c['y0'], c['y1']) for c in lst if c['kind'] == 'box'], float).reshape(-1, 6)
        c = np.array([(c['x'], c['z'], c['r'], c['y0'], c['y1']) for c in lst if c['kind'] == 'circle'], float).reshape(-1, 5)
        return b, c
    walkB, walkC = colls(NAV['colliders'])
    airB, airC = colls(NAV['colliders'] + NAV['airColliders'])
    def inside(P, B, C):
        x, y, z = P[:, :1], P[:, 1:2], P[:, 2:3]
        hit = np.zeros(len(P), bool)
        if len(B): hit |= ((x >= B[:, 0] - 1e-6) & (x <= B[:, 1] + 1e-6) & (z >= B[:, 2] - 1e-6) & (z <= B[:, 3] + 1e-6) & (y >= B[:, 4] - 1e-6) & (y <= B[:, 5] + 1e-6)).any(1)
        if len(C): hit |= (((x - C[:, 0]) ** 2 + (z - C[:, 1]) ** 2 <= (C[:, 2] + 1e-6) ** 2) & (y >= C[:, 3] - 1e-6) & (y <= C[:, 4] + 1e-6)).any(1)
        return hit
    gaps = []
    for pid, lo, hi, _pierce, is_box in PARTS:
        lo, hi = np.array(lo, float), np.array(hi, float)
        near = (S[:, 0] - BODY_R < hi[0]) & (S[:, 1] + BODY_R > lo[0]) & (S[:, 2] - BODY_R < hi[2]) & (S[:, 3] + BODY_R > lo[2]) \
            & (S[:, 4] < hi[1]) & (S[:, 4] + BODY_H + JUMP_REACH > lo[1])
        if not near.any(): continue
        base = S[near & (S[:, 4] <= lo[1] + 1e-6), 4]
        if len(base) and hi[1] - base.max() <= STEP_UP: continue
        a, b = lo + margin, hi - margin
        thin = b <= a; a[thin] = b[thin] = ((lo + hi) / 2)[thin]
        axes = [np.linspace(a[k], b[k], max(2, int(np.ceil((b[k] - a[k]) / step)) + 1)) if b[k] > a[k] else np.array([a[k]]) for k in range(3)]
        P = np.stack(np.meshgrid(*axes, indexing='ij'), -1).reshape(-1, 3)
        if not is_box:
            c, h = (lo + hi) / 2, np.maximum((hi - lo) / 2 - margin, 1e-3)
            P = P[((P[:, 0] - c[0]) / h[0]) ** 2 + ((P[:, 2] - c[2]) / h[2]) ** 2 <= 1]
        if not len(P): continue
        x, y, z = P[:, :1], P[:, 1:2], P[:, 2:3]
        src = (x >= S[:, 0] - BODY_R) & (x <= S[:, 1] + BODY_R) & (z >= S[:, 2] - BODY_R) & (z <= S[:, 3] + BODY_R)   # point × R
        dy = y - S[:, 4]
        walk = src & (dy >= -1e-6) & (dy <= BODY_H)
        air = src & (dy > BODY_H) & (dy <= BODY_H + JUMP_REACH)
        cover = (x >= S[:, 0]) & (x <= S[:, 1]) & (z >= S[:, 2]) & (z <= S[:, 3]) & (y <= S[:, 4] + 1e-6)                # point × S
        # shielded[p, R]: some S over p with S.y - R.y < BODY_H (and S above R).
        rise = S[None, :, 4] - S[:, None, 4]                                                                      # [R, S] = S.y - R.y
        ok = (rise > -1e-6) & (rise < BODY_H)
        shielded = (cover.astype(np.int32) @ ok.T.astype(np.int32)) > 0                                           # point × R
        need_walk = (walk & ~shielded).any(1)
        need_air = (air & ~shielded).any(1) & ~need_walk
        bad = (need_walk & ~inside(P, walkB, walkC)) | (need_air & ~inside(P, airB, airC))
        # Second pass, only for flagged points: a body centred on R within its radius of the point must also
        # fit there without overlapping an active collider (a point behind a rail is not reachable).
        for k in np.flatnonzero(bad):
            bad[k] = any(_body_fits(P[k], S[j], bool(walk[k, j]))
                         for j in np.flatnonzero((walk[k] | air[k]) & ~shielded[k]))
        if bad.any():
            q = P[bad][0]
            gaps.append([pid, int(bad.sum()), int(len(P)), [round(float(v), 2) for v in q]])
    return gaps
