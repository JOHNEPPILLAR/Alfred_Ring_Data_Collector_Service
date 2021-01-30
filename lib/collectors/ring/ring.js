/**
 * Import libraries
 */
const { RingApi } = require('ring-client-api');
const moment = require('moment');
const debug = require('debug')('Ring:DataCollector');

const pollingIntival = 2 * 60 * 60 * 1000; // 2 hrs

/**
 * Login to ring
 */
async function ringLogin() {
  try {
    debug('Get access tokens');
    const token = await this._getVaultSecret('Token');

    debug('Login');
    const ringApi = new RingApi({
      refreshToken: token,
      cameraDingsPollingSeconds: 2,
      avoidSnapshotBatteryDrain: true,
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
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
    return false;
  }
}

/**
 * Save recordings
 */
async function saveRecordings(camera) {
  this.logger.info('Save recordings from device');

  let eventsWithRecordings;
  try {
    debug('Get events from device');
    const eventsResponse = await camera.getEvents({});

    debug('Filter for last 2 hours');
    const last2Hours = moment().utc().subtract(2, 'hour');
    eventsWithRecordings = eventsResponse.events.filter(
      (event) =>
        event.recording_status === 'ready' &&
        moment(event.created_at).utc().isAfter(last2Hours),
    );
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err}`);
    return;
  }

  if (!eventsWithRecordings.length) {
    this.logger.info('No events to process');
    return;
  }

  debug('Connect to DB');
  const dbConnection = await this._connectToDB();

  // eslint-disable-next-line no-restricted-syntax
  await Promise.all(
    eventsWithRecordings.map(async (eventWithRecording) => {
      debug('Check if recording exists');
      const fileName = `${eventWithRecording.created_at}-${eventWithRecording.ding_id_str}.mp4`;

      const query = {
        filename: fileName,
      };
      const results = await dbConnection
        .db(this.namespace)
        .collection(`media.files`)
        .find(query)
        .toArray();

      if (results.length > 0) {
        // Exit function event already is saved
        debug('Media event already saved in DB');
        return false;
      }

      debug('Get recording url');
      let transcodedUrl;
      try {
        transcodedUrl = await camera.getRecordingUrl(
          eventWithRecording.ding_id_str,
          {
            transcoded: true, // Transcoded has ring log and timestamp
          },
        );
      } catch (err) {
        this.logger.error(`${this._traceStack()} - ${err}`);
        return true;
      }

      debug('Save video file');
      await this._saveStreamToDB(
        dbConnection,
        'media',
        fileName,
        transcodedUrl,
      );

      this.logger.info(`Saved motion event to db - ${fileName}`);
      return true;
    }),
  );

  debug(`Close DB connection`);
  await dbConnection.close();
}

/**
 * Save battery data
 */
async function saveBatteryData(data) {
  let dbConnection;
  let deviceJSON = {};

  try {
    debug('Getting data from device');
    deviceJSON = {
      time: new Date(),
      device: this.deviceID,
      location: this.deviceDescription,
      battery: data,
    };
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
    return false;
  }

  try {
    debug(`Saving data: ${deviceJSON.location}`);
    dbConnection = await this._connectToDB();
    const results = await dbConnection
      .db(this.namespace)
      .collection(this.namespace)
      .insertOne(deviceJSON);

    if (results.insertedCount === 1)
      this.logger.info(`Saved battery data: ${deviceJSON.location}`);
    else
      this.logger.error(
        `${this._traceStack()} - Failed to save data: ${
          deviceJSON.description
        }`,
      );
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  } finally {
    debug('Close DB connection');
    await dbConnection.close();
  }

  return true;
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
      saveBatteryData.call(this, data);
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
