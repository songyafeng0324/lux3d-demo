"""T10-B pavilion source. Execute inside live Blender through MCP, not local CLI.
Web design coordinates (x,y,z) -> Blender (x,-z,y); glTF export converts once.
Only owns scene T10_Pavilion_v1; leaves other scenes intact.
"""
import bpy, math, json
from pathlib import Path
from mathutils import Vector
ROOT=Path('/Users/yafeng/Documents/ChatGPT/hackathon/aholo-lux3d')
OUT=ROOT/'assets/t10'; OUT.mkdir(parents=True,exist_ok=True)
D=json.loads((ROOT/'docs/design/t10-a/layout-draft.json').read_text())
NAME='T10_Pavilion_v1'
if NAME in bpy.data.scenes:
    old=bpy.data.scenes[NAME]
    for ob in list(old.objects):
        if ob.users_scene==(old,): bpy.data.objects.remove(ob,do_unlink=True)
    bpy.data.scenes.remove(old)
scene=bpy.data.scenes.new(NAME); bpy.context.window.scene=scene
scene.unit_settings.scale_length=1
scene['design_version']=D['version']; scene['source']='scripts/blender/build_t10.py via Blender MCP'
scene['scope']='Building framework, no published exhibits or production navigation'
COL={}
for name in ['Structure','Floors','Stairs','Balustrades','Roof','Windows','Exhibit_Platforms','Lighting','Cameras']:
    c=bpy.data.collections.new('T10_'+name);scene.collection.children.link(c);COL[name]=c
M={}
def mat(name,c,rough=.6,metal=0,emission=0):
    m=bpy.data.materials.new('T10_'+name);m.use_nodes=True
    p=next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    p.inputs['Base Color'].default_value=(*c,1);p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metal
    if emission:
        p.inputs['Emission Color'].default_value=(*c,1);p.inputs['Emission Strength'].default_value=emission
    M[name]=m;return m
mat('Walnut',(.075,.033,.018),.55);mat('Cedar',(.16,.073,.032),.65)
mat('Redwood',(.17,.028,.017),.55);mat('Brass',(.42,.245,.067),.34,.72)
mat('Stone',(.24,.275,.29),.83);mat('StoneLight',(.31,.33,.32),.85)
mat('Plaster',(.44,.37,.26),.95);mat('RoofTile',(.055,.085,.092),.75)
mat('Paper',(.7,.57,.37),.9);mat('Lantern', (1,.48,.115),.45,0,2.2)
# Geometry grouped by semantic part and material, to keep both editability and draw calls reasonable.
B={}
def point(p):return (p[0],-p[2],p[1])
def poly(name,vs,fs,material,group):
    key=(name,material,group); v,f=B.setdefault(key,([],[]));n=len(v)
    v.extend(point(p) for p in vs);f.extend(tuple(n+i for i in face) for face in fs)
def box(name,center,size,material='Walnut',group='Structure'):
    x,y,z=center;a,b,c=[t/2 for t in size]
    vs=[(x+dx*a,y+dy*b,z+dz*c) for dx,dy,dz in [(-1,-1,-1),(-1,-1,1),(-1,1,1),(-1,1,-1),(1,-1,-1),(1,-1,1),(1,1,1),(1,1,-1)]]
    poly(name,vs,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(3,7,6,2),(0,4,7,3),(1,2,6,5)],material,group)
def region(name,x1,x2,z1,z2,top,thick,material='Cedar',group='Floors'):
    box(name,((x1+x2)/2,top-thick/2,(z1+z2)/2),(x2-x1,thick,z2-z1),material,group)
def beam(name,a,b,width=.14,depth=None,material='Walnut',group='Structure'):
    a,b=Vector(a),Vector(b);d=(b-a).normalized();ref=Vector((0,1,0))
    if abs(d.dot(ref))>.95:ref=Vector((1,0,0))
    u=d.cross(ref).normalized()*width/2;v=d.cross(u).normalized()*(depth or width)/2
    vs=[tuple(p+s*u+t*v) for p in [a,b] for s,t in [(-1,-1),(-1,1),(1,1),(1,-1)]]
    poly(name,vs,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],material,group)
