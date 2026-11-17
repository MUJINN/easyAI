const https = require('node:https');
const EventEmitter = require('node:events');
const { Readable } = require('node:stream');

const catalogs = {
  'api.kilo.ai': { data: [{ id: 'kilo-test-model' }] },
  'token.sensenova.cn': { data: [{ id: 'nova-test-model' }] },
  'discovery-api.intern-ai.org.cn': { data: [{ id: 'internlm-test-model' }] },
  'api.scnet.cn': { data: [{ id: 'scnet-test-model' }] },
  'custom.example': { data: [{ id: 'custom-test-model' }] },
};
const expectedKeys = {
  'token.sensenova.cn': 'sensenova-secret-test-key',
  'discovery-api.intern-ai.org.cn': 'internlm-test-key',
  'api.scnet.cn': 'scnet-secret-test-key',
  'custom.example': 'custom-provider-secret',
};

https.request = (input, optionsOrCallback, maybeCallback) => {
  const options = input instanceof URL
    ? { ...optionsOrCallback, hostname: input.hostname, path: `${input.pathname}${input.search}` }
    : input;
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.write = () => {};
  request.destroy = (error) => {
    if (error) request.emit('error', error);
    return request;
  };
  request.end = () => {
    const expectedKey = expectedKeys[options.hostname];
    const authorized = !expectedKey || options.headers.authorization === `Bearer ${expectedKey}`;
    let responseBody = catalogs[options.hostname];
    if (options.hostname === 'custom.example' && options.path.endsWith('/chat/completions')) {
      responseBody = { choices: [{ message: { content: 'custom provider works' } }] };
    }
    const response = Readable.from([
      Buffer.from(JSON.stringify(authorized
        ? responseBody
        : { error: 'unexpected provider credentials' })),
    ]);
    response.statusCode = authorized ? 200 : 401;
    response.headers = {};
    process.nextTick(() => callback(response));
  };
  return request;
};
