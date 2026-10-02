// Admin (10.1): every management capability, on every resource; secrets only at org and team level.
@id("role.admin.manage")
permit (principal is Bastion::User, action in [Bastion::Action::"seeCatalog", Bastion::Action::"catalog.create", Bastion::Action::"catalog.update", Bastion::Action::"catalog.publish", Bastion::Action::"catalog.delete", Bastion::Action::"marketplace.manage", Bastion::Action::"plugin.approveExecutable", Bastion::Action::"installation.manage", Bastion::Action::"override.edit", Bastion::Action::"policy.edit", Bastion::Action::"guard.edit", Bastion::Action::"user.manage", Bastion::Action::"team.manage", Bastion::Action::"registry.install", Bastion::Action::"logs.view", Bastion::Action::"audit.view", Bastion::Action::"settings.edit"], resource)
when { principal.role == "admin" };

@id("role.admin.secrets-org")
permit (principal is Bastion::User, action == Bastion::Action::"secrets.manage", resource is Bastion::Org)
when { principal.role == "admin" };

@id("role.admin.secrets-team")
permit (principal is Bastion::User, action == Bastion::Action::"secrets.manage", resource is Bastion::Team)
when { principal.role == "admin" };
