/**
 * MIT License
 *
 * Copyright (c) 2018 Simo Ahava
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const {URL} = require(`url`);
const fs = require(`fs`);
const {promisify} = require(`util`);

const uuidv1 = require(`uuid/v1`);
const {Validator} = require(`jsonschema`);

const {BigQuery} = require(`@google-cloud/bigquery`);
const {PubSub} = require(`@google-cloud/pubsub`);
const {Storage} = require(`@google-cloud/storage`);
const {google} = require(`googleapis`);

const bqSchema = require(`./bigquery-schema.json`);
const config = require(`./config.json`);
const configSchema = require(`./config.schema.json`);

API_KEY = config.auth || ""
const PageSpeed = google.pagespeedonline({version: 'v5',
                                          auth: API_KEY});
// Make filesystem write work with async/await
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);

// Initialize new GC clients
const bigquery = new BigQuery({
  projectId: config.projectId
});
const pubsub = new PubSub({
  projectId: config.projectId
});
const storage = new Storage({
  projectId: config.projectId
});

const validator = new Validator;

const log = console.log;

/**
 * Function that runs PageSpeed Insights API.
 *
 * @param {string} id ID of the source for logging purposes.
 * @param {string} url URL to audit.
 * @param {string} strategy device type to obtain report for.
 * @param {string} category Lighthouse audit categories to run.
 * @returns {Promise<object>} The object containing the Pagespeed Insight report.
 */
async function getPagespeedInsightsReport(id, url, strategy, category) {

  log(`${id}: Requesting Pagespeed Insight report for ${url} on ${strategy}`);

  category = category || []
  const psi = await PageSpeed.pagespeedapi.runpagespeed({url: url,
                                                         strategy: strategy,
                                                         category: category});
  psi.id = id
  psi.url = url
  psi.emulatedFormFactor = strategy
  log(`${id}: Pagespeed Insight report received for ${url} on ${strategy}`);

  return psi;
}

/**
 * Converts input object to newline-delimited JSON
 *
 * @param {object} data Object to convert.
 * @returns {string} The stringified object.
 */
function toNdjson(data) {
  data = Array.isArray(data) ? data : [data];
  let outNdjson = '';
  data.forEach(item => {
    outNdjson += JSON.stringify(item) + '\n';
  });
  return outNdjson;
}

/**
 * Publishes a message to the Pub/Sub topic for every ID in config.json source object.
 *
 * @param {array<string>} ids Array of ids to publish into Pub/Sub.
 * @returns {Promise<any[]>} Resolved promise when all IDs have been published.
 */
async function sendAllPubsubMsgs(ids) {
  return await Promise.all(ids.map(async (id) => {
    const msg = Buffer.from(id);
    log(`${id}: Sending init PubSub message`);
    await pubsub
      .topic(config.pubsubTopicId)
      .publisher()
      .publish(msg);
    log(`${id}: Init PubSub message sent`)
  }));
}

/**
 * Write the psi log object and reports to GCS. Only write reports if config.outputFormat is defined in config.json.
 *
 * @param {object} obj The Pagespeed Insight report object.
 * @param {string} id ID of the source.
 * @returns {Promise<void>} Resolved promise when all write operations are complete.
 */
async function writeLogAndReportsToStorage(obj, id) {
  const bucket = storage.bucket(config.gcs.bucketName);
  config.outputFormat = config.outputFormat || [];
  await Promise.all(config.outputFormat.map(async (fileType) => {
    let filePath = `${id}/${obj.emulatedFormFactor}/report_${obj.analysisUTCTimestamp}`;
    let mimetype;
    let output;
    switch (fileType) {
      case 'csv':
        // TODO: add function to format json obj a csv report
        break;
      case 'json':
        mimetype = 'application/json';
        filePath += '.json';
        output = true;
      default:
        // TODO: add function to format json obj into an HTML report
        break;
      }
      if (output === true) {
        const file = bucket.file(filePath);
        log(`${id}: Writing ${fileType} report to bucket ${config.gcs.bucketName}`);
        return await file.save(obj, {
          metadata: {contentType: mimetype}
      });
    }
  }));
  const file = bucket.file(`${id}/${obj.emulatedFormFactor}/log_${obj.analysisUTCTimestamp}.json`);
  log(`${id}: Writing log to bucket ${config.gcs.bucketName}`);
  return await file.save(JSON.stringify(obj, null, " "), {
    metadata: {contentType: 'application/json'}
  });
}

