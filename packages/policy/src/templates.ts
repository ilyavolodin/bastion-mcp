// Role templates (10.3) as strings so bundlers need not read files. Kept identical to templates/*.cedar
// (a test fails when they drift).

const GUARD =
  '// Deactivated principals are denied everything; forbid always wins (10.3).\n@id("guard.inactive")\nforbid (principal, action, resource)\nwhen { principal.active == false };\n';

const ADMIN =
  '// Admin (10.1): every management capability, on every resource; secrets only at org and team level.\n@id("role.admin.manage")\npermit (principal is Bastion::User, action in [Bastion::Action::"seeCatalog", Bastion::Action::"catalog.create", Bastion::Action::"catalog.update", Bastion::Action::"catalog.publish", Bastion::Action::"catalog.delete", Bastion::Action::"marketplace.manage", Bastion::Action::"plugin.approveExecutable", Bastion::Action::"installation.manage", Bastion::Action::"override.edit", Bastion::Action::"policy.edit", Bastion::Action::"guard.edit", Bastion::Action::"user.manage", Bastion::Action::"team.manage", Bastion::Action::"registry.install", Bastion::Action::"logs.view", Bastion::Action::"audit.view", Bastion::Action::"settings.edit"], resource)\nwhen { principal.role == "admin" };\n\n@id("role.admin.secrets-org")\npermit (principal is Bastion::User, action == Bastion::Action::"secrets.manage", resource is Bastion::Org)\nwhen { principal.role == "admin" };\n\n@id("role.admin.secrets-team")\npermit (principal is Bastion::User, action == Bastion::Action::"secrets.manage", resource is Bastion::Team)\nwhen { principal.role == "admin" };\n';

const MANAGER =
  '// Manager of team T (10.1): scoped to the teams in principal.managedTeams.\n@id("role.manager.team")\npermit (principal is Bastion::User, action in [Bastion::Action::"seeCatalog", Bastion::Action::"catalog.create", Bastion::Action::"catalog.publish", Bastion::Action::"marketplace.manage", Bastion::Action::"installation.manage", Bastion::Action::"policy.edit", Bastion::Action::"user.manage", Bastion::Action::"secrets.manage", Bastion::Action::"audit.view"], resource is Bastion::Team)\nwhen { resource in principal.managedTeams };\n\n@id("role.manager.approve-requests")\npermit (principal is Bastion::User, action == Bastion::Action::"registry.install", resource is Bastion::User)\nwhen { resource in principal.managedTeams };\n\n@id("role.manager.entries")\npermit (principal is Bastion::User, action in [Bastion::Action::"seeCatalog", Bastion::Action::"catalog.update", Bastion::Action::"catalog.delete", Bastion::Action::"override.edit"], resource is Bastion::CatalogEntry)\nwhen { resource has ownerTeam && principal.managedTeams.contains(resource.ownerTeam) };\n\n@id("role.manager.installations")\npermit (principal is Bastion::User, action in [Bastion::Action::"installation.manage", Bastion::Action::"override.edit"], resource is Bastion::Installation)\nwhen { resource has ownerTeam && principal.managedTeams.contains(resource.ownerTeam) };\n\n@id("role.manager.service-installations")\npermit (principal is Bastion::User, action in [Bastion::Action::"installation.manage", Bastion::Action::"override.edit"], resource is Bastion::Installation)\nwhen { resource has ownerService && resource.ownerService in principal.managedTeams };\n\n@id("role.manager.view-org")\npermit (principal is Bastion::User, action == Bastion::Action::"seeCatalog", resource is Bastion::Org)\nwhen { !principal.managedTeams.isEmpty() };\n';

const MEMBER =
  '// Member capabilities (10.1), held by every user and, for their own installations, by service accounts.\n@id("member.own-installation-user")\npermit (principal is Bastion::User, action in [Bastion::Action::"installation.manage", Bastion::Action::"override.edit"], resource is Bastion::Installation)\nwhen { resource has ownerUser && resource.ownerUser == principal };\n\n@id("member.own-installation-service")\npermit (principal is Bastion::ServiceAccount, action in [Bastion::Action::"installation.manage", Bastion::Action::"override.edit"], resource is Bastion::Installation)\nwhen { resource has ownerService && resource.ownerService == principal };\n\n@id("member.personal-install")\npermit (principal is Bastion::User, action == Bastion::Action::"installation.manage", resource is Bastion::Org);\n\n@id("member.registry-install")\npermit (principal is Bastion::User, action == Bastion::Action::"registry.install", resource is Bastion::Org)\nwhen { principal.role != "auditor" };\n\n@id("member.own-logs")\npermit (principal is Bastion::User, action == Bastion::Action::"logs.view", resource is Bastion::User)\nwhen { resource == principal };\n\n@id("member.own-secrets")\npermit (principal is Bastion::User, action == Bastion::Action::"secrets.manage", resource is Bastion::User)\nwhen { resource == principal };\n';

const AUDITOR =
  '// Auditor (10.1): read-only org view, call log and audit log. Never any secret values.\n@id("role.auditor.view")\npermit (principal is Bastion::User, action in [Bastion::Action::"seeCatalog", Bastion::Action::"logs.view", Bastion::Action::"audit.view"], resource)\nwhen { principal.role == "auditor" };\n';

export const ROLE_TEMPLATES: Readonly<
  Record<'guard' | 'admin' | 'manager' | 'member' | 'auditor', string>
> = {
  guard: GUARD,
  admin: ADMIN,
  manager: MANAGER,
  member: MEMBER,
  auditor: AUDITOR,
};
