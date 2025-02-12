import sharp from 'sharp';
import redirect from './redirect.js';
import { URL } from 'url';
import sanitizeFilename from 'sanitize-filename';

const MAX_DIMENSION = 16384;

/**
 * Compress an image based on request parameters and stream the output.
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
        // For animated images, fallback to webp; otherwise use the requested format.
        const outputFormat = 'webp';
        const avifParams = outputFormat === 'avif' ? optimizeAvifParams(metadata.width, metadata.height) : {};

        // Prepare the image (resize early & apply grayscale if requested).
        let processedImage = prepareImage(input, grayscale, isAnimated, metadata);
        const formatOptions = getFormatOptions(outputFormat, compressionQuality, avifParams, isAnimated);

        // Create a transform stream that converts the image to the desired format.
        const transformStream = processedImage.toFormat(outputFormat, formatOptions);

        // Build a sanitized filename from the provided URL parameter.
        const parsedUrl = new URL(req.params.url || 'http://example.com/image');
        const filename = sanitizeFilename(parsedUrl.pathname.split('/').pop() || 'image') + `.${outputFormat}`;

        // Set response headers.
        res.setHeader('Content-Type', `image/${outputFormat}`);
        // Note: Content-Length is omitted because the size is not known in advance.
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // Optionally, pass along the original size if known.
        res.setHeader('x-original-size', req.params.originSize || 0);

        // Handle any errors from the transform stream.
        transformStream.on('error', (error) => {
            handleSharpError(error, res, processedImage, outputFormat, req, compressionQuality);
        });

        // Pipe the processed image stream directly to the HTTP response.
        transformStream.pipe(res);
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

function optimizeAvifParams(width, height) {
    // Use minimal tiling and an effort of 0 for faster encoding.
    return { tileRows: 1, tileCols: 1, minQuantizer: 30, maxQuantizer: 50, effort: 0 };
}

function getFormatOptions(outputFormat, quality, avifParams, isAnimated) {
    const options = {
        quality,
        alphaQuality: 80,
        chromaSubsampling: '4:2:0',
        loop: isAnimated ? 0 : undefined,
    };
    return outputFormat === 'avif' ? { ...options, ...avifParams } : options;
}

function prepareImage(input, grayscale, isAnimated, metadata) {
    let processedImage = sharp(input, { animated: isAnimated });

    // Resize early to reduce processing overhead.
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
    // Apply a slight sharpening filter if the image is not animated.
    if (!isAnimated) {
        processedImage = processedImage.sharpen(0.5);
    }

    // Skipped artifact reduction for faster processing.
    return processedImage;
}

function handleSharpError(error, res, sharpInstance, outputFormat, req, quality) {
    logError('Unhandled sharp error:', error);
    redirect(req, res);
}

function logError(message, error = null) {
    console.error({ message, error: error?.message || null });
}

export default compress;