/**
 * Check events in GCS states.json to see if an event with given ID has been pushed to Pub/Sub less than
 * minTimeBetweenTriggers (in config.json) ago.
 *
 * @param {string} id ID of the source (and the Pub/Sub message).
 * @param {number} timeNow Timestamp when this method was invoked.
 * @returns {Promise<object>} Object describing active state and time delta between invocation and when the state entry was created, if necessary.
 */
async function checkEventState(id, strategy, timeNow) {
  let eventStates = {};
  try {
    // Try to load existing state file from storage
    const destination = `/tmp/state_${id}_${strategy}.json`;
    await storage
      .bucket(config.gcs.bucketName)
      .file(`${id}/${strategy}/state.json`)
      .download({destination: destination});
    eventStates = JSON.parse(await readFile(destination));
  } catch(e) {}

  // Check if event corresponding to id has been triggered less than the timeout ago
  const delta = id in eventStates && (timeNow - eventStates[id].created);
  if (delta && delta < config.minTimeBetweenTriggers) {
    return {active: true, delta: Math.round(delta/1000)}
  }

  // Otherwise write the state of the event with current timestamp and save to bucket
  eventStates[id] = {created: timeNow};
  await storage.bucket(config.gcs.bucketName).file(`${id}/${strategy}/state.json`).save(JSON.stringify(eventStates, null, " "), {
    metadata: {contentType: 'application/json'}
  });
  return {active: false}
}

/**
 * The Cloud Function. Triggers on a Pub/Sub trigger, audits the URLs in config.json, writes the result in GCS and loads the data into BigQuery.
 *
 * @param {object} event Trigger object.
 * @param {function} callback Callback function (not provided).
 * @returns {Promise<*>} Promise when BigQuery load starts.
 */
async function launchPagespeedInsights (event, callback) {
  try {

    const source = config.source;
    const msg = Buffer.from(event.data, 'base64').toString();
    const ids = source.map(obj => obj.id);
    const uuid = uuidv1();
    const metadata = {
      sourceFormat: 'NEWLINE_DELIMITED_JSON',
      schema: {fields: bqSchema},
      jobId: uuid
    };

    // If the Pub/Sub message is not valid
    if (msg !== 'all' && !ids.includes(msg)) { return console.error('No valid message found!'); }

    if (msg === 'all') { return sendAllPubsubMsgs(ids); }

    const [src] = source.filter(obj => obj.id === msg);
    const id = src.id;
    const url = src.url;
    const device = src.strategy
    const category = src.category

    log(`${id}: Received message to start with URL ${url} on ${device}`);

    const timeNow = new Date().getTime();
    const eventState = await checkEventState(id, device, timeNow);
    if (eventState.active) {
      return log(`${id}: Found active event on ${device} (${Math.round(eventState.delta)}s < ${Math.round(config.minTimeBetweenTriggers/1000)}s), aborting...`);
    }

    const json = await getPagespeedInsightsReport(id, device, url);

    await writeLogAndReportsToStorage(json, id);

    json.job_id = uuid;

    await writeFile(`/tmp/${uuid}.json`, toNdjson(json));

    log(`${id}: BigQuery job with ID ${uuid} starting for ${url} on ${device}`);

    return bigquery
      .dataset(config.datasetId)
      .table('reports')
      .load(`/tmp/${uuid}.json`, metadata);

  } catch(e) {
    console.error(e);
  }
}

/**
 * Initialization function - only run when Cloud Function is deployed and/or a new instance is started. Validates the configuration file against its schema.
 */
function init() {
  // Validate config schema
  const result = validator.validate(config, configSchema);
  if (result.errors.length) {
    throw new Error(`Error(s) in configuration file: ${JSON.stringify(result.errors, null, " ")}`);
  } else {
    log(`Configuration validated successfully`);
  }
}

if (process.env.NODE_ENV !== 'test') {
  init();
} else {
  // For testing
  module.exports = {
    _init: init,
    _writeLogAndReportsToStorage: writeLogAndReportsToStorage,
    _sendAllPubSubMsgs: sendAllPubsubMsgs,
    _toNdJson: toNdjson,
    _launchPagespeedInsights: launchPagespeedInsights,
    _checkEventState: checkEventState,
    _getPagespeedInsightsReport: getPagespeedInsightsReport
  }
}

module.exports.launchPagespeedInsights = launchPagespeedInsights;
