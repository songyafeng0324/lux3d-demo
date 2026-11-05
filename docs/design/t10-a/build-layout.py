"""Generate the reviewable T10-A concept layout. Not production navigation."""
import json
from pathlib import Path
from html import escape
root = Path(__file__).resolve().parent
slots = []
for level, zs in [(0, [-10,-7.5,-5,-2.5,0,2.5,5,7.5,10]), (1, [-10,-6,-2,2,6,10])]:
    for x in [-9.6, 9.6]:
        for z in zs:
            slots.append(dict(id=f'T{len(slots)+1:02}', floor=level, position=[x,level*4.8,z], footprint=[1.2,1.2]))
data=dict(version='treasure-pavilion-t10-a-draft-v1', status='design-only-not-runtime', units='metres', axes='Web Y up; north = -Z; east = +X',
    footprint=dict(x=[-12,12],z=[-14,14]), upperFloorY=4.8, upperSlabThickness=.3,
    atriumOpening=dict(x=[-6,6],z=[-4.5,7.5]), entrance=dict(x=[-2,2],z=14),
    cameraEntry=dict(position=[0,1.65,12.2],target=[0,3,-9]),
    stair=dict(footprint=dict(x=[-2.7,2.7],z=[-13,-6.7]), flightBandWidth=2.4, finishedClearWidth=None, centralGap=.6,
        rise=4.8, risersPerFlight=15, riserHeight=.16, conceptualRunPerFlight=4.8,
        landing=dict(x=[-2.7,2.7],z=[-13,-11.5],y=2.4),
        ascendingPath=[[1.5,0,-6.7],[1.5,2.4,-11.5],[1.5,2.4,-12.25],[-1.5,2.4,-12.25],[-1.5,2.4,-11.5],[-1.5,4.8,-6.7]],
        upperOpening=dict(x=[-2.7,2.7],z=[-13,-6.7]),
        note='Flight width is conceptual band width, not finished clear width. Path is schematic, not collision-validated. Two parallel opposing flights. Reserve footprint on both floors; no access below. Upper exit only at west flight south end; guard every other hole edge.'),
    guardrailHeight=1.15, northCrossAisleDepth=2.2, columnRadius=.4,
    columns=[[x,z] for x in [-6.4,6.4] for z in [-4.9,1.5,7.9]],
    minNominalSideClearWidth=2.2, exhibitSlots=slots,
    exclusions=['Do not migrate courtyard-v1','Do not add private-room floors','No real published exhibits in these drawings'])
