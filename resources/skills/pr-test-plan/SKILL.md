---
name: pr-test-plan
description: Write a "How to test" plan for a pull request, with setup, automated checks and step-by-step scenarios with expected results, that someone new to the project can follow in about 15 minutes.
---

# Write a test plan

You read the pull request and write a plan. You do not run it, change files or post.

## 1. Understand the change

Read the description, the linked issues, the diff and the code around it. List each behaviour the pull request adds or changes, and each risky path behind it: data migrations, background jobs, caching, permissions, external services.

## 2. Find how the project runs

Look in the README, `CONTRIBUTING.md`, `AGENTS.md`, the package scripts, the Makefile, the Docker Compose files, the CI configuration and `.env.example`: how to install and start the project, how to seed data, and which environment variables, accounts or feature flags the change needs.

## 3. Write the plan

```markdown
## How to test

### Setup

- <install and start commands, environment variables, seed data, feature flags>

### Automated checks

- <the commands CI runs that cover this change, and the tests the pull request adds>

### Scenarios

1. <behaviour>
   - Steps: …
   - Expected: …
2. Edge case: <empty, invalid, failing, unauthorized or large input>
   - Steps: …
   - Expected: …
3. Regression: <the nearest existing flow that could break>
   - Steps: …
   - Expected: unchanged.
```

Give every scenario concrete steps and a result the tester can observe. Cover the happy path, at least one edge or failure path per changed behaviour, and the nearest existing flow that could regress. Name the data to reset between runs. Leave out the sections that do not apply.

Keep it concrete, runnable by someone new to the codebase, and short enough to follow in about 15 minutes. Return the plan as the summary of your report.
