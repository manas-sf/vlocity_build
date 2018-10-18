var yaml = require('js-yaml');
var fs = require('fs-extra');
var path = require('path');
var mustache = require('mustache');

var ValidationTest = module.exports = function(vlocity) {
    this.vlocity = vlocity || {};
    this.testJobInfo = {};
};

ValidationTest.prototype.validate = async function(jobInfo, currentContextData) {
    var self = this;

    self.testJobInfo = {
        jobInfo : jobInfo,
        PricebookEntries : {},
        tests : {},
        cleanTestData : jobInfo.cleanTestData,
        errorHappen: false
    };

    self.config = self.loadConfig();
    self.vlocityMatchingKeys = await self.vlocity.utilityservice.getAllDRMatchingKeys();
    var allTests = self.loadAllTests(jobInfo);
    var runTestData = await self.groupRunTestData(jobInfo, currentContextData, allTests);
    var promisesArray = [];

    for (var testUniqueKey in runTestData) {
        if (runTestData[testUniqueKey]) {
            runTestData[testUniqueKey].testUniqueKey = testUniqueKey;
            promisesArray.push(self.runTest(runTestData[testUniqueKey]));
        }
    }

    const promises = await self.vlocity.utilityservice.parallelLimit(promisesArray, 20);
    await Promise.all(promises);
    self.printTestReport(jobInfo);
};

ValidationTest.prototype.groupRunTestData = async function(jobInfo, currentContextData, allTests) {
    var self = this;
    var runTestData = {};

    for (var y = 0; y < currentContextData.length; y++) {
        var dataPackType = currentContextData[y].VlocityDataPackType;
        var dataPack = this.vlocity.utilityservice.getDataPackData(currentContextData[y]);

        if (dataPackType && dataPack) {
            var tests = {};
            
            if (allTests['All']) {
                tests = JSON.parse(JSON.stringify(allTests['All']));
            }

            if (allTests[dataPackType]) {
                if (!tests) {
                    tests = JSON.parse(JSON.stringify(allTests[dataPackType]));
                } else {
                    tests = self.vlocity.utilityservice.mergeMaps(tests, JSON.parse(JSON.stringify(allTests[dataPackType])));
                }
            }

            for (var fileName in tests) {
                var guid = this.vlocity.datapacksutils.guid();
                var testName = fileName.substring(0, fileName.indexOf('.'));
                
                runTestData[guid] = {
                    actions : JSON.parse(JSON.stringify(yaml.safeLoad(tests[fileName]))),
                    dataPack : dataPack,
                    testName : testName,
                };

                if (self['initializeTest' + dataPackType]) {
                    runTestData[guid] = self['initializeTest' + dataPackType](jobInfo, runTestData[guid]);
                }
            }
        }
    }

    return runTestData;
};

ValidationTest.prototype.initializeTestProduct2 = function(jobInfo, runTestData) {
    if (runTestData.dataPack && jobInfo) {
        if (!jobInfo.defaultPriceList) {
            this.testJobInfo.errorHappen = true;
            return VlocityUtils.error('Default PriceList Missing', 'VlocityRecordSourceKey', runTestData.dataPack.VlocityRecordSourceKey);
        }

        this.testJobInfo.defaultPriceList = jobInfo.defaultPriceList;
        var globalKeys = this.getDataPacksGlobalKeys([runTestData.dataPack]);

        if (!globalKeys || !globalKeys[0]) {
            this.testJobInfo.errorHappen = true;
            return VlocityUtils.error('Global Key Missing', 'VlocityRecordSourceKey', runTestData.dataPack.VlocityRecordSourceKey);
        }
        
        runTestData.dataPackUniqueKey = globalKeys[0];
    }

    return runTestData;
};

ValidationTest.prototype.loadAllTests = function(jobInfo) {  
    var tests;

    try {
        tests = JSON.parse(JSON.stringify(this.vlocity.datapacksutils.loadFilesFromDir(path.join(jobInfo.projectPath, '..', 'test', 'vlocitytests'), 'vlocitytests')));
    } catch(e)  {}

    var defaultTests = JSON.parse(JSON.stringify(this.vlocity.datapacksutils.loadFilesFromDir(path.join(__dirname, '..', 'test', 'validationtest'), 'validationtest')));

    if (tests) {
        for (var key in tests) {
            if (defaultTests[key]) {
                for (var fileName in tests[key]) {
                    if (defaultTests[key][fileName]) {
                        this.testJobInfo.errorHappen = true;
                        return VlocityUtils.error('Configuration Error', 'Please rename the test file', key, fileName);
                    }

                    defaultTests[key][fileName] = tests[key][fileName];
                }
            } else {
                defaultTests[key] = tests[key];
            }
        }
    }
    
    return this.filterTestsByType(defaultTests, jobInfo);
};

