# GitHub-hosted Funding Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate two Top10 Funding PNG tables, publish them to a public GitHub image branch, and send them through Google Chat.

**Architecture:** Keep ranking/history intact and replace only the delivery presentation. A renderer produces PNG buffers, a GitHub client publishes immutable paths and returns public URLs, and the job sends a small image-card payload only after both uploads succeed.

**Tech Stack:** Node.js 24, TypeScript, `sharp`, GitHub REST Contents/Git Refs APIs, Google Chat incoming Webhook, Node test runner.

## Global Constraints

- Produce exactly two images for ranks 1–10 and 11–20.
- Use the existing equal-weight next-Funding APR ranking and five venue metrics.
- Do not expose GitHub Token or Google Chat Webhook in logs or errors.
- Do not upload or mutate state during dry-run.
- Mark a slot successful only after image publication and Chat success.

---

### Task 1: Funding image renderer

**Files:**
- Create: `src/image/funding-report.ts`
- Create: `test/image/funding-report.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `renderFundingReportImages(leaderboard): Promise<FundingReportImage[]>`
- Produces: `{ range: '1-10' | '11-20'; png: Buffer }`

- [ ] Write tests asserting two outputs, escaped labels, all venue columns, color semantics, and PNG signatures.
- [ ] Run the focused tests and confirm failure because the renderer is absent.
- [ ] Implement SVG generation and `sharp` conversion with deterministic dimensions.
- [ ] Run focused tests and the full suite.

### Task 2: GitHub image publisher

**Files:**
- Create: `src/github/image-publisher.ts`
- Create: `test/github/image-publisher.test.ts`
- Modify: `src/domain.ts`
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

**Interfaces:**
- Produces: `GitHubImagePublisher.publish(images, slot): Promise<PublishedFundingImages>`
- Consumes: GitHub token, `owner/repository`, branch, image buffers, and scheduled slot.

- [ ] Write tests for existing-branch upload, missing-branch creation, immutable paths, public URLs, and redacted API errors.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement GitHub API calls, validation, and public raw URLs.
- [ ] Add configuration parsing and required-variable tests.
- [ ] Run focused tests and the full suite.

### Task 3: Image Chat payload and job integration

**Files:**
- Create: `src/chat/image-message.ts`
- Create: `test/chat/image-message.test.ts`
- Modify: `src/app.ts`
- Modify: `src/job.ts`
- Modify: `test/job.test.ts`

**Interfaces:**
- Produces: `buildFundingImageChatMessage(leaderboard, publishedImages): GoogleChatMessage`
- Extends: `FundingJobDeps` with renderer and image publisher dependencies.

- [ ] Write tests for the two-image Chat payload and render-upload-send-commit ordering.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement the payload builder and wire rendering/publishing into send mode.
- [ ] Preserve dry-run isolation and add upload-failure/state tests.
- [ ] Run focused tests and the full suite.

### Task 4: Environment loading, immediate startup, operations docs

**Files:**
- Create: `src/env.ts`
- Create: `test/env.test.ts`
- Modify: `src/index.ts`
- Modify: `src/cli.ts`
- Modify: `src/scheduler.ts`
- Modify: `test/scheduler.test.ts`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces: `loadProjectEnv(): void`
- Changes daemon startup to attempt the latest unsent slot immediately.

- [ ] Write tests for `.env` precedence and unconditional unsent startup invocation.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement environment loading before configuration and startup behavior.
- [ ] Document public-repository requirement, variables, deployment, and validation.
- [ ] Run typecheck, all tests, build, and inspect generated fixture PNGs.
