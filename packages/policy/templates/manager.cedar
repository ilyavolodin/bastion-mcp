// Manager of team T (10.1): scoped to the teams in principal.managedTeams.
@id("role.manager.team")
permit (principal is Bastion::User, action in [Bastion::Action::"seeCatalog", Bastion::Action::"catalog.create", Bastion::Action::"catalog.publish", Bastion::Action::"marketplace.manage", Bastion::Action::"installation.manage", Bastion::Action::"policy.edit", Bastion::Action::"user.manage", Bastion::Action::"secrets.manage", Bastion::Action::"audit.view"], resource is Bastion::Team)
when { resource in principal.managedTeams };

@id("role.manager.approve-requests")
permit (principal is Bastion::User, action == Bastion::Action::"registry.install", resource is Bastion::User)
when { resource in principal.managedTeams };

@id("role.manager.entries")
permit (principal is Bastion::User, action in [Bastion::Action::"seeCatalog", Bastion::Action::"catalog.update", Bastion::Action::"catalog.delete", Bastion::Action::"override.edit"], resource is Bastion::CatalogEntry)
when { resource has ownerTeam && principal.managedTeams.contains(resource.ownerTeam) };

@id("role.manager.installations")
permit (principal is Bastion::User, action in [Bastion::Action::"installation.manage", Bastion::Action::"override.edit"], resource is Bastion::Installation)
when { resource has ownerTeam && principal.managedTeams.contains(resource.ownerTeam) };

@id("role.manager.service-installations")
permit (principal is Bastion::User, action in [Bastion::Action::"installation.manage", Bastion::Action::"override.edit"], resource is Bastion::Installation)
when { resource has ownerService && resource.ownerService in principal.managedTeams };

@id("role.manager.view-org")
permit (principal is Bastion::User, action == Bastion::Action::"seeCatalog", resource is Bastion::Org)
when { !principal.managedTeams.isEmpty() };
