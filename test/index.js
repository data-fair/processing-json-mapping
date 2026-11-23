process.env.NODE_ENV = 'test'

const nock = require('nock')
const config = require('config')
const assert = require('node:assert').strict
const processing = require('../')

describe('test', function () {
  it('should expose a plugin config schema for super admins', async () => {
    const schema = require('../plugin-config-schema.json')
    assert.ok(schema)
  })
  it('should expose a processing config schema for users', async () => {
    const schema = require('../processing-config-schema.json')
    assert.equal(schema.type, 'object')
  })

  it('should only consider the configured origin for credentials', () => {
    assert.equal(processing.isSameOrigin('https://test.com/api/items?page=2', 'https://test.com/api/items'), true)
    assert.equal(processing.isSameOrigin('https://evil.com/api/items', 'https://test.com/api/items'), false)
    assert.equal(processing.isSameOrigin('https://test.com.evil.com/api', 'https://test.com/api/items'), false)
    assert.equal(processing.isSameOrigin('https://test.com@evil.com/api', 'https://test.com/api/items'), false)
    assert.equal(processing.isSameOrigin('/api/items', 'https://test.com/api/items'), false)
  })

  describe('request timeout', () => {
    const axios = require('axios')
    const dfURL = 'http://df.test'

    /**
     * Run context that needs no data-fair instance: the dataset is mocked with nock, and every
     * request sent to the API is recorded.
     */
    const mockContext = (processingConfig) => {
      const instance = axios.create({ baseURL: dfURL + '/' })
      const apiRequests = []
      const spy = Object.assign((cfg) => {
        apiRequests.push(cfg)
        return instance(cfg)
      }, instance)
      const noop = async () => {}
      return {
        apiRequests,
        context: {
          processingId: 'p1',
          processingConfig: {
            datasetMode: 'update',
            dataset: { id: 'ds', title: 'Timeout' },
            apiURL: 'https://test.com/api/items',
            resultPath: 'data',
            detectSchema: true,
            ...processingConfig
          },
          axios: spy,
          log: { step: noop, info: noop, warning: noop, error: noop, debug: noop },
          patchConfig: noop,
          ws: { waitForJournal: noop }
        }
      }
    }
    const nockDataset = () => nock(dfURL)
      .get('/api/v1/datasets/ds').reply(200, { id: 'ds', title: 'Timeout', schema: [{ key: 'id', type: 'integer' }] })
      .post('/api/v1/datasets/ds/_bulk_lines').reply(200, { nbOk: 1 })

    // an earlier test that failed before reaching the API leaves its interceptors behind
    beforeEach(() => nock.cleanAll())
    afterEach(() => nock.cleanAll())

    it('should keep 10 minutes when the option is not set', async () => {
      const df = nockDataset()
      const api = nock('https://test.com').get('/api/items').reply(200, { data: [{ id: 1 }] })
      const { context, apiRequests } = mockContext({})
      await processing.run(context)
      assert.ok(api.isDone())
      assert.ok(df.isDone())
      assert.deepEqual(apiRequests.map(r => r.timeout), [10 * 60000])
    })

    it('should apply the configured timeout to every page', async () => {
      nockDataset()
      const api = nock('https://test.com')
        .get('/api/items').reply(200, { data: [{ id: 1 }], next: 'https://test.com/api/items?page=2' })
        .get('/api/items?page=2').reply(200, { data: [] })
      const { context, apiRequests } = mockContext({
        requestTimeout: 45,
        pagination: { method: 'nextPageData', nextPagePath: 'next' }
      })
      await processing.run(context)
      assert.ok(api.isDone())
      assert.deepEqual(apiRequests.map(r => r.timeout), [45 * 60000, 45 * 60000])
    })

    it('should fail with a message naming the option when the API is too slow', async () => {
      nock(dfURL).get('/api/v1/datasets/ds').reply(200, { id: 'ds', title: 'Timeout', schema: [] })
      // hold back the whole answer, headers included, like an API still computing its export
      // (nock's delay() sends the headers first, which axios does not report as a timeout)
      nock('https://test.com').get('/api/items')
        .reply(async () => { await new Promise(resolve => setTimeout(resolve, 1000)); return [200, { data: [] }] })
      // 0.001 minute = 60 ms, below the 1 minute the form allows, to keep the test fast
      const { context } = mockContext({ requestTimeout: 0.001 })
      await assert.rejects(processing.run(context), (err) => {
        assert.match(err.message, /n'a pas répondu en 0,001 minute\b/)
        assert.match(err.message, /« Délai d'attente des requêtes \(minutes\) »/)
        assert.equal(err.cause.code, 'ECONNABORTED')
        return true
      })
    })

    it('should fall back to the default on an invalid value, within the timer limits', () => {
      assert.equal(processing.requestTimeoutMs(undefined), 600000)
      assert.equal(processing.requestTimeoutMs(0), 600000)
      assert.equal(processing.requestTimeoutMs(-5), 600000)
      assert.equal(processing.requestTimeoutMs(Number.NaN), 600000)
      assert.equal(processing.requestTimeoutMs(30), 1800000)
      assert.equal(processing.requestTimeoutMs(0.000001), 1)
      assert.equal(processing.requestTimeoutMs(50000), 2 ** 31 - 1)
    })

    it('should not take a network-level ETIMEDOUT for a request timeout', () => {
      assert.equal(processing.isRequestTimeout({ code: 'ECONNABORTED', message: 'timeout of 600000ms exceeded' }), true)
      assert.equal(processing.isRequestTimeout({ code: 'ETIMEDOUT', message: 'timeout of 600000ms exceeded' }), true)
      assert.equal(processing.isRequestTimeout({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT 1.2.3.4:443' }), false)
    })
  })

  it.skip('should use oauth connection to insee API', async function () {
    this.timeout(1000000)

    const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
    // const context = testsUtils.context({
    //   pluginConfig: {},
    //   processingConfig: {
    //     datasetMode: 'create',
    //     dataset: { title: 'Organisation avec schéma auto' },
    //     apiURL: 'https://www.data.gouv.fr/api/1/organizations/?page=1&page_size=100',
    //     resultPath: 'data',
    //     pagination: {
    //       method: 'nextPageData',
    //      nextPagePath: 'next_page'
    //     },
    //     detectSchema: false,
    //     columns: [
    //       {
    //         columnPath: 'acronym',
    //         columnType: 'Texte'
    //       },
    //       {
    //         columnPath: 'logo',
    //         columnType: 'Texte'
    //       },
    //       {
    //         columnPath: 'badges',
    //         multivalued: true
    //       },
    //       {
    //         columnPath: 'metrics.views',
    //         columnType: 'Nombre'
    //       }
    //     ]
    //   },
    //   tmpDir: 'data'
    // }, config, true)

    const context = testsUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'Json mapping test' },
        apiURL: 'https://api.insee.fr/metadonnees/V1/concepts/definitions',
        resultPath: '',
        detectSchema: true,
        // auth: {
        //   authMethod: 'bearerAuth',
        //   token: config.inseeToken
        // },
        auth: {
          authMethod: 'apiKey',
          apiKeyHeader: 'Authorization',
          apiKeyValue: `Bearer ${config.inseeToken}`
        },
        // auth: {
        //   authMethod: 'oauth2',
        //   grantType: 'client_credentials',
        //   tokenURL: 'https://api.insee.fr/token',
        //   clientId: config.inseeClientId,
        //   clientSecret: config.inseeClientSecret
        // },
        clearFile: false
      },
      tmpDir: 'data'
    }, config, true)

    await processing.run(context)
  })

  it('should create a dataset from a public API, detect the schema, perform a simple pagination', async function () {
    const scope = nock('https://test.com')
      .get('/api/items')
      .reply(200, {
        data: [
          { id: 1, name: 'item1', price: 10 },
          { id: 2, name: 'item2', price: 20 }
        ],
        next_page: 'https://test.com/api/items?page=2'
      })
      .get('/api/items?page=2')
      .reply(200, {
        data: [
          { id: 3, name: 'item3', price: 30 }
        ]
      })

    const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
    const context = testsUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'processing-json-mapping test simple' },
        apiURL: 'https://test.com/api/items',
        resultPath: 'data',
        pagination: {
          method: 'nextPageData',
          nextPagePath: 'next_page'
        },
        detectSchema: true
      },
      tmpDir: 'data'
    }, config, true)
    await processing.run(context)
    assert.ok(scope.isDone())

    assert.equal(context.processingConfig.datasetMode, 'update')
    assert.equal(context.processingConfig.dataset.title, 'processing-json-mapping test simple')
    const datasetId = context.processingConfig.dataset.id

    try {
      await context.ws.waitForJournal(datasetId, 'finalize-end')
      let dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
      assert.equal(dataset.schema.filter(p => !p['x-calculated']).length, 3)

      const scope2 = nock('https://test.com')
        .get('/api/items')
        .reply(200, {
          data: [
            { id: 4, name: 'item4', price: 40 }
          ]
        })
      await processing.run(context)
      assert.ok(scope2.isDone())

      await context.ws.waitForJournal(datasetId, 'finalize-end')

      dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
      assert.equal(dataset.count, 4)
    } finally {
      await context.axios.delete(`api/v1/datasets/${datasetId}`)
    }
  })

  it('should perform a pagination based on offset parameter', async function () {
    const scope = nock('https://test.com')
      .get('/api/items?offset=0&limit=2')
      .reply(200, {
        data: [
          { id: 1, name: 'item1', price: 10 },
          { id: 2, name: 'item2', price: 20 }
        ],
        next_page: 'https://test.com/api/items?offset=2&limit=2'
      })
      .get('/api/items?offset=2&limit=2')
      .reply(200, {
        data: [
          { id: 3, name: 'item3', price: 30 }
        ]
      })

    const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
    const context = testsUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'processing-json-mapping test offset page' },
        apiURL: 'https://test.com/api/items',
        resultPath: 'data',
        pagination: {
          method: 'queryParams',
          offsetKey: 'offset',
          offsetFrom0: true,
          limitKey: 'limit',
          limitValue: 2
        },
        detectSchema: true
      },
      tmpDir: 'data'
    }, config, true)
    await processing.run(context)
    assert.ok(scope.isDone())

    assert.equal(context.processingConfig.datasetMode, 'update')
    assert.equal(context.processingConfig.dataset.title, 'processing-json-mapping test offset page')
    const datasetId = context.processingConfig.dataset.id

    try {
      await context.ws.waitForJournal(datasetId, 'finalize-end')
      let dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
      assert.equal(dataset.schema.filter(p => !p['x-calculated']).length, 3)

      const scope2 = nock('https://test.com')
        .get('/api/items?offset=0&limit=2')
        .reply(200, {
          data: [
            { id: 4, name: 'item4', price: 40 }
          ]
        })
      await processing.run(context)
      assert.ok(scope2.isDone())

      await context.ws.waitForJournal(datasetId, 'finalize-end')

      dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
      assert.equal(dataset.count, 4)
    } finally {
      await context.axios.delete(`api/v1/datasets/${datasetId}`)
    }
  })

  it('should create a dataset from a public API with explicit schema', async function () {
    const scope = nock('https://test.com')
      .get('/api/items')
      .reply(200, {
        data: [
          { id: 1, info: { name: 'item1', price: 10 } },
          { id: 2, info: { name: 'item2', price: 20 } }
        ],
        next_page: 'https://test.com/api/items?page=2'
      })
      .get('/api/items?page=2')
      .reply(200, {
        data: [
          { id: 3, info: { name: 'item3', price: 30 } }
        ]
      })

    const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
    const context = testsUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'processing-json-mapping test 2' },
        apiURL: 'https://test.com/api/items',
        resultPath: 'data',
        pagination: {
          method: 'nextPageData',
          nextPagePath: 'next_page'
        },
        detectSchema: false,
        columns: [
          {
            columnPath: 'id',
            columnType: 'Nombre',
            isPrimaryKey: true
          },
          {
            columnPath: 'info.name',
            columnType: 'Texte'
          },
          {
            columnPath: 'info.price',
            columnType: 'Nombre'
          }
        ]
      },
      tmpDir: 'data'
    }, config, true)
    await processing.run(context)
    assert.ok(scope.isDone())

    assert.equal(context.processingConfig.datasetMode, 'update')
    assert.equal(context.processingConfig.dataset.title, 'processing-json-mapping test 2')
    const datasetId = context.processingConfig.dataset.id

    try {
      await context.ws.waitForJournal(datasetId, 'finalize-end')
      let dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
      assert.equal(dataset.schema.filter(p => !p['x-calculated']).length, 3)

      const scope2 = nock('https://test.com')
        .get('/api/items')
        .reply(200, {
          data: [
            { id: 1, info: { name: 'item1 changed', price: 41 } }
          ]
        })
      await processing.run(context)
      assert.ok(scope2.isDone())

      await context.ws.waitForJournal(datasetId, 'finalize-end')

      dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
      assert.equal(dataset.count, 3)
      assert.equal(dataset.schema[0].key, 'id')
      assert.equal(dataset.schema[1].key, 'infoname')
      assert.equal(dataset.schema[1].title, 'info.name')
      assert.equal(dataset.schema[2].key, 'infoprice')
      assert.equal(dataset.schema[2].title, 'info.price')

      const lines = (await context.axios.get(`api/v1/datasets/${datasetId}/lines`)).data.results
      assert.equal(lines.length, 3)
      assert.equal(lines[0].id, 1)
      assert.equal(lines[0].infoname, 'item1 changed')
      assert.equal(lines[0].infoprice, 41)
    } finally {
      await context.axios.delete(`api/v1/datasets/${datasetId}`)
    }
  })

  it('should fail to update a dataset with a type change', async function () {
    const scope = nock('https://test.com')
      .get('/api/items')
      .reply(200, { data: [{ id: 1, name: 'item1' }] })

    const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
    const context = testsUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'processing-json-mapping test 3' },
        apiURL: 'https://test.com/api/items',
        resultPath: 'data',
        pagination: {
          method: 'nextPageData',
          nextPagePath: 'next_page'
        },
        detectSchema: false,
        columns: [
          {
            columnPath: 'id',
            columnType: 'Nombre',
            isPrimaryKey: true
          },
          {
            columnPath: 'name',
            columnType: 'Texte'
          }
        ]
      },
      tmpDir: 'data'
    }, config, true)
    await processing.run(context)
    assert.ok(scope.isDone())

    const datasetId = context.processingConfig.dataset.id

    try {
      await context.ws.waitForJournal(datasetId, 'finalize-end')

      context.processingConfig.columns[1].columnType = 'Nombre'
      await assert.rejects(processing.run(context), (err) => {
        assert.equal(err.message, 'La configuration a changé depuis la création du jeu de donnée. La colonne name a changé de type.')
        return true
      })
    } finally {
      await context.axios.delete(`api/v1/datasets/${datasetId}`)
    }
  })

  it('should fail to update a dataset with a new column', async function () {
    const scope = nock('https://test.com')
      .get('/api/items')
      .reply(200, { data: [{ id: 1, name: 'item1' }] })

    const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
    const context = testsUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'processing-json-mapping test 3' },
        apiURL: 'https://test.com/api/items',
        resultPath: 'data',
        pagination: {
          method: 'nextPageData',
          nextPagePath: 'next_page'
        },
        detectSchema: false,
        columns: [
          {
            columnPath: 'id',
            columnType: 'Nombre',
            isPrimaryKey: true
          },
          {
            columnPath: 'name',
            columnType: 'Texte'
          }
        ]
      },
      tmpDir: 'data'
    }, config, true)
    await processing.run(context)
    assert.ok(scope.isDone())

    const datasetId = context.processingConfig.dataset.id

    try {
      await context.ws.waitForJournal(datasetId, 'finalize-end')

      context.processingConfig.columns.push({
        columnPath: 'price',
        columnType: 'Nombre'
      })
      await assert.rejects(processing.run(context), (err) => {
        assert.equal(err.message, 'La configuration a changé depuis la création du jeu de donnée. La colonne price n\'existe pas. La configuration peut être mise à jour avec la mise à jour forcée.')
        return true
      })
    } finally {
      await context.axios.delete(`api/v1/datasets/${datasetId}`)
    }
  })

  it('should update a dataset with a new column name', async function () {
    const scope = nock('https://test.com')
      .get('/api/items')
      .reply(200, { data: [{ id: 1, name: 'item1' }] })

    const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
    const context = testsUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'processing-json-mapping test 3' },
        apiURL: 'https://test.com/api/items',
        resultPath: 'data',
        pagination: {
          method: 'nextPageData',
          nextPagePath: 'next_page'
        },
        detectSchema: false,
        columns: [
          {
            columnPath: 'id',
            columnType: 'Nombre',
            isPrimaryKey: true
          },
          {
            columnPath: 'nameko',
            columnType: 'Texte'
          }
        ]
      },
      tmpDir: 'data'
    }, config, true)
    await processing.run(context)
    assert.ok(scope.isDone())

    const datasetId = context.processingConfig.dataset.id

    try {
      await context.ws.waitForJournal(datasetId, 'finalize-end')

      context.processingConfig.columns[1].columnPath = 'na.me'
      context.processingConfig.forceUpdate = true

      const scope2 = nock('https://test.com')
        .get('/api/items')
        .reply(200, {
          data: [
            { id: 1, na: { me: 'item1' }, price: 41 }
          ]
        })
      await processing.run(context)
      assert.ok(scope2.isDone())

      await context.ws.waitForJournal(datasetId, 'finalize-end')

      const dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
      assert.equal(dataset.schema.filter(p => !p['x-calculated']).length, 3)
      assert.equal(dataset.count, 1)
    } finally {
      await context.axios.delete(`api/v1/datasets/${datasetId}`)
    }
  })

  it('should update a dataset with a new column if forceUpdate is true', async function () {
    const scope = nock('https://test.com')
      .get('/api/items')
      .reply(200, { data: [{ id: 1, name: 'item1' }] })

    const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
    const context = testsUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'processing-json-mapping test 3' },
        apiURL: 'https://test.com/api/items',
        resultPath: 'data',
        pagination: {
          method: 'nextPageData',
          nextPagePath: 'next_page'
        },
        detectSchema: false,
        columns: [
          {
            columnPath: 'id',
            columnType: 'Nombre',
            isPrimaryKey: true
          },
          {
            columnPath: 'name',
            columnType: 'Texte'
          }
        ]
      },
      tmpDir: 'data'
    }, config, true)
    await processing.run(context)
    assert.ok(scope.isDone())

    const datasetId = context.processingConfig.dataset.id

    try {
      await context.ws.waitForJournal(datasetId, 'finalize-end')

      context.processingConfig.columns.push({
        columnPath: 'price',
        columnType: 'Nombre'
      })
      context.processingConfig.forceUpdate = true

      const scope2 = nock('https://test.com')
        .get('/api/items')
        .reply(200, {
          data: [
            { id: 1, name: 'item1 changed', price: 41 }
          ]
        })
      await processing.run(context)
      assert.ok(scope2.isDone())

      await context.ws.waitForJournal(datasetId, 'finalize-end')

      const dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
      assert.equal(dataset.schema.filter(p => !p['x-calculated']).length, 3)
      assert.equal(dataset.count, 1)
    } finally {
      await context.axios.delete(`api/v1/datasets/${datasetId}`)
    }
  })

  /* it.skip('should move data from an extended datasets', async function () {
    const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
    const context = testsUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'processing-json-mapping test ext' },
        apiURL: 'https://staging-koumoul.com/data-fair/api/v1/datasets/dssl726fsrwlatrz7gd-si5t/lines',
        resultPath: 'results',
        pagination: {
          method: 'nextPageData',
          nextPagePath: 'next'
        },
        detectSchema: false,
        columns: [
          {
            columnPath: 'code_commune',
            columnType: 'Texte'
          },
          {
            columnPath: '_parcelles.batimentsArea',
            columnType: 'Nombre'
          }
        ]
      },
      tmpDir: 'data'
    }, config, true)
    await processing.run(context)
    assert.ok(scope.isDone())

    const datasetId = context.processingConfig.dataset.id
  }) */
})
