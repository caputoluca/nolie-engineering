import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";
import { apiRepoURL, workerRepoURL } from "./ecr";
import { redisEndpoint } from "./redis";
import { albSecurityGroup, ecsSecurityGroup, vpc } from "./vpc";

const stack = pulumi.getStack();
const config = new pulumi.Config();

// Config values
const apiCpu = config.requireNumber("apiCpu");
const apiMemory = config.requireNumber("apiMemory");
const apiDesiredCount = config.requireNumber("apiDesiredCount");
const apiMinCount = config.requireNumber("apiMinCount");
const apiMaxCount = config.requireNumber("apiMaxCount");
const workerCpu = config.requireNumber("workerCpu");
const workerMemory = config.requireNumber("workerMemory");
const workerDesiredCount = config.requireNumber("workerDesiredCount");
const workerMinCount = config.requireNumber("workerMinCount");
const workerMaxCount = config.requireNumber("workerMaxCount");
// Image tags: always required via environment variable
// For initial deploy, set API_IMAGE_TAG and WORKER_IMAGE_TAG env vars manually

const isDryRun = pulumi.runtime.isDryRun();

const apiImageTag =
	process.env.API_IMAGE_TAG || (isDryRun ? "dry-run" : undefined);
const workerImageTag =
	process.env.WORKER_IMAGE_TAG || (isDryRun ? "dry-run" : undefined);

if (!apiImageTag || !workerImageTag) {
	throw new Error(
		"API_IMAGE_TAG and WORKER_IMAGE_TAG environment variables are required",
	);
}
const apiDomain = config.require("apiDomain");

// =============================================================================
// Secrets Helper
// =============================================================================

const awsIdentity = aws.getCallerIdentity();
const awsRegion = aws.getRegion();

/**
 * Creates ECS secrets configuration from AWS Secrets Manager
 * Secrets are fetched at container startup and injected as env vars
 */
const secrets = (names: string[], service: "api" | "worker") =>
	pulumi.all([awsIdentity, awsRegion]).apply(([identity, region]) =>
		names.map((name) => ({
			name,
			valueFrom: `arn:aws:secretsmanager:${region.region}:${identity.accountId}:secret:nolie/${stack}/${service}:${name}::`,
		})),
	);

// All env vars from Infisical (synced to AWS Secrets Manager)
// These match the zod schemas in apps/api/app/plugins/config.ts and apps/worker/app/config.ts
const API_SECRETS = [
	"DATABASE_URL",
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"FRONTEND_URL",
	"SOCIAL_SIGN_IN_REDIRECT_URL",
	"EMAIL_VERIFICATION_URL",
	// HOST is set in environment array
	"COOKIE_DOMAIN",
	"APP_BASE_URL",
	"QUEUE_PREFIX",
	"POSTMARK_API_KEY",
	"NOTIFY_EMAIL",
	"CONTACT_EMAIL",
	"SUPPORT_EMAIL",
	"S3_BUCKET_NAME",
	"S3_API_ENDPOINT",
	"S3_ACCESS_KEY_ID",
	"S3_SECRET_ACCESS_KEY",
	"R2_PUBLIC_URL",
	"ABLY_PUBLISH_KEY",
	"ABLY_SUBSCRIBE_KEY",
	"STRIPE_API_KEY",
	"STRIPE_WEBHOOK_SECRET",
	"STRIPE_CONNECT_WEBHOOK_SECRET",
	"BETTER_AUTH_SECRET",
	"BETTER_AUTH_URL",
	"OPENAI_API_KEY",
	"TRUSTED_ORIGINS",
	"SENTRY_DSN",
	"NOLIE_RATE_LIMITING_ENABLED",
	"SHIPPO_WEBHOOK_SECRET",
	"SHIPPO_API_TOKEN",
	"INTERNAL_API_SECRET",
	// PORT is set in environment array
];

const WORKER_SECRETS = [
	"DATABASE_URL",
	"QUEUE_PREFIX",
	"ABLY_PUBLISH_KEY",
	"ASSETS_URL",
	"AUCTIONS_WORKER_CONCURRENCY",
	"PAYOUTS_WORKER_CONCURRENCY",
	"BIDS_WORKER_CONCURRENCY",
	"BIDS_PERSIST_WORKER_CONCURRENCY",
	"NOTIFICATIONS_WORKER_CONCURRENCY",
	"RECURRING_AUCTIONS_WORKER_CONCURRENCY",
	"POSTMARK_API_KEY",
	"FRONTEND_URL",
	"NOTIFY_EMAIL",
	"SUPPORT_EMAIL",
	"OPS_EMAIL",
	"POSTHOG_API_KEY",
	"POSTHOG_HOST",
	"QUEUE_LATENCY_WARN_MS",
	"QUEUE_LATENCY_ERROR_MS",
	"SENTRY_DSN",
	"STRIPE_API_KEY",
	"SLACK_BOT_TOKEN",
	"SLACK_CHANNEL_ID",
	"SHIPPO_API_TOKEN",
];

// =============================================================================
// ECS Cluster
// =============================================================================

