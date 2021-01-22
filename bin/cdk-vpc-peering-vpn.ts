#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { CdkVpcPeeringVpnStack } from '../lib/cdk-vpc-peering-vpn-stack';

const app = new cdk.App();
new CdkVpcPeeringVpnStack(app, 'CdkVpcPeeringVpnStack');
