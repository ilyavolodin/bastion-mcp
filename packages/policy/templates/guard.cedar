// Deactivated principals are denied everything; forbid always wins (10.3).
@id("guard.inactive")
forbid (principal, action, resource)
when { principal.active == false };
