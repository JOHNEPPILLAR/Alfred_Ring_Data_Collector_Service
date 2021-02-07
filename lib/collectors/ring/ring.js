/**
 * Import libraries
 */
const { RingApi } = require('ring-client-api');
const moment = require('moment');
const debug = require('debug')('Ring:DataCollector');
const fs = require('fs');
const axios = require('axios');

const pollingIntival = 2 * 60 * 60 * 1000; // 2 hrs

/**
 * Login to ring
 */
async function ringLogin() {
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
 * Download file
 */
async function downloadFile(fileUrl, outputLocationPath) {
  return axios({
    method: 'get',
    url: fileUrl,
    responseType: 'stream',
  }).then((response) => {
    const writer = fs.createWriteStream(`${outputLocationPath}`);
    return new Promise((resolve, reject) => {
      response.data.pipe(writer);
      let error = null;
      writer.on('error', (err) => {
        error = err;
        writer.close();
        reject(err);
      });
      writer.on('close', () => {
        if (!error) {
          resolve(true);
        }
      });
    });
  });
}

/**
 * Save recordings
 */
async function saveRecordings(camera) {
  this.logger.info('Save recordings from device');

  debug('Get events from device');
  const eventsResponse = await camera.getEvents({});

  debug('Filter for last 2 hours');
  const last2Hours = moment().utc().subtract(2, 'hour');
  const eventsWithRecordings = eventsResponse.events.filter(
    (event) =>
      event.recording_status === 'ready' &&
      moment(event.created_at).utc().isAfter(last2Hours),
  );

  if (!eventsWithRecordings.length) {
    this.logger.info('No events to process');
    return;
  }

  // eslint-disable-next-line no-restricted-syntax
  await Promise.all(
    eventsWithRecordings.map(async (eventWithRecording) => {
      debug('Ensure month folder exists');
      const month = moment().format('M');
      const year = moment().format('YYYY');
      const folderPath = `media/ring/${year}/${month}`;
      try {
        fs.mkdirSync(folderPath, { recursive: true });
      } catch (err) {
        if (!err.message.includes('EEXIST: file already exists')) throw err;
      }

      debug('Check if file exists');
      const fullFilePath = `${folderPath}/${eventWithRecording.created_at}_${eventWithRecording.ding_id_str}.mp4`;
      if (fs.existsSync(fullFilePath)) {
        debug('Recording already exists');
        return;
      }

      debug('Get recording url');
      const transcodedUrl = await camera.getRecordingUrl(
        eventWithRecording.ding_id_str,
        {
          transcoded: true, // Transcoded has ring log and timestamp
        },
      );

      debug('Download and save recording');
      await downloadFile.call(this, transcodedUrl, fullFilePath);
      this.logger.info(`Saved file: ${fullFilePath}`);
    }),
  );
}

/**
 * Save battery data
 */
async function saveBatteryData(data) {
  let deviceJSON = {};

  debug('Getting data from device');
  deviceJSON = {
    time: new Date(),
    device: this.deviceID,
    location: this.deviceDescription,
    battery: data,
  };

  debug(`Saving data: ${deviceJSON.location}`);
  const dbConnection = await this._connectToDB();
  const results = await dbConnection
    .db(this.namespace)
    .collection(this.namespace)
    .insertOne(deviceJSON);

  if (results.insertedCount === 1)
    this.logger.info(`Saved battery data: ${deviceJSON.location}`);
  else
    this.logger.error(
      `${this._traceStack()} - Failed to save data: ${deviceJSON.description}`,
    );

  debug(`Close DB connection`);
  await dbConnection.close();
}

/**
 * Subscribe to ring events
 */
async function _subscribeToRingEvents() {
  try {
    const ringApi = await ringLogin.call(this);
    debug('Get devices');
    const cameras = await ringApi.getCameras();
    if (cameras.length) {
      debug('Found devices');
    } else {
      debug('No devices found');
      this._fatal(true);
      return;
    }

    // Doorbell
    const camera = cameras.find(
      (device) => device.initialData.kind === 'doorbell_scallop',
    );

    if (typeof camera === 'undefined' || camera === null) {
      debug('No doorbell device found');
      this._fatal(true);
      return;
    }

    camera.onData.subscribe((data) => {
      this.deviceID = data.id;
      this.deviceDescription = data.description;
    });

    camera.onBatteryLevel.subscribe((data) => {
      try {
        saveBatteryData.call(this, data);
      } catch (err) {
        debug(err);
      }
    });

    await saveRecordings.call(this, camera);
    this.saveRecordingsInterval = setInterval(async () => {
      await saveRecordings.call(this, camera);
    }, pollingIntival);
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err}`);
  }
}

module.exports = {
  _subscribeToRingEvents,
};
