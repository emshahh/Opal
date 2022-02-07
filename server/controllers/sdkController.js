import { config } from 'dotenv';
import { DefaultAzureCredential } from '@azure/identity';
import { ResourceManagementClient } from '@azure/arm-resources';
import { SubscriptionClient } from '@azure/arm-resources-subscriptions';
import { OperationalInsightsManagementClient } from '@azure/arm-operationalinsights';
import fetch from 'node-fetch';
import axios from 'axios'
config();

// Create a new credential.
const credential = new DefaultAzureCredential();

const sdkController = {};

sdkController.executionOnly = async (req, res, next) => {
  res.locals.executionOnly = true;
  return next();
};

sdkController.fetchSubscriptionIds = async (req, res, next) => {
  // get all subscriptions associated with the given credential.
  // look up iterator functionality in relation to promise use.
  // subscriptions are accessed through an iterator.
  // may need to iterate through pages of subscriptions.
  const subClient = new SubscriptionClient(credential);
  const subscriptions = subClient.subscriptions.list();
  // const nextSub = await subscriptions.next();
  // nextSub.value will return an array of subscriptions.
  // for our purposes, all we need is the subscriptionId.
  // return an array of subscription ids.

  res.locals.subscriptions = {};
  //This is using .list().byPage() await .next().value because we are using a forEach loop.
  //If we iterate with a for loop, we can use await .list() and for await ().
  for await (const sub of subscriptions) {
    res.locals.subscriptions[sub.subscriptionId] = {
      tenantId: sub.tenantId,
      displayName: sub.displayName,
      id: sub.id,
      subscriptionId: sub.subscriptionId,
      subscriptionName: sub.subscriptionName,
      resourceGroups: {},
    };

    // Create an insights management client for collecting workspace IDs (for insights into function-level metrics).
    const opClient = new OperationalInsightsManagementClient(credential, res.locals.subscriptions[sub.subscriptionId].subscriptionId);
    let workspaces = opClient.workspaces.list();
    res.locals.subscriptions[sub.subscriptionId].workSpaceArray = [];
    for await (const workspace of workspaces) {
      res.locals.subscriptions[sub.subscriptionId].workSpaceArray.push(workspace.customerId);
    }
    return next();
  }
};

sdkController.fetchResourceGroups = async (req, res, next) => {
  const start = new Date();
  for (let sub in res.locals.subscriptions) {
    res.locals.subscriptions[sub].rmc = new ResourceManagementClient(credential, sub);
    const groups = res.locals.subscriptions[sub].rmc.resourceGroups.list({ top: null });
    const groupsByPage = groups.byPage();
    const groupsPerSub = await groupsByPage.next();
    //Because we aren't iterating we need to use the .next() property.
    res.locals.subscriptions[sub].resourceGroups = groupsPerSub.value;
  }
  // console.log('fetching resource groups took');
  // console.log(end - start);
  // console.log('milliseconds');
  return next();
};

sdkController.fetchResources = async (req, res, next) => {
  const functionAppArray = [];
  const insightsList = [];
  const subscriptions = res.locals.subscriptions;
  for (let sub in subscriptions) {
    const currentSub = subscriptions[sub];
    for (let group in currentSub.resourceGroups) {
      const currentGroup = currentSub.resourceGroups[group];
      // add resource management client for this specific resource group.
      const rmc = currentSub.rmc;
      // get list of resources associated with that group.
      const resources = rmc.resources.listByResourceGroup(currentGroup.name);
      // const resourcesByPage = resources.byPage();
      // assume only one page
      // get list of all resources in a given group.
      // const allResources = await resourcesByPage.next();
      const functionList = [];

      // Sort resources into Function Applications and Insights. Ignore others.
      for await (const app of resources) {
        app.tenantId = currentSub.tenantId;
        app.subscriptionDisplayName = currentSub.displayName;
        app.subscriptionNamespaceId = currentSub.id;
        app.subscriptionId = currentSub.subscriptionId;
        app.resourceGroupId = currentGroup.id;
        app.resourceGroupName = currentSub.name;
        if ((app.kind === 'functionapp' || app.kind === 'functionapp,linux') && (app.type === 'Microsoft.Web/sites' || app.type === 'microsoft.web/sites')) {
          // If type is 'function', sort it into an array of function apps.
          functionList.push(app);
        } else if (app.type.toLowerCase() === 'microsoft.insights/components') {
          insightsList.push(app);
        }
      }

      // Pair every insight component with its corresponding function application.
      insightsList.forEach((app) => {
        for (const functionApp of functionList) {
          // Convert both to lowercase to avoid capitalization issues.
          const fatl = functionApp.name.toLowerCase();
          const atl = app.name.toLowerCase();
          if (fatl === atl) {
            functionApp.insightId = app.id;
          }
        }
      });
      // That group's function list is equal to the modified functionList.
      currentGroup.functionList = functionList;
      functionList.forEach((app) => {
        functionAppArray.push(app);
      });
    }
  }

  // delete the RMC once it's no longer needed.
  for (const sub in res.locals.subscriptions) {
    delete res.locals.subscriptions[sub].rmc;
  }

  res.locals.functionApps = functionAppArray;
  res.locals.insights = insightsList;
  return next();
};

