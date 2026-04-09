# Team & Scale Playbook (Ops & Teams)

Welcome to the Team & Scale Playbook. This guide is designed for teams working together, project maintainers setting standards, and CI/CD pipelines enforcing governance.

Once a project has multiple contributors (human or AI), Brainclaw becomes the synchronization point to ensure everyone is pulling in the same direction.

## Team Profiles

### Team Developers
You collaborate on shared projects with other humans and their agents.
**Key Value:** Async collaboration and avoiding conflicting AI actions. Use file claims so an agent doesn't rewrite code another agent is working on.
- [Concepts: Plans & Claims](../../concepts/plans-and-claims.md)
- [Concepts: Coordination](../../concepts/coordination.md)

### Project Maintainers
You are responsible for code quality and architecture.
**Key Value:** Protect the main branch by defining global rules that all joining agents must read. 
- [Review Workflow](../../review.md)
- [Server Operations](../../server-operations.md)

### CI/CD Operators
You manage headless agents in automation pipelines.
**Key Value:** Auditing, governance, and unattended code review. Brainclaw provides a headless way to manage AI actions on CI.
