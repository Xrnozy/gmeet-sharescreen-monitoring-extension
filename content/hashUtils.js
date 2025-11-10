// Utility functions: dHash, pHash, gradientHash, helpers

function toGrayscale(imageData, width, height) {
  const out = new Float32Array(width * height);
  for (let i = 0, j = 0; i < imageData.length; i += 4, j++) {
    out[j] =
      0.299 * imageData[i] +
      0.587 * imageData[i + 1] +
      0.114 * imageData[i + 2];
  }
  return out;
}

function resizeGray(src, srcW, srcH, dstW, dstH) {
  const dst = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const sy = ((y + 0.5) * srcH) / dstH - 0.5;
    const y0 = Math.max(0, Math.floor(sy)),
      y1 = Math.min(srcH - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < dstW; x++) {
      const sx = ((x + 0.5) * srcW) / dstW - 0.5;
      const x0 = Math.max(0, Math.floor(sx)),
        x1 = Math.min(srcW - 1, x0 + 1);
      const wx = sx - x0;
      const v00 = src[y0 * srcW + x0],
        v01 = src[y0 * srcW + x1];
      const v10 = src[y1 * srcW + x0],
        v11 = src[y1 * srcW + x1];
      dst[y * dstW + x] =
        (1 - wx) * (1 - wy) * v00 +
        wx * (1 - wy) * v01 +
        (1 - wx) * wy * v10 +
        wx * wy * v11;
    }
  }
  return dst;
}

function hammingBits(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function dHashFromGray(gray, w, h) {
  const small = resizeGray(gray, w, h, 9, 8);
  const bits = new Uint8Array(64);
  let idx = 0;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      bits[idx++] = small[y * 9 + x] > small[y * 9 + x + 1] ? 1 : 0;
  return bits;
}

function dct2(matrix, N) {
  const out = new Float64Array(N * N);
  const PI = Math.PI;
  const factor = Math.sqrt(2 / N);
  for (let u = 0; u < N; u++) {
    const cu = u === 0 ? Math.SQRT1_2 : 1;
    for (let v = 0; v < N; v++) {
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      let sum = 0;
      for (let x = 0; x < N; x++) {
        const cx = Math.cos(((2 * x + 1) * u * PI) / (2 * N));
        for (let y = 0; y < N; y++)
          sum +=
            matrix[y * N + x] * cx * Math.cos(((2 * y + 1) * v * PI) / (2 * N));
      }
      out[v * N + u] = factor * cu * cv * sum;
    }
  }
  return out;
}

function pHashFromGray(gray, w, h) {
  const N = 32;
  const small = resizeGray(gray, w, h, N, N);
  const dct = dct2(small, N);
  const vals = new Float64Array(64);
  let i = 0;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) vals[i++] = dct[y * N + x];
  const sorted = Float64Array.from(vals).sort((a, b) => a - b);
  const median = sorted[32];
  const bits = new Uint8Array(64);
  for (let j = 0; j < 64; j++) bits[j] = vals[j] > median ? 1 : 0;
  return bits;
}

function gradientHash(gray, w, h) {
  const small = resizeGray(gray, w, h, 32, 32);
  const bits = new Uint8Array(64);
  let idx = 0;
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let gx = 0,
        gy = 0;
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x,
            py = by * 4 + y,
            i = py * 32 + px;
          const dx = small[i + 1] - small[i - 1 < 0 ? 0 : i - 1];
          const dy = small[i + 32] - small[i - 32 < 0 ? 0 : i - 32];
          gx += dx;
          gy += dy;
        }
      bits[idx++] = gx * gx + gy * gy > 0 ? (gx > gy ? 1 : 0) : 0;
    }
  }
  return bits;
}

window.GMS = window.GMS || {};
window.GMS.hashUtils = {
  toGrayscale,
  resizeGray,
  dHashFromGray,
  pHashFromGray,
  gradientHash,
  hammingBits,
};
