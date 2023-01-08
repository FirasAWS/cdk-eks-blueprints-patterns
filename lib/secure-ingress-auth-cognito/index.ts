import 'source-map-support/register';
import * as blueprints from '@aws-quickstart/eks-blueprints';
import { LookupHostedZoneProvider, GlobalResources, utils, ClusterInfo } from '@aws-quickstart/eks-blueprints';
import { KubecostAddOn } from '@kubecost/kubecost-eks-blueprints-addon';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { prevalidateSecrets } from '../common/construct-utils';
import { SECRET_ARGO_ADMIN_PWD } from '../multi-region-construct';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { ICertificate } from "aws-cdk-lib/aws-certificatemanager";



const logger = blueprints.utils.logger;
//const gitUrl = 'https://github.com/aws-samples/eks-blueprints-workloads.git';
const gitUrl = 'https://github.com/rameshv29/eks-blueprints-workloads.git';

//Class Cognito Stack (Adding Cognito Class here since Nested stack output not available in blueprints)

/**
 * Stack the creates the cognito user pool, app client, configure the client and app client domain. .
 */

class CognitoIdpStack extends cdk.Stack {

    public readonly userPoolOut: cognito.UserPool;
    public readonly userPoolClientOut: cognito.UserPoolClient;
    public readonly userPoolDomainOut: cognito.UserPoolDomain;
    
    constructor(scope: Construct, id: string, subDomain: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Cognito User Pool
        const userPool = new cognito.UserPool(this, 'CognitoIDPUserPool', {
            userPoolName: 'CognitoIDPUserPool',
            selfSignUpEnabled: false,
            signInAliases: {
                email: true,
                username: true
            },
            standardAttributes: {
                email: {
                    mutable: true,
                    required: true
                },
                givenName: {
                    mutable: true,
                    required: true
                },
                familyName: {
                    mutable: true,
                    required: true
                }
            }
        });
        
        // Output the User Pool ID

        this.userPoolOut = userPool;

        const userPoolOut = new cdk.CfnOutput(this, 'CognitoIDPUserPoolOut', {
            value: userPool.userPoolId,
            exportName: 'CognitoIDPUserPoolId'
        });

        const userPoolArnOut = new cdk.CfnOutput(this, 'CognitoIDPUserPoolArnOut', {
            value: userPool.userPoolArn,
            exportName: 'CognitoIDPUserPoolArn'
        });


        // We will ask the IDP to redirect back to our domain's index page
        const redirectUri = `https://${subDomain}/oauth2/idpresponse`;
      
        // Configure the user pool client application 
        const userPoolClient = new cognito.UserPoolClient(this, 'CognitoAppClient', {
            userPool,
            authFlows: {
                userPassword: true
            },
            oAuth: {
                flows: {
                    authorizationCodeGrant: true
                },
                scopes: [
                    cognito.OAuthScope.PHONE,
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.PROFILE,
                    cognito.OAuthScope.OPENID
                ],
                callbackUrls: [redirectUri]
                // TODO - What about logoutUrls?
            },
            generateSecret: false,
            userPoolClientName: 'Web',
            supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO]
        });

        // Output the User Pool App Client ID
        this.userPoolClientOut = userPoolClient;

        const userPoolClientOut = new cdk.CfnOutput(this, 'CognitoIDPUserPoolClientOut', {
            value: userPoolClient.userPoolClientId,
            exportName: 'CognitoIDPUserPoolClientId'
        });

        // Add the domain to the user pool
        const userPoolDomain = userPool.addDomain('CognitoDomain', {
            cognitoDomain: {
                domainPrefix: 'my-cdk-blueprint',
            },
        });

        // Output the User Pool App Client ID

        this.userPoolDomainOut = userPoolDomain;
        const useruserPoolDomainOut = new cdk.CfnOutput(this, 'CognitoIDPUserPoolDomainOut', {
            value: userPoolDomain.domainName,
            exportName: 'CognitoIDPUserPoolDomain'
        });
        
    }
}


