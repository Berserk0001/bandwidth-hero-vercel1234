const sharp = require('sharp');
const redirect = require('./redirect');

function compress(req, res, input) {
  const format = 'webp';

  sharp(input)
    .grayscale(req.params.grayscale)
    .toFormat(format, {
      quality: req.params.quality,
      progressive: true,
      optimizeScans: true,
      effort:0
    })
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {

      res.setHeader('content-type', `image/${format}`);
      res.setHeader('content-length', info.size);
      res.setHeader('x-original-size', req.params.originSize);
      res.setHeader('x-bytes-saved', req.params.originSize - info.size);
      res.status(200).send(data);
    });
}

module.exports = compress;
