import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as synced_folder from "@pulumi/synced-folder";

// Import the program's configuration settings.
const config = new pulumi.Config();
const path = config.get("path") || "./www";
const indexDocument = config.get("indexDocument") || "index.html";
const errorDocument = config.get("errorDocument") || "error.html";

// Create an S3 bucket and configure it as a website.
const bucket = new aws.s3.BucketV2("bucket");

const bucketWebsite = new aws.s3.BucketWebsiteConfigurationV2("bucketWebsite", {
    bucket: bucket.bucket,
    indexDocument: { suffix: indexDocument },
    errorDocument: { key: errorDocument },
});

// Configure ownership controls for the new S3 bucket
const ownershipControls = new aws.s3.BucketOwnershipControls("ownership-controls", {
    bucket: bucket.bucket,
    rule: {
        objectOwnership: "ObjectWriter",
    },
});

// Configure public ACL block on the new S3 bucket
const publicAccessBlock = new aws.s3.BucketPublicAccessBlock("public-access-block", {
    bucket: bucket.bucket,
    blockPublicAcls: false,
});

// Use a synced folder to manage the files of the website.
const bucketFolder = new synced_folder.S3BucketFolder("bucket-folder", {
    path: path,
    bucketName: bucket.bucket,
    acl: "public-read",
}, { dependsOn: [ownershipControls, publicAccessBlock]});

// --------------------
// Application Load Balancer
// --------------------

// Create a VPC and subnets (for demo purposes)
const vpc = new aws.ec2.Vpc("vpc", { cidrBlock: "10.0.0.0/16" });
const subnet = new aws.ec2.Subnet("subnet", {
    vpcId: vpc.id,
    cidrBlock: "10.0.1.0/24",
    availabilityZone: "ca-central-1a",
});

// Security group for ALB
const albSg = new aws.ec2.SecurityGroup("alb-sg", {
    vpcId: vpc.id,
    description: "Allow HTTP",
    ingress: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] }],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

// Create the ALB
const alb = new aws.lb.LoadBalancer("alb", {
    internal: false,
    loadBalancerType: "application",
    securityGroups: [albSg.id],
    subnets: [subnet.id],
});

// Target group
const targetGroup = new aws.lb.TargetGroup("tg", {
    port: 80,
    protocol: "HTTP",
    targetType: "instance",
    vpcId: vpc.id,
});

// Listener
const listener = new aws.lb.Listener("listener", {
    loadBalancerArn: alb.arn,
    port: 80,
    defaultActions: [{
        type: "forward",
        targetGroupArn: targetGroup.arn,
    }],
});

// --------------------
// Example EC2 instance to serve traffic
// --------------------
const ami = aws.ec2.getAmi({
    mostRecent: true,
    owners: ["amazon"],
    filters: [{ name: "name", values: ["amzn2-ami-hvm-*-x86_64-gp2"] }],
});

const server = new aws.ec2.Instance("server", {
    instanceType: "t2.micro",
    vpcSecurityGroupIds: [albSg.id],
    subnetId: subnet.id,
    ami: ami.then(a => a.id),
    userData: `#!/bin/bash
echo "Hello from Pulumi ALB" > index.html
nohup python3 -m http.server 80 &`,
});

// Register EC2 with target group
const attachment = new aws.lb.TargetGroupAttachment("attach", {
    targetGroupArn: targetGroup.arn,
    targetId: server.id,
    port: 80,
});

// --------------------
// Exports
// --------------------
export const originURL = pulumi.interpolate`http://${bucketWebsite.websiteEndpoint}`;
export const originHostname = bucketWebsite.websiteEndpoint;
export const albDNS = alb.dnsName;
