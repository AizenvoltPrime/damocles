struct OrganizationService {}

struct Logger {}

struct Repository {}

struct TenantController {
    logger: Logger,
}

impl TenantController {
    fn new(service: OrganizationService) -> TenantController {
        TenantController { logger: Logger {} }
    }

    fn resolve(&self, repo: &Repository) -> OrganizationService {
        OrganizationService {}
    }

    fn count(&self, value: i32) -> String {
        String::new()
    }
}
