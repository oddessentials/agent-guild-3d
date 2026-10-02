# Renders the Grove level badge with Blender: a smooth dark river stone with moss on its
# shoulder, seen from above, over transparency. The level number is drawn on it by CSS.
#   blender -b -P source/stone.py -- OUT.png
import sys, math
import bpy

out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 256
scene.cycles.use_denoising = True
prefs = bpy.context.preferences.addons["cycles"].preferences
try:
    prefs.compute_device_type = "OPTIX"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = "GPU"
except Exception:
    pass
scene.render.resolution_x = scene.render.resolution_y = 512
scene.render.film_transparent = True
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"

# The stone: a flattened, slightly irregular pebble.
bpy.ops.mesh.primitive_uv_sphere_add(segments=128, ring_count=64, radius=1)
stone = bpy.context.object
stone.scale = (1.0, 0.86, 0.38)
bpy.ops.object.shade_smooth()
tex = bpy.data.textures.new("lumps", "CLOUDS")
tex.noise_scale = 0.9
disp = stone.modifiers.new("lumps", "DISPLACE")
disp.texture = tex
disp.strength = 0.07
stone.modifiers.new("smooth", "SUBSURF").levels = 2

mat = bpy.data.materials.new("stone")
mat.use_nodes = True
nt = mat.node_tree
n, l = nt.nodes, nt.links
bsdf = n["Principled BSDF"]
geo = n.new("ShaderNodeNewGeometry")
coord = n.new("ShaderNodeTexCoord")

# Slate-grey stone with faint mineral veins and speckle.
grain = n.new("ShaderNodeTexNoise"); grain.inputs["Scale"].default_value = 7; grain.inputs["Detail"].default_value = 10
l.new(coord.outputs["Object"], grain.inputs["Vector"])
stone_ramp = n.new("ShaderNodeValToRGB")
stone_ramp.color_ramp.elements[0].color = (0.03, 0.035, 0.04, 1)
stone_ramp.color_ramp.elements[1].color = (0.11, 0.12, 0.125, 1)
l.new(grain.outputs["Fac"], stone_ramp.inputs["Fac"])
vein = n.new("ShaderNodeTexWave"); vein.inputs["Scale"].default_value = 0.3; vein.inputs["Distortion"].default_value = 6; vein.inputs["Detail"].default_value = 4
l.new(coord.outputs["Object"], vein.inputs["Vector"])
vein_ramp = n.new("ShaderNodeValToRGB")
vein_ramp.color_ramp.elements[0].position = 0.99
vein_ramp.color_ramp.elements[0].color = (0, 0, 0, 1)
vein_ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
l.new(vein.outputs["Fac"], vein_ramp.inputs["Fac"])
veined = n.new("ShaderNodeMix"); veined.data_type = "RGBA"; veined.inputs["B"].default_value = (0.26, 0.27, 0.27, 1)
l.new(vein_ramp.outputs["Color"], veined.inputs["Factor"])
l.new(stone_ramp.outputs["Color"], veined.inputs["A"])

