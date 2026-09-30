class OrganizationService {
}

class Logger {
}

class Repository {
}

class TenantController {
    private Logger logger;

    public TenantController(OrganizationService service) {
    }

    public OrganizationService resolve(Repository repo) {
        return null;
    }

    public java.util.List<Repository> load() {
        return null;
    }

    public String count(int value) {
        return String.valueOf(value);
    }
}