ValidationTest.prototype.filterTestsByType = function(allTests, jobInfo) {
    var tests = JSON.parse(JSON.stringify(allTests));
    var testsTypes = jobInfo.tests;

    var validateInOrg = false;
    var validateLocally = false;
    var testTypes = {};

    if (testsTypes) {
        for (var i = 0; i < testsTypes.length; i++) {
            var testType = testsTypes[i]; 
            if (testType === 'Org') {
                validateInOrg = true;
            } else if (testType === 'Local') {
                validateLocally = true;
            } else if (testType.includes('/')) {
                if (!testType.includes('.yaml')) {
                    testType = testType + '.yaml';
                }

                testTypes[testType] = '';
            }
        }
    }

    for (var dataPackType in tests) {
        for (var fileName in tests[dataPackType]) {
            var data = tests[dataPackType][fileName];
            var actions = yaml.safeLoad(data);
            var uniqueKey = dataPackType + '/' + fileName;

            if (uniqueKey && testTypes.hasOwnProperty(uniqueKey)) {
                continue;
            } else if (actions && actions[0] && actions[0].Action) {
                var firstAction = actions[0].Action;

                if (!((firstAction === 'Org' && validateInOrg)
                    || (firstAction === 'Local' && validateLocally))) {
                    delete tests[dataPackType][fileName];
                }
            } else {
                delete tests[dataPackType][fileName];
            }
        }
    }

    return tests;
};

ValidationTest.prototype.runTest = async function(testDataToRunAgainst) {
    var self = this;
    var actions = testDataToRunAgainst.actions;
    var testUniqueKey = testDataToRunAgainst.testUniqueKey;
    var dataPackUniqueKey = testDataToRunAgainst.dataPackUniqueKey;
    var testName = testDataToRunAgainst.testName;
    var vlocityRecordSourceKey = testDataToRunAgainst.dataPack.VlocityRecordSourceKey;

    if (!dataPackUniqueKey) {
        dataPackUniqueKey = testUniqueKey;
    }

    if (actions && testUniqueKey) {
        self.testJobInfo.tests[testUniqueKey] = {
            cleanDataMap : {},
            dataJson : {},
            timeTrackingArray : [],
            dataPackUniqueKey : dataPackUniqueKey, 
            dataPack : testDataToRunAgainst.dataPack,
            testReport: {
                [vlocityRecordSourceKey] : {
                    [testName] : {}
                }
            }
        };

        for (var y = 0; y < actions.length; y++) {
            var obj = actions[y];
            obj.dataPackUniqueKey = dataPackUniqueKey;
            obj.testUniqueKey = testUniqueKey;
            obj.dataPack = testDataToRunAgainst.dataPack;
            obj.vlocityRecordSourceKey = vlocityRecordSourceKey;
            obj.testName = testName;
            
            self.testJobInfo.tests[testUniqueKey].actionFailed = false;
            self.testJobInfo.tests[testUniqueKey].actionMessage = '';

            if (obj && obj.Action) {
                var result;
                var action = obj.Action;

                if (self.vlocity.validationtest[action]) {
                    self.startTimer(obj);
                    
                    result = await self.vlocity.validationtest[action](obj);
                    
                    self.endTimer(obj);

                    if (!this.testJobInfo.tests[obj.testUniqueKey].actionFailed
                        && self.doAssert(obj)) {
                        self.assert(obj, result);
                    }

                    self.createActionReport(obj);

                    if (this.stopTestCheck(obj)) {
                        break;
                    }
                }
            }
        }
    }
};

ValidationTest.prototype.stopTestCheck = function(obj) {
    if (this.testJobInfo.tests[obj.testUniqueKey].actionFailed) {
        if (this.testJobInfo.cleanTestData) {
            this.cleanDataAll(obj);
        }

        return true;
    }

    return false;
};

