/**
 * Import libraries
 */
const { RingApi } = require('ring-client-api');
const moment = require('moment');
const fs = require('fs');
const axios = require('axios');

const pollingIntival = 2 * 60 * 60 * 1000; // 2 hrs

async function ringLogin() {
  try {
    this.logger.trace(`${this._traceStack()} - Get access tokens`);
    const token = await this._getVaultSecret('Token');

    this.logger.trace(`${this._traceStack()} - Login`);
    const ringApi = new RingApi({
      refreshToken: token,
      cameraDingsPollingSeconds: 2,
      avoidSnapshotBatteryDrain: true,
    });

    ringApi.onRefreshTokenUpdated.subscribe(
      async ({ newRefreshToken, oldRefreshToken }) => {
        this.logger.debug(`${this._traceStack()} - Refresh token updated`);

        if (!oldRefreshToken) return;

        this.logger.trace(
          `${this._traceStack()} - Update vault with new token`,
        );
        this._updateVaultSecret.call(this, 'Token', newRefreshToken);
      },
    );

    return ringApi;
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
    return false;
  }
}

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

async function saveRecordings(camera) {
  this.logger.info('Save recordings from device');

  let eventsWithRecordings;
  try {
    this.logger.trace(`${this._traceStack()} - Get events from device`);
    const eventsResponse = await camera.getEvents({});

    this.logger.trace(`${this._traceStack()} - Filter for last 2 hours`);
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

  // eslint-disable-next-line no-restricted-syntax
  await Promise.all(
    eventsWithRecordings.map(async (eventWithRecording) => {
      this.logger.trace(`${this._traceStack()} - Get recording url`);
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
        return;
      }

      const month = moment().format('M');
      let folderPath = `media/${month}`;
      try {
        fs.mkdirSync(folderPath);
      } catch (err) {
        if (!err.message.includes('EEXIST: file already exists')) {
          this.logger.error(`${this._traceStack()} - ${err}`);
          return;
        }
      }
      folderPath += `/${eventWithRecording.created_at}-${eventWithRecording.ding_id_str}.mp4`;

      if (fs.existsSync(folderPath)) {
        this.logger.trace(`${this._traceStack()} - Recording already exists`);
        return;
      }

      try {
        this.logger.trace(
          `${this._traceStack()} - Download and save recording`,
        );
        await downloadFile.call(this, transcodedUrl, folderPath);
        this.logger.info(
          `Saved file: ${eventWithRecording.created_at}-${eventWithRecording.ding_id_str}.mp4`,
        );
      } catch (err) {
        this.logger.error(`${this._traceStack()} - ${err}`);
      }

      let dbConnection;
      try {
        this.logger.trace(`${this._traceStack()} - Getting data from device`);
        const deviceJSON = {
          time: new Date(),
          path: folderPath,
        };
        this.logger.trace(
          `${this._traceStack()} - Saving recording data to db`,
        );
        dbConnection = await this._connectToDB();
        this.logger.trace(`${this._traceStack()} - Insert data`);
        const results = await dbConnection
          .db(this.namespace)
          .collection('recordings')
          .insertOne(deviceJSON);

        if (results.insertedCount === 1)
          this.logger.info('Saved recording data to DB');
        else
          this.logger.error(
            `${this._traceStack()} - Failed to save recording data`,
          );
      } catch (err) {
        this.logger.error(`${this._traceStack()} - ${err}`);
      } finally {
        this.logger.trace(`${this._traceStack()} - Close DB connection`);
        await dbConnection.close();
      }
    }),
  );

  this.logger.debug(`${this._traceStack()} - Finished processing recordings`);
}

async function saveBatteryData(data) {
  let dbConnection;
  let deviceJSON = {};

  try {
    this.logger.trace(`${this._traceStack()} - Getting data from device`);
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
    this.logger.trace(
      `${this._traceStack()} - Saving data: ${deviceJSON.location}`,
    );
    dbConnection = await this._connectToDB();
    this.logger.trace(`${this._traceStack()} - Insert data`);
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
    this.logger.trace(`${this._traceStack()} - Close DB connection`);
    await dbConnection.close();
  }

  return true;
}

async function _subscribeToRingEvents() {
  try {
    const ringApi = await ringLogin.call(this);

    this.logger.trace(`${this._traceStack()} - Get devices`);
    const cameras = await ringApi.getCameras();
    if (cameras.length) {
      this.logger.trace(`${this._traceStack()} - Found devices`);
    } else {
      this.logger.trace(`${this._traceStack()} - No devices found`);
      this._fatal(true);
      return;
    }

    // Doorbell
    const camera = cameras.find(
      (device) => device.initialData.kind === 'doorbell_scallop',
    );

    if (typeof camera === 'undefined' || camera === null) {
      this.logger.trace(`${this._traceStack()} - No doorbell device found`);
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
