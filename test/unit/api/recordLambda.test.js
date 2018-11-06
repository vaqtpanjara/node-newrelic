'use strict'

const API = require('../../../api')
const chai = require('chai')
const expect = chai.expect
const helper = require('../../lib/agent_helper')
const lambdaSampleEvents = require('./lambdaSampleEvents')

const ATTR_DEST = require('../../../lib/config/attribute-filter').DESTINATIONS
// attribute key names
const REGION = 'aws.region'
const REQ_ID = 'aws.requestId'
const LAMBDA_ARN = 'aws.lambda.arn'
const COLDSTART = 'aws.lambda.coldStart'
const FUNCTION_NAME = 'aws.lambda.functionName'
const FUNCTION_VERS = 'aws.lambda.functionVersion'
const MEM_LIMIT = 'aws.lambda.memoryLimit'
const EVENTSOURCE_ARN = 'aws.lambda.eventSource.arn'

describe('The recordLambda API', () => {
  const groupName = 'Function'
  const functionName = 'testName'
  const expectedTransactionName = groupName + '/' + functionName
  const expectedBgTransactionName = 'OtherTransaction/' + expectedTransactionName
  const expectedWebTransactionName = 'WebTransaction/' + expectedTransactionName
  const errorMessage = 'sad day'

  let agent
  let api

  let stubEvent
  let stubContext
  let stubCallback

  let error

  beforeEach(() => {
    agent = helper.loadMockedAgent()
    api = new API(agent)

    stubEvent = {}
    stubContext = {
      done: () => {},
      succeed: () => {},
      fail: () => {},
      functionName: functionName,
      functionVersion: 'TestVersion',
      invokedFunctionArn: 'arn:test:function',
      memoryLimitInMB: '128',
      awsRequestId: 'testid'
    },
    stubCallback = () => {}

    process.env.AWS_REGION = 'nr-test'
    process.env.AWS_EXECUTION_ENV = 'Test_nodejsNegative2.3'

    error = new SyntaxError(errorMessage)
  })

  afterEach(() => {
    stubEvent = null
    stubContext = null
    stubCallback = null
    error = null

    delete process.env.AWS_REGION
    delete process.env.AWS_EXECUTION_ENV

    helper.unloadAgent(agent)
    agent = null
    api = null
  })

  it('should return original handler if not a function', () => {
    const handler = {}
    const newHandler = api.recordLambda(handler)

    expect(newHandler).to.equal(handler)
  })

  it('should report API supportability metric', () => {
    api.recordLambda(() => {})

    const metric = agent.metrics.getMetric('Supportability/API/recordLambda')
    expect(metric.callCount).to.equal(1)
  })

  it('should pick up on the arn', function() {
    expect(agent.lambdaArn).to.be.undefined
    api.recordLambda(function(){})(stubEvent, stubContext, stubCallback)
    expect(agent.lambdaArn).to.equal(stubContext.invokedFunctionArn)
  })

  describe('when invoked with non web event', () => {
    it('should create a transaction for handler', () => {
      const wrappedHandler = api.recordLambda((event, context, callback) => {
        const transaction = agent.tracer.getTransaction()
        expect(transaction.type).to.equal('bg')
        expect(transaction.getFullName()).to.equal(expectedBgTransactionName)
        expect(transaction.isActive()).to.be.true

        callback(null, 'worked')
      })

      wrappedHandler(stubEvent, stubContext, stubCallback)
    })

    it('should record standard background metrics', (done) => {
      agent.on('transactionFinished', confirmMetrics)

      const wrappedHandler = api.recordLambda((event, context, callback) => {
        callback(null, 'worked')
      })

      wrappedHandler(stubEvent, stubContext, stubCallback)

      function confirmMetrics() {
        const unscopedMetrics = agent.metrics.unscoped
        expect(unscopedMetrics).exist

        const otherTransactionAll = 'OtherTransaction/all'
        expect(unscopedMetrics[otherTransactionAll], otherTransactionAll)
          .to.exist.and.have.property('callCount', 1)

        expect(
          unscopedMetrics[expectedBgTransactionName],
          expectedBgTransactionName
        ).to.exist.and.have.property('callCount', 1)

        expect(unscopedMetrics.OtherTransactionTotalTime, 'OtherTransactionTotalTime')
          .to.exist.and.have.property('callCount', 1)

        const transactionOtherTotalTime =
          'OtherTransactionTotalTime/' + expectedTransactionName
        expect(unscopedMetrics[transactionOtherTotalTime], transactionOtherTotalTime)
          .to.exist.and.have.property('callCount', 1)

        done()
      }
    })
  })

  describe('when invoked with API Gateway Lambda proxy event', () => {
    const validResponse = {
      "isBase64Encoded": false,
      "statusCode": 200,
      "headers": {"responseHeader": "headerValue"},
      "body": "worked"
    }

    it('should create web transaction', (done) => {
      agent.on('transactionFinished', confirmAgentAttribute)

      const apiGatewayProxyEvent = lambdaSampleEvents.apiGatewayProxyEvent

      const wrappedHandler = api.recordLambda((event, context, callback) => {
        const transaction = agent.tracer.getTransaction()
        expect(transaction.type).to.equal('web')
        expect(transaction.getFullName()).to.equal(expectedWebTransactionName)
        expect(transaction.isActive()).to.be.true

        callback(null, validResponse)
      })

      wrappedHandler(apiGatewayProxyEvent, stubContext, stubCallback)

      function confirmAgentAttribute(transaction) {
        const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_EVENT)

        expect(agentAttributes).to.have.property('request.method', 'GET')
        expect(agentAttributes).to.have.property('request.uri', '/test/hello')

        done()
      }
    })

    it('should capture request parameters', (done) => {
      agent.on('transactionFinished', confirmAgentAttribute)

      agent.config.attributes.enabled = true
      agent.config.attributes.include = ['request.parameters.*']
      agent.config.emit('attributes.include')

      const apiGatewayProxyEvent = lambdaSampleEvents.apiGatewayProxyEvent

      const wrappedHandler = api.recordLambda((event, context, callback) => {
        callback(null, validResponse)
      })

      wrappedHandler(apiGatewayProxyEvent, stubContext, stubCallback)

      function confirmAgentAttribute(transaction) {
        const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_EVENT)

        expect(agentAttributes).to.have.property('request.parameters.name', 'me')
        expect(agentAttributes).to.have.property('request.parameters.team', 'node agent')

        done()
      }
    })

    it('should capture request headers', (done) => {
      agent.on('transactionFinished', confirmAgentAttribute)

      const apiGatewayProxyEvent = lambdaSampleEvents.apiGatewayProxyEvent

      const wrappedHandler = api.recordLambda((event, context, callback) => {
        callback(null, validResponse)
      })

      wrappedHandler(apiGatewayProxyEvent, stubContext, stubCallback)

      function confirmAgentAttribute(transaction) {
        const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_EVENT)

        expect(agentAttributes).to.have.property(
          'request.headers.accept',
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        )
        expect(agentAttributes).to.have.property(
          'request.headers.acceptEncoding',
          'gzip, deflate, lzma, sdch, br'
        )
        expect(agentAttributes).to.have.property(
          'request.headers.acceptLanguage',
          'en-US,en;q=0.8'
        )
        expect(agentAttributes).to.have.property(
          'request.headers.cloudFrontForwardedProto',
          'https'
        )
        expect(agentAttributes).to.have.property(
          'request.headers.cloudFrontIsDesktopViewer',
          'true'
        )
        expect(agentAttributes).to.have.property(
          'request.headers.cloudFrontIsMobileViewer',
          'false'
        )
        expect(agentAttributes).to.have.property(
          'request.headers.cloudFrontIsSmartTVViewer',
          'false'
        )
        expect(agentAttributes).to.have.property(
          'request.headers.cloudFrontIsTabletViewer',
          'false'
        )
        expect(agentAttributes).to.have.property(
          'request.headers.cloudFrontViewerCountry',
          'US'
        )
        expect(agentAttributes).to.have.property(
          'request.headers.host',
          'wt6mne2s9k.execute-api.us-west-2.amazonaws.com'
        )
        expect(agentAttributes).to.have.property(
          'request.headers.upgradeInsecureRequests',
          '1'
        )
        expect(agentAttributes).to.have.property(
          'request.headers.userAgent',
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_6)'
        )
        expect(agentAttributes).to.have.property(
          'request.headers.via',
          '1.1 fb7cca60f0ecd82ce07790c9c5eef16c.cloudfront.net (CloudFront)'
        )

        done()
      }
    })

    it('should filter request headers by `exclude` rules', (done) => {
      agent.on('transactionFinished', confirmAgentAttribute)

      const apiGatewayProxyEvent = lambdaSampleEvents.apiGatewayProxyEvent

      const wrappedHandler = api.recordLambda((event, context, callback) => {
        callback(null, validResponse)
      })

      wrappedHandler(apiGatewayProxyEvent, stubContext, stubCallback)

      function confirmAgentAttribute(transaction) {
        const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_EVENT)

        expect(agentAttributes).to.not.have.property('request.headers.X-Amz-Cf-Id')
        expect(agentAttributes).to.not.have.property('request.headers.X-Forwarded-For')
        expect(agentAttributes).to.not.have.property('request.headers.X-Forwarded-Port')
        expect(agentAttributes).to.not.have.property('request.headers.X-Forwarded-Proto')

        expect(agentAttributes).to.not.have.property('request.headers.xAmzCfId')
        expect(agentAttributes).to.not.have.property('request.headers.xForwardedFor')
        expect(agentAttributes).to.not.have.property('request.headers.xForwardedPort')
        expect(agentAttributes).to.not.have.property('request.headers.xForwardedProto')

        expect(agentAttributes).to.not.have.property('request.headers.XAmzCfId')
        expect(agentAttributes).to.not.have.property('request.headers.XForwardedFor')
        expect(agentAttributes).to.not.have.property('request.headers.XForwardedPort')
        expect(agentAttributes).to.not.have.property('request.headers.XForwardedProto')

        done()
      }
    })

    it('should capture status code', (done) => {
      agent.on('transactionFinished', confirmAgentAttribute)

      const apiGatewayProxyEvent = lambdaSampleEvents.apiGatewayProxyEvent

      const wrappedHandler = api.recordLambda((event, context, callback) => {
        callback(null, validResponse)
      })

      wrappedHandler(apiGatewayProxyEvent, stubContext, stubCallback)

      function confirmAgentAttribute(transaction) {
        const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_EVENT)

        expect(agentAttributes).to.have.property(
          'httpResponseCode',
          '200'
        )

        expect(agentAttributes).to.have.property(
          'response.status',
          '200'
        )

        done()
      }
    })

    it('should capture response headers', (done) => {
      agent.on('transactionFinished', confirmAgentAttribute)

      const apiGatewayProxyEvent = lambdaSampleEvents.apiGatewayProxyEvent

      const wrappedHandler = api.recordLambda((event, context, callback) => {
        callback(null, validResponse)
      })

      wrappedHandler(apiGatewayProxyEvent, stubContext, stubCallback)

      function confirmAgentAttribute(transaction) {
        const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_EVENT)

        expect(agentAttributes).to.have.property(
          'response.headers.responseHeader',
          'headerValue'
        )

        done()
      }
    })

    it('should record standard web metrics', (done) => {
      agent.on('transactionFinished', confirmMetrics)

      const apiGatewayProxyEvent = lambdaSampleEvents.apiGatewayProxyEvent

      const wrappedHandler = api.recordLambda((event, context, callback) => {
        callback(null, validResponse)
      })

      wrappedHandler(apiGatewayProxyEvent, stubContext, stubCallback)

      function confirmMetrics() {
        const unscopedMetrics = agent.metrics.unscoped
        expect(unscopedMetrics).exist

        expect(unscopedMetrics.HttpDispatcher, 'HttpDispatcher')
          .to.exist.and.have.property('callCount', 1)

        expect(unscopedMetrics.Apdex, 'Apdex').to.exist.and.have.property('satisfying', 1)

        const transactionApdex = 'Apdex/' + expectedTransactionName
        expect(unscopedMetrics[transactionApdex], transactionApdex)
          .to.exist.and.have.property('satisfying', 1)

        expect(unscopedMetrics.WebTransaction, 'WebTransaction')
          .to.exist.and.have.property('callCount', 1)

        expect(
          unscopedMetrics[expectedWebTransactionName],
          expectedWebTransactionName
        ).to.exist.and.have.property('callCount', 1)

        expect(unscopedMetrics.WebTransactionTotalTime, 'WebTransactionTotalTime')
          .to.exist.and.have.property('callCount', 1)

        const transactionWebTotalTime =
          'WebTransactionTotalTime/' + expectedTransactionName
        expect(unscopedMetrics[transactionWebTotalTime], transactionWebTotalTime)
          .to.exist.and.have.property('callCount', 1)

        done()
      }
    })
  })

  it('should create a segment for handler', () => {
    const wrappedHandler = api.recordLambda((event, context, callback) => {
      const segment = api.shim.getSegment()
      expect(segment).is.not.null
      expect(segment.name).to.equal(functionName)

      callback(null, 'worked')
    })

    wrappedHandler(stubEvent, stubContext, stubCallback)
  })

  it('should capture cold start boolean on first invocation', (done) => {
    agent.on('transactionFinished', confirmColdStart)

    const wrappedHandler = api.recordLambda((event, context, callback) => {
      callback(null, 'worked')
    })

    wrappedHandler(stubEvent, stubContext, stubCallback)

    function confirmColdStart(transaction) {
      const attributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_EVENT)
      expect(attributes['aws.lambda.coldStart']).to.equal(true)
      done()
    }
  })

  it('should not include cold start on subsequent invocations', (done) => {
    let transactionNum = 1

    agent.on('transactionFinished', confirmNoAdditionalColdStart)

    const wrappedHandler = api.recordLambda((event, context, callback) => {
      callback(null, 'worked')
    })

    wrappedHandler(stubEvent, stubContext, stubCallback)
    wrappedHandler(stubEvent, stubContext, () => {
      done()
    })

    function confirmNoAdditionalColdStart(transaction) {
      if (transactionNum > 1) {
        const attributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_EVENT)
        expect(attributes['aws.lambda.coldStart']).to.not.exist
      }

      transactionNum++
    }
  })

  it('should capture AWS agent attributes and send to correct dests', (done) => {
    agent.on('transactionFinished', confirmAgentAttributes)

    const wrappedHandler = api.recordLambda((event, context, callback) => {
      callback(null, 'worked')
    })

    const stubEvt = {
      Records: [
        {eventSourceARN: 'stub:eventsource:arn'}
      ]
    }

    wrappedHandler(stubEvt, stubContext, stubCallback)

    function confirmAgentAttributes(transaction) {
      // verify attributes exist in correct destinations
      const txTrace = _verifyDestinations(transaction)

      // now verify actual values
      expect(txTrace[REGION]).to.equal(process.env.AWS_REGION)
      expect(txTrace[REQ_ID]).to.equal(stubContext.awsRequestId)
      expect(txTrace[LAMBDA_ARN]).to.equal(stubContext.invokedFunctionArn)
      expect(txTrace[COLDSTART]).to.be.true
      expect(txTrace[FUNCTION_NAME]).to.equal(stubContext.functionName)
      expect(txTrace[FUNCTION_VERS]).to.equal(stubContext.functionVersion)
      expect(txTrace[MEM_LIMIT]).to.equal(stubContext.memoryLimitInMB)

      done()
    }

    function _verifyDestinations(tx) {
      const txTrace = tx.trace.attributes.get(ATTR_DEST.TRANS_TRACE)
      const errEvent = tx.trace.attributes.get(ATTR_DEST.ERROR_EVENT)
      const txEvent = tx.trace.attributes.get(ATTR_DEST.TRANS_EVENT)

      const all = [REGION, REQ_ID, LAMBDA_ARN, COLDSTART]
      const limited = [FUNCTION_NAME, FUNCTION_VERS, MEM_LIMIT, EVENTSOURCE_ARN]

      all.forEach((key) => {
        expect(txTrace[key], key).to.not.be.undefined
        expect(errEvent[key], key).to.not.be.undefined
        expect(txEvent[key], key).to.not.be.undefined
      })
      limited.forEach((key) => {
        expect(txTrace[key], key).to.not.be.undefined
        expect(errEvent[key], key).to.not.be.undefined
      })

      return txTrace
    }
  })

  it('should not add attributes from empty event', (done) => {
    agent.on('transactionFinished', confirmAgentAttribute)

    const wrappedHandler = api.recordLambda((event, context, callback) => {
      callback(null, 'worked')
    })

    wrappedHandler(stubEvent, stubContext, stubCallback)

    function confirmAgentAttribute(transaction) {
      const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_TRACE)

      expect(agentAttributes[EVENTSOURCE_ARN]).to.be.undefined
      done()
    }
  })

  it('should capture kinesis data stream event source arn', (done) => {
    agent.on('transactionFinished', confirmAgentAttribute)

    stubEvent = lambdaSampleEvents.kinesisDataStreamEvent

    const wrappedHandler = api.recordLambda((event, context, callback) => {
      callback(null, 'worked')
    })

    wrappedHandler(stubEvent, stubContext, stubCallback)

    function confirmAgentAttribute(transaction) {
      const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_TRACE)

      expect(agentAttributes[EVENTSOURCE_ARN])
        .to.equal('kinesis:eventsourcearn')
      done()
    }
  })

  it('should capture S3 PUT event source arn attribute', (done) => {
    agent.on('transactionFinished', confirmAgentAttribute)

    stubEvent = lambdaSampleEvents.s3PutEvent

    const wrappedHandler = api.recordLambda((event, context, callback) => {
      callback(null, 'worked')
    })

    wrappedHandler(stubEvent, stubContext, stubCallback)

    function confirmAgentAttribute(transaction) {
      const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_TRACE)

      expect(agentAttributes[EVENTSOURCE_ARN]).to.equal('bucketarn')
      done()
    }
  })

  it('should capture SNS event source arn attribute', (done) => {
    agent.on('transactionFinished', confirmAgentAttribute)

    stubEvent = lambdaSampleEvents.snsEvent

    const wrappedHandler = api.recordLambda((event, context, callback) => {
      callback(null, 'worked')
    })

    wrappedHandler(stubEvent, stubContext, stubCallback)

    function confirmAgentAttribute(transaction) {
      const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_TRACE)

      expect(agentAttributes[EVENTSOURCE_ARN])
        .to.equal('eventsubscriptionarn')
      done()
    }
  })

  it('should capture DynamoDB Update event source attribute', (done) => {
    agent.on('transactionFinished', confirmAgentAttribute)

    stubEvent = lambdaSampleEvents.dynamoDbUpdateEvent

    const wrappedHandler = api.recordLambda((event, context, callback) => {
      callback(null, 'worked')
    })

    wrappedHandler(stubEvent, stubContext, stubCallback)

    function confirmAgentAttribute(transaction) {
      const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_TRACE)

      expect(agentAttributes[EVENTSOURCE_ARN])
        .to.equal('dynamodb:eventsourcearn')
      done()
    }
  })

  it('should capture CodeCommit event source attribute', (done) => {
    agent.on('transactionFinished', confirmAgentAttribute)

    stubEvent = lambdaSampleEvents.codeCommitEvent

    const wrappedHandler = api.recordLambda((event, context, callback) => {
      callback(null, 'worked')
    })

    wrappedHandler(stubEvent, stubContext, stubCallback)

    function confirmAgentAttribute(transaction) {
      const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_TRACE)

      expect(agentAttributes[EVENTSOURCE_ARN])
        .to.equal('arn:aws:codecommit:us-west-2:123456789012:my-repo')
      done()
    }
  })

  it('should not capture unknown event source attribute', (done) => {
    agent.on('transactionFinished', confirmAgentAttribute)

    stubEvent = lambdaSampleEvents.cloudFrontEvent

    const wrappedHandler = api.recordLambda((event, context, callback) => {
      callback(null, 'worked')
    })

    wrappedHandler(stubEvent, stubContext, stubCallback)

    function confirmAgentAttribute(transaction) {
      const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_TRACE)

      expect(agentAttributes[EVENTSOURCE_ARN]).to.be.undefined
      done()
    }
  })

  it('should capture Kinesis Data Firehose event source attribute', (done) => {
    agent.on('transactionFinished', confirmAgentAttribute)

    stubEvent = lambdaSampleEvents.kinesisDataFirehoseEvent

    const wrappedHandler = api.recordLambda((event, context, callback) => {
      callback(null, 'worked')
    })

    wrappedHandler(stubEvent, stubContext, stubCallback)

    function confirmAgentAttribute(transaction) {
      const agentAttributes = transaction.trace.attributes.get(ATTR_DEST.TRANS_TRACE)

      expect(agentAttributes[EVENTSOURCE_ARN]).to.equal('aws:lambda:events')
      done()
    }
  })

  describe('when callback used', () => {
    it('should end appropriately', () => {
      let transaction

      const wrappedHandler = api.recordLambda((event, context, callback) => {
        transaction = agent.tracer.getTransaction()
        callback(null, 'worked')
      })

      wrappedHandler(stubEvent, stubContext, function confirmEndCallback() {
        expect(transaction.isActive()).to.be.false

        const currentTransaction = agent.tracer.getTransaction()
        expect(currentTransaction).is.null
      })
    })

    it('should notice errors', (done) => {
      agent.on('transactionFinished', confirmErrorCapture)

      const wrappedHandler = api.recordLambda((event, context, callback) => {
        callback(error, 'failed')
      })

      wrappedHandler(stubEvent, stubContext, stubCallback)

      function confirmErrorCapture() {
        expect(agent.errors.errors.length).to.equal(1)
        const noticedError = agent.errors.errors[0]
        expect(noticedError[1], 'transaction name').to.equal(expectedBgTransactionName)
        expect(noticedError[2], 'message').to.equal(errorMessage)
        expect(noticedError[3], 'type').to.equal('SyntaxError')

        done()
      }
    })

    it('should notice string errors', (done) => {
      agent.on('transactionFinished', confirmErrorCapture)

      const wrappedHandler = api.recordLambda((event, context, callback) => {
        callback('failed')
      })

      wrappedHandler(stubEvent, stubContext, stubCallback)

      function confirmErrorCapture() {
        expect(agent.errors.errors.length).to.equal(1)
        const noticedError = agent.errors.errors[0]
        expect(noticedError[1], 'transaction name').to.equal(expectedBgTransactionName)
        expect(noticedError[2], 'message').to.equal('failed')
        expect(noticedError[3], 'type').to.equal('Error')

        const data = noticedError[4]
        expect(data.stack_trace, 'stack_trace').to.exist

        done()
      }
    })
  })

  describe('when context.done used', () => {
    it('should end appropriately', () => {
      let transaction

      context.done = confirmEndCallback

      const wrappedHandler = api.recordLambda((event, context) => {
        transaction = agent.tracer.getTransaction()
        context.done(null, 'worked')
      })

      wrappedHandler(stubEvent, stubContext, stubCallback)

      function confirmEndCallback() {
        expect(transaction.isActive()).to.be.false

        const currentTransaction = agent.tracer.getTransaction()
        expect(currentTransaction).is.null
      }
    })

    it('should notice errors', (done) => {
      agent.on('transactionFinished', confirmErrorCapture)

      const wrappedHandler = api.recordLambda((event, context) => {
        context.done(error, 'failed')
      })

      wrappedHandler(stubEvent, stubContext, stubCallback)

      function confirmErrorCapture() {
        expect(agent.errors.errors.length).to.equal(1)
        const noticedError = agent.errors.errors[0]
        expect(noticedError[1], 'transaction name').to.equal(expectedBgTransactionName)
        expect(noticedError[2], 'message').to.equal(errorMessage)
        expect(noticedError[3], 'type').to.equal('SyntaxError')

        done()
      }
    })

    it('should notice string errors', (done) => {
      agent.on('transactionFinished', confirmErrorCapture)

      const wrappedHandler = api.recordLambda((event, context) => {
        context.done('failed')
      })

      wrappedHandler(stubEvent, stubContext, stubCallback)

      function confirmErrorCapture() {
        expect(agent.errors.errors.length).to.equal(1)
        const noticedError = agent.errors.errors[0]
        expect(noticedError[1], 'transaction name').to.equal(expectedBgTransactionName)
        expect(noticedError[2], 'message').to.equal('failed')
        expect(noticedError[3], 'type').to.equal('Error')

        const data = noticedError[4]
        expect(data.stack_trace, 'stack_trace').to.exist

        done()
      }
    })
  })

  describe('when context.succeed used', () => {
    it('should end appropriately', () => {
      let transaction

      context.succeed = confirmEndCallback

      const wrappedHandler = api.recordLambda((event, context) => {
        transaction = agent.tracer.getTransaction()
        context.succeed('worked')
      })

      wrappedHandler(stubEvent, stubContext, stubCallback)

      function confirmEndCallback() {
        expect(transaction.isActive()).to.be.false

        const currentTransaction = agent.tracer.getTransaction()
        expect(currentTransaction).is.null
      }
    })
  })

  describe('when context.fail used', () => {
    it('should end appropriately', () => {
      let transaction

      context.fail = confirmEndCallback

      const wrappedHandler = api.recordLambda((event, context) => {
        transaction = agent.tracer.getTransaction()
        context.fail()
      })

      wrappedHandler(stubEvent, stubContext, stubCallback)

      function confirmEndCallback() {
        expect(transaction.isActive()).to.be.false

        const currentTransaction = agent.tracer.getTransaction()
        expect(currentTransaction).is.null
      }
    })

    it('should notice errors', (done) => {
      agent.on('transactionFinished', confirmErrorCapture)

      const wrappedHandler = api.recordLambda((event, context) => {
        context.fail(error)
      })

      wrappedHandler(stubEvent, stubContext, stubCallback)

      function confirmErrorCapture() {
        expect(agent.errors.errors.length).to.equal(1)
        const noticedError = agent.errors.errors[0]
        expect(noticedError[1], 'transaction name').to.equal(expectedBgTransactionName)
        expect(noticedError[2], 'message').to.equal(errorMessage)
        expect(noticedError[3], 'type').to.equal('SyntaxError')

        done()
      }
    })

    it('should notice string errors', (done) => {
      agent.on('transactionFinished', confirmErrorCapture)

      const wrappedHandler = api.recordLambda((event, context) => {
        context.fail('failed')
      })

      wrappedHandler(stubEvent, stubContext, stubCallback)

      function confirmErrorCapture() {
        expect(agent.errors.errors.length).to.equal(1)
        const noticedError = agent.errors.errors[0]
        expect(noticedError[1], 'transaction name').to.equal(expectedBgTransactionName)
        expect(noticedError[2], 'message').to.equal('failed')
        expect(noticedError[3], 'type').to.equal('Error')

        const data = noticedError[4]
        expect(data.stack_trace, 'stack_trace').to.exist

        done()
      }
    })
  })
})