ValidationTest.prototype.startTimer = function(action) {
    if (action.TimeTrack) {
        var actionStartTimer = {[action.Action] : new Date()};
        var elapsedTimeTrackingArray = this.testJobInfo.tests[action.testUniqueKey]
            .testReport[action.vlocityRecordSourceKey][action.testName].ElapsedTimeTracking;

        if (!elapsedTimeTrackingArray) {
            elapsedTimeTrackingArray = [];
        }

        elapsedTimeTrackingArray.push(actionStartTimer);

        this.testJobInfo.tests[action.testUniqueKey]
            .testReport[action.vlocityRecordSourceKey][action.testName].ElapsedTimeTracking = elapsedTimeTrackingArray;
    }
};

ValidationTest.prototype.endTimer = function(action) {
    if (action.TimeTrack) {
        var elapsedTimeTrackingArray = this.testJobInfo.tests[action.testUniqueKey]
            .testReport[action.vlocityRecordSourceKey][action.testName].ElapsedTimeTracking;

        if (elapsedTimeTrackingArray) {
            var timeTrackingSize = elapsedTimeTrackingArray.length;
            var startTime = elapsedTimeTrackingArray[timeTrackingSize-1][action.Action];
            var actionEndTimer = {[action.Action] : new Date() - startTime};

            elapsedTimeTrackingArray[timeTrackingSize-1] = actionEndTimer;
            this.testJobInfo.tests[action.testUniqueKey]
                    .testReport[action.vlocityRecordSourceKey][action.testName].ElapsedTimeTracking = elapsedTimeTrackingArray;
        }
    }
};

ValidationTest.prototype.saveReportLocally = function() {
    var testReport = this.createResponse();
    fs.outputFileSync(path.join('vlocity-temp', 'validationTest', this.testJobInfo.jobInfo.logName), yaml.dump(testReport.records), 'utf8');
};

ValidationTest.prototype.createResponse = function(failuresOnly) {
    var records = [];
    var reportMap = {};

    for (var testUniqueKey in this.testJobInfo.tests) {
        for (var dataPackKey in this.testJobInfo.tests[testUniqueKey].testReport) {    
            if (!reportMap.hasOwnProperty(dataPackKey)) {
                reportMap[dataPackKey] = {};
            } 

            var dataPackKeyData = this.testJobInfo.tests[testUniqueKey].testReport[dataPackKey];

            for (var testName in dataPackKeyData) {
                if (failuresOnly) {
                    if (!dataPackKeyData[testName].TestResult) {
                        reportMap[dataPackKey][testName] = dataPackKeyData[testName];
                    }
                } else {
                    reportMap[dataPackKey][testName] = dataPackKeyData[testName];
                }
            }
        }
    }

    for (var dataPackKey in reportMap) {
        if (!this.vlocity.utilityservice.isEmptyObject(reportMap[dataPackKey])) {
            records.push({[dataPackKey] :reportMap[dataPackKey]});
        }
    }

    var response = {'records' : records};

    if (this.testJobInfo.errorHappen) {
        response.status = 'error';
    }
    
    return response;
};

ValidationTest.prototype.createActionReport = function(action) {
    var actionFailed = this.testJobInfo.tests[action.testUniqueKey].actionFailed;
    var actionReport = this.testJobInfo.tests[action.testUniqueKey].testReport[action.vlocityRecordSourceKey][action.testName];
    actionReport.TestResult = !actionFailed;

    if (actionFailed) {
        actionReport.FailedAction = {
            ActionName: action.Action, 
            Message: this.testJobInfo.tests[action.testUniqueKey].actionMessage
        };
    }

    this.testJobInfo.tests[action.testUniqueKey].testReport[action.vlocityRecordSourceKey][action.testName] = actionReport;
    this.saveReportLocally();
    return this.testJobInfo.tests[action.testUniqueKey].testReport;
};

ValidationTest.prototype.printTestReport = function(jobInfo) {
    if (!this.testJobInfo.errorHappen) {
        VlocityUtils.success('Validation Test Completed');
    } else {
        jobInfo.hasError = true;
        VlocityUtils.error('Validation Test Failed');
    }

    var testResults = this.createResponse(true).records;

    if (testResults && testResults.length > 0) {
        VlocityUtils.success('Summary', yaml.dump(testResults));
    }

    VlocityUtils.verbose('Summary', yaml.dump(this.createResponse().records));
};