sdkController.formatExecutions = (req, res, next) => {
  const executionObj = {};
  for (let sub in res.locals.subscriptions) {
    executionObj[sub] = {};
    for (let group of res.locals.subscriptions[sub].resourceGroups) {
      if (group.functionList.length) {
        executionObj[sub][group.name] = {};
        let currentFuncArray = group.functionList;
        currentFuncArray.forEach((func) => {
          let functionCount = {
            name: func.name,
            id: func.id,
            tenantId: func.tenantId,
            subscriptionDisplayName: func.subscriptionDisplayName,
            subscriptionId: func.subscriptionId,
            subscriptionNamespaceId: func.subscriptionNamespaceId,
            resourceGroupId: func.resourceGroupId,
            resourceGroupName: func.resourceGroupName,
            location: func.location,
            metricName: 'ExecutionCount',
            timeseries: res.locals.webMetrics[func.name].metrics[0].timeseries,
          };
          if (func.insightId !== undefined) {
            functionCount.insightId = func.insightId;
          }
          if (res.locals.subscriptions[sub].workSpaceArray[0] !== undefined) {
            console.log(res.locals.subscriptions[sub]);
            functionCount.workSpaceId = res.locals.subscriptions[sub].workSpaceArray[0];
          } else {
          }
          functionCount.totalCount = 0;
          functionCount.timeseries.forEach((time) => {
            functionCount.totalCount += time.total;
          });
          executionObj[sub][group.name][functionCount.name] = functionCount;
        });
      }
    }
  }
  res.locals.executionObj = executionObj;
  return next();
};

// This should be renamed -- this just gets all functions associated with one function app.
sdkController.getAllFunctions = async (req, res, next) => {
  const { subscriptionIdentifier, resourceGroupName, appName } = res.locals.azure.functionData;
  try {
    const fetchURL = `https://management.azure.com/subscriptions/${subscriptionIdentifier}/resourceGroups/${resourceGroupName}/providers/Microsoft.Web/sites/${appName}/functions?api-version=2021-01-01`;
    await fetch(fetchURL, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + res.locals.azure.bearerToken.token,
      },
    })
      .then((response) => response.json())
      .then((data) => {
        res.locals.allFunctions = data;
        return next();
      });
  } catch (err) {
    console.log('ERROR in web data');
    return next(err);
  }
};