(root/'layout-draft.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
S=['<svg xmlns="http://www.w3.org/2000/svg" width="1680" height="1320" viewBox="0 0 1680 1320">', '''<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="#44a99c" stroke-width="1.3"/></marker><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 8L8 0" stroke="#d7d1c4" stroke-width="1"/></pattern></defs>''','<rect width="1680" height="1320" fill="#f4f0e6"/>']
def text(x,y,t,size=18,color='#233335',anchor='start'):
    S.append(f'<text x="{x}" y="{y}" font-family="PingFang SC, sans-serif" font-size="{size}" fill="{color}" text-anchor="{anchor}">{escape(t)}</text>')
def rect(x,y,w,h,fill,stroke='none',sw=1):
    S.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')
def path(d,color='#44a99c',sw=3,arrow=False,dash=''):
    S.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}" '+('marker-end="url(#arrow)" ' if arrow else '')+(f'stroke-dasharray="{dash}" ' if dash else '')+'/>')
text(60,58,'藏宝阁 / 空间设计草案',36);text(60,95,'T10-A · 先确定能走通的空间，再制作建筑 · 2026.11.05',18,'#64716e')
text(1600,55,'01 / 结构依据',18,anchor='end');text(1600,85,'尺寸暂定 · 非施工图 · 非运行验证',16,'#817567',anchor='end')
scale=18
for level, ox in [(0,100),(1,720)]:
    oy=180
    text(ox,145,('一层 / 18 个展位' if level==0 else '二层 / 12 个展位'),25)
    def P(x,z):return (ox+(x+12)*scale,oy+(z+14)*scale)
    def box(x1,z1,x2,z2,fill,stroke='#a7997f',sw=1):
        a,b=P(x1,z1);rect(a,b,(x2-x1)*scale,(z2-z1)*scale,fill,stroke,sw)
    box(-12,-14,12,14,'#e7dcc7' if level==0 else '#d8c5a4','#514f43',3)
    box(-6,-4.5,6,7.5,'#f7f5ee','#b4a389',2)
    if level:
        box(-6,-4.5,6,7.5,'url(#hatch)','#826740',3)
    a,b=P(0,1);text(a,b,'通高中庭' if level==0 else '中庭开口 / 无楼板',17,anchor='middle')
    text(a,b+26,'12 × 12 m',16,'#6e776e',anchor='middle')
    box(-2.7,-13,2.7,-6.7,'#b8c9bc','#455f54',2)
    box(-2.7,-13,2.7,-11.5,'#9db7a7')
    for i in range(16):
        z=-11.5+i*.32
        for x1,x2 in [(-2.7,-.3),(.3,2.7)]:
            a,b=P(x1,z);c,d=P(x2,z);path(f'M{a},{b} L{c},{d}','#788978',1)
    for x,z1,z2 in [(1.5,-7,-11.2),(-1.5,-11.2,-7)]:
        a,b=P(x,z1);c,d=P(x,z2);path(f'M{a},{b} L{c},{d}','#236a5e',2,True)
    a,b=P(3.2,-10);text(a,b,'折返梯',14);text(a,b+21,'0 → 2.4 → 4.8 m',12)
    a,b=P(0,-4.7);text(a,b,'横向净通道 2.2 m',11,anchor='middle')
    # Main walking route stays off the opening, stairs, columns, and display footprints.
    route=[(0,13),(0,9),(8,9),(8,-5.9),(1.5,-5.9),(1.5,-6.7)] if not level else [(-1.5,-6.7),(-1.5,-5.9),(-8,-5.9),(-8,10),(8,10),(8,-5.9),(3.5,-5.9)]
    pts=[P(*v) for v in route];path('M'+' L'.join(f'{x},{y}' for x,y in pts),'#44a99c',3,True,'7 5')
    for x,z in data['columns']:
        a,b=P(x,z);S.append(f'<circle cx="{a}" cy="{b}" r="7.2" fill="#5a4736"/>')
    for slot in slots:
        if slot['floor']!=level:continue
        x,_,z=slot['position'];a,b=P(x,z)
        rect(a-10.8,b-10.8,21.6,21.6,'#a98041','#72562d');text(a,b+4,slot['id'],10,'#fff',anchor='middle')
    if not level:
        a,b=P(-2,14);path(f'M{a},{b}h72','#f4f0e6',6);text(ox+216,oy+536,'南侧入口 / 净宽 4 m',17,anchor='middle')
    else:text(ox+216,oy+536,'二层标高 +4.8 m / 环绕参观',17,anchor='middle')
    text(ox+216,oy-12,'24 m',15,'#6e776e',anchor='middle');text(ox-42,oy+254,'28 m',15,'#6e776e')
    text(ox+420,oy-18,'北 ↑',17)
text(1240,164,'布局要点',24)
notes=['南侧进入，北侧上楼','右梯上行 → 平台折返','左梯抵达二层北廊','中庭与梯井均需护栏','展位沿外侧，内侧留通道','总计 30 位，编号 T01—T30','两层展位均为概念锚点','个人小屋仍保持一间']
for i,t in enumerate(notes):text(1240,208+i*37,t,18)
rect(1240,540,22,15,'#a98041');text(1274,554,'展位 / 1.2 × 1.2 m',16)
path('M1240 585h24','#44a99c',3,True);text(1274,591,'建议参观路线',16)
rect(1240,613,22,15,'url(#hatch)','#826740');text(1274,628,'楼板开口 / 不可行走',16)
path('M60 780H1620','#d2c8b5',1)
text(60,830,'楼梯展开剖面 / 两段平行梯展开表示，不是第三层',26)
# Unfolded staircase, exact level rise and conceptual run.
sx,sy,ss=100,1145,54
path(f'M{sx-30},{sy}H{sx+30}','#4e5247',3)
pts=[(sx,sy)]
for flight in range(2):
    for i in range(15):
        x0,y0=pts[-1];pts.extend([(x0,y0-.16*ss),(x0+.32*ss,y0-.16*ss)])
    if flight==0:
        x0,y0=pts[-1];pts.append((x0+1.5*ss,y0))
path('M'+' L'.join(f'{x:.2f},{y:.2f}' for x,y in pts),'#6c5a3f',3)
xend,yend=pts[-1];path(f'M{xend},{yend}h90','#6c5a3f',4)
text(90,1170,'一层 ±0.00',17);text(365,1045,'折返平台 +2.40',17);text(730,930,'二层 +4.80',17)
text(160,1135,'第一段：15 × 0.16 m',16);text(545,1025,'第二段：15 × 0.16 m',16)
text(1060,877,'楼梯草案参数',23)
for i,t in enumerate(['梯带宽 2.4 m；平台深 1.5 m','单段水平投影约 4.8 m','梯井预留 5.4 × 6.3 m','栏杆高 1.15 m；楼板厚约 0.3 m','护栏扣减后净宽、净高、碰撞待粗模验证']):text(1060,916+i*33,t,17)
text(60,1200,'结构优先级：layout-draft.json → 本图 → 视角概念图。透视图不用于测量或确认梯段拓扑。',18)
text(60,1240,'概念图中的采光顶、楼梯形状与展品数量允许偏差；建模以尺寸草案校验，最终以浏览器实走结果收敛。',17,'#68746e')
text(60,1283,'AHOLO / LUX3D                                           SPACE STUDY 01                                       18 + 12 = 30',15,'#8b7e6a')
S.append('</svg>');(root/'03-layout.svg').write_text('\n'.join(S))
print('Wrote layout-draft.json, 03-layout.svg; 30 slots; levels 18 + 12.')
