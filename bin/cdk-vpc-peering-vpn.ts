#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { CdkVpcPeeringVpnStack } from '../lib/cdk-vpc-peering-vpn-stack';

const app = new cdk.App();
new CdkVpcPeeringVpnStack(app, 'CdkVpcPeeringVpnStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
