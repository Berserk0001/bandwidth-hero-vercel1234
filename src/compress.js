import sharp from 'sharp';
import redirect from './redirect.js';
import { URL } from 'url';
import sanitizeFilename from 'sanitize-filename';
import os from 'os';

// Configure sharp to use all CPU cores and enable a larger cache.
sharp.concurrency(os.cpus().length);
sharp.cache({ items: 500, memory: 200, files: 0 });

const MAX_DIMENSION = 16384;
const LARGE_IMAGE_THRESHOLD = 4000000;
const MEDIUM_IMAGE_THRESHOLD = 1000000;

/**
 * Compress an image based on request parameters.
 * @param {Request} req - Express request object.
 * @param {Response} res - Express response object.
 * @param {Buffer|string} input - Input image buffer or file path.
 */
async function compress(req, res, input) {
  try {
    if (!Buffer.isBuffer(input) && typeof input !== 'string') {
      logError('Invalid input: must be a Buffer or file path.');
      return redirect(req, res);
    }
    
    // Get compression parameters (including a "fast" flag)
    const { format, compressionQuality, grayscale, fastMode } = getCompressionParams(req);

    // Obtain metadata
    const sharpInstance = sharp(input);
    const metadata = await sharpInstance.metadata();
  
    if (!isValidMetadata(metadata)) {
      logError('Invalid or missing metadata.');
      return redirect(req, res);
    }

    const isAnimated = metadata.pages > 1;
    const pixelCount = metadata.width * metadata.height;
    const outputFormat = isAnimated ? 'webp' : format;

    // If AVIF is requested and not animated, use lower effort in fast mode.
    const avifParams =
      outputFormat === 'avif'
        ? optimizeAvifParams(metadata.width, metadata.height, fastMode)
        : {};

    // Prepare image pipeline; skip heavy artifact reduction in fast mode.
    let processedImage = prepareImage(input, grayscale, isAnimated, metadata, pixelCount, fastMode);

    const formatOptions = getFormatOptions(outputFormat, compressionQuality, avifParams, isAnimated);
    
    // Await the full pipeline rather than using .then()
    const { data, info } = await processedImage
      .toFormat(outputFormat, formatOptions)
      .toBuffer({ resolveWithObject: true });
      
    sendImage(res, data, outputFormat, req.params.url || '', req.params.originSize || 0, info.size);
  } catch (error) {
    handleSharpError(error, res, null, null, req, null);
  }
}

function getCompressionParams(req) {
  const format = req.params?.webp ? 'avif' : 'jpeg';
  const compressionQuality = Math.min(Math.max(parseInt(req.params?.quality, 10) || 75, 10), 100);
  const grayscale = req.params?.grayscale === 'true' || req.params?.grayscale === true;
  // Enable fast mode when the 'fast' parameter is provided.
  const fastMode = req.params?.fast === 'true' || req.params?.fast === true;
  return { format, compressionQuality, grayscale, fastMode };
}

function isValidMetadata(metadata) {
  return metadata && metadata.width && metadata.height;
}

function optimizeAvifParams(width, height, fastMode) {
  if (fastMode) {
    // Use lower AVIF encoding effort to speed up processing
    return { tileRows: 1, tileCols: 1, minQuantizer: 30, maxQuantizer: 50, effort: 0 };
  }
  const area = width * height;
  if (area > LARGE_IMAGE_THRESHOLD) {
    return { tileRows: 4, tileCols: 4, minQuantizer: 30, maxQuantizer: 50, effort: 3 };
  } else if (area > MEDIUM_IMAGE_THRESHOLD) {
    return { tileRows: 2, tileCols: 2, minQuantizer: 28, maxQuantizer: 48, effort: 4 };
  } else {
    return { tileRows: 1, tileCols: 1, minQuantizer: 26, maxQuantizer: 46, effort: 5 };
  }
}

function getFormatOptions(outputFormat, quality, avifParams, isAnimated) {
  const options = {
    quality,
    alphaQuality: 80,
    // smartSubsample: true,
    chromaSubsampling: '4:2:0',
    loop: isAnimated ? 0 : undefined,
  };
  if (outputFormat === 'avif') {
    return { ...options, ...avifParams };
  }
  return options;
}

function prepareImage(input, grayscale, isAnimated, metadata, pixelCount, fastMode) {
  let processedImage = sharp(input, { animated: isAnimated });
  if (grayscale) processedImage = processedImage.grayscale();
  
  // Apply artifact reduction only when not in fast mode.
  if (!isAnimated && !fastMode) {
    processedImage = applyArtifactReduction(processedImage, pixelCount);
  }

  // Resize only if dimensions exceed the maximum.
  if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
    processedImage = processedImage.resize({
      width: Math.min(metadata.width, MAX_DIMENSION),
      height: Math.min(metadata.height, MAX_DIMENSION),
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  return processedImage;
}

function applyArtifactReduction(sharpInstance, pixelCount) {
  const settings =
    pixelCount > LARGE_IMAGE_THRESHOLD
      ? { blur: 0.4, denoise: 0.15, sharpen: 0.8, saturation: 0.85 }
      : pixelCount > MEDIUM_IMAGE_THRESHOLD
      ? { blur: 0.35, denoise: 0.12, sharpen: 0.6, saturation: 0.9 }
      : { blur: 0.3, denoise: 0.1, sharpen: 0.5, saturation: 0.95 };
  return sharpInstance
    .modulate({ saturation: settings.saturation })
    .blur(settings.blur)
    .sharpen(settings.sharpen)
    .gamma();
}

function handleSharpError(error, res, sharpInstance, outputFormat, req, quality) {
  logError('Unhandled sharp error:', error);
  redirect(req, res);
}

function sendImage(res, data, format, url, originSize, compressedSize) {
  const filename =
    sanitizeFilename(new URL(url).pathname.split('/').pop() || 'image') + `.${format}`;
  res.setHeader('Content-Type', `image/${format}`);
  res.setHeader('Content-Length', data.length);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('x-original-size', originSize);
  res.setHeader('x-bytes-saved', Math.max(originSize - compressedSize, 0));
  res.status(200).end(data);
}

function logError(message, error = null) {
  console.error({ message, error: error?.message || null });
}

export default compress;
