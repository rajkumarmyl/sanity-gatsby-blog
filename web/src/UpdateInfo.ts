import { FunctionShield, FunctionInvoke, IContext, Logger, IEvent, AdTokenHelper, AdTokenHelperProps, LoggerTypes } from '@clublabs/aws-lambda';
import {
  createLambdaResponse, LambdaResponse, CommonGatewayType, getCommonApiDomain, getCommonGatewayId
} from '@lib/common';
import {
  extractTestRegionFromEvent, HeaderKeys, MulesoftHelper, MulesoftSecret, MulesoftSecretsHelper,
  MulesoftBrokerOperations, executeGetCall, executePostCall
} from '@lib/network';
import { UpdateAddressRequest, UpdateAddressResponse } from '@lib/web-contracts';
import { ServiceError, createRequestHeaders, ConfigOptions } from '@lib/utility';
import { StatusCode } from 'status-code-enum';
import { InputArguments } from './contracts/MaintainMembershipProfileContract';
import _ from 'lodash';
import { NewAddress } from '@lib/web-contracts';
import { ConfirmEmail } from './models/ConfirmEmail';

const AWSXRay = require('aws-xray-sdk-core');
AWSXRay.captureAWS(require('aws-sdk'));

FunctionShield.configure();//Disables http calls
const logger = Logger.getInstance();
const functionInvoke = new FunctionInvoke();
const SECRET_ID = 'commonservices/secrets/team/acechatbot';

const endpoints = {
  customerAddresses: `/customer-addresses/`,
  policy: `/policy/`,
  recordPolicyNotes: `/record-policy-notes`,
  customerDetails: `/customer-details/`,
  customerDetailsV2: `/v2/customer-details/`,
  sendEmail: '/send-email'
}

type PolicyNote = { policyNumber: string, notes: string[] };

var policyNote: PolicyNote;
let confirmEmail: ConfirmEmail;

const inputArgumentsFixture: any = {
  CallCreateNewCustomer: 'N',
  CallUpdMemberPhoneEmail: 'N',
  CallUpdCustAddress: 'Y',
  CallUpdCustCommPref: 'N',
  TraceLevel: '',
  EmployeeNumber: '40312',
  EmployeeClubCode: '004',
  EmployeeSection: 'SL',
  DistrictOffice: '15',
  SourceCode: '01',
  RequestedBy: 'AddressChange',
  ApprovedBy: '',
  ChangeMembershipHousehold: '',
  MembershipAddrRole1: "ML",
  NewCountyCode: '',
  NewCountryName: '',
  NewCountry: "",

  NewAttnCo: "",
  NewOverrideIndicator: "N",
  NewMailStop: '',
  NewMailCode: '',
  NewEffectiveDate: '',
  NewExpirationDate: '',

};

enum AddrRole {
  MB = 'MB',
  RS = 'RS',
  ML = 'ML',
  RI = 'RI'
}

/**
 * @deprecated This method is no longer in use because the send-email lambda 
 * is now available within common-utils. We no longer need to use the payments team implementation.
 * Upon deletion, make sure to remove PAYMENT_ACCOUNT_ID and any of its references; including in deploy pipelines and yaml files.
 */
export const invokeSendEmailLambda = async (confirmEmail: ConfirmEmail) => {
  const paymentSendMailArn = `arn:aws:lambda:${process.env.AWS_REGION}:${process.env.PAYMENT_ACCOUNT_ID}:function:send-email`;
  const etResponse = await functionInvoke.invoke(paymentSendMailArn, confirmEmail, logger.getClientContext());
  const response = JSON.parse(etResponse.Payload.toString());
  return response;
}

export const sendEmail = async (invokedFunctionArn: string, payload, context?: IContext, mulesoftSecret?: MulesoftSecret, requestHeaders?: ConfigOptions) => {
  let gatewayId = getCommonGatewayId(CommonGatewayType.utils, invokedFunctionArn);
  const url = `${getCommonApiDomain(invokedFunctionArn)}${endpoints.sendEmail}`;
  return executePostCall(url, gatewayId, payload, null, context, requestHeaders, mulesoftSecret.clientId, mulesoftSecret.clientSecret);
}

export const getClientNumberFromPolicy = (policyResponse: JSON, customerId: string): string => {
  let resultArray = [];
  
  searchJson(policyResponse, 'ClientNumber', 'Sequence', ['0001', '0002', '0', '00', '1', '01'], qualifySearch, resultArray);
  var clientNumber = '';
  for (var item of resultArray) {
    if (item['Membership']['CustId'] === customerId) {
      clientNumber = item['ClientNumber'];
      // we are getting preferred email from customer details. Not using this email anymore
      //confirmEmail.email = item['Membership']['eMail'];
    }
    break;
  }
  if (clientNumber === '') {
    clientNumber = resultArray[0].ClientNumber;
    //confirmEmail.email = resultArray[0]['Membership']['eMail'];
  }
  return clientNumber;
}

