/**
 * Import external libraries
 */
const debug = require('debug')('Ring:DoorBell');

/**
 * @type get
 * @path /image
 */
async function _getLatestImage(req, res, next) {
  debug(`Display doorbell image API called`);

  try {
    const camera = await this._getDoorBellDevice.call(this);
    if (camera instanceof Error) throw camera;

    debug('Get latest image from doorbell camera');
    const image = await camera.getSnapshot();

    debug('Send image back to caller');
    res.sendRaw(image);
    next();
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
    this._sendResponse(res, next, 500, err);
  }
  next();
}

/**
 * @type get
 * @path /health
 */
async function _getHealth(req, res, next) {
  debug(`Display doorbell health data API called`);

  const healthData = await this._healthData();
  this._sendResponse(res, next, 200, healthData);
}

module.exports = {
  _getLatestImage,
  _getHealth,
};