def cylinder(name,x,y,z,r,h,material='Walnut',group='Structure',sides=20,r2=None):
    vs=[(x+(r if k==0 else (r2 or r))*math.cos(i*math.tau/sides),y+k*h,z+(r if k==0 else (r2 or r))*math.sin(i*math.tau/sides)) for k in range(2) for i in range(sides)]
    fs=[tuple(range(sides-1,-1,-1)),tuple(range(sides,sides*2))]+[(i,(i+1)%sides,(i+1)%sides+sides,i+sides) for i in range(sides)]
    poly(name,vs,fs,material,group)
def rail(name,a,b,height=1.15):
    a,b=Vector(a),Vector(b);length=(b-a).length
    for up,width in [(.18,.09),(.68,.09),(height,.13)]:beam(name,tuple(a+Vector((0,up,0))),tuple(b+Vector((0,up,0))),width,.10,'Walnut','Balustrades')
    n=math.ceil(length/.85)
    for i in range(n+1):
        p=a.lerp(b,i/n);beam(name,tuple(p),tuple(p+Vector((0,height+.07,0))),.10,.10,'Walnut','Balustrades')
        box(name,tuple(p+Vector((0,height+.09,0))),(.14,.055,.14),'Brass','Balustrades')
    for i in range(n):
        p=a.lerp(b,(i+.5)/n);beam(name,tuple(p+Vector((0,.24,0))),tuple(p+Vector((0,.66,0))),.045,.045,'Redwood','Balustrades')
# Ground and masonry foundation.
region('GroundBase',-12,12,-14,14,0,.32,'Stone')
for ix in range(12):
    for iz in range(14):
        region('StonePaving',-11.99+ix*2,-10.01+ix*2,-13.99+iz*2,-12.01+iz*2,.025,.04,'StoneLight' if (ix+iz)%3==0 else 'Stone')
# Upper floor partition explicitly subtracts atrium AND staircase opening.
parts=[(-12,-6,-14,14),(6,12,-14,14),(-6,6,7.5,14),(-6,6,-14,-13),(-6,-2.7,-13,-6.7),(2.7,6,-13,-6.7),(-6,6,-6.7,-4.5)]
for i,(x1,x2,z1,z2) in enumerate(parts):region(f'UpperSlab_{i}',x1,x2,z1,z2,4.8,.3)
# Timber plank seams only on valid floor portions.
for i,(x1,x2,z1,z2) in enumerate(parts):
    for j in range(math.ceil((z2-z1)/.45)):
        zz=z1+j*.45
        box('UpperPlankSeams',((x1+x2)/2,4.802,zz),(x2-x1,.008,.016),'Walnut','Floors')
# Structural columns, stone footings and brass collars.
for idx,(x,z) in enumerate(D['columns']):
    cylinder(f'Column_{idx}',x,.2,z,.4,8.9,r2=.34)
    cylinder('StoneColumnBases',x,0,z,.53,.25,'StoneLight',sides=16)
    cylinder('ColumnCollars',x,.25,z,.415,.16,'Brass')
    cylinder('ColumnCollars',x,4.3,z,.395,.14,'Brass')
    box('ColumnCapitals',(x,8.72,z),(1.05,.25,.86),'Cedar')
    box('ColumnCapitals',(x,8.96,z),(1.45,.18,.7),'Walnut')
for x in [-6.4,6.4]:
    beam('LongBeams',(x,4.4,-13.7),(x,4.4,13.7),.35,.48)
    beam('LongBeams',(x,9,-13.7),(x,9,13.7),.4,.5)
for z in [-4.9,7.9]:
    beam('MezzanineCrossBeams',(-6.4,4.38,z),(6.4,4.38,z),.3,.44)
for z in [-4.9,1.5,7.9]:
    beam('RoofTies',(-11.9,9,z),(11.9,9,z),.3,.36)
# Walls with actual window apertures and lattice, not opaque boxes.
for side in [-1,1]:
    x=side*12
    for a,b in [(0,1.25),(3.75,4.8),(4.8,5.65),(8.15,9.15)]:box('SideWallBands',(x,(a+b)/2,0),(.22,b-a,28),'Plaster','Windows')
    for z in [-14,-10,-6,-2,2,6,10,14]:box('WallPosts',(x,4.6,z),(.3,9.2,.28),'Redwood','Windows')
    for lo,hi in [(1.25,3.75),(5.65,8.15)]:
        for z in [v*.5 for v in range(-27,28)]:box('SideLattice',(x,(lo+hi)/2,z),(.12,hi-lo,.045),'Walnut','Windows')
        for yy in [lo,lo+.6,lo+1.25,hi]:box('SideLattice',(x,yy,0),(.13,.055,28),'Walnut','Windows')