# Moss: on the upper-left shoulder, where the normal faces up and away from the centre, broken up by noise.
sep = n.new("ShaderNodeSeparateXYZ")
l.new(coord.outputs["Object"], sep.inputs["Vector"])
side = n.new("ShaderNodeMath"); side.operation = "MULTIPLY_ADD"
side.inputs[1].default_value = -0.7; side.inputs[2].default_value = 0.0
l.new(sep.outputs["X"], side.inputs[0])
side2 = n.new("ShaderNodeMath"); side2.operation = "MULTIPLY_ADD"
side2.inputs[1].default_value = 0.7
l.new(sep.outputs["Y"], side2.inputs[0]); l.new(side.outputs[0], side2.inputs[2])
patch = n.new("ShaderNodeTexNoise"); patch.inputs["Scale"].default_value = 3.2; patch.inputs["Detail"].default_value = 8; patch.inputs["Roughness"].default_value = 0.7
l.new(coord.outputs["Object"], patch.inputs["Vector"])
mossy = n.new("ShaderNodeMath"); mossy.operation = "ADD"
l.new(side2.outputs[0], mossy.inputs[0]); l.new(patch.outputs["Fac"], mossy.inputs[1])
tufts = n.new("ShaderNodeTexNoise"); tufts.inputs["Scale"].default_value = 24; tufts.inputs["Detail"].default_value = 6
l.new(coord.outputs["Object"], tufts.inputs["Vector"])
ragged = n.new("ShaderNodeMath"); ragged.operation = "MULTIPLY_ADD"; ragged.inputs[1].default_value = 0.16
l.new(tufts.outputs["Fac"], ragged.inputs[0]); l.new(mossy.outputs[0], ragged.inputs[2])
mossy = ragged
moss_mask = n.new("ShaderNodeMapRange")
moss_mask.inputs["From Min"].default_value = 1.06; moss_mask.inputs["From Max"].default_value = 1.12
l.new(mossy.outputs[0], moss_mask.inputs["Value"])
fuzz = n.new("ShaderNodeTexNoise"); fuzz.inputs["Scale"].default_value = 60; fuzz.inputs["Detail"].default_value = 4
l.new(coord.outputs["Object"], fuzz.inputs["Vector"])
moss_ramp = n.new("ShaderNodeValToRGB")
moss_ramp.color_ramp.elements[0].color = (0.02, 0.07, 0.01, 1)
moss_ramp.color_ramp.elements[1].color = (0.12, 0.30, 0.03, 1)
l.new(fuzz.outputs["Fac"], moss_ramp.inputs["Fac"])
color = n.new("ShaderNodeMix"); color.data_type = "RGBA"
l.new(moss_mask.outputs["Result"], color.inputs["Factor"])
l.new(veined.outputs["Result"], color.inputs["A"]); l.new(moss_ramp.outputs["Color"], color.inputs["B"])
l.new(color.outputs["Result"], bsdf.inputs["Base Color"])

# Wet-polished stone, velvety moss.
rough = n.new("ShaderNodeMapRange")
rough.inputs["To Min"].default_value = 0.32; rough.inputs["To Max"].default_value = 0.95
l.new(moss_mask.outputs["Result"], rough.inputs["Value"])
l.new(rough.outputs["Result"], bsdf.inputs["Roughness"])
sheen = n.new("ShaderNodeMath"); sheen.operation = "MULTIPLY"; sheen.inputs[1].default_value = 0.8
l.new(moss_mask.outputs["Result"], sheen.inputs[0])
l.new(sheen.outputs[0], bsdf.inputs["Sheen Weight"])
bsdf.inputs["Sheen Tint"].default_value = (0.6, 0.9, 0.4, 1)
bump = n.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.25
bumpmix = n.new("ShaderNodeMath"); bumpmix.operation = "MULTIPLY_ADD"; bumpmix.inputs[1].default_value = 1.0
l.new(moss_mask.outputs["Result"], bumpmix.inputs[0]); l.new(grain.outputs["Fac"], bumpmix.inputs[2])
fuzzh = n.new("ShaderNodeMath"); fuzzh.operation = "MULTIPLY"
l.new(fuzz.outputs["Fac"], fuzzh.inputs[0]); l.new(moss_mask.outputs["Result"], fuzzh.inputs[1])
height = n.new("ShaderNodeMath"); height.operation = "ADD"
l.new(fuzzh.outputs[0], height.inputs[0]); l.new(grain.outputs["Fac"], height.inputs[1])
l.new(height.outputs[0], bump.inputs["Height"])
l.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
stone.data.materials.append(mat)

# Camera from above, a little tilted; soft key light from the upper left and a cool rim.
bpy.ops.object.camera_add(location=(0, -1.3, 4.6), rotation=(math.radians(16), 0, 0))
cam = bpy.context.object
cam.data.type = "ORTHO"
cam.data.ortho_scale = 2.3
scene.camera = cam
bpy.ops.object.light_add(type="AREA", location=(-2.5, -1.5, 4))
key = bpy.context.object; key.data.energy = 180; key.data.size = 3; key.data.color = (1.0, 0.95, 0.86)
key.rotation_euler = (math.radians(30), math.radians(-35), 0)
bpy.ops.object.light_add(type="AREA", location=(2.6, 2.2, 1.2))
rim = bpy.context.object; rim.data.energy = 140; rim.data.size = 2; rim.data.color = (0.7, 0.9, 1.0)
rim.rotation_euler = (math.radians(-70), math.radians(45), 0)
world = bpy.data.worlds.new("w"); scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.25, 0.3, 0.28, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.25

scene.render.filepath = out
bpy.ops.render.render(write_still=True)
