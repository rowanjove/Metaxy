export interface ImagePipelineOptions {
  maxDimension?: number; // e.g. 4096, 2560, 1920 (0 = original)
  quality?: number; // 0.1 to 1.0 (default 0.85)
  webpMode?: "OFF" | "SMART" | "ALWAYS";
  generateThumbnail?: boolean;
  thumbMaxDimension?: number; // default 640
  thumbQuality?: number; // default 0.75
  watermarkText?: string;
  watermarkPosition?: string;
}

export interface ProcessedImageResult {
  blob: Blob;
  filename: string;
  contentType: string;
  width: number;
  height: number;
  originalBytes: number;
  outputBytes: number;
  thumbBlob?: Blob;
  dominantColor?: string;
}

const MAX_DECODE_PIXELS = 40_000_000; // 40 MP safety threshold

export async function processImageFile(
  file: File,
  options: ImagePipelineOptions = {}
): Promise<ProcessedImageResult> {
  const originalBytes = file.size;
  const originalType = file.type.toLowerCase();
  const maxDim = options.maxDimension || 0;
  const quality = options.quality ?? 0.85;
  const webpMode = options.webpMode || "SMART";
  const genThumb = options.generateThumbnail !== false;
  const thumbDim = options.thumbMaxDimension || 640;
  const thumbQuality = options.thumbQuality || 0.75;

  // 1. Pass-through exemption: GIF, SVG, AVIF, or non-image
  if (originalType === "image/gif" || originalType === "image/svg+xml" || originalType === "image/avif") {
    // Generate thumbnail only if it's not SVG
    let thumbBlob: Blob | undefined;
    let width = 0;
    let height = 0;
    if (typeof window !== "undefined" && originalType !== "image/svg+xml") {
      try {
        const img = await loadImageElement(file);
        width = img.naturalWidth || img.width;
        height = img.naturalHeight || img.height;
        if (genThumb) {
          thumbBlob = await generateThumbFromImage(img, thumbDim, thumbQuality);
        }
      } catch {
        // Fallback if image failed to decode in element
      }
    }

    return {
      blob: file,
      filename: file.name,
      contentType: file.type,
      width,
      height,
      originalBytes,
      outputBytes: originalBytes,
      thumbBlob
    };
  }

  // 2. Decode image element
  const img = await loadImageElement(file);
  let srcWidth = img.naturalWidth || img.width;
  let srcHeight = img.naturalHeight || img.height;

  // 3. Pixel Safety Check (Max 40 MP)
  const totalPixels = srcWidth * srcHeight;
  let scale = 1;
  if (totalPixels > MAX_DECODE_PIXELS) {
    scale = Math.sqrt(MAX_DECODE_PIXELS / totalPixels);
  }

  // 4. Dimension clamping
  let targetWidth = Math.round(srcWidth * scale);
  let targetHeight = Math.round(srcHeight * scale);

  if (maxDim > 0 && (targetWidth > maxDim || targetHeight > maxDim)) {
    const dimScale = Math.min(maxDim / targetWidth, maxDim / targetHeight);
    targetWidth = Math.round(targetWidth * dimScale);
    targetHeight = Math.round(targetHeight * dimScale);
  }

  // 5. Render to Canvas
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not create 2D canvas context.");
  }

  // Preserve alpha channel (do not draw background)
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  // Apply watermark if configured
  if (options.watermarkText && options.watermarkText.trim()) {
    drawWatermark(ctx, targetWidth, targetHeight, options.watermarkText.trim(), options.watermarkPosition || "bottom-right");
  }

  // Extract dominant color sample
  let dominantColor: string | undefined;
  try {
    dominantColor = sampleDominantColor(ctx, targetWidth, targetHeight);
  } catch {
    // optional
  }

  // 6. Encode main image
  let outputBlob: Blob = file;
  let outputType = file.type;
  let outputName = file.name;

  if (webpMode === "ALWAYS") {
    const webpBlob = await canvasToBlob(canvas, "image/webp", quality);
    if (webpBlob) {
      outputBlob = webpBlob;
      outputType = "image/webp";
      outputName = replaceExtension(file.name, "webp");
    }
  } else if (webpMode === "SMART") {
    // Try WebP encoding and compare size
    const webpBlob = await canvasToBlob(canvas, "image/webp", quality);
    if (webpBlob && webpBlob.size < originalBytes * 0.9) {
      outputBlob = webpBlob;
      outputType = "image/webp";
      outputName = replaceExtension(file.name, "webp");
    } else if (targetWidth < srcWidth || targetHeight < srcHeight || options.watermarkText) {
      // Re-encode to original format if resized or watermarked
      const targetType = originalType === "image/png" ? "image/png" : "image/jpeg";
      const fallbackBlob = await canvasToBlob(canvas, targetType, quality);
      if (fallbackBlob && fallbackBlob.size < originalBytes) {
        outputBlob = fallbackBlob;
      }
    }
  } else if (targetWidth < srcWidth || targetHeight < srcHeight || options.watermarkText) {
    // Mode is OFF, but image was resized or watermarked
    const targetType = originalType === "image/png" ? "image/png" : "image/jpeg";
    const resBlob = await canvasToBlob(canvas, targetType, quality);
    if (resBlob) outputBlob = resBlob;
  }

  // 7. Generate Thumbnail (max 640px WebP)
  let thumbBlob: Blob | undefined;
  if (genThumb) {
    thumbBlob = await generateThumbFromCanvas(canvas, thumbDim, thumbQuality);
  }

  return {
    blob: outputBlob,
    filename: outputName,
    contentType: outputType,
    width: targetWidth,
    height: targetHeight,
    originalBytes,
    outputBytes: outputBlob.size,
    thumbBlob,
    dominantColor
  };
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function replaceExtension(filename: string, newExt: string): string {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) return `${filename}.${newExt}`;
  return `${filename.substring(0, dotIndex)}.${newExt}`;
}

