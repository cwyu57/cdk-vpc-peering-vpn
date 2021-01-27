import * as fs from 'fs';
import * as cdk from '@aws-cdk/core';
import * as cr from '@aws-cdk/custom-resources';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as iam from '@aws-cdk/aws-iam';
import * as logs from '@aws-cdk/aws-logs';
import * as route53 from '@aws-cdk/aws-route53';

export class CdkVpcPeeringVpnStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    const vpnVpcCidr = '10.255.0.0/16';
    const vpnVpcDnsIp = '10.255.0.2';
    const clientVpnCidr = '10.255.252.0/22';

    const vpnVpcPublicSubnetGroupName = 'pubic';
    const vpnVpcIsolatedSubnetGroupName = 'client-vpn-isolated';

    const vpnVpc = new ec2.Vpc(this, 'VpnVpc', {
      cidr: vpnVpcCidr,
      maxAzs: 3,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: vpnVpcPublicSubnetGroupName,
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: vpnVpcIsolatedSubnetGroupName,
          subnetType: ec2.SubnetType.ISOLATED,
        },
      ],
    });

    const clientVpnAcm = new cr.AwsCustomResource(this, 'ClientVpnAcmCustomResource', {
      functionName: 'client-vpn-acm-custom-resource-handler',
      logRetention: logs.RetentionDays.ONE_DAY,
      onCreate: {
        service: 'ACM',
        action: 'importCertificate',
        parameters: {
          Certificate: fs.readFileSync('./certificates/server.crt').toString(),
          PrivateKey: fs.readFileSync('./certificates/server.key').toString(),
          CertificateChain: fs.readFileSync('./certificates/ca.crt').toString(),
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('CertificateArn'),
      },
      onDelete: {
        service: 'ACM',
        action: 'deleteCertificate',
        parameters: {
          CertificateArn: new cr.PhysicalResourceIdReference(),
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [ "acm:DeleteCertificate", "acm:ImportCertificate"],
          resources: ['*'],
        }),
      ]),
    });

    const acmArn = clientVpnAcm.getResponseField('CertificateArn');

    const clientVpnEndpoint = new ec2.CfnClientVpnEndpoint(this, 'ClientVpnEndpoint', {
      authenticationOptions: [
        {
          type: 'certificate-authentication',
          mutualAuthentication: {
            clientRootCertificateChainArn: acmArn,
          },
        },
      ],
      clientCidrBlock: clientVpnCidr, // 使用者使用 VPN 連線後的 CIDR Block
      connectionLogOptions: {
        enabled: false,
      },
      serverCertificateArn: acmArn,
      vpcId: vpnVpc.vpcId,
      splitTunnel: true,
      dnsServers: [
        vpnVpcDnsIp,
      ],
    });


    vpnVpc.isolatedSubnets.forEach((subnet, idx) => {
      new ec2.CfnClientVpnTargetNetworkAssociation(this, `ClientVpnTargetNetworkAssociation${idx + 1}`, {
        clientVpnEndpointId: clientVpnEndpoint.ref,
        subnetId: subnet.subnetId,
      });
    });

    const authorizationRuleVpnVpc = new ec2.CfnClientVpnAuthorizationRule(this, 'ClientVpnAuthorizationRuleVpnVpc', {
      clientVpnEndpointId: clientVpnEndpoint.ref,
      targetNetworkCidr: vpnVpcCidr,
      authorizeAllGroups: true,
    });

    const mainVpcCidr = '10.0.0.0/16';

    const mainVpcPublicSubnetGroupName = 'pubic';
    const mainVpcPrivateSubnetGroupName = 'private';
    const mainVpcIsolatedSubnetGroupName = 'isolated';

    const mainVpc = new ec2.Vpc(this, 'MainVpc', {
      cidr: mainVpcCidr,
      maxAzs: 3,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: mainVpcPublicSubnetGroupName,
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: mainVpcPrivateSubnetGroupName,
          subnetType: ec2.SubnetType.PRIVATE,
        },
        {
          cidrMask: 28,
          name: mainVpcIsolatedSubnetGroupName,
          subnetType: ec2.SubnetType.ISOLATED,
        }
      ],
    });

    const authorizationRuleMainVpc = new ec2.CfnClientVpnAuthorizationRule(this, 'ClientVpnAuthorizationRuleMainVpc', {
      clientVpnEndpointId: clientVpnEndpoint.ref,
      targetNetworkCidr: mainVpcCidr,
      authorizeAllGroups: true,
    });


    vpnVpc.isolatedSubnets.forEach((isolatedSubnet, idx) => {
      const clientVpnRoute = new ec2.CfnClientVpnRoute(this, `VpnVpcIsolatedSubnetPeeringRoute${idx}`, {
        clientVpnEndpointId: clientVpnEndpoint.ref,
        destinationCidrBlock: mainVpcCidr,
        targetVpcSubnetId: isolatedSubnet.subnetId,
      });

      // handle dependency issue
      this
        .node.findChild(`VpnVpcIsolatedSubnetPeeringRoute${idx}`)
        .node.addDependency(this.node.findChild('MainVpc'))
    });

    const peeringConnection = new ec2.CfnVPCPeeringConnection(this, 'ClientVpnVpcToChocolabsVpc', {
      vpcId: vpnVpc.vpcId,
      peerVpcId: mainVpc.vpcId,
    });

    // vpn vpc -> peering connection -> main vpc
    vpnVpc.publicSubnets
      .forEach((publicSubnet, idx) => {
        const route = new ec2.CfnRoute(this, `VpnVpcPublicSubnet${idx + 1}RouteToMainVpc`, {
          routeTableId: publicSubnet.routeTable.routeTableId,
          destinationCidrBlock: mainVpcCidr,
          vpcPeeringConnectionId: peeringConnection.ref,
        });
      })
    vpnVpc.privateSubnets
      .forEach((privateSubnet, idx) => {
        const route = new ec2.CfnRoute(this, `VpnVpcPrivateSubnet${idx + 1}RouteToMainVpc`, {
          routeTableId: privateSubnet.routeTable.routeTableId,
          destinationCidrBlock: mainVpcCidr,
          vpcPeeringConnectionId: peeringConnection.ref,
        });
      })
    vpnVpc.isolatedSubnets
      .forEach((isolatedSubnet, idx) => {
        const route = new ec2.CfnRoute(this, `VpnVpcIsolatedSubnet${idx + 1}RouteToMainVpc`, {
          routeTableId: isolatedSubnet.routeTable.routeTableId,
          destinationCidrBlock: mainVpcCidr,
          vpcPeeringConnectionId: peeringConnection.ref,
        });
      })

    // main vpc -> peering connection -> vpn vpc
    mainVpc.publicSubnets
      .forEach((publicSubnet, idx) => {
        const route = new ec2.CfnRoute(this, `MainVpcPublicSubnet${idx + 1}RouteToVpnVpc`, {
          routeTableId: publicSubnet.routeTable.routeTableId,
          destinationCidrBlock: vpnVpcCidr,
          vpcPeeringConnectionId: peeringConnection.ref,
        });
      })
    mainVpc.privateSubnets
      .forEach((privateSubnet, idx) => {
        const route = new ec2.CfnRoute(this, `MainVpcPrivateSubnet${idx + 1}RouteToVpnVpc`, {
          routeTableId: privateSubnet.routeTable.routeTableId,
          destinationCidrBlock: vpnVpcCidr,
          vpcPeeringConnectionId: peeringConnection.ref,
        });
      })
    mainVpc.isolatedSubnets
      .forEach((isolatedSubnet, idx) => {
        const route = new ec2.CfnRoute(this, `MainVpcIsolatedSubnet${idx + 1}RouteToVpnVpc`, {
          routeTableId: isolatedSubnet.routeTable.routeTableId,
          destinationCidrBlock: vpnVpcCidr,
          vpcPeeringConnectionId: peeringConnection.ref,
        });
      });

    const vpcPeeringDns = new cr.AwsCustomResource(this, 'VpcPeeringDnsCustomResource', {
      functionName: 'vpc-peering-dns-custom-resource-handler',
      logRetention: logs.RetentionDays.ONE_DAY,
      onCreate: {
        service: 'EC2',
        action: 'modifyVpcPeeringConnectionOptions',
        parameters: {
          VpcPeeringConnectionId: peeringConnection.ref,
          AccepterPeeringConnectionOptions: {
            AllowDnsResolutionFromRemoteVpc: true,
          },
          RequesterPeeringConnectionOptions: {
            AllowDnsResolutionFromRemoteVpc: true,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('VpcPeeringDnsCustomResource'),
      },
      onDelete: {
        service: 'EC2',
        action: 'modifyVpcPeeringConnectionOptions',
        parameters: {
          VpcPeeringConnectionId: peeringConnection.ref,
          AccepterPeeringConnectionOptions: {
            AllowDnsResolutionFromRemoteVpc: false,
          },
          RequesterPeeringConnectionOptions: {
            AllowDnsResolutionFromRemoteVpc: false,
          },
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['ec2:ModifyVpcPeeringConnectionOptions'],
          resources: ['*'],
        }),
      ]),
    });

    const vpnVpcBastionHost = new ec2.BastionHostLinux(this, 'VpnVpcBastionHost', {
      vpc: vpnVpc,
      subnetSelection: {
        subnetGroupName: vpnVpcPublicSubnetGroupName,
      },
    });

    vpnVpcBastionHost.connections.allowFromAnyIpv4(ec2.Port.tcp(22));  // allow any ip v4 for demo usage, do not use in production environment
    vpnVpcBastionHost.connections.allowFrom(ec2.Peer.ipv4(vpnVpcCidr), ec2.Port.icmpPing());
    vpnVpcBastionHost.connections.allowFrom(ec2.Peer.ipv4(mainVpcCidr), ec2.Port.icmpPing());

    new cdk.CfnOutput(this, 'VpnVpcBastionHostPublicDnsName', {
      value: vpnVpcBastionHost.instancePublicDnsName,
    });
    new cdk.CfnOutput(this, 'VpnVpcBastionHostPrivateDnsName', {
      value: vpnVpcBastionHost.instancePrivateDnsName,
    });

    const mainVpcBastionHost = new ec2.BastionHostLinux(this, 'MainVpcBastionHost', {
      vpc: mainVpc,
      subnetSelection: {
        subnetGroupName: mainVpcPublicSubnetGroupName,
      },
    });

    mainVpcBastionHost.connections.allowFromAnyIpv4(ec2.Port.tcp(22));  // allow any ip v4 for demo usage, do not use in production environment
    mainVpcBastionHost.connections.allowFrom(ec2.Peer.ipv4(vpnVpcCidr), ec2.Port.icmpPing());
    mainVpcBastionHost.connections.allowFrom(ec2.Peer.ipv4(mainVpcCidr), ec2.Port.icmpPing());

    new cdk.CfnOutput(this, 'MainVpcBastionHostPublicDnsName', {
      value: mainVpcBastionHost.instancePublicDnsName,
    });
    new cdk.CfnOutput(this, 'MainVpcBastionHostPrivateDnsName', {
      value: mainVpcBastionHost.instancePrivateDnsName,
    });

    const privateHostZone = new route53.PrivateHostedZone(this, 'PrivateHostZone', {
      zoneName: 'internal.example.com',
      vpc: mainVpc,
    })

    privateHostZone.addVpc(vpnVpc);

    new route53.CnameRecord(this, 'MainVpcBastionHostPrivateCnameRecord', {
      domainName: mainVpcBastionHost.instancePrivateDnsName,
      zone: privateHostZone,
      recordName: 'main-vpc-bastion-host-private',
      ttl: cdk.Duration.seconds(20),
    });

    new route53.CnameRecord(this, 'VpnVpcBastionHostPrivateCnameRecord', {
      domainName: vpnVpcBastionHost.instancePrivateDnsName,
      zone: privateHostZone,
      recordName: 'vpn-vpc-bastion-host-private',
      ttl: cdk.Duration.seconds(20),
    });

    new route53.CnameRecord(this, 'MainVpcBastionHostPublicCnameRecord', {
      domainName: mainVpcBastionHost.instancePublicDnsName,
      zone: privateHostZone,
      recordName: 'main-vpc-bastion-host-public',
      ttl: cdk.Duration.seconds(20),
    });

    new route53.CnameRecord(this, 'VpnVpcBastionHostPublicCnameRecord', {
      domainName: vpnVpcBastionHost.instancePublicDnsName,
      zone: privateHostZone,
      recordName: 'vpn-vpc-bastion-host-public',
      ttl: cdk.Duration.seconds(20),
    });
  }
}
