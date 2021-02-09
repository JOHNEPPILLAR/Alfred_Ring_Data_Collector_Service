/**
 * Import libraries
 */
const { RingApi } = require('ring-client-api');
const debug = require('debug')('Ring:Helper');

/**
 * Login to ring
 */
async function _ringLogin() {
  debug('Get access tokens');
  const token = await this._getVaultSecret('Token');

  debug('Login');
  const ringApi = new RingApi({
    refreshToken: token,
    cameraDingsPollingSeconds: 2,
    avoidSnapshotBatteryDrain: false,
  });

  ringApi.onRefreshTokenUpdated.subscribe(
    async ({ newRefreshToken, oldRefreshToken }) => {
      debug('Refresh token updated');
      if (!oldRefreshToken) return;
      debug('Update vault with new token');
      this._updateVaultSecret.call(this, 'Token', newRefreshToken);
    },
  );

  return ringApi;
}

/**
 * Get doorbell device
 */
async function _getDoorBellDevice() {
  // Login
  const ringApi = await this._ringLogin.call(this);

  const noDeviceErr = new Error('Not able to find doorbell device');

  debug('Get camera devices');
  const cameras = await ringApi.getCameras();
  if (cameras.length) {
    debug('Found camera devices');
  } else {
    debug('No camera devices found');
    return noDeviceErr;
  }

  // Filter for Doorbell
  const camera = cameras.find(
    (device) => device.initialData.kind === 'doorbell_scallop',
  );

  if (typeof camera === 'undefined' || camera === null) {
    debug('No doorbell device found');
    return noDeviceErr;
  }
  return camera;
}

/**
 * Get camera heath data
 */
async function _healthData(device) {
  const cameraHealthData = await device.getHealth();
  return cameraHealthData;
}

module.exports = {
  _ringLogin,
  _getDoorBellDevice,
  _healthData,
};