# North wall and south entry; timber framing and inset restrained wall panels.
box('NorthWall',(0,4.55,-14),(24,9.1,.24),'Plaster','Windows')
for a,b in [(-12,-2),(2,12)]:box('EntryWall',((a+b)/2,4.55,14),(b-a,9.1,.24),'Plaster','Windows')
box('EntryLintel',(0,6.4,14),(4,5.4,.28),'Walnut','Windows')
for z in [-13.85,13.85]:
    for x in [-11.8,-8,-4,4,8,11.8]:
        box('EndWallPosts',(x,4.5,z),(.22,9,.28),'Redwood','Windows')
        for y in [1.8,6.6]:box('WallPanels',(x,y,z+(.03 if z<0 else -.03)),(2.4,2.5,.12),'Walnut','Windows')
    for y in [1,4.4,8.8]:box('EndWallBeams',(0,y,z),(24,.2,.32),'Cedar','Windows')
# Two opposite stair flights, actual thirty treads with supporting stringers.
for i in range(15):
    region('EastFlight_Treads',.3,2.7,-6.7-(i+1)*.32,-6.7-i*.32,(i+1)*.16,.12,'Cedar','Stairs')
    region('WestFlight_Treads',-2.7,-.3,-11.5+i*.32,-11.5+(i+1)*.32,2.4+(i+1)*.16,.12,'Cedar','Stairs')
    box('StairNosing',(1.5,(i+1)*.16+.003,-6.7-i*.32-.02),(2.4,.018,.035),'Brass','Stairs')
    box('StairNosing',(-1.5,2.4+(i+1)*.16+.003,-11.5+(i+1)*.32-.02),(2.4,.018,.035),'Brass','Stairs')
region('HalfLanding',-2.7,2.7,-13,-11.5,2.4,.23,'Cedar','Stairs')
for x in [.45,2.55]:beam('EastStringers',(x,-.1,-6.7),(x,2.3,-11.5),.16,.26,'Walnut','Stairs')
for x in [-2.55,-.45]:beam('WestStringers',(x,2.3,-11.5),(x,4.7,-6.7),.16,.26,'Walnut','Stairs')
for x in [-2.5,2.5]:box('LandingSupports',(x,1.1,-12.6),(.22,2.2,.22),'Walnut','Stairs')
# Panels close the underside to visitors, leaving east lower entrance free.
box('StairUnderClosure',(-1.2,1.1,-6.72),(3,2.2,.12),'Redwood','Stairs')
for x in [-2.64,2.64]:box('StairUnderClosure',(x,1.05,-9.7),(.12,2.1,5.9),'Walnut','Stairs')
# Upper atrium edge and staircase well guardrails.
for a,b in [((-6,4.8,-4.5),(6,4.8,-4.5)),((-6,4.8,7.5),(6,4.8,7.5)),((-6,4.8,-4.5),(-6,4.8,7.5)),((6,4.8,-4.5),(6,4.8,7.5))]:rail('AtriumGuard',a,b)
for a,b in [((-2.7,4.8,-13),(2.7,4.8,-13)),((-2.7,4.8,-13),(-2.7,4.8,-6.7)),((2.7,4.8,-13),(2.7,4.8,-6.7)),((-.3,4.8,-6.7),(2.7,4.8,-6.7))]:rail('StairWellGuard',a,b)
for x in [.36,2.64]:rail('EastStairRail',(x,.16,-6.7),(x,2.56,-11.5),1.05)
for x in [-2.64,-.36]:rail('WestStairRail',(x,2.56,-11.5),(x,4.96,-6.7),1.05)
rail('LandingRail',(-2.64,2.4,-12.94),(2.64,2.4,-12.94),1.05)
# Exactly thirty empty plinths, semantic slot names; no fabricated published objects.
for slot in D['exhibitSlots']:
    x,y,z=slot['position']; name='Exhibit_'+slot['id']
    box(name,(x,y+.12,z),(1.2,.24,1.2),'Walnut','Exhibit_Platforms')
    box(name,(x,y+.66,z),(1.04,.85,1.04),'Redwood','Exhibit_Platforms')
    box(name,(x,y+1.11,z),(1.2,.12,1.2),'Cedar','Exhibit_Platforms')
    for h in [.24,1.04]:box(name,(x,y+h,z),(1.08,.035,1.08),'Brass','Exhibit_Platforms')