export const getInputArgumentAddress = (useCase: UseCase, custIdArray: string[], customerId: string, memberNumber: string, clubCode: string, address, policyNumber?: string, policyAddrRisk?: []): any => {
  /*
  var inputArguments: any = { ...inputArgumentsFixture, ...{ MembershipClubCode: clubCode, MembershipNumber: memberNumber } };
  */
  var addrType = address.addrType || null;

  var addrRole;
  switch (addrType) {
    case "residence":
      addrRole = AddrRole.RS;
      //inputArguments.ChangeMembershipHousehold = 'Y';
      break;
    case "mailing":
      addrRole = AddrRole.MB;
      break;
    case "risk":
      addrRole = AddrRole.RI;
    //inputArguments.ChangeMembershipHousehold = 'Y';
  }

  switch (useCase) {
    case UseCase.MembershipOnlySameAddress:
      //inputArguments.ChangeMembershipHousehold = '';
      if (custIdArray.length == 0) { // mailing address
        var customerList: any = {
          CustomerList1: {
            CustomerNumber: customerId,
            //MemberRoleCode: "ML",
            CustomerAddressRole1: "RS",
            CustomerAddressRole2: "MB"
          }
        }
        //return { ...inputArguments, ...customerList };
        return customerList;
      } else { // residence address, need to update the household residence
        var customerLists = {};
        for (let i = 0; i < custIdArray.length; i++) {
          var customerListx: string = `CustomerList${i + 1}`;
          const object = {
            [customerListx]: {
              CustomerNumber: custIdArray[i],
              CustomerAddressRole1: "RS",
              CustomerAddressRole2: "MB"
            }
          }
          customerLists = { ...customerLists, ...object };
        }
        //return { ...inputArguments, ...customerLists };
        return customerLists;
      }

    case UseCase.MembershipOnlyDiffAddress:
      //inputArguments.ChangeMembershipHousehold = '';

      if (custIdArray.length == 0) {
        var customerList: any = {
          CustomerList1: {
            CustomerNumber: customerId,
            //MemberRoleCode: "ML",
            CustomerAddressRole1: addrRole,
          }
        }
        //return { ...inputArguments, ...customerList };
        return customerList;

      } else {
        var customerLists = {};
        for (let i = 0; i < custIdArray.length; i++) {
          var customerListx: string = `CustomerList${i + 1}`;
          const object = {
            [customerListx]: {
              CustomerNumber: custIdArray[i],
              CustomerAddressRole1: "RS",
            }
          }
          customerLists = { ...customerLists, ...object };
        }
        //return { ...inputArguments, ...customerLists };
        return customerLists;
      }

    case UseCase.MembershipOnlyMailingOnly:      
    if (custIdArray.length == 0) { // mailing address
      var customerList: any = {
        CustomerList1: {
          CustomerNumber: customerId,
          CustomerAddressRole1: "MB",
        }
      }
      return customerList;
    } else { // per Darren: Backend allows it but with our UI, there's no way to indicate which member in the household gets a different mailing address so I believe we're updating all members with the same mailing address. The chat bubble on the first page says that's what we're going to do so hopefully that's how it's behaving.
      var customerLists = {};
      for (let i = 0; i < custIdArray.length; i++) {
        var customerListx: string = `CustomerList${i + 1}`;
        const object = {
          [customerListx]: {
            CustomerNumber: custIdArray[i],
            CustomerAddressRole1: "MB",
          }
        }
        customerLists = { ...customerLists, ...object };
      }
      return customerLists;
    }

    case UseCase.MembershipOnlyResidenceOnly:
      if (custIdArray.length == 0) { // residence address
        var customerList: any = {
          CustomerList1: {
            CustomerNumber: customerId,
            CustomerAddressRole1: "RS",
          }
        }
        return customerList;
      } else { // residence address, need to update the household residence
        var customerLists = {};
        for (let i = 0; i < custIdArray.length; i++) {
          var customerListx: string = `CustomerList${i + 1}`;
          const object = {
            [customerListx]: {
              CustomerNumber: custIdArray[i],
              CustomerAddressRole1: "RS",
            }
          }
          customerLists = { ...customerLists, ...object };
        }
        return customerLists;
      }

    case UseCase.InsuranceSameAddress:
      //inputArguments.ChangeMembershipHousehold = '';
      // using this flag is quite dangerous as the backend sometimes checks the feature flag and will refuse to 
      // perform update.
      var policyList: any = generatePolicyList(useCase, policyNumber, clubCode, policyAddrRisk);
      return policyList;

    case UseCase.InsuranceMailingOnly:
      var policyList: any = generatePolicyList(useCase, policyNumber, clubCode, policyAddrRisk);
      return policyList;

    case UseCase.InsuranceResidenceOnly:
      var policyList: any = generatePolicyList(useCase, policyNumber, clubCode, policyAddrRisk);
      return policyList;
  }
}

export const generatePolicyList = (useCase: UseCase, policyNumber: string, clubCode: string, policyAddrRisk: any[]): any => {
  var policyList: any = {
    PolicyList1: {
      PolicyNumber: policyNumber,
      PolicyLobCode: "20",
      PolicyClubCode: clubCode,
      PolicyAddr1Role: "ML",
      PolicyAddr1Risk: "",
    }
  }
  switch (useCase) {
    case UseCase.InsuranceSameAddress:
      if (policyAddrRisk.length > 0 && policyAddrRisk[0] !=='HOME') {
        // auto policy
        for (let i = 0; i < policyAddrRisk.length; i++) {
          //We start from PolicyAddres2Role since PolicyAddr1Role will always be ML
          policyList.PolicyList1[`PolicyAddr${i + 2}Role`] = "RI";
          policyList.PolicyList1[`PolicyAddr${i + 2}Risk`] = policyAddrRisk[i];
        }
      } else {
        // HOME policy
        /*
        for (let i = 0; i < policyAddrRisk.length; i++) {
          // We start from PolicyAddres2Role since PolicyAddr1Role will always be ML
          // to change different 
          policyList.PolicyList1[`PolicyAddr${i + 2}Role`] = "RI";
          policyList.PolicyList1[`PolicyHuonAddr${i + 2}Risk`] = policyAddrRisk[i];
        }
        */
        policyList = {
          PolicyList1: {
            PolicyNumber: policyNumber,
            PolicyLobCode: "20",
            PolicyClubCode: clubCode,
            PolicyAddr1Role: "ML",
            PolicyHuonAddr1Risk: "",
            //PolicyHuonAddr1Section: "",
            //PolicyHuonAddr1Type: "MA",
            PolicyAddr2Role: "RI",
            //PolicyAddr2MustMatchResI: "N",
            PolicyHuonAddr2Risk: "HOME",
            //PolicyHuonAddr2Section: "TEN"
            //PolicyHuonAddr2Type: "RS"
        }

       }

      }
      return policyList;
    case UseCase.InsuranceResidenceOnly:
      if (policyAddrRisk.length > 0 && policyAddrRisk[0] !=='HOME') {
        // auto policy
        for (let i = 0; i < policyAddrRisk.length; i++) {
          //We start from PolicyAddres1Role since we do not want to update ML
          policyList.PolicyList1[`PolicyAddr${i + 1}Role`] = "RI";
          policyList.PolicyList1[`PolicyAddr${i + 1}Risk`] = policyAddrRisk[i];
        }
      } else {
        // HOME policy
        return {
          PolicyList1: {
            PolicyNumber: policyNumber,
            PolicyLobCode: "20",
            PolicyClubCode: clubCode,
            PolicyAddr1Role: "RI",
            PolicyHuonAddr1Risk: "HOME",
          }
        }
      }
      return policyList;
    case UseCase.InsuranceMailingOnly:
      if (policyAddrRisk.length > 0 && policyAddrRisk[0] !=='HOME') {
        // auto policy
        return policyList;
      } else {
        // home policy
        return {
          PolicyList1: {
            PolicyNumber: policyNumber,
            PolicyLobCode: "20",
            PolicyClubCode: clubCode,
            PolicyAddr1Role: "ML",
            PolicyHuonAddr1Risk: "",
          }
        }
      }
    //case UseCase.InsuranceDiffAddress:
    // this can be done by InsuranceSameAddress + InsuranceMailingOnly
    // so no need to implement it. 
      
  }

}

