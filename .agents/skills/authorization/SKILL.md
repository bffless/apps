---
name: authorization
description: Two-level permission system with global and project roles
---

# Authorization

**Docs**: https://docs.bffless.app/features/authorization/

BFFless uses a two-level permission system: global roles for workspace-wide access and project roles for fine-grained control.

## Global Roles

| Role | Capabilities |
|------|-------------|
| **Admin** | Full workspace access, manage users, billing, settings |
| **User** | Create projects, manage own content |
| **Member** | View-only access, participate in assigned projects |

## Project Roles

| Role | Capabilities |
|------|-------------|
| **Owner** | Full control, delete project, transfer ownership |
| **Admin** | Manage settings, users, deployments |
| **Contributor** | Deploy, create aliases, modify content |
| **Viewer** | Read-only access to project and deployments |

## Permission Sources

Users can receive project access from multiple sources:

1. **Direct assignment**: Explicitly added to project
2. **Group membership**: Inherited from user group
3. **Effective role**: Highest permission wins when multiple sources exist

## API Keys

Two types of API keys for automation:

- **Global keys**: Workspace-wide access, use the creator's permissions
- **Project keys**: Scoped to single project, specify exact role

Best practice: Use project-scoped keys with minimum required permissions.

## Common Patterns

**External contractors**: Add as Member globally, Contributor on specific projects

**CI/CD pipelines**: Create project API key with Contributor role

**Client preview access**: Use share links instead of user accounts

## Troubleshooting

**"Permission denied" errors?**
- Check effective role (may be inherited from group)
- Verify API key scope matches the project
- Global Members need explicit project assignment
