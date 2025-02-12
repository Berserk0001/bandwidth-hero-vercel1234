import sharp from 'sharp';
import redirect from './redirect.js';
import { URL } from 'url';
import sanitizeFilename from 'sanitize-filename';

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
        
        const { format, compressionQuality, grayscale } = getCompressionParams(req);
        const metadata = await sharp(input).metadata();
      
        if (!isValidMetadata(metadata)) {
            logError('Invalid or missing metadata.');
            return redirect(req, res);
        }
        
        const isAnimated = metadata.pages > 1;
        const outputFormat = isAnimated ? 'webp' : format;
        const avifParams = outputFormat === 'avif' ? optimizeAvifParams(metadata.width, metadata.height) : {};
        
        // Prepare the image:
        // Resize early so that subsequent processing, including artifact reduction,
        // is applied to a smaller image.
        let processedImage = prepareImage(input, grayscale, isAnimated, metadata);
        
        const formatOptions = getFormatOptions(outputFormat, compressionQuality, avifParams, isAnimated);
        
        processedImage
            .toFormat(outputFormat, formatOptions)
            .toBuffer({ resolveWithObject: true })
            .then(({ data, info }) => {
                sendImage(res, data, outputFormat, req.params.url || '', req.params.originSize || 0, info.size);
            })
            .catch((error) => {
                handleSharpError(error, res, processedImage, outputFormat, req, compressionQuality);
            });
    } catch (err) {
        logError('Error during image compression:', err);
        redirect(req, res);
    }
}

function getCompressionParams(req) {
    // Use AVIF if the request parameter "webp" is provided; otherwise default to JPEG.
    const format = req.params?.webp ? 'avif' : 'jpeg';
    const compressionQuality = Math.min(Math.max(parseInt(req.params?.quality, 10) || 75, 10), 100);
    const grayscale = req.params?.grayscale === 'true' || req.params?.grayscale === true;
    return { format, compressionQuality, grayscale };
}

function isValidMetadata(metadata) {
    return metadata && metadata.width && metadata.height;
}

function optimizeAvifParams(width, height) {
    // For AVIF, use settings based on the original image area.
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
        chromaSubsampling: '4:2:0',
        loop: isAnimated ? 0 : undefined,
    };
    if (outputFormat === 'avif') {
        return { ...options, ...avifParams };
    }
    return options;
}

/**
 * Prepares the image:
 * 1. Resizes the image early if it's larger than the maximum allowed dimensions.
 * 2. Applies grayscale if requested.
 * 3. Applies artifact reduction on the resized image.
 */
function prepareImage(input, grayscale, isAnimated, metadata) {
    // Create a sharp instance with animation support if needed.
    let processedImage = sharp(input, { animated: isAnimated });
    
    // Resize early: this reduces the number of pixels for subsequent processing.
    if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
        processedImage = processedImage.resize({
            width: Math.min(metadata.width, MAX_DIMENSION),
            height: Math.min(metadata.height, MAX_DIMENSION),
            fit: 'inside',
            withoutEnlargement: true,
        });
    }
    
    // Apply grayscale if requested.
    if (grayscale) {
        processedImage = processedImage.grayscale();
    }
    
    // Apply artifact reduction only if image is not animated.
    if (!isAnimated) {
        // Since the image has been resized, we recalculate a rough pixel count.
        const resizedWidth = Math.min(metadata.width, MAX_DIMENSION);
        const resizedHeight = Math.min(metadata.height, MAX_DIMENSION);
        const pixelCount = resizedWidth * resizedHeight;
        processedImage = applyArtifactReduction(processedImage, pixelCount);
    }
    
    return processedImage;
}

/**
 * Apply artifact reduction techniques:
 * - Adjust saturation
 * - Apply a slight blur
 * - Sharpen the image
 * - Correct gamma
 *
 * The parameters are chosen based on the (resized) pixel count.
 */
function applyArtifactReduction(sharpInstance, pixelCount) {
    // Determine settings based on pixel count.
    // Because the image is resized, these thresholds work on the new (smaller) image.
    const settings = pixelCount > LARGE_IMAGE_THRESHOLD
        ? { blur: 0.4, sharpen: 0.8, saturation: 0.85 }
        : pixelCount > MEDIUM_IMAGE_THRESHOLD
        ? { blur: 0.35, sharpen: 0.6, saturation: 0.9 }
        : { blur: 0.3, sharpen: 0.5, saturation: 0.95 };
    
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
    const filename = sanitizeFilename(new URL(url).pathname.split('/').pop() || 'image') + `.${format}`;
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