async function generateThumbFromImage(img: HTMLImageElement, maxDim: number, quality: number): Promise<Blob | undefined> {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return undefined;

  const scale = Math.min(1, maxDim / Math.max(w, h));
  const tw = Math.round(w * scale);
  const th = Math.round(h * scale);

  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.drawImage(img, 0, 0, tw, th);

  const blob = await canvasToBlob(canvas, "image/webp", quality);
  return blob || undefined;
}

async function generateThumbFromCanvas(srcCanvas: HTMLCanvasElement, maxDim: number, quality: number): Promise<Blob | undefined> {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const tw = Math.round(w * scale);
  const th = Math.round(h * scale);

  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.drawImage(srcCanvas, 0, 0, tw, th);

  const blob = await canvasToBlob(canvas, "image/webp", quality);
  return blob || undefined;
}

function sampleDominantColor(ctx: CanvasRenderingContext2D, width: number, height: number): string {
  const stepX = Math.max(1, Math.floor(width / 10));
  const stepY = Math.max(1, Math.floor(height / 10));
  const imgData = ctx.getImageData(0, 0, width, height).data;

  let rTotal = 0;
  let gTotal = 0;
  let bTotal = 0;
  let count = 0;

  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const idx = (y * width + x) * 4;
      const a = imgData[idx + 3];
      if (a > 128) {
        rTotal += imgData[idx];
        gTotal += imgData[idx + 1];
        bTotal += imgData[idx + 2];
        count++;
      }
    }
  }

  if (count === 0) return "#888888";
  const r = Math.round(rTotal / count).toString(16).padStart(2, "0");
  const g = Math.round(gTotal / count).toString(16).padStart(2, "0");
  const b = Math.round(bTotal / count).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
}

function drawWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  position: string
) {
  const fontSize = Math.max(12, Math.round(Math.min(width, height) * 0.035));
  ctx.save();
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;
  const padding = fontSize * 0.8;

  let x = width - textWidth - padding;
  let y = height - padding;

  if (position === "top-left") {
    x = padding;
    y = padding + fontSize;
  } else if (position === "top-right") {
    x = width - textWidth - padding;
    y = padding + fontSize;
  } else if (position === "center") {
    x = (width - textWidth) / 2;
    y = (height + fontSize) / 2;
  } else if (position === "bottom-left") {
    x = padding;
    y = height - padding;
  }

  ctx.fillText(text, x, y);
  ctx.restore();
}