# Pitched roof with subtly upswept eaves, compact 4 x 6 m daylight opening.
profile=[(-13.2,9.35),(-11.8,9.12),(-8,9.65),(-4,10.55),(-2,11.0),(0,11.4),(2,11.0),(4,10.55),(8,9.65),(11.8,9.12),(13.2,9.35)]
for i in range(len(profile)-1):
    xa,ya=profile[i];xb,yb=profile[i+1]
    spans=[(-15,-2),(4,15)] if xa>=-2 and xb<=2 else [(-15,15)]
    for za,zb in spans:
        poly('PitchedRoof',[(xa,ya,za),(xb,yb,za),(xb,yb,zb),(xa,ya,zb)],[(0,1,2,3)],'RoofTile','Roof')
        for zz in [za,zb]:beam('RoofFrame',(xa,ya-.12,zz),(xb,yb-.12,zz),.18,.25,'Walnut','Roof')
    for zz in [-14,-10,-6,-2,4,8,12,14]:
        if not(xa>=-2 and xb<=2 and -2<zz<4):beam('Rafters',(xa,ya-.16,zz),(xb,yb-.16,zz),.12,.16,'Cedar','Roof')
# Closed timber gables under the roof, hidden together with roof in cutaway view.
for zz in [-14,14]:
    ridge_profile=[(-12,9.1),(-8,9.65),(-4,10.55),(0,11.4),(4,10.55),(8,9.65),(12,9.1)]
    poly('GableInfill',[(x,y,zz) for x,y in ridge_profile],[tuple(range(len(ridge_profile)))],'Plaster','Roof')
    for x,yy in ridge_profile[1:-1]:beam('GablePosts',(x,9.1,zz),(x,yy,zz),.12,.16,'Redwood','Roof')
# Break up the stair underside enclosure with simple timber framing.
for xx in [-2.64,-1.2,.24]:box('StairClosureTrim',(xx,1.1,-6.63),(.10,2.2,.10),'Walnut','Stairs')
for yy in [.12,1.1,2.08]:box('StairClosureTrim',(-1.2,yy,-6.63),(3,.10,.10),'Walnut','Stairs')
# Aperture wooden frame, cross-bars; actual hole admits skylight.
for x in [-2,2]:beam('SkylightFrame',(x,11,-2),(x,11,4),.16,.22,'Brass','Roof')
for zz in [-2,1,4]:beam('SkylightFrame',(-2,11,zz),(2,11,zz),.09,.12,'Cedar','Roof')
for x in [-13.2,13.2]:beam('EaveTrim',(x,9.35,-15),(x,9.35,15),.2,.22,'Cedar','Roof')
for za,zb in [(-15,-2),(4,15)]:beam('Ridge',(0,11.45,za),(0,11.45,zb),.28,.25,'RoofTile','Roof')
# Lanterns: geometry and physical lights are separate to support Web re-lighting.
LIGHTS=[]
def light(name,p,color,power,kind='POINT',size=1,target=None):
    dat=bpy.data.lights.new(name,kind);dat.energy=power;dat.color=color
    if kind=='POINT':dat.shadow_soft_size=size
    if kind=='AREA':dat.shape='DISK';dat.size=size
    ob=bpy.data.objects.new(name,dat);COL['Lighting'].objects.link(ob);ob.location=point(p)
    if target:ob.rotation_euler=(Vector(point(target))-ob.location).to_track_quat('-Z','Y').to_euler()
    LIGHTS.append(dict(name=name,position=list(p),color=list(color),power=power,type=kind,size=size));return ob