export const cluster = new aws.ecs.Cluster(`nolie-${stack}`, {
	settings: [
		{
			name: "containerInsights",
			value: "enabled",
		},
	],
});

// =============================================================================
// ALB (Application Load Balancer)
// =============================================================================

export const alb = new aws.lb.LoadBalancer(`nolie-${stack}`, {
	loadBalancerType: "application",
	securityGroups: [albSecurityGroup.id],
	subnets: vpc.publicSubnetIds,
	tags: { Environment: stack },
});

// Target group - ALB forwards traffic here
export const apiTargetGroup = new aws.lb.TargetGroup(`nolie-api-${stack}`, {
	port: 8000,
	protocol: "HTTP",
	vpcId: vpc.vpcId,
	targetType: "ip", // Required for Fargate
	healthCheck: {
		path: "/health",
		interval: 30,
		timeout: 5,
		healthyThreshold: 2,
		unhealthyThreshold: 3,
	},
});

// =============================================================================
// ACM Certificate
// =============================================================================

const certificate = new aws.acm.Certificate(`nolie-cert-${stack}`, {
	domainName: apiDomain,
	validationMethod: "DNS",
	tags: { Environment: stack },
});

// Export validation records for Cloudflare DNS
export const certificateValidation = certificate.domainValidationOptions;

// Wait for certificate to be validated before using it
const certificateValidated = new aws.acm.CertificateValidation(
	`nolie-cert-validation-${stack}`,
	{
		certificateArn: certificate.arn,
	},
);

// =============================================================================
// ALB Listeners
// =============================================================================

// HTTP listener - redirect to HTTPS
const _httpListener = new aws.lb.Listener(`nolie-http-${stack}`, {
	loadBalancerArn: alb.arn,
	port: 80,
	protocol: "HTTP",
	defaultActions: [
		{
			type: "redirect",
			redirect: {
				port: "443",
				protocol: "HTTPS",
				statusCode: "HTTP_301",
			},
		},
	],
});

// HTTPS listener
const _httpsListener = new aws.lb.Listener(`nolie-https-${stack}`, {
	loadBalancerArn: alb.arn,
	port: 443,
	protocol: "HTTPS",
	sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
	certificateArn: certificateValidated.certificateArn,
	defaultActions: [
		{
			type: "forward",
			targetGroupArn: apiTargetGroup.arn,
		},
	],
});

// =============================================================================
// IAM Roles for ECS Tasks
// =============================================================================

// Execution role - allows ECS to pull images and write logs
const executionRole = new aws.iam.Role(`nolie-exec-${stack}`, {
	assumeRolePolicy: JSON.stringify({
		Version: "2012-10-17",
		Statement: [
			{
				Action: "sts:AssumeRole",
				Effect: "Allow",
				Principal: { Service: "ecs-tasks.amazonaws.com" },
			},
		],
	}),
});