function getNewAddress(address, clubCode, memberNumber): NewAddress {
  var newAddress: any = { ...inputArgumentsFixture, ...{ MembershipClubCode: clubCode, MembershipNumber: memberNumber } };
  newAddress.NewAddressLine1 = address.NewAddressLine1;
  newAddress.NewAddressLine2 = address.NewAddressLine2 ? address.NewAddressLine2 : '';
  newAddress.NewCity = address.NewCity ? address.NewCity : '';
  newAddress.NewState = address.NewState ? address.NewState : '';
  newAddress.NewZip = address.NewZip ? address.NewZip : '';
  newAddress.NewZipSuffix = address.NewZipSuffix ? address.NewZipSuffix : '';
  return newAddress;
}

function buildPolicyNoteWithAddress(policyNumber: string, fullName: string, newAddress: NewAddress): PolicyNote {
  let note: PolicyNote = {
    'policyNumber': policyNumber,
    'notes':
      [
        //`Web AO: Submitted: person making the change client ID: ${clientId} `,
        `Web AO: Submitted: person making the change: ${fullName} `,
        "Web AO: Submitted: residence, mailing and risk addresses updated. ",
        `Web AO: Submitted: new address: street: ${newAddress.NewAddressLine1} `,
        `Web AO: Submitted: new address: unit: ${(newAddress.NewAddressLine2 == '' || newAddress.NewAddressLine2 == null) ? 'N/A' : newAddress.NewAddressLine2} `,
        `Web AO: Submitted: new address: city: ${newAddress.NewCity} `,
        `Web AO: Submitted: new address: state: ${newAddress.NewState} `,
        `Web AO: Submitted: new address: zip code: ${newAddress.NewZip}`
      ]
  };
  return note;
}

/**
 * @param memberNumber - must be 8 digit number; value will be set to the MembershipNumber property. The payload name
 * is not accurate; do NOT provide the 16 digit membership number.
 */
