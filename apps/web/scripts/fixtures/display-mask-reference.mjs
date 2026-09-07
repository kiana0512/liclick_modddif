// Frozen pixel reference from 5c0764ff; do not optimize this test oracle.
function getTone(data, offset) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const alpha = data[offset + 3];
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const chroma = max - min;
    const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    return { alpha, max, min, chroma, luma };
}
export function applyPackedDepthDisplayMask(source, packedDepth) {
    if (source.width !== packedDepth.width || source.height !== packedDepth.height) {
        throw new Error('Generated display source and depth dimensions must match.');
    }
    const output = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
    let changedPixels = 0;
    for (let offset = 0; offset < output.data.length; offset += 4) {
        const clearPixel = packedDepth.data[offset] >= 254 &&
            packedDepth.data[offset + 1] >= 254 &&
            packedDepth.data[offset + 2] >= 254;
        if (!clearPixel)
            continue;
        if (output.data[offset] !== 0 ||
            output.data[offset + 1] !== 0 ||
            output.data[offset + 2] !== 0 ||
            output.data[offset + 3] !== 0)
            changedPixels += 1;
        output.data[offset] = 0;
        output.data[offset + 1] = 0;
        output.data[offset + 2] = 0;
        output.data[offset + 3] = 0;
    }
    return { imageData: output, changedPixels };
}
export function removeStrictOuterDarkDisplayBackground(source) {
    const { width, height, data } = source;
    const output = new ImageData(new Uint8ClampedArray(data), width, height);
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    const accepts = (index, seed) => {
        const tone = getTone(data, index * 4);
        if (tone.alpha <= (seed ? 8 : 16))
            return true;
        return seed
            ? tone.luma <= 11 && tone.max <= 24 && tone.chroma <= 20
            : tone.luma <= 17 && tone.max <= 32 && tone.chroma <= 24;
    };
    const enqueue = (index, seed) => {
        if (visited[index] || !accepts(index, seed))
            return;
        visited[index] = 1;
        queue[tail] = index;
        tail += 1;
    };
    for (let x = 0; x < width; x += 1) {
        enqueue(x, true);
        enqueue((height - 1) * width + x, true);
    }
    for (let y = 1; y < height - 1; y += 1) {
        enqueue(y * width, true);
        enqueue(y * width + width - 1, true);
    }
    while (head < tail) {
        const current = queue[head];
        head += 1;
        const x = current % width;
        const y = Math.floor(current / width);
        if (x > 0)
            enqueue(current - 1, false);
        if (x < width - 1)
            enqueue(current + 1, false);
        if (y > 0)
            enqueue(current - width, false);
        if (y < height - 1)
            enqueue(current + width, false);
    }
    let changedPixels = 0;
    for (let index = 0; index < tail; index += 1) {
        const offset = queue[index] * 4;
        if (output.data[offset] !== 0 ||
            output.data[offset + 1] !== 0 ||
            output.data[offset + 2] !== 0 ||
            output.data[offset + 3] !== 0)
            changedPixels += 1;
        output.data[offset] = 0;
        output.data[offset + 1] = 0;
        output.data[offset + 2] = 0;
        output.data[offset + 3] = 0;
    }
    return { imageData: output, changedPixels };
}
