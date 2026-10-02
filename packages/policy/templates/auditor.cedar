// Auditor (10.1): read-only org view, call log and audit log. Never any secret values.
@id("role.auditor.view")
permit (principal is Bastion::User, action in [Bastion::Action::"seeCatalog", Bastion::Action::"logs.view", Bastion::Action::"audit.view"], resource)
when { principal.role == "auditor" };