export const buildUpdateAddressPayloads = (context: IContext, customerId: string, httpBody: any, clubCode: string, custIdArray: string[], requestHeaders: ConfigOptions): InputArguments[] => {
  var payloadList = [];
  var useCase;
  const membershipOnly = httpBody?.membershipOnly || false;

  const addresses = httpBody.newAddresses;
  const residence = { ...addresses.residence, ...{ addrType: 'residence' } };
  const mailing = { ...addresses.mailing, ...{ addrType: 'mailing' } };
  //const risk = { ...addresses.risk, ...{ addrType: 'risk' } };

  const policyNumber = httpBody.policyNumber;
  const memberNumber = httpBody.memberNumber;
  const policyAddrRisk = httpBody.policyAddrRisk || null;//PolicyAddrRisk is the make/model of the car
  logger.debug("policyAddrRisk:", policyAddrRisk);

  if (!membershipOnly)
    useCase = getInsruanceUseCase(context, httpBody, requestHeaders);
  else
    useCase = getUseCase(context, httpBody, requestHeaders);
  logger.debug('useCase: ', useCase);

  switch (useCase) {
    case UseCase.MembershipOnlySameAddress:
      var newAddress: NewAddress = getNewAddress(residence, clubCode, memberNumber);
      //newAddress.ChangeMembershipHousehold = 'Y';
      if (residence.NewAddressLine1 || residence.NewAddressLine2) {
        var addrTypePayload = getInputArgumentAddress(UseCase.MembershipOnlySameAddress, custIdArray, customerId, memberNumber, clubCode, residence);
        var inputArguments = { ...newAddress, ...addrTypePayload };
        payloadList.push(inputArguments);
      } else if (mailing.NewAddressLine1 || mailing.NewAddressLine2) {
        var addrTypePayload = getInputArgumentAddress(UseCase.MembershipOnlySameAddress, [], customerId, memberNumber, clubCode, mailing);
        inputArguments = { ...newAddress, ...addrTypePayload };
        payloadList.push(inputArguments);
      }
      confirmEmail.attributes.setAddressChange1(newAddress);
      break;

    case UseCase.MembershipOnlyDiffAddress:
      if ((residence.NewAddressLine1 || residence.NewAddressLine2) && (mailing.NewAddressLine1 || mailing.NewAddressLine2)) {
        // Important: residence address has to be the first payload because it is required to change all house hold residence to be the same
        // mailing can be different so the ChangeMembershipHouseHold can NOT be set to Y, and it has to be executed last.
        // if you update mailing first, then the second call to update residence will change the household addresses which is not what we want 
        var newResidenceAddress: NewAddress = getNewAddress(residence, clubCode, memberNumber);
        var addrTypePayload = getInputArgumentAddress(UseCase.MembershipOnlyDiffAddress, custIdArray, customerId, memberNumber, clubCode, residence);
        inputArguments = { ...newResidenceAddress, ...addrTypePayload };
        payloadList.push(inputArguments);

        confirmEmail.attributes.setAddressChange1(newResidenceAddress);

        var newMailingAddress: NewAddress = getNewAddress(mailing, clubCode, memberNumber);
        addrTypePayload = getInputArgumentAddress(UseCase.MembershipOnlyDiffAddress, [], customerId, memberNumber, clubCode, mailing);
        inputArguments = { ...newMailingAddress, ...addrTypePayload };
        payloadList.push(inputArguments);

        confirmEmail.attributes.setAddressChange2(newMailingAddress);
      }
      break;

    case UseCase.MembershipOnlyMailingOnly:
      if (mailing.NewAddressLine1 || mailing.NewAddressLine2) {
        var newMailingAddress: NewAddress = getNewAddress(mailing, clubCode, memberNumber);
        addrTypePayload = getInputArgumentAddress(UseCase.MembershipOnlyMailingOnly, custIdArray, customerId, memberNumber, clubCode, mailing);
        inputArguments = { ...newMailingAddress, ...addrTypePayload };
        payloadList.push(inputArguments);

        confirmEmail.attributes.setAddressChange1(newMailingAddress);
      }
      break;

    case UseCase.MembershipOnlyResidenceOnly:
      if (residence.NewAddressLine1 || residence.NewAddressLine2) {
        var newResidenceAddress: NewAddress = getNewAddress(residence, clubCode, memberNumber);
        addrTypePayload = getInputArgumentAddress(UseCase.MembershipOnlyResidenceOnly, custIdArray, customerId, memberNumber, clubCode, residence);
        inputArguments = { ...newResidenceAddress, ...addrTypePayload };
        payloadList.push(inputArguments);

        confirmEmail.attributes.setAddressChange1(newResidenceAddress);
      }
      break;

    case UseCase.InsuranceSameAddress:
      var newRiskAddress: NewAddress = getNewAddress(residence, clubCode, memberNumber);
      newRiskAddress.NewOverrideIndicator = 'Y';
      confirmEmail.attributes.setAddressChange1(newRiskAddress);
      //newRiskAddress.ChangeMembershipHousehold = 'Y';
      if (residence.NewAddressLine1 || residence.NewAddressLine2) {
        if (policyNumber && policyAddrRisk) {
          var addrTypePayload4Policy = getInputArgumentAddress(UseCase.InsuranceSameAddress, [], customerId, memberNumber, clubCode, residence, policyNumber, policyAddrRisk);
          logger.debug("addrTypePayload4Policy: ", addrTypePayload4Policy)
        } else {
          logger.debug("error thrown")
          throw new ServiceError(
            'Schema validation failed. Missing policyNumber and/or policyAddrRisk.',
            context.functionName,
            requestHeaders.requestId,
            StatusCode.ClientErrorBadRequest,
            { awsRequestId: context.awsRequestId }
          );
        }
        //payloadList.push(inputArguments);
        var addrTypePayload4Member = getInputArgumentAddress(UseCase.MembershipOnlySameAddress, custIdArray, customerId, memberNumber, clubCode, residence);
        logger.debug("addrTypePayload4Member: ", addrTypePayload4Member)
        inputArguments = { ...newRiskAddress, ...addrTypePayload4Policy, ...addrTypePayload4Member  };
        payloadList.push(inputArguments);
        var fullName = httpBody.lastName + ', ' + httpBody.firstName;
        policyNote = buildPolicyNoteWithAddress(policyNumber, fullName, newRiskAddress);
      }
      break;
    case UseCase.InsuranceDiffAddress:
      var newRiskAddress: NewAddress = getNewAddress(residence, clubCode, memberNumber);
      var newMailingAddress: NewAddress = getNewAddress(mailing, clubCode, memberNumber);
      //var origMailingAddress: NewAddress = getNewAddress(mailing)
      newRiskAddress.NewOverrideIndicator = 'Y';
      confirmEmail.attributes.setAddressChange1(newRiskAddress);
      confirmEmail.attributes.setAddressChange2(newMailingAddress);
      //newRiskAddress.ChangeMembershipHousehold = 'Y';
      // create payload for mailing. In order not to create a task in work basket, risk and mailing address change broker call need to be executed first.
      // and we have to update both ML and RI in one batched call
      // then we have to push a new broker payload with new mailing address (newMailingAddress) to change ML/MB only

      // first create broker payload for risk + mailing address
      if (residence.NewAddressLine1 || residence.NewAddressLine2) {
        if (policyNumber && policyAddrRisk) {
          var addrTypePayload4Policy = getInputArgumentAddress(UseCase.InsuranceSameAddress, [], customerId, memberNumber, clubCode, residence, policyNumber, policyAddrRisk);
        } else {
          throw new ServiceError(
            'Schema validation failed. Missing policyNumber and/or policyAddrRisk.',
            context.functionName,
            requestHeaders.requestId,
            StatusCode.ClientErrorBadRequest,
            { awsRequestId: context.awsRequestId }
          );
        }
        var addrTypePayload4Member = getInputArgumentAddress(UseCase.MembershipOnlySameAddress, custIdArray, customerId, memberNumber, clubCode, residence);
        inputArguments = { ...newRiskAddress, ...addrTypePayload4Policy, ...addrTypePayload4Member };
        payloadList.push(inputArguments);

        var fullName = httpBody.lastName + ', ' + httpBody.firstName;
        policyNote = buildPolicyNoteWithAddress(policyNumber, fullName, newRiskAddress);
      }
      // second call to update mailing address for policy and all household member's mailing address
      if (mailing.NewAddressLine1 || mailing.NewAddressLine2) {
        if (policyNumber) {
          var addrTypePayload4Mailing = getInputArgumentAddress(UseCase.InsuranceMailingOnly, [], customerId, memberNumber, clubCode, mailing, policyNumber, policyAddrRisk);
        } else {
          throw new ServiceError(
            'Schema validation failed. Missing policyNumber and/or policyAddrRisk.',
            context.functionName,
            requestHeaders.requestId,
            StatusCode.ClientErrorBadRequest,
            { awsRequestId: context.awsRequestId }
          );
        }

        var addrTypePayload4PolicySecondCallMailingOnly = getInputArgumentAddress(UseCase.MembershipOnlyMailingOnly, [], customerId, memberNumber, clubCode, mailing);
        inputArguments = { ...newMailingAddress, ...addrTypePayload4Mailing, ...addrTypePayload4PolicySecondCallMailingOnly };
        payloadList.push(inputArguments);
        policyNote = buildPolicyNoteWithAddress(policyNumber, fullName, newMailingAddress);
      }
    break;
    
    case UseCase.InsuranceMailingOnly:
      var newMailingAddress: NewAddress = getNewAddress(mailing, clubCode, memberNumber);
      confirmEmail.attributes.setAddressChange1(newMailingAddress);
      if (mailing.NewAddressLine1 || mailing.NewAddressLine2) {
        if (policyNumber && policyAddrRisk) {
          var addrTypePayload4Policy = getInputArgumentAddress(UseCase.InsuranceMailingOnly, [], customerId, memberNumber, clubCode, mailing, policyNumber, policyAddrRisk);
        } else {
          throw new ServiceError(
            'Schema validation failed. Missing policyNumber and/or policyAddrRisk.',
            context.functionName,
            requestHeaders.requestId,
            StatusCode.ClientErrorBadRequest,
            { awsRequestId: context.awsRequestId }
          );
        }
        var addrTypePayload4Member = getInputArgumentAddress(UseCase.MembershipOnlyMailingOnly, custIdArray, customerId, memberNumber, clubCode, mailing);
        inputArguments = { ...newMailingAddress, ...addrTypePayload4Policy, ...addrTypePayload4Member };
        payloadList.push(inputArguments);
        var fullName = httpBody.lastName + ', ' + httpBody.firstName;
        policyNote = buildPolicyNoteWithAddress(policyNumber, fullName, newMailingAddress);
      }
    break;

    case UseCase.InsuranceResidenceOnly:
      var newRiskAddress: NewAddress = getNewAddress(residence, clubCode, memberNumber);
      //var origMailingAddress: NewAddress = getNewAddress(mailing, clubCode, memberNumber);
      newRiskAddress.NewOverrideIndicator = 'Y';
      confirmEmail.attributes.setAddressChange1(newRiskAddress);

      if (residence.NewAddressLine1 || residence.NewAddressLine2) {
        if (policyNumber && policyAddrRisk) {
          var addrTypePayload4Policy = getInputArgumentAddress(UseCase.InsuranceResidenceOnly, [], customerId, memberNumber, clubCode, residence, policyNumber, policyAddrRisk);
        } else {
          throw new ServiceError(
            'Schema validation failed. Missing policyNumber and/or policyAddrRisk.',
            context.functionName,
            requestHeaders.requestId,
            StatusCode.ClientErrorBadRequest,
            { awsRequestId: context.awsRequestId }
          );
        }
        var addrTypePayload4Member = getInputArgumentAddress(UseCase.MembershipOnlyResidenceOnly, custIdArray, customerId, memberNumber, clubCode, residence);
        inputArguments = { ...newRiskAddress, ...addrTypePayload4Policy, ...addrTypePayload4Member };
        payloadList.push(inputArguments);

        var fullName = httpBody.lastName + ', ' + httpBody.firstName;
        policyNote = buildPolicyNoteWithAddress(policyNumber, fullName, newRiskAddress);
      }
    break;
  }

  confirmEmail.attributes.FirstName = httpBody.firstName;
  confirmEmail.attributes.LastName = httpBody.lastName;
  confirmEmail.attributes.CustId = customerId;
  confirmEmail.attributes.ClubCode = clubCode;
  confirmEmail.attributes.MembershipNumber = clubCode + '-' + memberNumber;

  logger.debug("payloadList: ", payloadList);
  return payloadList;
}

