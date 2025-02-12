import sharp from 'sharp';
import redirect from './redirect.js';
import { URL } from 'url';
import sanitizeFilename from 'sanitize-filename';

const MAX_DIMENSION = 16384;

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
        // Use a temporary sharp instance to get metadata
        const metadata = await sharp(input).metadata();
      
        if (!isValidMetadata(metadata)) {
            logError('Invalid or missing metadata.');
            return redirect(req, res);
        }

        const isAnimated = metadata.pages > 1;
        // Use webp for animated images, else the requested format.
        const outputFormat = isAnimated ? 'webp' : format;
        // For AVIF, use faster encoding parameters.
        const avifParams = outputFormat === 'avif' ? optimizeAvifParams(metadata.width, metadata.height) : {};

        // Prepare the image: resize early and apply grayscale if requested.
        let processedImage = prepareImage(input, grayscale, isAnimated, metadata);

        const formatOptions = getFormatOptions(outputFormat, compressionQuality, avifParams, isAnimated);
        
        processedImage.toFormat(outputFormat, formatOptions)
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
    const format = req.params?.webp ? 'avif' : 'jpeg';
    const compressionQuality = Math.min(Math.max(parseInt(req.params?.quality, 10) || 75, 10), 100);
    const grayscale = req.params?.grayscale === 'true' || req.params?.grayscale === true;

    return { format, compressionQuality, grayscale };
}

function isValidMetadata(metadata) {
    return metadata && metadata.width && metadata.height;
}

// For faster AVIF encoding, we set effort to 0.
function optimizeAvifParams(width, height) {
    return { tileRows: 1, tileCols: 1, minQuantizer: 30, maxQuantizer: 50, effort: 0 };
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

// Resize early to reduce processing load and skip extra artifact reduction.
function prepareImage(input, grayscale, isAnimated, metadata) {
    let processedImage = sharp(input, { animated: isAnimated });
    
    // Resize early if the image is too large.
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
    
    // Note: The artifact reduction (blur, denoise, sharpen, gamma) has been removed
    // to speed up processing.
    
    return processedImage;
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
