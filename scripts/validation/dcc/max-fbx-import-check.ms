fn logLine stream text =
(
  format "%\n" text to:stream
)

fn vecText v =
(
  ("[" + (v.x as string) + "," + (v.y as string) + "," + (v.z as string) + "]")
)

fn collectBitmapNames mat names =
(
  if mat == undefined then names
  else
  (
    if isProperty mat #diffuseMap do
    (
      local m = mat.diffuseMap
      if m != undefined do append names (classof m as string)
      if m != undefined and isProperty m #filename do append names m.filename
    )
    for i = 1 to getNumSubTexmaps mat do
    (
      local sm = getSubTexmap mat i
      if sm != undefined do
      (
        append names (classof sm as string)
        if isProperty sm #filename do append names sm.filename
      )
    )
    names
  )
)

local fbxPath = maxOps.mxsCmdLineArgs[#fbx]
local outPath = maxOps.mxsCmdLineArgs[#out]
local stream = createFile outPath

try
(
  resetMaxFile #noPrompt
  try (FBXImporterSetParam "Mode" #create) catch()
  try (FBXImporterSetParam "Animation" false) catch()
  try (FBXImporterSetParam "Cameras" false) catch()
  try (FBXImporterSetParam "Lights" false) catch()

  logLine stream ("INPUT=" + fbxPath)
  local imported = importFile fbxPath #noPrompt using:FBXIMP
  logLine stream ("IMPORT_RETURN=" + (imported as string))
  logLine stream ("OBJECT_COUNT=" + (objects.count as string))
  logLine stream ("GEOMETRY_COUNT=" + (geometry.count as string))

  local geos = for o in geometry collect o
  if geos.count > 0 then
  (
    local mn = [1e9, 1e9, 1e9]
    local mx = [-1e9, -1e9, -1e9]
    for o in geos do
    (
      local bb = nodeGetBoundingBox o (matrix3 1)
      mn.x = amin mn.x bb[1].x
      mn.y = amin mn.y bb[1].y
      mn.z = amin mn.z bb[1].z
      mx.x = amax mx.x bb[2].x
      mx.y = amax mx.y bb[2].y
      mx.z = amax mx.z bb[2].z
      logLine stream ("NODE=" + o.name + " CLASS=" + (classof o as string) + " FACES=" + ((try (o.mesh.numfaces) catch 0) as string) + " VERTS=" + ((try (o.mesh.numverts) catch 0) as string))
    )
    local size = mx - mn
    logLine stream ("BBOX_MIN=" + vecText mn)
    logLine stream ("BBOX_MAX=" + vecText mx)
    logLine stream ("BBOX_SIZE=" + vecText size)
  )

  local materialCount = 0
  local bitmapNames = #()
  for o in objects do
  (
    if o.material != undefined do
    (
      materialCount += 1
      collectBitmapNames o.material bitmapNames
    )
  )
  logLine stream ("MATERIAL_NODE_COUNT=" + (materialCount as string))
  for b in bitmapNames do logLine stream ("BITMAP=" + (b as string))
)
catch
(
  logLine stream ("ERROR=" + (getCurrentException()))
)

close stream
quitMax #noPrompt
