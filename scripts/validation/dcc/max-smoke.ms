local outPath = maxOps.mxsCmdLineArgs[#out]
local stream = createFile outPath
format "MAX_SMOKE_OK\n" to:stream
format "MAX_VERSION=%\n" maxVersion() to:stream
close stream
quitMax #noPrompt
