# Phase 4: Infrastructure Architecture

**Uses Atomic Skill:** `orchestrate-generation`
**Phase Type:** LINEAR

## Purpose

Design infrastructure with Infrastructure as Code approach.

## Domain-Specific Extensions (Architecture)

**IaC Tool Selection (from Phase 0 cloud strategy):**
- On-premise default: Terraform (cloud-agnostic)
- Cloud-native: CloudFormation (AWS-only) or Terraform
- Multi-cloud: Terraform or Pulumi

**Deliverables:**

1. **IaC Templates**
   - Network layer (VPC, subnets, NAT)
   - Compute layer (EC2/ECS/EKS, auto-scaling)
   - Data layer (RDS/DynamoDB, S3, caching)
   - Security layer (security groups, IAM, KMS)
   - Monitoring layer (CloudWatch, logging)

2. **Container Orchestration**
   - Kubernetes vs Docker Swarm decision
   - Deployment manifests
   - Helm charts (if Kubernetes)
   - Service definitions

3. **Cloud-Native Patterns**
   - 12-Factor App methodology application
   - Managed services strategy
   - Serverless considerations (if applicable)

4. **Cost Estimation**
   - Cloud pricing calculator estimates
   - Right-sizing guidance

## Gate Exit Criteria

- [ ] IaC templates for all environments (dev/staging/prod)
- [ ] Tool selection ADR
- [ ] Container orchestration configured
- [ ] Infrastructure idempotent (re-run safe)
- [ ] Cost estimation provided
- [ ] Cloud architecture diagram complete

## Output

- infrastructure/ (Terraform/CloudFormation/Pulumi modules)
- helm-charts/ (if Kubernetes)
- cloud-architecture-diagram
- cost-estimation.md
- adrs/infrastructure/

## MANDATORY Agent Invocation

```bash
Task tool with subagent_type: "orchestrate-generation"
```

Produces: `.claude/memory/{task_id}-generation-memory.md`