/**
 * See docs/patterns/secure-ingress-cognito.md for mode details on the setup.
 */
export class PipelineSecureIngressCognito extends cdk.Stack{

    async buildAsync(scope: Construct, id: string) {

        await prevalidateSecrets(PipelineSecureIngressCognito.name, undefined, SECRET_ARGO_ADMIN_PWD);

        const subdomain: string = utils.valueFromContext(scope, "dev.subzone.name", "secure-ingress.reachrk.people.aws.dev");
        //const parentDnsAccountId = scope.node.tryGetContext("parent.dns.account")!;
        const parentDomain = utils.valueFromContext(scope, "parent.hostedzone.name", "reachrk.people.aws.dev");

        const CognitoIdpStackOut = new CognitoIdpStack (scope,'cognito-idp-stack', subdomain,
            {
                env: {
                    account: process.env.CDK_DEFAULT_ACCOUNT,
                    region: process.env.CDK_DEFAULT_REGION,
                },
            }
        );

        blueprints.HelmAddOn.validateHelmVersions = false;

        await blueprints.EksBlueprint.builder()
            .account(process.env.CDK_DEFAULT_ACCOUNT)
            .region(process.env.CDK_DEFAULT_REGION)
            //.teams(...teams)
            .resourceProvider(GlobalResources.HostedZone, new LookupHostedZoneProvider(parentDomain))
            .resourceProvider(GlobalResources.Certificate, new blueprints.CreateCertificateProvider('secure-ingress-cert', `${subdomain}`, GlobalResources.HostedZone))
            .addOns(
                new blueprints.VpcCniAddOn(),
                new blueprints.CoreDnsAddOn(),
                new blueprints.CertManagerAddOn,
                new blueprints.AwsLoadBalancerControllerAddOn,
                //new blueprints.NestedStackAddOn({
                //    builder: CognitoIdpStack.builder(subdomain),
                //    id: "cognito-nested-stack"
                //}),
                new KubecostAddOn(),
                new blueprints.ExternalDnsAddOn({
                    hostedZoneResources: [GlobalResources.HostedZone] // you can add more if you register resource providers
                }),
                new blueprints.SecretsStoreAddOn({ rotationPollInterval: "120s" }),
                new blueprints.ArgoCDAddOn({
                    bootstrapRepo: {
                        repoUrl: gitUrl,
                        targetRevision: "secure-ingress-workload-kubecost",
                        path: 'envs/dev'
                    },
                    bootstrapValues: {
                        spec: {
                            ingress: {
                                host: subdomain,
                                cognitoUserPoolArn: CognitoIdpStackOut.userPoolOut.userPoolArn,
                                cognitoUserPoolAppId: CognitoIdpStackOut.userPoolClientOut.userPoolClientId,
                                cognitoDomainName: CognitoIdpStackOut.userPoolDomainOut.domainName,
                                region: process.env.CDK_DEFAULT_REGION,
                                //cognitoFullDomainName: 
                                //certificateArn: GlobalResources.Certificate  secureIngressCert,
                            }
                        },
                    },
                    adminPasswordSecretName: SECRET_ARGO_ADMIN_PWD,
                }),
                new blueprints.MetricsServerAddOn,
                new blueprints.ClusterAutoScalerAddOn)
            .buildAsync(scope, `${id}-blueprint`);

            blueprints.HelmAddOn.validateHelmVersions = false;
            
            
    }
}

/*

export declare interface ClusterAddOn { 
    id? : string;
    deploy(clusterInfo: ClusterInfo): Promise<Construct> | void;
}

export declare interface ClusterPostDeploy {
    postDeploy(clusterInfo: ClusterInfo): Promise<Construct> {
        const certificate = ClusterInfo.getResource<ICertificate>(GlobalResources.Certificate);
        
    }
}
*/