export enum UseCase {
  MembershipOnlySameAddress = 'MembershipOnlySameAddress',//residence + mailing provided; both same
  MembershipOnlyDiffAddress = 'MembershipOnlyDiffAddress',//residence + mailing provided; are different
  MembershipOnlyMailingOnly = 'MembershipOnlyMailingOnly',//only mailing provided
  MembershipOnlyResidenceOnly = 'MembershipOnlyResidenceOnly',//only residence provided
  InsuranceSameAddress = 'InsuranceSameAddress',//residence + mailing provided
  InsuranceMailingOnly = 'InsuraceMailingOnly',//only mailing provided
  InsuranceResidenceOnly = 'InsuranceResidenceOnly',//only residence provided
  InsuranceDiffAddress = 'InsuranceDiffAddress'//residence + mailing provided; are different
}

export const getInsruanceUseCase = (context: IContext, httpBody: any, requestHeaders: ConfigOptions): UseCase => {
  if (httpBody.newAddresses?.residence === undefined && httpBody.newAddresses?.mailing !== undefined) {
    return UseCase.InsuranceMailingOnly
  } else if (httpBody.newAddresses?.residence !== undefined && httpBody.newAddresses?.mailing === undefined) {
    return UseCase.InsuranceResidenceOnly
  } else if (httpBody.newAddresses?.residence !== undefined && httpBody.newAddresses?.mailing !== undefined
    && !_.isEqual(httpBody.newAddresses?.residence, httpBody.newAddresses?.mailing)) {
    return UseCase.InsuranceDiffAddress
  } else if (httpBody.newAddresses?.residence !== undefined && httpBody.newAddresses?.mailing !== undefined
    && _.isEqual(httpBody.newAddresses?.residence, httpBody.newAddresses?.mailing)) {
    return UseCase.InsuranceSameAddress
  } else {
    throw new ServiceError(
      'Unhandled insurance usecase.',
      `${context.functionName} ::: getUseCase`,
      requestHeaders.requestId,
      StatusCode.ServerErrorInternal,
      {
        policyNumber: httpBody?.policyNumber,
        memberNumber: httpBody?.memberNumber,
        membershipOnly: !!httpBody?.membershipOnly,
      }
    )
  }
}

export const getUseCase = (context: IContext, httpBody: any, requestHeaders: ConfigOptions): UseCase => {
  if (httpBody.newAddresses?.residence !== undefined
    && httpBody.newAddresses?.mailing !== undefined
    && _.isEqual(httpBody.newAddresses?.residence, httpBody.newAddresses?.mailing)) {
    return UseCase.MembershipOnlySameAddress
  } else if (httpBody.newAddresses?.residence !== undefined && httpBody.newAddresses?.mailing !== undefined
    && !_.isEqual(httpBody.newAddresses?.residence, httpBody.newAddresses?.mailing)) {
    return UseCase.MembershipOnlyDiffAddress
  } else if (httpBody.newAddresses?.residence === undefined && httpBody.newAddresses?.mailing !== undefined) {
    return UseCase.MembershipOnlyMailingOnly
  } else if (httpBody.newAddresses?.residence !== undefined && httpBody.newAddresses?.mailing === undefined) {
    return UseCase.MembershipOnlyResidenceOnly
  } else {
    throw new ServiceError(
      'Unhandled membership-only usecase.',
      `${context.functionName} ::: getUseCase`,
      requestHeaders.requestId,
      StatusCode.ServerErrorInternal,
      {
        policyNumber: httpBody?.policyNumber,
        memberNumber: httpBody?.memberNumber,
        membershipOnly: !!httpBody?.membershipOnly,
      }
    )
  }
}

