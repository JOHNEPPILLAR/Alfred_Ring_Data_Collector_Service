/**
 * Import libraries
 */
const moment = require('moment');
const debug = require('debug')('Ring:DataCollector');
const fs = require('fs');
const axios = require('axios');
const { _healthData } = require('../../helpers/ring');

const pollingIntival = 2 * 60 * 60 * 1000; // 2 hrs

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
 * Save camera health data
 */
async function saveCameraHealthData(data) {
  // eslint-disable-next-line no-param-reassign
  data.time = new Date();

  debug(`[${data.id}] Saving data`);
  const dbConnection = await this._connectToDB();
  const results = await dbConnection
    .db(this.namespace)
    .collection(this.namespace)
    .insertOne(data);

  if (results.insertedCount === 1)
    this.logger.info(`[${data.id}] Saved camera health data`);
  else
    this.logger.error(
      `${this._traceStack()} - [${data.id}] Failed to save camera health data`,
    );

  debug(`Close DB connection`);
  await dbConnection.close();
}

async function getData(camera) {
  await saveRecordings.call(this, camera);
  const cameraHealthData = await _healthData(camera);
  await saveCameraHealthData.call(this, cameraHealthData);
}

/**
 * Subscribe to ring events
 */
async function _subscribeToRingEvents() {
  try {
    // Get door bell device
    const camera = await this._getDoorBellDevice.call(this);
    if (camera instanceof Error) throw camera;

    // Save data
    await getData.call(this, camera);

    // Setup intival to save data
    this.saveRecordingsInterval = setInterval(async () => {
      await getData.call(this, camera);
    }, pollingIntival);
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  }
}

module.exports = {
  _subscribeToRingEvents,
};