ValidationTest.prototype.query = async function(action) {
   var queryString = mustache.render(action.Query, action.dataPack);
   queryString = this.vlocity.utilityservice.checkNamespacePrefix(queryString);
   return await this.vlocity.queryservice.query(queryString);
};

ValidationTest.prototype.validateDataPackFields = function(action) {
    return this.testJobInfo.tests[action.testUniqueKey].dataPack;
};

ValidationTest.prototype.createCart = async function(action) {
    action.SObject = action.Type;
    var result = await this.createSObject(action);
    this.testJobInfo.tests[action.testUniqueKey].dataJson['createCart'] = result;
    return result;
};

ValidationTest.prototype.createSObject = async function(action) {
    var sObjectType = action.SObject;
    
    var sObject = await this.buildSObject(action);
    var result;

    try {
        result = await this.vlocity.utilityservice.createSObject(sObjectType, sObject);   
    } catch (e) {
        this.testJobInfo.tests[action.testUniqueKey].actionFailed = true;
        this.testJobInfo.tests[action.testUniqueKey].actionMessage = e;
        this.testJobInfo.errorHappen = true;
        return;
    }
     
    var sObjectRetrieved = await this.retrieveSObject(sObjectType, result.id);
    this.addToCleanUpMap(action, sObjectType, sObjectRetrieved);
    this.testJobInfo.tests[action.testUniqueKey].dataJson['createSObject' + sObjectType] = sObjectRetrieved;
    return sObjectRetrieved;
};

ValidationTest.prototype.getCartItems = async function(action) {
    var self = this;
    var dataJson = self.testJobInfo.tests[action.testUniqueKey].dataJson;
    var cartId = dataJson.createCart.Id;

    var result = await new Promise(function(resolve, reject) {
        self.vlocity.jsForceConnection.apex.get(self.buildBaseURL() + "/carts/" + cartId + "/items", function(err, result) {
            if (err || !result) {
                self.failTest(action, err.message);
                VlocityUtils.error('Get Cart Items Failed', err.message);
            }

            resolve(result);
        });
    });

    self.testJobInfo.tests[action.testUniqueKey].dataJson['getCartItems'] = result;
    return result;
};

ValidationTest.prototype.getCartsProducts = async function(action) {
    var self = this;
    var dataJson = self.testJobInfo.tests[action.testUniqueKey].dataJson;
    var cartId = dataJson.createCart.Id;

    var result = await new Promise(function(resolve, reject) {
        self.vlocity.jsForceConnection.apex.get(self.buildBaseURL() + "/carts/" + cartId + "/products", function(err, result) {
            if (err || !result) {
                self.failTest(action, err.Message);
                VlocityUtils.error('Get Cart Products Failed', err.message);
            }

            resolve(result);
        });
    });

    self.testJobInfo.tests[action.testUniqueKey].dataJson['getCartsProducts'] = result;
    return result;
};

ValidationTest.prototype.deleteCartItems = async function(action) {
    var self = this;
    var dataJson = self.testJobInfo.tests[action.testUniqueKey].dataJson;
    var deleteCartItems = '';
    var cartId = dataJson.createCart.Id;
    var cartItems = dataJson.getCartItems.records;

    for (var i = 0; i < cartItems.length; i++) {
        deleteCartItems = deleteCartItems + cartItems[i].Id.value;

        if (i < cartItems.length-1) {
            deleteCartItems = deleteCartItems + ',';
        }
    }

    return await new Promise(function(resolve, reject) {
        self.vlocity.jsForceConnection.apex.del(self.buildBaseURL() + "/carts/" + cartId + "/items?id=" + deleteCartItems, function(err, result) {
            resolve(result);
        });
    });
};

ValidationTest.prototype.failTest = function(action, message) {
    this.testJobInfo.errorHappen = true;
    this.testJobInfo.tests[action.testUniqueKey].actionFailed = true;
    this.testJobInfo.tests[action.testUniqueKey].actionMessage = message;
};

