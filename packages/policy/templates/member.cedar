// Member capabilities (10.1), held by every user and, for their own installations, by service accounts.
@id("member.own-installation-user")
permit (principal is Bastion::User, action in [Bastion::Action::"installation.manage", Bastion::Action::"override.edit"], resource is Bastion::Installation)
when { resource has ownerUser && resource.ownerUser == principal };

@id("member.own-installation-service")
permit (principal is Bastion::ServiceAccount, action in [Bastion::Action::"installation.manage", Bastion::Action::"override.edit"], resource is Bastion::Installation)
when { resource has ownerService && resource.ownerService == principal };

@id("member.personal-install")
permit (principal is Bastion::User, action == Bastion::Action::"installation.manage", resource is Bastion::Org);

@id("member.registry-install")
permit (principal is Bastion::User, action == Bastion::Action::"registry.install", resource is Bastion::Org)
when { principal.role != "auditor" };

@id("member.own-logs")
permit (principal is Bastion::User, action == Bastion::Action::"logs.view", resource is Bastion::User)
when { resource == principal };

@id("member.own-secrets")
permit (principal is Bastion::User, action == Bastion::Action::"secrets.manage", resource is Bastion::User)
when { resource == principal };