new aws.iam.RolePolicyAttachment(`nolie-exec-policy-${stack}`, {
	role: executionRole.name,
	policyArn:
		"arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

// Allow reading secrets from Secrets Manager
new aws.iam.RolePolicy(`nolie-secrets-${stack}`, {
	role: executionRole.name,
	policy: pulumi.all([awsIdentity, awsRegion]).apply(([identity, region]) =>
		JSON.stringify({
			Version: "2012-10-17",
			Statement: [
				{
					Effect: "Allow",
					Action: ["secretsmanager:GetSecretValue"],
					Resource: `arn:aws:secretsmanager:${region.region}:${identity.accountId}:secret:nolie/${stack}/*`,
				},
			],
		}),
	),
});

// Task role - what the running container can do (add permissions as needed)
const taskRole = new aws.iam.Role(`nolie-task-${stack}`, {
	assumeRolePolicy: JSON.stringify({
		Version: "2012-10-17",
		Statement: [
			{
				Action: "sts:AssumeRole",
				Effect: "Allow",
				Principal: { Service: "ecs-tasks.amazonaws.com" },
			},
		],
	}),
});

const NODE_ENV = config.require("nodeEnv");

// =============================================================================
// API Service
// =============================================================================

export const apiService = new awsx.ecs.FargateService(`nolie-api-${stack}`, {
	cluster: cluster.arn,
	desiredCount: apiDesiredCount,
	healthCheckGracePeriodSeconds: 10, // Wait 10s before ALB health checks count
	networkConfiguration: {
		subnets: vpc.privateSubnetIds,
		securityGroups: [ecsSecurityGroup.id],
	},
	loadBalancers: [
		{
			targetGroupArn: apiTargetGroup.arn,
			containerName: "api",
			containerPort: 8000,
		},
	],
	taskDefinitionArgs: {
		executionRole: { roleArn: executionRole.arn },
		taskRole: { roleArn: taskRole.arn },
		container: {
			name: "api",
			image: pulumi.interpolate`${apiRepoURL}:${apiImageTag}`,
			cpu: apiCpu,
			memory: apiMemory,
			essential: true,
			portMappings: [
				{
					containerPort: 8000,
					protocol: "tcp",
				},
			],
			environment: [
				{
					name: "NODE_ENV",
					value: NODE_ENV,
				},
				{ name: "REDIS_URL", value: redisEndpoint },
				{ name: "PORT", value: "8000" },
				{ name: "HOST", value: "0.0.0.0" },
				{ name: "SENTRY_ENVIRONMENT", value: stack },
			],
			secrets: secrets(API_SECRETS, "api"),
		},
	},
	deploymentCircuitBreaker: {
		enable: true,
		rollback: true,
	},
});

// =============================================================================
// Worker Service
// =============================================================================

export const workerService = new awsx.ecs.FargateService(
	`nolie-worker-${stack}`,
	{
		cluster: cluster.arn,
		desiredCount: workerDesiredCount,
		networkConfiguration: {
			subnets: vpc.privateSubnetIds,
			securityGroups: [ecsSecurityGroup.id],
		},
		// No load balancer - worker just processes jobs from Redis
		taskDefinitionArgs: {
			executionRole: { roleArn: executionRole.arn },
			taskRole: { roleArn: taskRole.arn },
			container: {
				name: "worker",
				image: pulumi.interpolate`${workerRepoURL}:${workerImageTag}`,
				cpu: workerCpu,
				memory: workerMemory,
				essential: true,
				stopTimeout: 120, // max allowed on Fargate - allows graceful job completion
				environment: [
					{
						name: "NODE_ENV",
						value: NODE_ENV,
					},
					{ name: "REDIS_URL", value: redisEndpoint },
					{ name: "SENTRY_ENVIRONMENT", value: stack },
				],
				secrets: secrets(WORKER_SECRETS, "worker"),
			},
		},
		deploymentCircuitBreaker: {
			enable: true,
			rollback: true,
		},
	},
);

// =============================================================================
// Autoscaling - API
// =============================================================================

const apiScalingTarget = new aws.appautoscaling.Target(`api-scaling-${stack}`, {
	maxCapacity: apiMaxCount,
	minCapacity: apiMinCount,
	resourceId: pulumi.interpolate`service/${cluster.name}/${apiService.service.name}`,
	scalableDimension: "ecs:service:DesiredCount",
	serviceNamespace: "ecs",
});

// Scale based on requests per target (primary policy)
new aws.appautoscaling.Policy(`api-scaling-requests-${stack}`, {
	policyType: "TargetTrackingScaling",
	resourceId: apiScalingTarget.resourceId,
	scalableDimension: apiScalingTarget.scalableDimension,
	serviceNamespace: apiScalingTarget.serviceNamespace,
	targetTrackingScalingPolicyConfiguration: {
		predefinedMetricSpecification: {
			predefinedMetricType: "ALBRequestCountPerTarget",
			resourceLabel: pulumi.interpolate`${alb.arnSuffix}/${apiTargetGroup.arnSuffix}`,
		},
		targetValue: 1000, // requests per target per minute (~17 RPS) - lower for earlier scaling
		scaleInCooldown: 300, // 5 min - scale in slowly
		scaleOutCooldown: 30, // 30s - scale out faster
	},
});

// Scale based on CPU
new aws.appautoscaling.Policy(`api-scaling-cpu-${stack}`, {
	policyType: "TargetTrackingScaling",
	resourceId: apiScalingTarget.resourceId,
	scalableDimension: apiScalingTarget.scalableDimension,
	serviceNamespace: apiScalingTarget.serviceNamespace,
	targetTrackingScalingPolicyConfiguration: {
		predefinedMetricSpecification: {
			predefinedMetricType: "ECSServiceAverageCPUUtilization",
		},
		targetValue: 45, // scale when CPU hits 45% - gives headroom
		scaleInCooldown: 300,
		scaleOutCooldown: 30, // faster scale-out (30s instead of 60s)
	},
});

// =============================================================================
// Autoscaling - Worker
// =============================================================================

const workerScalingTarget = new aws.appautoscaling.Target(
	`worker-scaling-${stack}`,
	{
		maxCapacity: workerMaxCount,
		minCapacity: workerMinCount,
		resourceId: pulumi.interpolate`service/${cluster.name}/${workerService.service.name}`,
		scalableDimension: "ecs:service:DesiredCount",
		serviceNamespace: "ecs",
	},
);

// Scale based on CPU utilization (best for background workers)
new aws.appautoscaling.Policy(`worker-scaling-policy-${stack}`, {
	policyType: "TargetTrackingScaling",
	resourceId: workerScalingTarget.resourceId,
	scalableDimension: workerScalingTarget.scalableDimension,
	serviceNamespace: workerScalingTarget.serviceNamespace,
	targetTrackingScalingPolicyConfiguration: {
		predefinedMetricSpecification: {
			predefinedMetricType: "ECSServiceAverageCPUUtilization",
		},
		targetValue: 60, // scale when CPU hits 60%
		scaleInCooldown: 300,
		scaleOutCooldown: 30,
	},
});

// =============================================================================
// Exports
// =============================================================================

export const albDnsName = alb.dnsName;
export const clusterName = cluster.name;

// Export current image tags so CI can query them for unchanged services
export const currentApiImageTag = apiImageTag;
export const currentWorkerImageTag = workerImageTag;