ValidationTest.prototype.addProduct = async function(action) {
    var self = this;
    var dataJson = self.testJobInfo.tests[action.testUniqueKey].dataJson;
    var cartId = dataJson.createCart.Id;
    var productGlobalKey = action.dataPackUniqueKey;
    var pricebookId = dataJson.createCart.Pricebook2Id;
    
    if (!self.testJobInfo.PricebookEntries[pricebookId]) {
        self.testJobInfo.PricebookEntries[pricebookId] = {};
    }

    var pricebookEntryId = self.testJobInfo.PricebookEntries[pricebookId][productGlobalKey];

    if (!pricebookEntryId) {
        var queryString = self.vlocity.queryservice.buildSOQL('Id', 'PricebookEntry', "Product2Id IN (SELECT Id FROM Product2 WHERE %vlocity_namespace%__GlobalKey__c = '" + productGlobalKey + "') AND Pricebook2Id = '" + pricebookId + "' LIMIT 1");
        var result = await self.vlocity.queryservice.query(queryString);
               
        if (!result || result.totalSize == 0) {
            self.failTest(action, 'Pricebook Entry Not Found');
            return VlocityUtils.error('Not Found', 'PricebookEntry', queryString);
        } else {
            pricebookEntryId = result.records[0].Id;
            self.testJobInfo.PricebookEntries[pricebookId][productGlobalKey] = pricebookEntryId;
        }
    }

    var body = {items: [{itemId:pricebookEntryId}]};    

    var result = await new Promise(function(resolve, reject) {
        self.vlocity.jsForceConnection.apex.post(self.buildBaseURL() + "/carts/" + cartId + "/items", body, function(err, result) {
            if (err || !result) {
                self.failTest(action, err.message);
                VlocityUtils.error('Add To Cart Failed', body, err.message);
            }
                
            if (result.messages) {
                if (result.messages[0].message
                    && result.messages[0].message !== 'Successfully added.') {
                        self.failTest(action, result.message);
                        VlocityUtils.error('Add To Cart Failed', result.messages);
                }
            }

            resolve(result);
        });
    });

    self.testJobInfo.tests[action.testUniqueKey].dataJson['addProduct'] = result;
    return result;
};

ValidationTest.prototype.addToCleanUpMap = function(action, name, result) {
    var value = new Array();

    if (result && result.Id) {
        if (this.testJobInfo.tests[action.testUniqueKey].cleanDataMap.hasOwnProperty(name)) {
            value = this.testJobInfo.tests[action.testUniqueKey].cleanDataMap[name];
        }

        value.push(result.Id);
        this.testJobInfo.tests[action.testUniqueKey].cleanDataMap[name] = value;
    }
};

ValidationTest.prototype.retrieveSObject = async function(name, id) {
    var self = this;
    return await new Promise(function(resolve, reject) {
        self.vlocity.jsForceConnection.sobject(name).retrieve(id, function(err, result) {
            if (err) {
                self.testJobInfo.errorHappen = true;
                VlocityUtils.error('Can Not Retrieve SObject', name, object, err.message);
            }

            resolve(result);
        });
    });
};

ValidationTest.prototype.cleanDataAll = async function(action) {
    for (var sObjectName in this.testJobInfo.tests[action.testUniqueKey].cleanDataMap) {
        await this.destroySObject(sObjectName, this.testJobInfo.tests[action.testUniqueKey].cleanDataMap[sObjectName]);
    }
};

ValidationTest.prototype.destroySObject = async function(sObjectName, ids) {
    var self = this;

    return await new Promise(function(resolve, reject) {
        self.vlocity.jsForceConnection.sobject(sObjectName).destroy(ids, function(err, result) {
            if (err && err.message !== 'entity is deleted') {
                self.testJobInfo.errorHappen = true;
                VlocityUtils.error('Delete Failed', sObjectName, ids, err.message);
            }

            if (result) { 
                VlocityUtils.verbose('Successfully Deleted', sObjectName, ids.toString());
            }

            resolve(result);
        });
    });
};

ValidationTest.prototype.getPricelist = async function() {
    var queryString = this.vlocity.queryservice.buildSOQL('Id,%vlocity_namespace%__Code__c', '%vlocity_namespace%__PriceList__c', "%vlocity_namespace%__Code__c = '" + this.testJobInfo.defaultPriceList + "'");
    var result = await this.vlocity.queryservice.query(queryString);
        
    if (!result || result.records.length === 0) {
        this.testJobInfo.errorHappen = true;
        return VlocityUtils.error('Not Found', 'Price List', this.testJobInfo.defaultPriceList);
    }
    
    return result.records[0].Id;
};