for idx,(x,y,z) in enumerate([(0,7.4,1.5),(-7.1,3.3,-7),(7.1,3.3,-7),(-7.1,3.3,8),(7.1,3.3,8),(-9,7.6,-6),(9,7.6,-6),(-9,7.6,9),(9,7.6,9)]):
    r=.5 if idx==0 else .24;h=.9 if idx==0 else .5
    cylinder('LanternPaper',x,y-h/2,z,r,h,'Lantern','Lighting',8)
    for yy in [y-h/2,y+h/2]:cylinder('LanternFrames',x,yy-.04,z,r+.06,.08,'Brass','Lighting',8)
    for i in range(8):
        dx,dz=r*math.cos(i*math.tau/8),r*math.sin(i*math.tau/8)
        beam('LanternFrames',(x+dx,y-h/2,z+dz),(x+dx,y+h/2,z+dz),.035,.035,'Walnut','Lighting')
    beam('LanternSuspension',(x,y+h/2,z),(x,8.9,z),.028,.028,'Brass','Lighting')
    light(f'WarmLantern_{idx}',(x,y-.15,z),(1,.64,.29),650 if idx==0 else 220,size=.7)
light('CoolRoofDaylight',(0,10.8,1),(0.66,.79,1),3000,'AREA',5,target=(0,0,1))
light('EntryDaylight',(0,4.2,13.6),(.72,.83,1),1800,'AREA',4,target=(0,2,0))
for x in [-11.7,11.7]:light('SideDaylight', (x,6.8,1),(.7,.8,1),1800,'AREA',8,target=(0,3,1))
# Build grouped meshes with material-node colors exportable to glTF.
for (name,material,group),(vs,fs) in B.items():
    me=bpy.data.meshes.new(name+'Mesh');me.from_pydata(vs,[],fs);me.materials.append(M[material]);me.update()
    ob=bpy.data.objects.new(name+'_'+material,me);COL[group].objects.link(ob)
    ob['semantic_group']=group
    if name.startswith('Exhibit_'):ob['slot_id']=name.removeprefix('Exhibit_');ob['content']='empty exhibition platform'
# Dedicated cameras for reproducible concept comparison.
def camera(name,p,target,lens=26):
    dat=bpy.data.cameras.new(name);dat.lens=lens;dat.clip_end=250
    ob=bpy.data.objects.new(name,dat);COL['Cameras'].objects.link(ob);ob.location=point(p)
    ob.rotation_euler=(Vector(point(target))-ob.location).to_track_quat('-Z','Y').to_euler();return ob
entry=camera('T10_Entry',(0,1.65,12.2),(0,3.6,-7),24)
upper=camera('T10_Upper',(-7.8,6.45,-5.6),(2,3.7,10),22)
overview=camera('T10_Overview',(30,26,34),(0,3,0),38)
scene.camera=entry
world=bpy.data.worlds.new('T10_World');world.use_nodes=True
bg=next(n for n in world.node_tree.nodes if n.type=='BACKGROUND');bg.inputs['Color'].default_value=(.16,.21,.29,1);bg.inputs['Strength'].default_value=.35;scene.world=world
scene.render.resolution_x=1440;scene.render.resolution_y=900;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
try:scene.render.engine='CYCLES';scene.cycles.samples=24;scene.cycles.use_denoising=True
except Exception:scene.render.engine='BLENDER_EEVEE_NEXT'
scene.render.film_transparent=False
# Persist true measured layout delta separately from the concept proposal.
manifest=dict(scene=NAME,source='scripts/blender/build_t10.py',coordinateMapping='Web (x,y,z) -> Blender (x,-z,y); glTF export Y_UP once',
    exhibitSlots=D['exhibitSlots'],upperFloorY=4.8,atriumOpening=D['atriumOpening'],stairOpening=D['stair']['upperOpening'],
    stairPath=D['stair']['ascendingPath'],stairTreadCount=30,flightBandWidth=2.4,railPostWidth=.1,nominalStairClearWidth=2.18,
    stairLandingDepth=1.5,skylightFootprint=[4,6],lightMarkers=LIGHTS,
    cameras=[dict(name=o.name,position=[o.location.x,o.location.z,-o.location.y]) for o in [entry,upper,overview]],
    validationScope='Geometry and asset delivery; no implemented navigation or real exhibition content')
(OUT/'pavilion-layout.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
# Save source file; all prior scenes remain available.
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'pavilion-v1.blend'))
print(json.dumps({'scene':scene.name,'objects':len(scene.objects),'meshes':sum(o.type=='MESH' for o in scene.objects),'vertices':sum(len(o.data.vertices) for o in scene.objects if o.type=='MESH'),'faces':sum(len(o.data.polygons) for o in scene.objects if o.type=='MESH'),'blend':str(OUT/'pavilion-v1.blend')},ensure_ascii=False))