// This route gets all functions associated with all subscribers and resource groups fed in from frontend.
// Like need this to be async, but confirm.
sdkController.getFunctionList = async (req, res, next) => {
  /*
    {
      subscriptions: [
        {
          subName:
          resourceGroups: [
            {
              resourceGroupName:
              resources: [
               "resource1, resource2"
              ]
            }
          ]
        }
      ]
    }
    */
    console.log('entering getFunctionList');
  res.locals.funcList = {
    functions: [],
  };
  const funcPromise = [];
  const funcSub = [];
  const funcResGrp = [];
  const funcRes = [];
  for (let sub in res.locals.azure.subList) {
    let currentSub = res.locals.azure.subList[sub];
    for (let resGroup in currentSub.resourceGroups) {
      let currentGrp = currentSub.resourceGroups[resGroup];
      for (let i = 0; i < currentGrp.resources.length; i++) {
        let currentRes = currentGrp.resources[i];
        const fetchURL = `https://management.azure.com/subscriptions/${currentSub.subName}/resourceGroups/${currentGrp.resourceGroupName}/providers/Microsoft.Web/sites/${currentRes}/functions?api-version=2021-01-01`;
        let fetchPromise = axios(fetchURL, {
          method: 'GET',
          headers: {
            Authorization: 'Bearer ' + res.locals.azure.bearerToken.token,
          },
        });
        funcPromise.push(fetchPromise);
        funcSub.push(currentSub);
        funcResGrp.push(currentGrp);
        funcRes.push(currentRes);
      }
    }
  }
  Promise.all(funcPromise).then((resultArray) => {
    // For each requested resource in the promise array.
      for (let i = 0; i < resultArray.length; i++) {
        //console.log('here is one result from the promise aray');
        //console.log(resultArray[i].data.value);
        let currentFuncAppData = resultArray[i].data.value;
        // For each function within each requested resource.
        for (let j = 0; j < currentFuncAppData.length; j++) {
          let currentFuncData = currentFuncAppData[j];
          console.log(currentFuncData);
          let currentSub = funcSub[i];
          let currentGrp = funcResGrp[i];
          let currentRes = funcRes[i];
          const currentFunc = {
            shortname: currentFuncData.properties.name,
            id: currentFuncData.id,
            fullname: currentFuncData.name,
            type: currentFuncData.type,
            location: currentFuncData.location,
            properties: currentFuncData.properties,
            subscription: currentSub.subName,
            resourceGroup: currentGrp.resourceGroupName,
            resource: currentRes,
            //shortname: currentFuncData.properties.name,

            //name: name
          };
          res.locals.funcList.functions.push(currentFunc);
        }
      }
      console.log('complete');
      console.log(res.locals.funcList);
      return next();
    });
    //.then(() => {
    //  console.log('successfully resolved');
    //  console.log(res.locals.funcList);
    //  return next();
    //})
    //.catch((err) => {
      // Fix error handling here.
    //  console.log('did not successfully resolve');
    //  return next(`hit err of ${err}`);
    //});
};

sdkController.setSub = (req, res, next) => {
  res.locals.azure.subList = req.body.subscriptions;
  return next();
  /*
    {
      subscriptions: [
        {
          subName:
          resourceGroups: [
            {
              resourceGroupName:
              resources: [
               "resource1, resource2"
              ]
            }
          ]
        }
      ]
    }
    */
};

sdkController.formatAppDetail = (req, res, next) => {
  const selectedApp = res.locals.functionApps[0];
  const metricsArray = res.locals.webMetrics[selectedApp.name].metrics;
  const insightsArray = res.locals.insightsMetrics[0].metrics;
  const metricsObj = {};
  insightsArray.forEach((insight) => {
    metricsArray.push(insight);
  });
  res.locals.appDetail = {
    name: selectedApp.name,
    id: selectedApp.id,
    resourceGroupId: selectedApp.resourceGroupId,
    resourceGroupName: selectedApp.resourceGroupName,
    location: selectedApp.location,
    metrics: metricsArray,
  };
  return next();
};

sdkController.setFunctionApp = (req, res, next) => {
  // Both single-function and multi-function routes should be relying on same data in res.locals.
  const { name, id, location, insightId, resourceGroupId, resourceGroupName, workSpaceId } = req.body;
  res.locals.functionApps = [];
  res.locals.functionApps.push({
    name: name,
    id: id,
    resourceGroupId: resourceGroupId,
    resourceGroupName: resourceGroupName,
    location: location,
    insightId: insightId,
    workSpaceId: workSpaceId,
  });
  res.locals.executionOnly = false;
  return next();
};

sdkController.setFunction = (req, res, next) => {
  const { workSpaceId, functionName } = req.body;
  res.locals.azure = {
    specificFunction: {
      azureLogAnalyticsWorkspaceId: workSpaceId,
      functionName: functionName,
    },
  };
  return next();
};

sdkController.setResource = (req, res, next) => {
  const { subscription, resourceGroupName, appName } = req.body;
  res.locals.azure = {
    functionData: {
      subscriptionIdentifier: subscription,
      resourceGroupName: resourceGroupName,
      appName: appName,
    },
  };
  return next();
};

export default sdkController;