ValidationTest.prototype.parseFunctionVal = async function(value, dataJson, action) {
    if (!this.testJobInfo.tests[action.testUniqueKey].hashValues) {
        this.testJobInfo.tests[action.testUniqueKey].hashValues = {};
    }

    if (this.testJobInfo.tests[action.testUniqueKey].hashValues[value]) {
        return this.testJobInfo.tests[action.testUniqueKey].hashValues[value];
    }

    if (value == 'TODAY()') {
        valueRes = new Date();
    } else if (value == 'ACCOUNT()') {
        valueRes = dataJson.createSObjectAccount.Id
    } else if (value == 'PRICELIST()') {
        valueRes = await this.getPricelist();
    } else {
        return value;
    }

    this.testJobInfo.tests[action.testUniqueKey].hashValues[value] = valueRes;
    return valueRes;
};

ValidationTest.prototype.buildSObject = async function(action) {
    var dataJson = this.testJobInfo.tests[action.testUniqueKey].dataJson;
    var sObjectType = action.SObject;
    var sObjectConfig = JSON.parse(JSON.stringify(this.config[sObjectType]));
    
    for (key in sObjectConfig) {
        var value = action[key];
        
        if (!value) {
            value = sObjectConfig[key];
        }

        sObjectConfig[key] = await this.parseFunctionVal(value, dataJson, action);
    }

    return sObjectConfig;
};

// ----- ASSERTS -----
ValidationTest.prototype.doAssert = function(action) {
    return action && action.Assert;
};

ValidationTest.prototype.assert = async function(action, result) {
    if (action && result) {
        var assert = action.Assert;

        for (var key in assert) {
            if (this['assert' + key])   {
                this['assert' + key](action, result, assert);
            } else {
                this.assertEquals(action, result[key], assert[key], action.Action + ' ' + key);
            }
        }
    }
};

ValidationTest.prototype.assertfields = async function(action, result, assert) {
    var key = 'fields';
    for (var field in assert[key]) {
        this.assertEquals(action, result[field], assert[key][field], action.Action + ' ' + field);    
    }
};

ValidationTest.prototype.asserttotalSize = async function(action, result, assert) {
    var key = 'totalSize';
    if (typeof(assert[key]) == 'string') {
        this.compare(action, result[key], assert[key], action.Action + ' ' + key);
    } else {
        this.assertEquals(action, result[key], assert[key], action.Action + ' ' + key);
    }
};

ValidationTest.prototype.compare = function(action, actualVal, expectedVal, message) {
    var values = expectedVal.split(' ');

    var num;
    var compar;
    for (var i = 0; i < values.length; i++) {
        if (!isNaN(values[i])) {
            num = +values[i];
        } else {
            compar = values[i];
        }
    }

    switch(compar) {
        case '>': 
            this.assertTrue(action, actualVal > num, message + ' actual value: ' + actualVal + ' is not > ' + num);
            break;
        case '<':
            this.assertTrue(action, actualVal < num, message + ' actual value: ' + actualVal + ' is not < ' + num);
            break;
        case '>=':
            this.assertTrue(action, actualVal >= num, message + ' actual value: ' + actualVal + ' is not "=> ' + num + '"');
            break;
        case '<=':
            this.assertTrue(action, num <= actualVal, message + ' actual value: ' + actualVal + ' is not "=< ' + num + '"');
            break;
    }
};

ValidationTest.prototype.assertmatchingKey = async function(action, dataPack, assert) {
    var matchingKeyField = this.vlocityMatchingKeys[dataPack.VlocityRecordSObjectType];
    var assertVal = assert['matchingKey'];
    if (this['assert' + assertVal]) {
        this['assert' + assertVal](action, dataPack, matchingKeyField);
    }
};

ValidationTest.prototype.assertNotNull = async function(action, dataPack, matchingKeyField) {
    this.vlocity.validationtest.assertTrue(action, (dataPack[matchingKeyField] !== null && dataPack[matchingKeyField] !== ''), 'Value is null.');
};

