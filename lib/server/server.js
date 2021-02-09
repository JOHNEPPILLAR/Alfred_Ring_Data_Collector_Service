/**
 * Import external libraries
 */
const { Service } = require('alfred-base');
const debug = require('debug')('Ring:Server');

// Setup service options
const { version } = require('../../package.json');
const serviceName = require('../../package.json').description;
const namespace = require('../../package.json').name;

const options = {
  serviceName,
  namespace,
  serviceVersion: version,
};

// Bind helper functions to base class
Object.assign(Service.prototype, require('../helpers/ring'));

// Bind data collector functions to base class
Object.assign(Service.prototype, require('../collectors/ring/ring'));

// Bind api functions to base class
Object.assign(Service.prototype, require('../api/doorbell'));

// Create base service
const service = new Service(options);

async function setupServer() {
  // Setup service
  await service.createRestifyServer();

  // Apply api routes
  service.restifyServer.get('/image', (req, res, next) =>
    service._getLatestImage(req, res, next),
  );
  debug(`Added get '/image' api`);

  if (process.env.MOCK === 'true') {
    this.logger.info('Mocking enabled, will not monitor Ring events');
  } else {
    await service._subscribeToRingEvents(); // Subscripbe to ring device events
  }

  // Listen for api requests
  service.listen();
}
setupServer();
