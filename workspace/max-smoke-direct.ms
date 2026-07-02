local stream = createFile @"E:\Liclick 3D Texture\workspace\max-smoke-result.txt"
format "MAX_SMOKE_OK\n" to:stream
format "MAX_VERSION=%\n" (maxVersion()) to:stream
close stream
quitMax #noPrompt
