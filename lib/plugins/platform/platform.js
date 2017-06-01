'use strict';

const path = require('path');
const fs = require('fs');
const jwtDecode = require('jwt-decode');
const fsExtra = require('../../utils/fs/fse');
// const userStats = require('../../utils/userStats');
const configUtils = require('../../utils/config');
const publishService = require('../../utils/requests/publishService');
const functionInfoUtils = require('../../utils/functionInfoUtils');
const createApolloClient = require('../../utils/createApolloClient');


function addReadme(attributes, readmePath) {
  if (fs.existsSync(readmePath)) {
    const readmeContent = fsExtra.readFileSync(readmePath).toString('utf8');
    attributes.readme = readmeContent; // eslint-disable-line
  }
  return attributes;
}

const config = {
  PLATFORM_FRONTEND_BASE_URL: 'https://platform.serverless-dev.com/',
  GRAPHQL_ENDPOINT_URL: 'https://9iflr60nfb.execute-api.us-east-1.amazonaws.com/dev/graphql',
  AUTH0_CLIENT_ID: '09L1JPT2LSv8x0VKHdrs4p85FXpoIB6w',
  AUTH0_URL: 'https://serverlessdev.auth0.com',
  AUTH0_CALLBACK_URL: 'https://platform.serverless-dev.com/cli-authentication',
};

function fetchEndpoint(provider, stage, region) {
  return provider.request(
      'CloudFormation',
      'describeStacks',
      { StackName: provider.naming.getStackName(stage) },
      stage,
      region
  ).then(result => {
    let endpoint = null;

    if (result) {
      result.Stacks[0].Outputs.filter(x => { // eslint-disable-line
        return x.OutputKey.match(provider.naming.getServiceEndpointRegex());
      }).forEach(x => {
        endpoint = x.OutputValue;
      });
    }

    return endpoint;
  });
}

class Platform {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.hooks = {
      'after:deploy:deploy': this.publishService.bind(this),
    };
  }
  publishService() {
    console.log('publish service now');

    const userConfig = configUtils.getConfig();
    const currentId = userConfig.userId;
    const globalConfig = configUtils.getGlobalConfig();
    let authToken;
    if (globalConfig.users && globalConfig.users[currentId] && globalConfig.users[currentId].auth) {
      authToken = globalConfig.users[currentId].auth.id_token;
    }
    // console.log('authToken', authToken)
    if (!authToken) {
      console.log('no auth token found for', currentId)
      return undefined;
    }

    const clientWithAuth = createApolloClient(
      config.GRAPHQL_ENDPOINT_URL,
      authToken
    );

    const provider = this.serverless.getProvider('aws');
    const region = this.serverless.service.provider.region;
    const stage = this.serverless.processedInput.options.stage;

    return provider.getAccountId().then(accountId => {
      fetchEndpoint(provider, stage, region).then(endpoint => {
        const funcs = this.serverless.service.getAllFunctions().map(key => {
          const arnName = functionInfoUtils.getArnName(key, this.serverless);
          let funcAttributes = {
            name: key,
            runtime: functionInfoUtils.getRuntime(key, this.serverless),
            memory: functionInfoUtils.getMemorySize(key, this.serverless),
            timeout: functionInfoUtils.getTimeout(key, this.serverless),
            provider: this.serverless.service.provider.name,
            originId: `arn:aws:lambda:${region}:${accountId}:function:${arnName}`,
            endpoints: functionInfoUtils.getEndpoints(
              key,
              this.serverless,
              endpoint
            ),
          };
          if (this.serverless.service.functions[key].readme) {
            funcAttributes = addReadme(funcAttributes,  this.serverless.service.functions[key].readme);
          }
          return funcAttributes;
        });

        const serviceData = {
          name: this.serverless.service.service,
          stage: this.serverless.processedInput.options.stage,
          functions: funcs,
        };

        // TODO make sure it caputures multiple variations of readme file name
        const readmePath = path.join(
          this.serverless.config.servicePath,
          'README.md'
        );
        const serviceDataWithReadme = addReadme(serviceData, readmePath);

        // write to manifests.json file

        // publish to platform
        console.log('serviceDataWithReadme', serviceDataWithReadme)
        publishService(serviceDataWithReadme, clientWithAuth).then(() => {
          const username = jwtDecode(authToken).nickname;
          const serviceName = this.serverless.service.service;
          console.log('Your service is available at'); console.log(`${config.PLATFORM_FRONTEND_BASE_URL}services/${username}/${serviceName}`);
        }).catch(error => {
          console.log("Couldn't publish this deploy information to the Serverless Platform due: \n", error);
        });
      });
    });
  }
}

module.exports = Platform;