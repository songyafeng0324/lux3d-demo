"""Render actual asset evidence in live Blender via MCP after finalization."""
import bpy,json
from pathlib import Path
ROOT=Path('/Users/yafeng/Documents/ChatGPT/hackathon/aholo-lux3d')
s=bpy.data.scenes['T10_Pavilion_v1'];bpy.context.window.scene=s
s.render.resolution_x=1280;s.render.resolution_y=800;s.cycles.samples=24
for camera_name,file_name in [('T10_Entry','blender-entry.png'),('T10_Upper','blender-upper.png')]:
    s.camera=s.objects[camera_name];s.render.filepath=str(ROOT/'docs/validation/evidence/t10-b'/file_name)
    bpy.ops.render.render(write_still=True)
    print('Rendered',camera_name,s.render.filepath)
s.camera=s.objects['T10_Entry']
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/t10/pavilion-v1.blend'))
print('Actual two-view evidence rendered; saved editable blend with entry camera.')