export const getCustIdArray = (customerAddressJson, customerId: string): string[] => {
  var result = [];
  let customerList = [];
  searchJson(customerAddressJson, 'FirstName', 'CustomerSecured', ['Y', 'y', 'N', 'n', null], qualifySearch, customerList);
  for (var item of customerList) {
    var currentCustomerIdNum = item['CustomerIdNumber'];
    result.push(currentCustomerIdNum);
  }
  return result;
}

export const getPolicy = async (invokedFunctionArn: string, policyNumber: string, authBearer: string, mulesoftSecret?: MulesoftSecret, configOptions?: ConfigOptions): Promise<JSON> => {
  let url = `${getCommonApiDomain(invokedFunctionArn)}${endpoints.policy}${policyNumber}`;
  let gatewayId = getCommonGatewayId(CommonGatewayType.insurance, invokedFunctionArn);
  logger.debug(`Inside getPolicy. Url: ` + url + 'gatewayId: ' + gatewayId);
  return executeGetCall(url, gatewayId, authBearer, configOptions, mulesoftSecret.clientId, mulesoftSecret.clientSecret);
}

export const buildPolicyPremiumChangeResponse = (data: JSON, trackingCode: string, expirationDate: string): UpdateAddressResponse => {
  var response: UpdateAddressResponse = {
    oldPremium: 0,
    newPremium: 0,
    confirmationNumber: '',
    effectiveDate: '',
    expirationDate: ''
  };

  if (expirationDate != '' || expirationDate != null) {
    const yymmdd = expirationDate.split('-');
    response.expirationDate = yymmdd[1] + '/' + yymmdd[2] + '/' + yymmdd[0];
  }

  var transList = [];
  searchJson(data, 'Type', 'UserType', ['NAME/ADDRESS CHANGE'], qualifySearch, transList);
  const confirmationNumber = trackingCode;
  logger.info("Confirmation number to track this request: ", { confirmationNumber });
  if (transList.length > 0) {
    for (var transaction of transList) {
      if (transaction['Type'] === 'AMENDMENTS - NO PREMIUM' || transaction['Type'] === 'AMENDMENTS - EXTRA PREMIUM' || transaction['Type'] === 'AMENDMENTS - RETURN PREMIUM') {
        response.oldPremium = transaction.PrevPrem;
        response.newPremium = transaction.CurrPrem;
        response.effectiveDate = transaction.EffDt;
        break;
      }
    }
  }
  response.confirmationNumber = confirmationNumber;
  return response;
}

export const getCustomerDetails = async (event: IEvent, context: IContext, authBearer: string, mulesoftSecret?: MulesoftSecret, requestHeaders?: ConfigOptions, logger?: Logger): Promise<any> => {
  let invokedFunctionArn = context.invokedFunctionArn;
  const useIIBEndpoint = process.env.USE_IIB_ENDPOINT;
  let customerDetailsEndpoint = endpoints.customerDetailsV2;
  if (useIIBEndpoint?.toLowerCase().trim() === 'true') {
    customerDetailsEndpoint = endpoints.customerDetails;
  }
  logger.debug(`Inside getCustomerDetails. customerDetailsEndpoint: ` + customerDetailsEndpoint);
  let url = `${getCommonApiDomain(invokedFunctionArn)}${customerDetailsEndpoint}${event?.requestContext?.authorizer?.customerId}`;
  let gatewayId = getCommonGatewayId(CommonGatewayType.customer, invokedFunctionArn);
  return await executeGetCall(url, gatewayId, authBearer, requestHeaders, mulesoftSecret.clientId, mulesoftSecret.clientSecret);
}

export const getPreferredEmail = (customerDetails: any): string => {
  var resultArray = [];
  searchJson(customerDetails, 'emailAddress', 'validity', ['1', '3', '', ' ', null], qualifySearch, resultArray);
  if (resultArray[0]) return (resultArray[0]['emailAddress']);
  else return null;
}

export const getPolicyExpiration = (customerDetails: any, policyNumber: string): string => {
  var resultArray = [];
  searchJson(customerDetails, 'expirationDate', 'productId', [policyNumber], qualifySearch, resultArray);
  if (resultArray[0]) return (resultArray[0]['expirationDate']);
  else return null;
}

export const recordPolicyNotes = async (invokedFunctionArn: string, payload, authBearer: string, context?: IContext, mulesoftSecret?: MulesoftSecret, requestHeaders?: ConfigOptions) => {
  let gatewayId = getCommonGatewayId(CommonGatewayType.insurance, invokedFunctionArn);
  const url = `${getCommonApiDomain(invokedFunctionArn)}${endpoints.recordPolicyNotes}`;
  return executePostCall(url, gatewayId, payload, authBearer, context, requestHeaders, mulesoftSecret.clientId, mulesoftSecret.clientSecret);
}

function searchJson(o, find, qualifier, qlist, func, resultArray) {
  for (var i in o) {
    var result = null;
    result = func.apply(this, [i, o, find, qualifier, qlist]);
    if (result !== null) resultArray.push(result);
    else if (o[i] !== null && typeof (o[i]) == "object") {
      searchJson(o[i], find, qualifier, qlist, func, resultArray);
    }
  }
}

function qualifySearch(key, obj, find, qualifier, qlist) {
  if (key === find && qlist.includes(obj[qualifier])) {

    return obj;
  } else return null;
}

function getDateTime() {
  var today = new Date();
  var dd = String(today.getDate()).padStart(2, '0');
  var mo = String(today.getMonth() + 1).padStart(2, '0');
  var yyyy = today.getFullYear();
  var hh = String(today.getHours()).padStart(2, '0');
  var mm = String(today.getMinutes()).padStart(2, '0');
  var ss = String(today.getSeconds()).padStart(2, '0');
  return (mo + dd + yyyy + hh + mm + ss);
}

let mulesoftCreds: MulesoftSecret;

