"""Sample geometry along the planned route via live Blender. Not a navigation simulator."""
import bpy,json,math
from pathlib import Path
from mathutils import Vector
ROOT=Path('/Users/yafeng/Documents/ChatGPT/hackathon/aholo-lux3d');s=bpy.data.scenes['T10_Pavilion_v1'];bpy.context.window.scene=s
dg=bpy.context.evaluated_depsgraph_get();d=json.loads((ROOT/'assets/t10/pavilion-layout.json').read_text())
stairs=d['stairPath']
route=[[0,0,12.2],[0,0,9],[8,0,9],[8,0,-5.9],[1.5,0,-5.9]]+stairs+[[-1.5,4.8,-5.9],[-8,4.8,-5.9],[-8,4.8,10],[8,4.8,10],[8,4.8,-5.9],[-1.5,4.8,-5.9]]+list(reversed(stairs))+[[1.5,0,-5.9],[8,0,-5.9],[8,0,9],[0,0,9],[0,0,12.2]]
def ray(p,vec,distance):return s.ray_cast(dg,Vector((p[0],-p[2],p[1])),Vector((vec[0],-vec[2],vec[1])),distance=distance)
samples=0;issues=[];min_clear=100;max_step=0;prev_y=None
for a,b in zip(route,route[1:]):
    aa,bb=Vector(a),Vector(b);n=max(1,math.ceil((bb-aa).length/.16))
    for k in range(n):
        p=aa.lerp(bb,k/n);hit,loc,_,_,ob,_=ray((p.x,p.y+.25,p.z),(0,-1,0),.6)
        samples+=1
        if not hit:issues.append({'kind':'no_floor','position':list(p)});continue
        feet=loc.z
        if prev_y is not None:max_step=max(max_step,abs(feet-prev_y))
        prev_y=feet
        h,l,_,_,o,_=ray((p.x,feet+.03,p.z),(0,1,0),2.2)
        if h:
            clear=l.z-feet;min_clear=min(min_clear,clear)
            if clear<1.8:issues.append({'kind':'headroom','position':list(p),'clearance':clear,'object':o.name})
        for height in [.35,.9,1.65]:
            for j in range(8):
                h,l,_,_,o,_=ray((p.x,feet+height,p.z),(math.cos(j*math.tau/8),0,math.sin(j*math.tau/8)),.28)
                if h:issues.append({'kind':'body_radius','position':list(p),'height':height,'object':o.name})
result={'scope':'Static sampled rays only; no continuous motion, WASD, frame-rate or anti-fall verification','route':route,'sampleSpacingMax':.16,'bodyRadiusProbe':.28,'headroomRequirement':1.8,'samples':samples,'issues':issues,'maxAdjacentGroundHeightChange':max_step,'minOverheadHitWithin2_2m':min_clear if min_clear<100 else None,'pass':not issues and max_step<.18}
(ROOT/'assets/t10/route-geometry-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='route'},ensure_ascii=False))