ValidationTest.prototype.assertNoDuplicates = async function(action, dataPack, matchingKeyField) {
    this.vlocity.validationtest.checkMatchingKeysDuplicate(dataPack, matchingKeyField);
    this.testJobInfo.matchingKeysMap = {};
};

ValidationTest.prototype.findAllDataPacks = function(dataPack) {
    var dataPackCloned = JSON.parse(JSON.stringify(dataPack));

    for (key in dataPackCloned) {
        if (dataPackCloned[key]
            && dataPackCloned[key] instanceof Array
            && dataPackCloned[key][0]
            && dataPackCloned[key][0] instanceof Object) {
                var matchingKeyField = this.vlocityMatchingKeys[dataPackCloned[key][0].VlocityRecordSObjectType];
                this.vlocity.validationtest.checkMatchingKeysDuplicate(dataPackCloned[key][0], matchingKeyField);
        }
    }
};

ValidationTest.prototype.checkMatchingKeysDuplicate = function(dataPack, matchingKeyField) {
    var dataPackUniqueKey = '';
    
    if (!matchingKeyField) {
        this.testJobInfo.errorHappen = true;
        VlocityUtils.error('Matching Key Field Missing',  dataPack.VlocityRecordSObjectType + ' has missing key for ' + dataPack.VlocityDataPackSObjectType + ' with Name: ', dataPack.Name);
    } else {
        if (matchingKeyField.includes(',')) {
            matchingKeyField = matchingKeyField.split(',');
    
            for (var i = 0; i < matchingKeyField.length; i++) {
                if (dataPack[matchingKeyField[i]] instanceof Object) {
                    if (dataPack[matchingKeyField[i]].VlocityMatchingRecordSourceKey) {
                        dataPackUniqueKey += dataPack[matchingKeyField[i]].VlocityMatchingRecordSourceKey;
                    } else if (dataPack[matchingKeyField[i]].VlocityLookupRecordSourceKey) {
                        dataPackUniqueKey += dataPack[matchingKeyField[i]].VlocityLookupRecordSourceKey;
                    }   
                } else {
                    dataPackUniqueKey += dataPack[matchingKeyField[i]] ? dataPack[matchingKeyField[i]] : null;
                }
            }
        } else {
            dataPackUniqueKey = dataPack.VlocityRecordSObjectType + dataPack[matchingKeyField];
        }
    
        if (!this.testJobInfo.matchingKeysMap) {
            this.testJobInfo.matchingKeysMap = {};
        }
        
        if (this.testJobInfo.matchingKeysMap[dataPackUniqueKey]) {
            this.vlocity.validationtest.assertTrue(action, false, 'Duplicate Found');
        }
    
        if (dataPackUniqueKey !== '') {
            this.testJobInfo.matchingKeysMap[dataPackUniqueKey] = '';
            this.vlocity.validationtest.findAllDataPacks(dataPack);
        }
    }
};

ValidationTest.prototype.assertTrue = function(action, actual, message) {
    if (!actual) {
        this.failTest(action, message);
        VlocityUtils.error('Assert Failed', message);
    }
}

ValidationTest.prototype.assertEquals = function(action, actual, expected, message) {
    if (actual !== expected) {
        this.failTest(action, 'Assert Failed ' + message + ' Actual Result ' + actual + ' Expected Result ' + expected);
        VlocityUtils.error('Assert Failed', message, 'Actual Result', actual, 'Expected Result', expected);
    }
}

ValidationTest.prototype.buildBaseURL = function() {
    return "/services/apexrest/" + this.vlocity.namespace + "/v2/cpq";
};

ValidationTest.prototype.getDataPacksGlobalKeys = function(dataPacks) {
    var globalKeys = [];

    if (dataPacks) {
        for (var i = 0; i < dataPacks.length; i++) {
            var dataPackData = dataPacks[i];
            if (dataPackData) {
                globalKeys.push(dataPackData['%vlocity_namespace%__GlobalKey__c']);
            }
        }
    }

    return globalKeys;
};

ValidationTest.prototype.loadConfig = function() {
    var result = yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'validationtestsettings.yaml'), 'utf8')); 
    result = this.vlocity.utilityservice.checkNamespacePrefix(result);
    return result;
};