exports.handler = async (event: IEvent, context: IContext): Promise<LambdaResponse> => {
  await logger.initialize(context, event?.headers); //Required logging
  const requestHeaders = createRequestHeaders(event);
  logger.setMeta({ [LoggerTypes.LogKey.CorrelationId]: requestHeaders.requestId })
  const testRegion = extractTestRegionFromEvent(event)
  if (testRegion) {
    requestHeaders.headerInfo = { ...requestHeaders.headerInfo, [HeaderKeys.TestRegion]: testRegion }
    logger.debug('Test region has been set.', { testRegion })
  }
  const splunkMeta = {
    customerId: '',
    memberNumber: '',
    membershipOnly: false,
    clubCode: '',
    testRegion
  }

  confirmEmail = new ConfirmEmail();

  logger.debug('Request Headers extracted', requestHeaders);
  try {
    if (!event.headers.Authorization) {
      logger.error('Missing Authorization header');
      throw new ServiceError(
        'Unauthorized',
        context.functionName,
        requestHeaders.requestId,
        StatusCode.ClientErrorUnauthorized,
        { awsRequestId: context.awsRequestId }
      )
    }

    let authBearer = event.headers.Authorization;
    let invokedFunctionArn = context.invokedFunctionArn;
    let customerId = event.requestContext?.authorizer?.customerId;
    let clubCode = event.requestContext?.authorizer?.clubCode;
    splunkMeta.clubCode = clubCode;
    splunkMeta.customerId = customerId;

    const httpBody: UpdateAddressRequest = JSON.parse(event?.body)

    
    if (
      !httpBody ||
      !httpBody.memberNumber ||
      !httpBody.firstName ||
      !httpBody.lastName ||
      !httpBody.newAddresses
      || (httpBody.policyAddrRisk && !Array.isArray(httpBody.policyAddrRisk))//policyAddrRisk must be an array.
      //|| (httpBody.policyNumber && (!httpBody.newAddresses.mailing || !httpBody.policyAddrRisk))//if you provide policyNumber, newAddresses.risk and policyAddrRisk must be provided
      ) {
      throw new ServiceError(
        'Schema validation failed, missing properties',
        context.functionName,
        requestHeaders.requestId,
        StatusCode.ClientErrorBadRequest,
        {
          policyNumber: httpBody?.policyNumber,
          memberNumber: httpBody?.memberNumber,
          membershipOnly: !!httpBody?.membershipOnly
        }
      )
    }
    

    splunkMeta.memberNumber = httpBody.memberNumber;
    splunkMeta.membershipOnly = httpBody.membershipOnly;

    const ingressProxyArn = `arn:aws:lambda:${process.env.AWS_REGION}:${process.env.INGRESS_PROXY_ACCOUNT_ID}:function:ace-ingress-proxy`;
    const adtokenProps: AdTokenHelperProps = { teamId: 'acechatbot', awsRegion: process.env.AWS_REGION, adProxyAccountId: process.env.AD_PROXY_ACCOUNT_ID }

    const adToken = (await AdTokenHelper.getAdToken(adtokenProps)).adToken;// get AdToken

    if (!mulesoftCreds) {
      mulesoftCreds = await MulesoftSecretsHelper.getMulesoftSecret(SECRET_ID);
      logger.debug('Received secrets from secrets manager');
    }

    logger.debug("before calling get customer address");
    
    let customerAddressJson = await executeGetCall(`${getCommonApiDomain(invokedFunctionArn)}${endpoints.customerAddresses}${customerId}`,
      getCommonGatewayId(CommonGatewayType.customer, invokedFunctionArn), authBearer, requestHeaders, mulesoftCreds.clientId, mulesoftCreds.clientSecret);
    logger.debug("before calling getCustIdArray")
    let custIdArray = getCustIdArray(customerAddressJson, customerId);
    
    //let custIdArray = ["311990020052430"];
    logger.debug("cusIdArray: ", custIdArray);

    let payloadList = buildUpdateAddressPayloads(context, customerId, httpBody, clubCode, custIdArray, requestHeaders) as InputArguments[];
    //return;
    const testRegion = extractTestRegionFromEvent(event)
    if (testRegion) logger.debug('Test region has been set.', { testRegion })
    for (var payload of payloadList) {
      const brokerPayload = MulesoftHelper.buildBrokerRequest(payload, MulesoftBrokerOperations.maintainMemberProfile, requestHeaders.requestId)
      const ingressRequestPayload = MulesoftHelper.buildMulesoftRequest(
        brokerPayload, mulesoftCreds, adToken, { 'X-Request-Id': requestHeaders.requestId }, testRegion)
      logger.debug('Calling ingress with...', ingressRequestPayload);
      let brokerResponse = await functionInvoke.invoke(ingressProxyArn, ingressRequestPayload, logger.getClientContext());
      const ingressResponse = JSON.parse(brokerResponse.Payload.toString());
      logger.debug("ingressResponse: ", ingressResponse);
      logger.debug("HUON error: ", ingressResponse.data?.Exports?.SystemReturnCode);

      if (ingressResponse && ingressResponse.data?.Exports?.SystemReturnCode == '0089') {
        // This is when HUON return "TextMessage":"MULTIPLE HUON CLIENTS FOUND FOR CUSTOMER"
        // It does not seem to be an HUON error. This ReturnCode seems to be for information purpose so we should 
        // not throw ServiceError
        logger.debug("HUON SystemReturnCode: 0089", ingressResponse.data?.Exports?.TextMessage);
      } else if (!ingressResponse || ingressResponse.statusCode >= 400) {
        logger.error('UA generic ingress response error', splunkMeta)
        throw new ServiceError(
          ingressResponse?.statusMessage,
          context?.functionName,
          requestHeaders.requestId,
          ingressResponse?.statusCode,
          { ingressResponse: ingressResponse?.data, ...splunkMeta }
        );
      } else if (!ingressResponse
        || ingressResponse.data?.Exports?.SystemReturnCode == '00099'
        || ingressResponse.data?.Exports?.SystemReturnCode == '0006'
        || ingressResponse.data?.Exports?.SystemReturnCode == '0015') {
        logger.error('UA HUON code error', { ...splunkMeta, huonSystemReturnCode: ingressResponse?.data?.Exports?.SystemReturnCode })
        throw new ServiceError(
          ingressResponse.data?.Exports?.TextMessage,
          context.functionName,
          requestHeaders.requestId,
          412,
          { ...splunkMeta, huonSystemReturnCode: ingressResponse?.data?.Exports?.SystemReturnCode }
        );
      } else if (!ingressResponse || ingressResponse.data?.Exports?.SystemReturnCode !== '0000') {
        logger.error('UA HUON unhandled error', { ...splunkMeta, huonSystemReturnCode: ingressResponse?.data?.Exports?.SystemReturnCode })
        throw new ServiceError(
          ingressResponse.data?.Exports?.TextMessage,
          context.functionName,
          requestHeaders.requestId,
          400,
          { ...splunkMeta, huonSystemReturnCode: ingressResponse?.data?.Exports?.SystemReturnCode }
        );
      }
    }

    // call customer details to get preferred email
    const customerDetails = await getCustomerDetails(event, context, authBearer, mulesoftCreds, requestHeaders, logger);
    logger.debug(`Customer details retrieved`);
    const preferredEmail = getPreferredEmail(customerDetails);
    confirmEmail.email = preferredEmail;
    logger.debug("member email: " + confirmEmail.email);

    const policyNumber = httpBody?.policyNumber;
    const trackingCode = clubCode + '-' + httpBody.memberNumber + '-' + getDateTime();
    logger.debug("Confirmation number for this request: ", { trackingCode });
    confirmEmail.attributes.ConfirmationNumber = trackingCode;

    if (policyNumber) {
      // get expiration date of policy from customerDetails
      var expirationDate = getPolicyExpiration(customerDetails, policyNumber);
      // If null; the policyNumber provided did not exist/match anything inside our customerDetails json.
      if (!expirationDate) {
        logger.error('No policy expiration', splunkMeta)
        throw new ServiceError(
          "Invalid policy number.",
          context.functionName,
          requestHeaders.requestId,
          policyResponse?.httpStatus,
          { ...splunkMeta, expirationDate: expirationDate }
        );
      }

      var policyResponse: any = await getPolicy(invokedFunctionArn, policyNumber, authBearer, mulesoftCreds, requestHeaders);
      if (!policyResponse || policyResponse.httpStatus >= 400) {
        logger.error('UA generic ingress response error', splunkMeta)
        throw new ServiceError(
          policyResponse?.statusMessage,
          context.functionName,
          requestHeaders.requestId,
          policyResponse?.httpStatus,
          { ...splunkMeta }
        );
      }
      logger.debug('Success retrieved policy.');

      var clientNumber = getClientNumberFromPolicy(policyResponse, customerId);
      logger.debug(`Client number retrieved from policy: ${clientNumber}`);

      if (policyNote?.notes) {
        policyNote?.notes?.unshift(`Web AO: Submitted: person making the change client ID: ${clientNumber} `);
      }

      const recordPolicyPayload = {
        policyNumber: policyNumber,
        notes: policyNote.notes
      };

      logger.info('Calling record-policy-notes within common insurance');
      const rpnResponse = await recordPolicyNotes(invokedFunctionArn, recordPolicyPayload, authBearer, context, mulesoftCreds, requestHeaders)
        .catch((e) => {
          logger.error('UA ::: Record policy note Service Error', e)
          throw new ServiceError(
            e?.response?.data?.message,
            `${context?.functionName} ::: record policy note`,
            requestHeaders?.requestId,
            e?.response?.status,
            { ...splunkMeta }
          )
        });
      logger.debug('common-insurance responded with ', rpnResponse);

      if (!rpnResponse || rpnResponse.httpStatus >= 400) {
        logger.error('Failed record policy notes', splunkMeta)
        throw new ServiceError(
          rpnResponse?.message,
          context?.functionName,
          requestHeaders?.requestId,
          rpnResponse?.httpStatus
        );
      } else {
        logger.info("Successfully recorded policy notes.", rpnResponse.data);
      }

      var lambdaResp4Policy = buildPolicyPremiumChangeResponse(policyResponse.data, trackingCode, expirationDate);
      confirmEmail.attributes.EffectiveDate = lambdaResp4Policy.effectiveDate;
      confirmEmail.attributes.PolicyNumber = policyNumber;
      logger.debug('Created send-email payload...', confirmEmail);

      let emailResponse = await sendEmail(invokedFunctionArn, confirmEmail, context, mulesoftCreds, requestHeaders);

      if (emailResponse.statusCode >= 400) {
        logger.error('Failed send email', splunkMeta)
        throw new ServiceError(
          emailResponse.data.error,
          context.functionName,
          requestHeaders.requestId,
          emailResponse.statusCode,
          { ...splunkMeta }
        );
      }

      logger.debug('Successfully sent email.')

      logger.debug('Succesfully updated address', { confirmationNumber: trackingCode, ...splunkMeta })
      return Promise.resolve(createLambdaResponse({
        message: 'Successfully updated address',
        data: lambdaResp4Policy,
      }, StatusCode.SuccessOK));
    } else {
      // membership only response
      confirmEmail.attributes.EffectiveDate = null;
      logger.debug('Created send-email payload...', confirmEmail);

      let emailResponse = await sendEmail(invokedFunctionArn, confirmEmail, context, mulesoftCreds, requestHeaders);

      if (emailResponse.statusCode >= 400) {
        logger.error('UA email failed', splunkMeta)
        throw new ServiceError(
          emailResponse.data.error,
          `${context.functionName} ::: sendEmail`,
          requestHeaders.requestId,
          emailResponse.statusCode,
          { awsRequestId: context.awsRequestId, ...splunkMeta }
        );
      }

      logger.debug('Successfully sent email.')

      logger.debug('Succesfully updated address', { confirmationNumber: trackingCode, ...splunkMeta })
      return Promise.resolve(createLambdaResponse({
        message: 'Successfully updated address',
        data: { confirmationNumber: trackingCode }
      }, StatusCode.SuccessOK));
    }
  } catch (error) {
    logger.error('Failed update address', { ...splunkMeta })
    logger.error('error', error)
    return Promise.resolve(createLambdaResponse({
      requestId: requestHeaders?.requestId,
      message: error?.ErrorMessage || error.message,
    }, error?.ComponentErrorCode || StatusCode.ServerErrorInternal));
  }
}

export default exports;